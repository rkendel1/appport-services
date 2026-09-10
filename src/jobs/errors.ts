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
