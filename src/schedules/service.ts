import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { JobService } from '../jobs/service.js';
import { ServiceAuthorityError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { requireVerifiedPrincipal, resolveTenant } from '../authority/principal.js';
import type { CreateScheduleInput, Schedule } from './models.js';

/** @deprecated Denials are reported as ServiceAuthorityError with code DENIED. */
export class ScheduleAuthorizationError extends Error {
  constructor() { super('Schedule operation is not authorized'); this.name = 'ScheduleAuthorizationError'; }
}
export class ScheduleValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ScheduleValidationError'; }
}

export interface ScheduleServiceOptions {
  readonly jobs: Pick<JobService, 'scheduleRecurring' | 'getSchedule' | 'listSchedules' | 'disableSchedule'>;
  /** Policy Enforcement Point for schedule reads. Creation and cancellation are enforced by the job service. */
  readonly authority?: ServiceGateway;
}

export class ScheduleService {
  constructor(private readonly options: ScheduleServiceOptions) {}

  async create(input: CreateScheduleInput, caller: AuthenticatedPrincipal): Promise<Schedule> {
    validateInput(input);
    return this.options.jobs.scheduleRecurring(input, caller);
  }

  async get(tenantId: string, id: string, caller: AuthenticatedPrincipal): Promise<Schedule | null> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    const schedule = await this.options.jobs.getSchedule(tenant, id);
    if (!schedule || schedule.applicationId !== this.gateway().application) return null;
    return this.gateway().execute('schedules.read', principal, { type: 'schedule', tenantId: tenant, id, attributes: { createdBy: schedule.createdBy } }, { service: 'schedules' }, async () => schedule);
  }

  /** Without a creator filter the request covers every schedule in the tenant; AuthBoundry decides. */
  async list(tenantId: string, caller: AuthenticatedPrincipal, options: { readonly createdBy?: string } = {}): Promise<readonly Schedule[]> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    return this.gateway().execute('schedules.read', principal, { type: 'schedule', tenantId: tenant, attributes: { createdBy: options.createdBy ?? '*' } }, { service: 'schedules' }, async () => {
      const schedules = (await this.options.jobs.listSchedules(tenant)).filter((schedule) => schedule.applicationId === this.gateway().application);
      return options.createdBy ? schedules.filter((schedule) => schedule.createdBy === options.createdBy) : schedules;
    });
  }

  async disable(tenantId: string, id: string, caller: AuthenticatedPrincipal): Promise<Schedule | null> {
    return this.options.jobs.disableSchedule(tenantId, id, caller);
  }

  private gateway(): ServiceGateway {
    if (!this.options.authority) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Schedules have no AuthBoundry authority configured');
    return this.options.authority;
  }
}

function validateInput(input: CreateScheduleInput): void {
  if (typeof input.type !== 'string' || !input.type.trim()) throw new ScheduleValidationError('type is required');
  if (typeof input.interval !== 'string' || !/^\d+[smhd]$/.test(input.interval)) throw new ScheduleValidationError('interval must match <number><s|m|h|d>');
}
