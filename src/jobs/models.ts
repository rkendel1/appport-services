import type { DurablePrincipal } from '../authority/principal.js';

export type { DurablePrincipal };

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

  /**
   * Durable execution identity captured from the authorized enqueue. The
   * worker process is never the authority; every run is authorized as this
   * principal (and its delegation) at execution time.
   */
  principal?: DurablePrincipal;

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

  /** Durable execution identity inherited by every job the schedule creates. */
  principal?: DurablePrincipal;

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
  /** Optional; must equal the caller's tenant. */
  tenantId?: string;
  type: string;
  payload: unknown;
  runAt?: string;
  maxAttempts?: number;
  /**
   * AuthBoundry delegation the job runs under. Not authority by itself:
   * AuthBoundry checks it on every execution, so revoking it stops future runs.
   */
  delegationId?: string;
}

export interface ScheduleRecurringInput {
  tenantId?: string;
  type: string;
  payload: unknown;
  interval: string;
  delegationId?: string;
  /** @deprecated Must equal the verified caller when supplied. */
  createdBy?: string;
}

export interface JobHandlerResult {
  success: boolean;
  error?: string;
}
