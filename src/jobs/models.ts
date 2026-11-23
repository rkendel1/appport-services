import type { DurablePrincipal } from '../authority/principal.js';

export type { DurablePrincipal };

export type JobStatus = 'scheduled' | 'pending' | 'running' | 'retrying' | 'completed' | 'failed';

export interface Job {
  id: string;
  tenantId: string;
  /** Owning application. */
  applicationId?: string;

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

  /**
   * Who the job runs as. Absent or `creator`: as `principal` (the enqueuer),
   * re-authorized on every run. `service`: as the application's service
   * principal; `principal` then records who enqueued it (and is attested), and
   * the run does not depend on the enqueuer's session.
   */
  runAs?: JobRunAs;

  /** The enqueuer's idempotency key (see `CreateJobInput.idempotencyKey`). */
  idempotencyKey?: string;
  /** Digest of the enqueue input, compared when the key is used again. */
  inputHash?: string;

  /**
   * Why the job was refused, when it was: a run that AuthBoundry (or the
   * job's attestation) refused, or a handler's terminal error. The job is
   * `failed`; this says it was a refusal, by whom and why. Never retried.
   */
  refusal?: JobRefusal;

  __version: number;
}

export interface JobRefusal {
  /** `DENIED`, `UNAUTHENTICATED`, `INVALID_REQUEST`, or a handler's terminal code (`FORBIDDEN`, ...). */
  readonly code: string;
  /** The capability refused, when an authorization refused it (`jobs.execute`, ...). */
  readonly capability?: string;
  /** The authorizer's (or attestation's) reason, e.g. `no_session`, `unattested_principal`. */
  readonly reason?: string;
  readonly decisionId?: string;
  /** The principal the run was refused for (the service principal for a service-run job). */
  readonly principalId: string;
  readonly message: string;
  readonly refusedAt: string;
}

/** See `Job.runAs`. */
export type JobRunAs = 'creator' | 'service';

export interface JobSchedule {
  id: string;
  tenantId: string;
  applicationId?: string;

  type: string;
  payload: unknown;

  interval: string;
  nextRunAt: string;

  enabled: boolean;

  createdAt: string;
  createdBy: string;

  /** Durable execution identity inherited by every job the schedule creates. */
  principal?: DurablePrincipal;

  /** Inherited by every job the schedule creates (see `Job.runAs`). */
  runAs?: JobRunAs;

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
  /** The job's type, on the record a transaction writes (`job.enqueued`, TransactionContext.queueJob). */
  jobType?: string;
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
  /**
   * `creator` (default): the job runs as the enqueuing principal, authorized
   * again on every run. `service`: it runs as the application's service
   * principal (`createServices({ servicePrincipal })`); enqueuing it needs
   * `jobs.create.service`.
   */
  runAs?: JobRunAs;
  /**
   * Idempotent enqueue: scoped to the tenant, application and job type. The
   * same key with the same input returns the original job (no second job);
   * with different input it is refused (`CONFLICT`, reason
   * `idempotency_conflict`). 1–200 characters.
   */
  idempotencyKey?: string;
}

export interface ScheduleRecurringInput {
  tenantId?: string;
  type: string;
  payload: unknown;
  interval: string;
  delegationId?: string;
  /** @deprecated Must equal the verified caller when supplied. */
  createdBy?: string;
  /** See `CreateJobInput.runAs`; creating a service schedule needs `schedules.create.service`. */
  runAs?: JobRunAs;
}

export interface JobHandlerResult {
  success: boolean;
  error?: string;
}
