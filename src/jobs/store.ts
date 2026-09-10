import type {
  Job,
  JobSchedule,
  JobAuditEvent,
} from './models.js';
import type { StateFirstDB } from '@feltdb/core';

const JOBS_COLLECTION = 'jobs';
const JOB_SCHEDULES_COLLECTION = 'job_schedules';
const JOB_AUDIT_COLLECTION = 'job_audit_events';

export interface JobStore {
  create(job: Job): Promise<void>;
  get(tenantId: string, id: string): Promise<Job | null>;
  list(tenantId: string): Promise<readonly Job[]>;
  listByStatus(tenantId: string, status: string): Promise<readonly Job[]>;
  listDue(tenantId: string, now: string): Promise<readonly Job[]>;
  claim(tenantId: string, jobId: string, expectedVersion: number, leaseExpiresAt: string): Promise<Job | null>;
  updateJob(tenantId: string, jobId: string, expectedVersion: number, updates: Partial<Job>): Promise<Job | null>;
}

export interface JobScheduleStore {
  create(schedule: JobSchedule): Promise<void>;
  get(tenantId: string, id: string): Promise<JobSchedule | null>;
  list(tenantId: string): Promise<readonly JobSchedule[]>;
  listDue(tenantId: string, now: string): Promise<readonly JobSchedule[]>;
  updateSchedule(tenantId: string, scheduleId: string, expectedVersion: number, updates: Partial<JobSchedule>): Promise<JobSchedule | null>;
  disable(tenantId: string, scheduleId: string, expectedVersion: number): Promise<JobSchedule | null>;
}

export interface JobAuditSink {
  record(event: JobAuditEvent): Promise<void>;
}

export class FeltDbJobStore implements JobStore {
  private readonly jobs;

  constructor(private readonly db: StateFirstDB) {
    this.jobs = db.collection<Job>(JOBS_COLLECTION);
  }

  async create(job: Job): Promise<void> {
    await this.db.transaction({
      operations: [
        {
          collection: JOBS_COLLECTION,
          id: job.id,
          requireAbsent: true,
          value: { ...job },
        },
      ],
    });
  }

  async get(tenantId: string, id: string): Promise<Job | null> {
    const job = await this.jobs.get(id);
    if (!job || job.tenantId !== tenantId) {
      return null;
    }
    return job;
  }

  async list(tenantId: string): Promise<readonly Job[]> {
    return this.jobs.find({ tenantId });
  }

  async listByStatus(tenantId: string, status: string): Promise<readonly Job[]> {
    return this.jobs.find({ tenantId, status } as Record<string, unknown>);
  }

  async listDue(tenantId: string, now: string): Promise<readonly Job[]> {
    const all = await this.jobs.find({ tenantId });
    return all.filter((job) => {
      const isDue =
        job.status === 'pending' && job.runAt <= now ||
        job.status === 'retrying' && job.nextAttemptAt && job.nextAttemptAt <= now;
      const isStale = job.status === 'running' && job.leaseExpiresAt && job.leaseExpiresAt <= now;
      return isDue || isStale;
    });
  }

  async claim(tenantId: string, jobId: string, expectedVersion: number, leaseExpiresAt: string): Promise<Job | null> {
    const now = new Date().toISOString();
    const result = await this.jobs.updateIfVersion(jobId, expectedVersion, {
      status: 'running',
      leaseExpiresAt,
      startedAt: now,
    });

    if (!result.updated || !result.item) {
      return null;
    }

    if (result.item.tenantId !== tenantId) {
      return null;
    }

    return result.item;
  }

  async updateJob(tenantId: string, jobId: string, expectedVersion: number, updates: Partial<Job>): Promise<Job | null> {
    const result = await this.jobs.updateIfVersion(jobId, expectedVersion, updates);

    if (!result.updated || !result.item) {
      return null;
    }

    if (result.item.tenantId !== tenantId) {
      return null;
    }

    return result.item;
  }
}

export class FeltDbJobScheduleStore implements JobScheduleStore {
  private readonly schedules;

  constructor(private readonly db: StateFirstDB) {
    this.schedules = db.collection<JobSchedule>(JOB_SCHEDULES_COLLECTION);
  }

  async create(schedule: JobSchedule): Promise<void> {
    await this.db.transaction({
      operations: [
        {
          collection: JOB_SCHEDULES_COLLECTION,
          id: schedule.id,
          requireAbsent: true,
          value: { ...schedule },
        },
      ],
    });
  }

  async get(tenantId: string, id: string): Promise<JobSchedule | null> {
    const schedule = await this.schedules.get(id);
    if (!schedule || schedule.tenantId !== tenantId) {
      return null;
    }
    return schedule;
  }

  async list(tenantId: string): Promise<readonly JobSchedule[]> {
    return this.schedules.find({ tenantId });
  }

  async listDue(tenantId: string, now: string): Promise<readonly JobSchedule[]> {
    const all = await this.schedules.find({ tenantId, enabled: true });
    return all.filter((schedule) => schedule.nextRunAt <= now);
  }

  async updateSchedule(tenantId: string, scheduleId: string, expectedVersion: number, updates: Partial<JobSchedule>): Promise<JobSchedule | null> {
    const result = await this.schedules.updateIfVersion(scheduleId, expectedVersion, updates);

    if (!result.updated || !result.item) {
      return null;
    }

    if (result.item.tenantId !== tenantId) {
      return null;
    }

    return result.item;
  }

  async disable(tenantId: string, scheduleId: string, expectedVersion: number): Promise<JobSchedule | null> {
    return this.updateSchedule(tenantId, scheduleId, expectedVersion, { enabled: false });
  }
}

export class FeltDbJobAuditSink implements JobAuditSink {
  private readonly auditCollection;

  constructor(db: StateFirstDB) {
    this.auditCollection = db.collection<JobAuditEvent>(JOB_AUDIT_COLLECTION);
  }

  async record(event: JobAuditEvent): Promise<void> {
    await this.auditCollection.insert({ ...event }, event.id);
  }
}

export const jobAuditCollectionName = JOB_AUDIT_COLLECTION;
