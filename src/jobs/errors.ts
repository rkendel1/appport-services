export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Job not found: ${jobId}`);
    this.name = 'JobNotFoundError';
  }
}

export class JobClaimFailedError extends Error {
  constructor(jobId: string, reason: string) {
    super(`Failed to claim job ${jobId}: ${reason}`);
    this.name = 'JobClaimFailedError';
  }
}

export class HandlerNotRegisteredError extends Error {
  constructor(jobType: string) {
    super(`Handler not registered for job type: ${jobType}`);
    this.name = 'HandlerNotRegisteredError';
  }
}

export class InvalidIntervalError extends Error {
  constructor(interval: string) {
    super(`Invalid interval format: ${interval}`);
    this.name = 'InvalidIntervalError';
  }
}

/**
 * Thrown by a job handler for a failure that retrying cannot fix: the job is
 * marked failed at once instead of being retried until its attempts run out.
 * A handler error whose `code` is `FORBIDDEN` (or whose `status` is 403) is
 * treated the same way.
 */
export class JobTerminalError extends Error {
  readonly terminal = true;
  constructor(message: string, readonly code: string = 'TERMINAL') {
    super(message);
    this.name = 'JobTerminalError';
  }
}
