import { createHash, randomUUID } from 'node:crypto';
import type {
  Job,
  JobRefusal,
  JobRunAs,
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
  /**
   * Who this run acts as: the job's durable principal (with delegation and run
   * id), or, for a job enqueued with `runAs: "service"`, the application's
   * service principal (its `enqueuedBy` names the enqueuer).
   */
  readonly principal: VerifiedPrincipal;
  /** `creator` or `service` (see `Job.runAs`). */
  readonly runAs: JobRunAs;
  /** The principal that enqueued the job (or created its schedule). */
  readonly enqueuedBy?: string;
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
    if (!this.options.authority) {
      if (input.runAs === 'service') throw new Error('runAs "service" needs an AuthBoundry authority and a service principal');
      return this.createJobRecord(input, 'system');
    }
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor(input, principal);
    const tenantId = resolveTenant(input, principal);
    if (this.runAsOf(input) === 'service') {
      this.gateway().servicePrincipal(tenantId);
      return this.gateway().execute('jobs.create.service', principal, { type: 'job', tenantId, attributes: { jobType: input.type, runAs: 'service' } }, { service: 'jobs' },
        (context) => this.createJobRecord({ ...input, tenantId, runAs: 'service' }, principal.principalId, this.gateway().application, principal, context.authorization.decisionId));
    }
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
    if (!this.options.authority) {
      if (input.runAs === 'service') throw new Error('runAs "service" needs an AuthBoundry authority and a service principal');
      return this.createScheduleRecord(input, input.createdBy ?? 'system');
    }
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor(input, principal);
    const tenantId = resolveTenant(input, principal);
    if (this.runAsOf(input) === 'service') {
      this.gateway().servicePrincipal(tenantId);
      return this.gateway().execute('schedules.create.service', principal, { type: 'schedule', tenantId, attributes: { jobType: input.type, runAs: 'service' } }, { service: 'jobs' },
        (context) => this.createScheduleRecord({ ...input, tenantId, runAs: 'service' }, principal.principalId, this.gateway().application, principal, context.authorization.decisionId));
    }
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
    let job = await this.jobStore.get(tenantId, jobId);
    if (!job) return false;
    const nowIso = this.now().toISOString();
    // A running job is held by its lease. Once the lease has expired, the attempt was abandoned (its worker
    // stopped before settling it): any worker may take the job over. The abandoned attempt counts, so a job
    // that stops its worker every time fails after maxAttempts instead of running forever.
    const abandoned = job.status === 'running' && Boolean(job.leaseExpiresAt) && job.leaseExpiresAt! <= nowIso;
    if (job.status === 'running' && !abandoned && job.leaseOwner !== workerId) return false;
    if (abandoned) {
      const attemptCount = job.attemptCount + 1;
      const lastError = `lease expired before attempt ${attemptCount} settled; it may have partly run`;
      if (attemptCount >= job.maxAttempts) {
        const failed = await this.jobStore.updateJob(tenantId, jobId, job.__version, { status: 'failed', attemptCount, lastError });
        if (failed) {
          await this.auditSink.record({
            id: randomUUID(), type: 'job.failed', jobId, tenantId, principalId: job.principal?.principalId ?? 'system',
            timestamp: nowIso, result: 'failure', details: { error: lastError, attemptCount },
          });
        }
        return false;
      }
      const counted = await this.jobStore.updateJob(tenantId, jobId, job.__version, { attemptCount, lastError });
      if (!counted) return false;
      job = counted;
    }

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

    // A service-run job must have been created by a service-run enqueue (or schedule): a creator-scoped
    // record changed to runAs "service" later does not attest.
    const runAs: JobRunAs = claimed.runAs === 'service' ? 'service' : 'creator';
    try {
      await this.gateway().attest(claimed.principal, runAs === 'service' ? ['jobs.create.service', 'schedules.create.service'] : ['jobs.create', 'schedules.create']);
    } catch (error) {
      await this.deny(claimed, `DENIED: ${error instanceof Error ? error.message : String(error)}`, error);
      return false;
    }

    const runId = `${claimed.id}:${claimed.attemptCount + 1}`;
    let principal: VerifiedPrincipal;
    try {
      principal = runAs === 'service'
        ? this.gateway().servicePrincipal(tenantId, { runId, enqueuedBy: claimed.principal.principalId })
        : mintVerifiedPrincipal({ ...claimed.principal, runId }, 'job');
    } catch (error) {
      await this.deny(claimed, `DENIED: ${error instanceof Error ? error.message : String(error)}`, error);
      return false;
    }

    try {
      await this.gateway().execute('jobs.execute', principal,
        { type: 'job', tenantId, id: claimed.id, attributes: { jobType: claimed.type, ...(runAs === 'service' ? { runAs, enqueuedBy: claimed.principal.principalId } : {}) } },
        { service: 'jobs', requestId: runId },
        (context) => handler(claimed, { principal, context, runId, runAs, enqueuedBy: claimed.principal!.principalId }));
      // Completed only if this worker still holds the job (its claim's version); otherwise not a success.
      return await this.completeJob(claimed, principal.principalId, runId);
    } catch (error) {
      if (isServiceAuthorityError(error) && (error.code === 'DENIED' || error.code === 'UNAUTHENTICATED')) {
        // The authorizer's reason is part of the message ("AuthBoundry denied jobs.execute (no_session)") and the audit.
        await this.deny(claimed, `DENIED: ${error.message}`, error, principal.principalId);
        return false;
      }
      if (isTerminalHandlerError(error)) {
        await this.deny(claimed, `${terminalCode(error)}: ${error instanceof Error ? error.message : String(error)}`, error, principal.principalId);
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
      // One job per schedule tick, whoever processes it: its id is derived from the schedule and the tick it is for,
      // and a job record is created only when absent. Two processors (or a retry after a crash between the job and the
      // schedule's advance) converge on the same job instead of creating one each.
      const jobId = tickJobId(schedule.tenantId, schedule.id, schedule.nextRunAt);
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
        ...(schedule.runAs === 'service' ? { runAs: 'service' as const } : {}),
        __version: 1,
      };

      let mine = false;
      if (!(await this.jobStore.get(schedule.tenantId, jobId))) {
        try {
          await this.jobStore.create(job);
          mine = true;
        } catch (error) {
          // Another processor created it between the read and the create: the tick has its job.
          if (!(await this.jobStore.get(schedule.tenantId, jobId))) throw error;
        }
      }

      const nextRunAt = this.nextRunTime(now, schedule.interval);
      // The schedule's own tenant (it is the schedule being advanced), at the version that was read.
      await this.scheduleStore.updateSchedule(schedule.tenantId, schedule.id, schedule.__version, { nextRunAt });
      if (mine) {
        created++;
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
    const key = idempotencyKeyOf(input.idempotencyKey);
    const id = key ? idempotentJobId(input.tenantId!, applicationId ?? '', input.type, key) : randomUUID();
    const inputHash = key ? enqueueDigest(input) : undefined;
    const now = this.now().toISOString();
    const runAt = input.runAt ?? now;
    const status = runAt <= now ? 'pending' : 'scheduled';
    if (key) {
      const existing = await this.jobStore.get(input.tenantId!, id);
      if (existing) return this.sameEnqueue(existing, inputHash!, key);
    }
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
      ...(principal && authorizedBy ? { principal: toDurablePrincipal(principal, input.runAs === 'service' ? undefined : input.delegationId ?? principal.delegationId, authorizedBy) } : {}),
      ...(input.runAs === 'service' ? { runAs: 'service' as const } : {}),
      ...(key ? { idempotencyKey: key, inputHash } : {}),
      __version: 1,
    };
    try {
      await this.jobStore.create(job);
    } catch (error) {
      // A concurrent enqueue with the same key won the conditional create (requireAbsent): answer with its job.
      const winner = key ? await this.jobStore.get(input.tenantId!, id) : null;
      if (!winner) throw error;
      return this.sameEnqueue(winner, inputHash!, key!);
    }
    await this.auditSink.record({
      id: randomUUID(),
      type: 'job.created',
      jobId: job.id,
      tenantId: job.tenantId,
      principalId,
      timestamp: now,
      result: 'success',
      details: { jobType: job.type, ...(job.runAs === 'service' ? { runAs: 'service' } : {}) },
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
      ...(principal && authorizedBy ? { principal: toDurablePrincipal(principal, input.runAs === 'service' ? undefined : input.delegationId ?? principal.delegationId, authorizedBy) } : {}),
      ...(input.runAs === 'service' ? { runAs: 'service' as const } : {}),
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
      refusal: undefined,
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
      return await this.completeJob(job, job.principal?.principalId ?? 'system');
    } catch (error) {
      await this.recordExecutionFailure(job, job.principal?.principalId ?? 'system', error);
      return false;
    }
  }

  /**
   * Record a completion, only when this worker still holds the job at the version it claimed. A worker whose claim was lost
   * (the job was handed out again, or changed) records that, not a success, and reports false.
   */
  private async completeJob(job: Job, principalId: string, runId?: string): Promise<boolean> {
    const completedAt = this.now().toISOString();
    const updated = await this.jobStore.updateJob(job.tenantId, job.id, job.__version, { status: 'completed', completedAt });
    if (!updated) {
      await this.auditSink.record({
        id: randomUUID(),
        type: 'job.completion_conflict',
        jobId: job.id,
        tenantId: job.tenantId,
        principalId,
        timestamp: completedAt,
        result: 'failure',
        details: { reason: 'the job changed after this worker claimed it; its completion was not recorded', claimedVersion: job.__version, ...(runId ? { runId } : {}) },
      });
      return false;
    }
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
    return true;
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

  /** Fail the job without retrying: a refusal (or a handler's terminal error) does not change by trying again. */
  private async deny(job: Job, reason: string, error?: unknown, principalId?: string): Promise<void> {
    const details = isServiceAuthorityError(error) ? error.details : undefined;
    const refusal: JobRefusal = {
      code: isServiceAuthorityError(error) ? error.code : isTerminalHandlerError(error) ? terminalCode(error) : reason.split(':')[0] || 'DENIED',
      ...(details?.capability ? { capability: details.capability } : {}),
      ...(details?.reason ? { reason: details.reason } : {}),
      ...(details?.decisionId ? { decisionId: details.decisionId } : {}),
      principalId: details?.principalId ?? principalId ?? job.principal?.principalId ?? 'anonymous',
      message: reason,
      refusedAt: this.now().toISOString(),
    };
    await this.jobStore.updateJob(job.tenantId, job.id, job.__version, { status: 'failed', lastError: reason, refusal });
    await this.auditSink.record({
      id: randomUUID(),
      type: 'job.denied',
      jobId: job.id,
      tenantId: job.tenantId,
      principalId: job.principal?.principalId ?? 'anonymous',
      timestamp: this.now().toISOString(),
      result: 'failure',
      details: {
        reason,
        ...(isServiceAuthorityError(error) ? { code: error.code } : isTerminalHandlerError(error) ? { code: terminalCode(error) } : {}),
        ...(details?.reason ? { authorizerReason: details.reason } : {}),
        ...(details?.decisionId ? { decisionId: details.decisionId } : {}),
        ...(job.runAs === 'service' ? { runAs: 'service' } : {}),
      },
    });
  }

  /** The original job for a repeated idempotent enqueue, or CONFLICT when the input differs. */
  private sameEnqueue(existing: Job, inputHash: string, key: string): Job {
    if (existing.idempotencyKey === key && existing.inputHash === inputHash) return existing;
    throw new ServiceAuthorityError('CONFLICT', `Idempotency key "${key}" was already used for a different ${existing.type} job`, { capability: 'jobs.create', reason: 'idempotency_conflict' });
  }

  private runAsOf(input: { readonly runAs?: unknown; readonly delegationId?: unknown }): JobRunAs {
    if (input.runAs === undefined || input.runAs === 'creator') return 'creator';
    if (input.runAs !== 'service') throw new ServiceAuthorityError('INVALID_REQUEST', 'runAs must be "creator" or "service"');
    if (input.delegationId !== undefined) throw new ServiceAuthorityError('INVALID_REQUEST', 'delegationId does not apply to a job that runs as the service principal');
    return 'service';
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

/** A handler failure that retrying cannot fix: `JobTerminalError`, or an error coded FORBIDDEN / status 403. */
function isTerminalHandlerError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || isServiceAuthorityError(error)) return false;
  const candidate = error as { terminal?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
  return candidate.terminal === true || candidate.code === 'FORBIDDEN' || candidate.status === 403 || candidate.statusCode === 403;
}

function terminalCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'FORBIDDEN';
}

function assertApplicationJobType(type: string): void {
  if (type.startsWith(SYSTEM_JOB_TYPE_PREFIX)) throw new Error(`Job type "${type}" is reserved for AppPort Services`);
}

function idempotencyKeyOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || /[\u0000-\u001f]/.test(value)) {
    throw new ServiceAuthorityError('INVALID_REQUEST', 'idempotencyKey must be 1 to 200 printable characters');
  }
  return value;
}

/** Same scope (tenant, application, job type, key) → same job id: the store's conditional create makes the enqueue idempotent. */
export function idempotentJobId(tenantId: string, applicationId: string, type: string, key: string): string {
  return uuidFrom(`idempotent\u0000${tenantId}\u0000${applicationId}\u0000${type}\u0000${key}`);
}

function enqueueDigest(input: CreateJobInput): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical({
    type: input.type, payload: input.payload ?? null, runAt: input.runAt ?? null, maxAttempts: input.maxAttempts ?? null,
    runAs: input.runAs === 'service' ? 'service' : 'creator', delegationId: input.delegationId ?? null,
  }))).digest('hex');
}

function uuidFrom(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The job id for one tick of a schedule: the same for every processor, UUID-shaped (name-based, SHA-256). */
function tickJobId(tenantId: string, scheduleId: string, tick: string): string {
  const h = createHash('sha256').update(`${tenantId}\u0000${scheduleId}\u0000${tick}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
