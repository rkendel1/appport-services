import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { JobService } from '../jobs/service.js';
import type { CreateScheduleInput, Schedule } from './models.js';

export class ScheduleAuthorizationError extends Error {
  constructor() { super('Schedule operation is not authorized'); this.name = 'ScheduleAuthorizationError'; }
}
export class ScheduleValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ScheduleValidationError'; }
}

export interface ScheduleServiceOptions {
  readonly jobs: Pick<JobService, 'scheduleRecurring' | 'getSchedule' | 'listSchedules' | 'disableSchedule'>;
}

export class ScheduleService {
  constructor(private readonly options: ScheduleServiceOptions) {}

  async create(input: CreateScheduleInput, principal: AuthenticatedPrincipal): Promise<Schedule> {
    this.authorizeTenant(principal, input.tenantId, 'schedules.create');
    validateInput(input);
    return this.options.jobs.scheduleRecurring({ ...input, createdBy: principal.principalId });
  }

  async get(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<Schedule | null> {
    this.authorizeTenant(principal, tenantId, 'schedules.read');
    const schedule = await this.options.jobs.getSchedule(tenantId, id);
    if (!schedule) return null;
    return this.visibleTo(principal, schedule, 'schedules.read') ? schedule : null;
  }

  async list(tenantId: string, principal: AuthenticatedPrincipal): Promise<readonly Schedule[]> {
    this.authorizeTenant(principal, tenantId, 'schedules.read');
    const schedules = await this.options.jobs.listSchedules(tenantId);
    return schedules.filter((schedule) => this.visibleTo(principal, schedule, 'schedules.read'));
  }

  async disable(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<Schedule | null> {
    this.authorizeTenant(principal, tenantId, 'schedules.write');
    const schedule = await this.options.jobs.getSchedule(tenantId, id);
    if (!schedule || !this.visibleTo(principal, schedule, 'schedules.write')) return null;
    return this.options.jobs.disableSchedule(tenantId, id);
  }

  private authorizeTenant(principal: AuthenticatedPrincipal, tenantId: string, scope: string): void {
    if (principal.tenantId !== tenantId || (!principal.scopes.includes(scope) && !principal.scopes.includes('schedules.admin'))) {
      throw new ScheduleAuthorizationError();
    }
  }

  private visibleTo(principal: AuthenticatedPrincipal, schedule: Schedule, scope: string): boolean {
    const anyScope = `${scope}:any`;
    return schedule.createdBy === principal.principalId || principal.scopes.includes(anyScope) || principal.scopes.includes('schedules.admin');
  }
}

function validateInput(input: CreateScheduleInput): void {
  if (!input.type.trim()) throw new ScheduleValidationError('type is required');
  if (!/^\d+[smhd]$/.test(input.interval)) throw new ScheduleValidationError('interval must match <number><s|m|h|d>');
}
