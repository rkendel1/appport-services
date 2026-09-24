import { randomUUID } from 'node:crypto';
import type {
  Job,
  JobSchedule,
  CreateJobInput,
  ScheduleRecurringInput,
} from './models.js';
import type { JobStore, JobScheduleStore, JobAuditSink } from './store.js';
import { InvalidIntervalError } from './errors.js';
import type { ServiceExecutionContext } from '../authority/context.js';
import { ServiceAuthorityError, isServiceAuthorityError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { mintVerifiedPrincipal, rejectCallerActor, requireVerifiedPrincipal, resolveTenant, toDurablePrincipal, type VerifiedPrincipal } from '../authority/principal.js';

const DEFAULT_MAX_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 1000;
const LEASE_DURATION_MS = 30000;
/** Job types under this prefix belong to AppPort Services itself. */
export const SYSTEM_JOB_TYPE_PREFIX = 'appport.';
const SYSTEM_JOB_API = Symbol('appport.systemJobs');

interface JobServiceOptions {
  readonly jobStore: JobStore;
  readonly scheduleStore: JobScheduleStore;
  readonly auditSink: JobAuditSink;
  readonly now?: () => Date;
  readonly maxRetryAttempts?: number;
  readonly leaseDurationMs?: number;
  readonly allowedTypes?: readonly string[];
  /** Policy Enforcement Point. Without it legacy compatibility rules apply. */
  readonly authority?: ServiceGateway;
}

/** What a running job is allowed to act as. Every effect it causes is authorized again. */
export interface JobExecution {
  /** The job's durable principal for this run (with delegation and run id). */
  readonly principal: VerifiedPrincipal;
  /** The jobs.execute authorization for this run. */
  readonly context: ServiceExecutionContext;
  readonly runId: string;
}

type JobHandler = (job: Job, execution: JobExecution) => Promise<void>;

export interface SystemJobQueue {
  register(type: string, handler: JobHandler): void;
  enqueue(input: CreateJobInput): Promise<Job>;
}

export function systemJobs(service: JobService): SystemJobQueue {
  return service[SYSTEM_JOB_API]();
}

export class JobService {
  private readonly jobStore: JobStore;
  private readonly scheduleStore: JobScheduleStore;
  private readonly auditSink: JobAuditSink;
  private readonly now: () => Date;
  private readonly maxRetryAttempts: number;
  private readonly leaseDurationMs: number;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly allowedTypes?: ReadonlySet<string>;

  constructor(private readonly options: JobServiceOptions) {
    this.jobStore = options.jobStore;
    this.scheduleStore = options.scheduleStore;
    this.auditSink = options.auditSink;
    this.now = options.now ?? (() => new Date());
    this.maxRetryAttempts = options.maxRetryAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.leaseDurationMs = options.leaseDurationMs ?? LEASE_DURATION_MS;
    this.allowedTypes = options.allowedTypes?.length ? new Set(options.allowedTypes) : undefined;
  }

  register(type: string, handler: JobHandler): void {
    assertApplicationJobType(type);
    this.assertAllowedType(type, false);
    this.handlers.set(type, handler);
  }

  [SYSTEM_JOB_API](): SystemJobQueue {
    return {
      register: (type, handler) => {
        if (!type.startsWith(SYSTEM_JOB_TYPE_PREFIX)) throw new Error(`System job types must start with "${SYSTEM_JOB_TYPE_PREFIX}"`);
        this.handlers.set(type, handler);
      },
      enqueue: async (input) => {
        if (!input.type.startsWith(SYSTEM_JOB_TYPE_PREFIX)) throw new Error(`System job types must start with "${SYSTEM_JOB_TYPE_PREFIX}"`);
        return this.createJobRecord(input, 'system');
      },
    };
  }

  async enqueue(input: CreateJobInput, caller?: VerifiedPrincipal): Promise<Job> {
    assertApplicationJobType(input.type);
    this.assertAllowedType(input.type, Boolean(this.options.authority));
    if (!this.options.authority) return this.createJobRecord(input, 'system');
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor(input, principal);
    const tenantId = resolveTenant(input, principal);
    const delegationId = input.delegationId ?? principal.delegationId;
    return this.gateway().execute('jobs.create', principal, { type: 'job', tenantId, attributes: { jobType: input.type, ...(delegationId ? { delegationId } : {}) } }, { service: 'jobs' },
      (context) => this.createJobRecord({ ...input, tenantId }, principal.principalId, this.gateway().application, principal, context.authorization.decisionId));
  }

  async schedule(input: CreateJobInput, caller?: VerifiedPrincipal): Promise<Job> {
    if (!input.runAt) {
      if (this.options.authority) throw new ServiceAuthorityError('INVALID_REQUEST', 'schedule() requires runAt');
      throw new Error('schedule() requires runAt');
    }
    return this.enqueue(input, caller);
  }

  async scheduleRecurring(input: ScheduleRecurringInput, caller?: VerifiedPrincipal): Promise<JobSchedule> {
    this.nextRunTime(this.now().toISOString(), input.interval);
    assertApplicationJobType(input.type);
    this.assertAllowedType(input.type, Boolean(this.options.authority));
    if (!this.options.authority) return this.createScheduleRecord(input, input.createdBy ?? 'system');
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor(input, principal);
    const tenantId = resolveTenant(input, principal);
    const delegationId = input.delegationId ?? principal.delegationId;
    return this.gateway().execute('schedules.create', principal, { type: 'schedule', tenantId, attributes: { jobType: input.type, ...(delegationId ? { delegationId } : {}) } }, { service: 'jobs' },
      (context) => this.createScheduleRecord({ ...input, tenantId }, principal.principalId, this.gateway().application, principal, context.authorization.decisionId));
  }

  async getJob(tenantId: string, jobId: string): Promise<Job | null> {
    return this.jobStore.get(tenantId, jobId);
  }

  async listJobs(tenantId: string): Promise<readonly Job[]> {
    return this.jobStore.list(tenantId);
  }

  /** Jobs whose run time or retry time has arrived, plus stale leases. */
  async listDueJobs(tenantId: string): Promise<readonly Job[]> {
    return this.jobStore.listDue(tenantId, this.now().toISOString());
  }

  async getSchedule(tenantId: string, scheduleId: string): Promise<JobSchedule | null> {
    return this.scheduleStore.get(tenantId, scheduleId);
  }

  async listSchedules(tenantId: string): Promise<readonly JobSchedule[]> {
    return this.scheduleStore.list(tenantId);
  }

  async disableSchedule(tenantId: string, scheduleId: string, caller?: VerifiedPrincipal): Promise<JobSchedule | null> {
    if (!this.options.authority) return this.disableScheduleLegacy(tenantId, scheduleId);
    const principal = requireVerifiedPrincipal(caller);
    const schedule = await this.scheduleStore.get(resolveTenant({ tenantId }, principal), scheduleId);
    if (!schedule || schedule.applicationId !== this.gateway().application) return null;
    return this.gateway().execute('schedules.cancel', principal, { type: 'schedule', tenantId, id: schedule.id, attributes: { jobType: schedule.type, createdBy: schedule.createdBy } }, { service: 'jobs' }, async () => {
      const updated = await this.scheduleStore.disable(tenantId, scheduleId, schedule.__version);
      if (updated) await this.recordScheduleAudit('job.schedule.disabled', updated, principal.principalId);
      return updated;
    });
  }

  async retry(tenantId: string, jobId: string, caller?: VerifiedPrincipal): Promise<Job | null> {
    const job = await this.jobStore.get(tenantId, jobId);
    if (!job) return null;
    if (!this.options.authority) return this.resetJob(job, 'system');
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    const owned = await this.jobStore.get(tenant, jobId);
    if (!owned || owned.applicationId !== this.gateway().application) return null;
    return this.gateway().execute('jobs.retry', principal, { type: 'job', tenantId, id: owned.id, attributes: { jobType: owned.type } }, { service: 'jobs' }, () => this.resetJob(owned, principal.principalId));
  }

  /**
   * Run one job. The worker id is only a lease owner; authority mode runs the
   * job as its durable principal, while legacy mode preserves the pre-authority
   * behavior for compatibility.
   */
  async executeJob(tenantId: string, jobId: string, workerId: string): Promise<boolean> {
    const job = await this.jobStore.get(tenantId, jobId);
    if (!job) return false;
    if (job.status === 'running' && job.leaseOwner !== workerId) return false;

    const leaseExpiresAt = new Date(this.now().getTime() + this.leaseDurationMs).toISOString();
    const claimed = await this.jobStore.claim(tenantId, jobId, job.__version, leaseExpiresAt);
    if (!claimed) return false;

    const handler = this.handlers.get(claimed.type);
    if (!handler) {
      await this.jobStore.updateJob(tenantId, jobId, claimed.__version, {
        status: 'failed',
        lastError: `Handler not registered for type: ${claimed.type}`,
      });
      return false;
    }

    const isSystemJob = claimed.type.startsWith(SYSTEM_JOB_TYPE_PREFIX);
    if (!this.options.authority || isSystemJob) return this.executeLegacyHandler(claimed, handler);
    if (!claimed.principal || claimed.principal.tenantId !== tenantId) {
      await this.deny(claimed, 'DENIED: anonymous job execution is not permitted; enqueue jobs through an authorized caller');
      return false;
    }

    try {
      await this.gateway().attest(claimed.principal, ['jobs.create', 'schedules.create']);
    } catch (error) {
      await this.deny(claimed, `DENIED: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }

    const runId = `${claimed.id}:${claimed.attemptCount + 1}`;
    const principal = mintVerifiedPrincipal({ ...claimed.principal, runId }, 'job');

    try {
      await this.gateway().execute('jobs.execute', principal,
        { type: 'job', tenantId, id: claimed.id, attributes: { jobType: claimed.type } },
        { service: 'jobs', requestId: runId },
        (context) => handler(claimed, { principal, context, runId }));
      await this.completeJob(claimed, principal.principalId, runId);
      return true;
    } catch (error) {
      if (isServiceAuthorityError(error) && (error.code === 'DENIED' || error.code === 'UNAUTHENTICATED')) {
        await this.deny(claimed, `DENIED: ${error.message}`);
        return false;
      }
      if (isServiceAuthorityError(error) && (error.code === 'AUTHORITY_UNAVAILABLE' || error.code === 'AUTHORIZATION_TIMEOUT')) {
        await this.jobStore.updateJob(tenantId, jobId, claimed.__version, {
          status: 'retrying',
          nextAttemptAt: new Date(this.now().getTime() + INITIAL_RETRY_DELAY_MS).toISOString(),
          lastError: `${error.code}: ${error.message}`,
        });
        return false;
      }
      await this.recordExecutionFailure(claimed, principal.principalId, error);
      return false;
    }
  }

  async processRecurringSchedules(tenantId: string): Promise<number> {
    const now = this.now().toISOString();
    const dueSchedules = await this.scheduleStore.listDue(tenantId, now);
    let created = 0;

    for (const schedule of dueSchedules) {
      const jobId = randomUUID();
      const job: Job = {
        id: jobId,
        tenantId: schedule.tenantId,
        ...(schedule.applicationId ? { applicationId: schedule.applicationId } : {}),
        type: schedule.type,
        payload: schedule.payload,
        status: 'pending',
        runAt: now,
        attemptCount: 0,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        createdAt: now,
        ...(schedule.principal ? { principal: schedule.principal } : {}),
        __version: 1,
      };

      await this.jobStore.create(job);
      created++;

      const nextRunAt = this.nextRunTime(now, schedule.interval);
      const updated = await this.scheduleStore.updateSchedule(tenantId, schedule.id, schedule.__version, { nextRunAt });
      if (updated) {
        await this.auditSink.record({
          id: randomUUID(),
          type: 'job.created_from_schedule',
          jobId,
          scheduleId: schedule.id,
          tenantId: schedule.tenantId,
          principalId: schedule.principal?.principalId ?? 'anonymous',
          timestamp: now,
          result: 'success',
        });
      }
    }

    return created;
  }

  private async createJobRecord(
    input: CreateJobInput & { tenantId?: string },
    principalId: string,
    applicationId?: string,
    principal?: VerifiedPrincipal,
    authorizedBy?: string,
  ): Promise<Job> {
    const id = randomUUID();
    const now = this.now().toISOString();
    const runAt = input.runAt ?? now;
    const status = runAt <= now ? 'pending' : 'scheduled';
    const job: Job = {
      id,
      tenantId: input.tenantId!,
      ...(applicationId ? { applicationId } : {}),
      type: input.type,
      payload: input.payload,
      status,
      runAt,
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? this.maxRetryAttempts,
      createdAt: now,
      ...(principal && authorizedBy ? { principal: toDurablePrincipal(principal, input.delegationId ?? principal.delegationId, authorizedBy) } : {}),
      __version: 1,
    };
    await this.jobStore.create(job);
    await this.auditSink.record({
      id: randomUUID(),
      type: 'job.created',
      jobId: job.id,
      tenantId: job.tenantId,
      principalId,
      timestamp: now,
      result: 'success',
      details: { jobType: job.type },
    });
    return job;
  }

  private async createScheduleRecord(
    input: ScheduleRecurringInput & { tenantId?: string },
    principalId: string,
    applicationId?: string,
    principal?: VerifiedPrincipal,
    authorizedBy?: string,
  ): Promise<JobSchedule> {
    const id = randomUUID();
    const now = this.now().toISOString();
    const nextRunAt = this.nextRunTime(now, input.interval);
    const schedule: JobSchedule = {
      id,
      tenantId: input.tenantId!,
      ...(applicationId ? { applicationId } : {}),
      type: input.type,
      payload: input.payload,
      interval: input.interval,
      nextRunAt,
      enabled: true,
      createdAt: now,
      createdBy: principalId,
      ...(principal && authorizedBy ? { principal: toDurablePrincipal(principal, input.delegationId ?? principal.delegationId, authorizedBy) } : {}),
      __version: 1,
    };
    await this.scheduleStore.create(schedule);
    await this.auditSink.record({
      id: randomUUID(),
      type: 'job.schedule.created',
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      principalId,
      timestamp: now,
      result: 'success',
      details: { jobType: schedule.type, interval: schedule.interval },
    });
    return schedule;
  }

  private async disableScheduleLegacy(tenantId: string, scheduleId: string): Promise<JobSchedule | null> {
    const schedule = await this.scheduleStore.get(tenantId, scheduleId);
    if (!schedule) return null;
    const updated = await this.scheduleStore.disable(tenantId, scheduleId, schedule.__version);
    if (updated) await this.recordScheduleAudit('job.schedule.disabled', updated, 'system');
    return updated;
  }

  private async resetJob(job: Job, principalId: string): Promise<Job | null> {
    const now = this.now().toISOString();
    const updated = await this.jobStore.updateJob(job.tenantId, job.id, job.__version, {
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: undefined,
      lastError: undefined,
    });
    if (updated) {
      await this.auditSink.record({
        id: randomUUID(),
        type: 'job.retried',
        jobId: updated.id,
        tenantId: updated.tenantId,
        principalId,
        timestamp: now,
        result: 'success',
      });
    }
    return updated;
  }

  private async executeLegacyHandler(job: Job, handler: JobHandler): Promise<boolean> {
    try {
      await handler(job, undefined as never);
      await this.completeJob(job, job.principal?.principalId ?? 'system');
      return true;
    } catch (error) {
      await this.recordExecutionFailure(job, job.principal?.principalId ?? 'system', error);
      return false;
    }
  }

  private async completeJob(job: Job, principalId: string, runId?: string): Promise<void> {
    const completedAt = this.now().toISOString();
    await this.jobStore.updateJob(job.tenantId, job.id, job.__version, { status: 'completed', completedAt });
    await this.auditSink.record({
      id: randomUUID(),
      type: 'job.completed',
      jobId: job.id,
      tenantId: job.tenantId,
      principalId,
      timestamp: completedAt,
      result: 'success',
      ...(runId ? { details: { runId } } : {}),
    });
  }

  private async recordExecutionFailure(job: Job, principalId: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const nextAttempt = job.attemptCount + 1;
    if (nextAttempt >= job.maxAttempts) {
      const failedAt = this.now().toISOString();
      await this.jobStore.updateJob(job.tenantId, job.id, job.__version, {
        status: 'failed',
        lastError: errorMessage,
        attemptCount: nextAttempt,
      });
      await this.auditSink.record({
        id: randomUUID(),
        type: 'job.failed',
        jobId: job.id,
        tenantId: job.tenantId,
        principalId,
        timestamp: failedAt,
        result: 'failure',
        details: { error: errorMessage, attemptCount: nextAttempt },
      });
      return;
    }
    const nextAttemptAt = new Date(this.now().getTime() + INITIAL_RETRY_DELAY_MS * Math.pow(2, job.attemptCount)).toISOString();
    await this.jobStore.updateJob(job.tenantId, job.id, job.__version, {
      status: 'retrying',
      nextAttemptAt,
      lastError: errorMessage,
      attemptCount: nextAttempt,
    });
    await this.auditSink.record({
      id: randomUUID(),
      type: 'job.retrying',
      jobId: job.id,
      tenantId: job.tenantId,
      principalId,
      timestamp: this.now().toISOString(),
      result: 'failure',
      details: { error: errorMessage, nextAttemptAt, attemptCount: nextAttempt },
    });
  }

  private async deny(job: Job, reason: string): Promise<void> {
    await this.jobStore.updateJob(job.tenantId, job.id, job.__version, { status: 'failed', lastError: reason });
    await this.auditSink.record({
      id: randomUUID(),
      type: 'job.denied',
      jobId: job.id,
      tenantId: job.tenantId,
      principalId: job.principal?.principalId ?? 'anonymous',
      timestamp: this.now().toISOString(),
      result: 'failure',
      details: { reason },
    });
  }

  private async recordScheduleAudit(type: string, schedule: JobSchedule, principalId: string): Promise<void> {
    await this.auditSink.record({
      id: randomUUID(),
      type,
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      principalId,
      timestamp: this.now().toISOString(),
      result: 'success',
    });
  }

  private assertAllowedType(type: string, authorityMode: boolean): void {
    if (!this.allowedTypes || this.allowedTypes.has(type)) return;
    if (authorityMode) throw new ServiceAuthorityError('INVALID_REQUEST', `Job type "${type}" is not declared in appport.toml`);
    throw new Error(`Job type "${type}" is not declared in appport.toml`);
  }

  private gateway(): ServiceGateway {
    if (!this.options.authority) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Jobs have no AuthBoundry authority configured');
    return this.options.authority;
  }

  private nextRunTime(now: string, interval: string): string {
    const match = interval.match(/^(\d+)([smhd])$/);
    if (!match) throw new InvalidIntervalError(interval);
    const value = parseInt(match[1], 10);
    const unit = match[2];
    let delayMs = 0;
    switch (unit) {
      case 's': delayMs = value * 1000; break;
      case 'm': delayMs = value * 60 * 1000; break;
      case 'h': delayMs = value * 60 * 60 * 1000; break;
      case 'd': delayMs = value * 24 * 60 * 60 * 1000; break;
    }
    return new Date(new Date(now).getTime() + delayMs).toISOString();
  }
}

function assertApplicationJobType(type: string): void {
  if (type.startsWith(SYSTEM_JOB_TYPE_PREFIX)) throw new Error(`Job type "${type}" is reserved for AppPort Services`);
}
