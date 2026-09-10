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
}

type JobHandler = (job: Job) => Promise<void>;

export class JobService {
  private readonly jobStore: JobStore;
  private readonly scheduleStore: JobScheduleStore;
  private readonly auditSink: JobAuditSink;
  private readonly now: () => Date;
  private readonly maxRetryAttempts: number;
  private readonly leaseDurationMs: number;
  private readonly handlers = new Map<string, JobHandler>();

  constructor(options: JobServiceOptions) {
    this.jobStore = options.jobStore;
    this.scheduleStore = options.scheduleStore;
    this.auditSink = options.auditSink;
    this.now = options.now ?? (() => new Date());
    this.maxRetryAttempts = options.maxRetryAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.leaseDurationMs = options.leaseDurationMs ?? LEASE_DURATION_MS;
  }

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  async enqueue(input: CreateJobInput): Promise<Job> {
    const id = randomUUID();
    const now = this.now().toISOString();
    const runAt = input.runAt ?? now;

    const status = runAt <= now ? 'pending' : 'scheduled';

    const job: Job = {
      id,
      tenantId: input.tenantId,
      type: input.type,
      payload: input.payload,
      status,
      runAt,
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      createdAt: now,
      __version: 1,
    };

    await this.jobStore.create(job);

    await this.auditSink.record({
      id: randomUUID(),
      type: 'job.created',
      jobId: job.id,
      tenantId: job.tenantId,
      principalId: 'system',
      timestamp: now,
      result: 'success',
      details: { jobType: job.type },
    });

    return job;
  }

  async schedule(input: CreateJobInput): Promise<Job> {
    if (!input.runAt) {
      throw new Error('schedule() requires runAt');
    }
    return this.enqueue(input);
  }

  async scheduleRecurring(input: ScheduleRecurringInput): Promise<JobSchedule> {
    const id = randomUUID();
    const now = this.now().toISOString();
    const nextRunAt = this.nextRunTime(now, input.interval);

    const schedule: JobSchedule = {
      id,
      tenantId: input.tenantId,
      type: input.type,
      payload: input.payload,
      interval: input.interval,
      nextRunAt,
      enabled: true,
      createdAt: now,
      createdBy: input.createdBy,
      __version: 1,
    };

    await this.scheduleStore.create(schedule);

    await this.auditSink.record({
      id: randomUUID(),
      type: 'job.schedule.created',
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      principalId: input.createdBy,
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

  async disableSchedule(tenantId: string, scheduleId: string): Promise<JobSchedule | null> {
    const schedule = await this.scheduleStore.get(tenantId, scheduleId);
    if (!schedule) {
      return null;
    }

    const updated = await this.scheduleStore.disable(tenantId, scheduleId, schedule.__version);
    if (updated) {
      await this.auditSink.record({
        id: randomUUID(),
        type: 'job.schedule.disabled',
        scheduleId: updated.id,
        tenantId: updated.tenantId,
        principalId: 'system',
        timestamp: this.now().toISOString(),
        result: 'success',
      });
    }

    return updated;
  }

  async retry(tenantId: string, jobId: string): Promise<Job | null> {
    const job = await this.jobStore.get(tenantId, jobId);
    if (!job) {
      return null;
    }

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
        principalId: 'system',
        timestamp: now,
        result: 'success',
      });
    }

    return updated;
  }

  async executeJob(tenantId: string, jobId: string, workerId: string): Promise<boolean> {
    const job = await this.jobStore.get(tenantId, jobId);
    if (!job) {
      return false;
    }

    if (job.status === 'running' && job.leaseOwner !== workerId) {
      return false;
    }

    const now = this.now().toISOString();
    const leaseExpiresAt = new Date(this.now().getTime() + this.leaseDurationMs).toISOString();

    const claimed = await this.jobStore.claim(tenantId, jobId, job.__version, leaseExpiresAt);
    if (!claimed) {
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

    try {
      await handler(claimed);

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
        principalId: 'system',
        timestamp: completedAt,
        result: 'success',
      });

      return true;
    } catch (error) {
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
          principalId: 'system',
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
          principalId: 'system',
          timestamp: this.now().toISOString(),
          result: 'failure',
          details: { error: errorMessage, nextAttemptAt, attemptCount: nextAttempt },
        });
      }

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
        type: schedule.type,
        payload: schedule.payload,
        status: 'pending',
        runAt: now,
        attemptCount: 0,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        createdAt: now,
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
          principalId: 'system',
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
