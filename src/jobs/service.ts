import { randomUUID } from 'node:crypto';
import type {
  Job,
  JobSchedule,
  CreateJobInput,
  ScheduleRecurringInput,
  JobHandlerResult,
} from './models.js';
import type { JobStore, JobScheduleStore, JobAuditSink } from './store.js';
import { HandlerNotRegisteredError, InvalidIntervalError } from './errors.js';
import type { ServiceExecutionContext } from '../authority/context.js';
import { ServiceAuthorityError, isServiceAuthorityError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { mintVerifiedPrincipal, rejectCallerActor, requireVerifiedPrincipal, resolveTenant, toDurablePrincipal, type VerifiedPrincipal } from '../authority/principal.js';

const DEFAULT_MAX_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 1000;
const LEASE_DURATION_MS = 30000;

interface JobServiceOptions {
  readonly jobStore: JobStore;
  readonly scheduleStore: JobScheduleStore;
  readonly auditSink: JobAuditSink;
  readonly now?: () => Date;
  readonly maxRetryAttempts?: number;
  readonly leaseDurationMs?: number;
  readonly allowedTypes?: readonly string[];
  /** Policy Enforcement Point. Without it job creation and execution fail closed. */
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
    if (this.allowedTypes && !this.allowedTypes.has(type)) throw new Error(`Job type "${type}" is not declared in appport.toml`);
    this.handlers.set(type, handler);
  }

  async enqueue(input: CreateJobInput, caller: VerifiedPrincipal): Promise<Job> {
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor(input, principal);
    const tenantId = resolveTenant(input, principal);
    if (this.allowedTypes && !this.allowedTypes.has(input.type)) throw new ServiceAuthorityError('INVALID_REQUEST', `Job type "${input.type}" is not declared in appport.toml`);
    const delegationId = input.delegationId ?? principal.delegationId;
    return this.gateway().execute('jobs.create', principal, { type: 'job', tenantId, attributes: { jobType: input.type, ...(delegationId ? { delegationId } : {}) } }, { service: 'jobs' },
      (context) => this.createJob({ ...input, tenantId }, principal, context.authorization.decisionId));
  }

  private async createJob(input: CreateJobInput & { tenantId: string }, principal: VerifiedPrincipal, authorizedBy: string): Promise<Job> {
    const id = randomUUID();
    const now = this.now().toISOString();
    const runAt = input.runAt ?? now;

    const status = runAt <= now ? 'pending' : 'scheduled';

    const job: Job = {
      id,
      tenantId: input.tenantId,
      applicationId: this.gateway().application,
      type: input.type,
      payload: input.payload,
      status,
      runAt,
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? this.maxRetryAttempts,
      createdAt: now,
      principal: toDurablePrincipal(principal, input.delegationId ?? principal.delegationId, authorizedBy),
      __version: 1,
    };

    await this.jobStore.create(job);

    await this.auditSink.record({
      id: randomUUID(),
      type: 'job.created',
      jobId: job.id,
      tenantId: job.tenantId,
      principalId: principal.principalId,
      timestamp: now,
      result: 'success',
      details: { jobType: job.type },
    });

    return job;
  }

  async schedule(input: CreateJobInput, caller: VerifiedPrincipal): Promise<Job> {
    if (!input.runAt) {
      throw new ServiceAuthorityError('INVALID_REQUEST', 'schedule() requires runAt');
    }
    return this.enqueue(input, caller);
  }

  async scheduleRecurring(input: ScheduleRecurringInput, caller: VerifiedPrincipal): Promise<JobSchedule> {
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor(input, principal);
    const tenantId = resolveTenant(input, principal);
    if (this.allowedTypes && !this.allowedTypes.has(input.type)) throw new ServiceAuthorityError('INVALID_REQUEST', `Job type "${input.type}" is not declared in appport.toml`);
    this.nextRunTime(this.now().toISOString(), input.interval);
    const delegationId = input.delegationId ?? principal.delegationId;
    return this.gateway().execute('schedules.create', principal, { type: 'schedule', tenantId, attributes: { jobType: input.type, ...(delegationId ? { delegationId } : {}) } }, { service: 'jobs' },
      (context) => this.createSchedule({ ...input, tenantId }, principal, context.authorization.decisionId));
  }

  private async createSchedule(input: ScheduleRecurringInput & { tenantId: string }, principal: VerifiedPrincipal, authorizedBy: string): Promise<JobSchedule> {
    const id = randomUUID();
    const now = this.now().toISOString();
    const nextRunAt = this.nextRunTime(now, input.interval);

    const schedule: JobSchedule = {
      id,
      tenantId: input.tenantId,
      applicationId: this.gateway().application,
      type: input.type,
      payload: input.payload,
      interval: input.interval,
      nextRunAt,
      enabled: true,
      createdAt: now,
      createdBy: principal.principalId,
      principal: toDurablePrincipal(principal, input.delegationId ?? principal.delegationId, authorizedBy),
      __version: 1,
    };

    await this.scheduleStore.create(schedule);

    await this.auditSink.record({
      id: randomUUID(),
      type: 'job.schedule.created',
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      principalId: principal.principalId,
      timestamp: now,
      result: 'success',
      details: { jobType: schedule.type, interval: schedule.interval },
    });

    return schedule;
  }

  async getJob(tenantId: string, jobId: string): Promise<Job | null> {
    return this.jobStore.get(tenantId, jobId);
  }

  async listJobs(tenantId: string): Promise<readonly Job[]> {
    return this.jobStore.list(tenantId);
  }

  async getSchedule(tenantId: string, scheduleId: string): Promise<JobSchedule | null> {
    return this.scheduleStore.get(tenantId, scheduleId);
  }

  async listSchedules(tenantId: string): Promise<readonly JobSchedule[]> {
    return this.scheduleStore.list(tenantId);
  }

  async disableSchedule(tenantId: string, scheduleId: string, caller: VerifiedPrincipal): Promise<JobSchedule | null> {
    const principal = requireVerifiedPrincipal(caller);
    const schedule = await this.scheduleStore.get(resolveTenant({ tenantId }, principal), scheduleId);
    if (!schedule || schedule.applicationId !== this.gateway().application) {
      return null;
    }

    return this.gateway().execute('schedules.cancel', principal, { type: 'schedule', tenantId, id: schedule.id, attributes: { jobType: schedule.type, createdBy: schedule.createdBy } }, { service: 'jobs' }, async () => {
      const updated = await this.scheduleStore.disable(tenantId, scheduleId, schedule.__version);
      if (updated) {
        await this.auditSink.record({
          id: randomUUID(),
          type: 'job.schedule.disabled',
          scheduleId: updated.id,
          tenantId: updated.tenantId,
          principalId: principal.principalId,
          timestamp: this.now().toISOString(),
          result: 'success',
        });
      }
      return updated;
    });
  }

  async retry(tenantId: string, jobId: string, caller: VerifiedPrincipal): Promise<Job | null> {
    const principal = requireVerifiedPrincipal(caller);
    const job = await this.jobStore.get(resolveTenant({ tenantId }, principal), jobId);
    if (!job || job.applicationId !== this.gateway().application) {
      return null;
    }
    return this.gateway().execute('jobs.retry', principal, { type: 'job', tenantId, id: job.id, attributes: { jobType: job.type } }, { service: 'jobs' }, () => this.resetJob(job, principal));
  }

  private async resetJob(job: Job, principal: VerifiedPrincipal): Promise<Job | null> {
    const { tenantId, id: jobId } = job;
    const now = this.now().toISOString();
    const updated = await this.jobStore.updateJob(tenantId, jobId, job.__version, {
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
        principalId: principal.principalId,
        timestamp: now,
        result: 'success',
      });
    }

    return updated;
  }

  /**
   * Run one job. The worker id is only a lease owner; the job runs as its
   * durable principal, and AuthBoundry is asked on every run, so a revoked
   * delegation stops the next run even across restarts.
   */
  async executeJob(tenantId: string, jobId: string, workerId: string): Promise<boolean> {
    const job = await this.jobStore.get(tenantId, jobId);
    if (!job) {
      return false;
    }

    if (job.status === 'running' && job.leaseOwner !== workerId) {
      return false;
    }

    const leaseExpiresAt = new Date(this.now().getTime() + this.leaseDurationMs).toISOString();

    const claimed = await this.jobStore.claim(tenantId, jobId, job.__version, leaseExpiresAt);
    if (!claimed) {
      return false;
    }

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

    const handler = this.handlers.get(claimed.type);
    if (!handler) {
      await this.jobStore.updateJob(tenantId, jobId, claimed.__version, {
        status: 'failed',
        lastError: `Handler not registered for type: ${claimed.type}`,
      });
      return false;
    }

    const runId = `${claimed.id}:${claimed.attemptCount + 1}`;
    const principal = mintVerifiedPrincipal({ ...claimed.principal, runId }, 'job');

    try {
      await this.gateway().execute('jobs.execute', principal,
        { type: 'job', tenantId, id: claimed.id, attributes: { jobType: claimed.type } },
        { service: 'jobs', requestId: runId },
        (context) => handler(claimed, { principal, context, runId }));

      const completedAt = this.now().toISOString();
      await this.jobStore.updateJob(tenantId, jobId, claimed.__version, {
        status: 'completed',
        completedAt,
      });

      await this.auditSink.record({
        id: randomUUID(),
        type: 'job.completed',
        jobId: claimed.id,
        tenantId: claimed.tenantId,
        principalId: principal.principalId,
        timestamp: completedAt,
        result: 'success',
        details: { runId },
      });

      return true;
    } catch (error) {
      if (isServiceAuthorityError(error) && (error.code === 'DENIED' || error.code === 'UNAUTHENTICATED')) {
        await this.deny(claimed, `DENIED: ${error.message}`);
        return false;
      }
      if (isServiceAuthorityError(error) && (error.code === 'AUTHORITY_UNAVAILABLE' || error.code === 'AUTHORIZATION_TIMEOUT')) {
        // Nothing ran. Retry later without consuming an attempt.
        await this.jobStore.updateJob(tenantId, jobId, claimed.__version, {
          status: 'retrying',
          nextAttemptAt: new Date(this.now().getTime() + INITIAL_RETRY_DELAY_MS).toISOString(),
          lastError: `${error.code}: ${error.message}`,
        });
        return false;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      const nextAttempt = claimed.attemptCount + 1;

      if (nextAttempt >= claimed.maxAttempts) {
        const failedAt = this.now().toISOString();
        await this.jobStore.updateJob(tenantId, jobId, claimed.__version, {
          status: 'failed',
          lastError: errorMessage,
          attemptCount: nextAttempt,
        });

        await this.auditSink.record({
          id: randomUUID(),
          type: 'job.failed',
          jobId: claimed.id,
          tenantId: claimed.tenantId,
          principalId: principal.principalId,
          timestamp: failedAt,
          result: 'failure',
          details: { error: errorMessage, attemptCount: nextAttempt },
        });
      } else {
        const nextAttemptAt = new Date(
          this.now().getTime() + INITIAL_RETRY_DELAY_MS * Math.pow(2, claimed.attemptCount),
        ).toISOString();

        await this.jobStore.updateJob(tenantId, jobId, claimed.__version, {
          status: 'retrying',
          nextAttemptAt,
          lastError: errorMessage,
          attemptCount: nextAttempt,
        });

        await this.auditSink.record({
          id: randomUUID(),
          type: 'job.retrying',
          jobId: claimed.id,
          tenantId: claimed.tenantId,
          principalId: principal.principalId,
          timestamp: this.now().toISOString(),
          result: 'failure',
          details: { error: errorMessage, nextAttemptAt, attemptCount: nextAttempt },
        });
      }

      return false;
    }
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

  private gateway(): ServiceGateway {
    if (!this.options.authority) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Jobs have no AuthBoundry authority configured');
    return this.options.authority;
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
      const updated = await this.scheduleStore.updateSchedule(
        tenantId,
        schedule.id,
        schedule.__version,
        { nextRunAt },
      );

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

  private nextRunTime(now: string, interval: string): string {
    const match = interval.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new InvalidIntervalError(interval);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    let delayMs = 0;
    switch (unit) {
      case 's':
        delayMs = value * 1000;
        break;
      case 'm':
        delayMs = value * 60 * 1000;
        break;
      case 'h':
        delayMs = value * 60 * 60 * 1000;
        break;
      case 'd':
        delayMs = value * 24 * 60 * 60 * 1000;
        break;
    }

    return new Date(new Date(now).getTime() + delayMs).toISOString();
  }
}
