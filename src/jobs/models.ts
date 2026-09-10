export type JobStatus = 'scheduled' | 'pending' | 'running' | 'retrying' | 'completed' | 'failed';

export interface Job {
  id: string;
  tenantId: string;

  type: string;
  payload: unknown;

  status: JobStatus;
  runAt: string;

  attemptCount: number;
  maxAttempts: number;

  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  nextAttemptAt?: string;

  leaseOwner?: string;
  leaseExpiresAt?: string;

  lastError?: string;

  __version: number;
}

export interface JobSchedule {
  id: string;
  tenantId: string;

  type: string;
  payload: unknown;

  interval: string;
  nextRunAt: string;

  enabled: boolean;

  createdAt: string;
  createdBy: string;

  __version: number;
}

export interface JobAuditEvent {
  id: string;
  type: string;
  jobId?: string;
  scheduleId?: string;
  tenantId: string;
  principalId: string;
  timestamp: string;
  result: 'success' | 'failure';
  details?: Record<string, unknown>;
}

export interface CreateJobInput {
  tenantId: string;
  type: string;
  payload: unknown;
  runAt?: string;
  maxAttempts?: number;
}

export interface ScheduleRecurringInput {
  tenantId: string;
  type: string;
  payload: unknown;
  interval: string;
  createdBy: string;
}

export interface JobHandlerResult {
  success: boolean;
  error?: string;
}
