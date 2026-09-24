/**
 * Failure semantics for the service Policy Enforcement Point.
 *
 * Each code is distinct so callers can tell an authorization outcome from a
 * provider outcome. A provider failure is never reported as DENIED, and a
 * denial never reaches the provider.
 */
export type ServiceFailureCode =
  | 'DENIED'
  | 'AUTHORITY_UNAVAILABLE'
  | 'AUTHORIZATION_TIMEOUT'
  | 'INVALID_REQUEST'
  | 'PROVIDER_ERROR'
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND';

const STATUS: Readonly<Record<ServiceFailureCode, number>> = {
  DENIED: 403,
  AUTHORITY_UNAVAILABLE: 503,
  AUTHORIZATION_TIMEOUT: 504,
  INVALID_REQUEST: 400,
  PROVIDER_ERROR: 502,
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
};

export class ServiceAuthorityError extends Error {
  readonly status: number;

  constructor(
    readonly code: ServiceFailureCode,
    message: string,
    readonly details: { readonly capability?: string; readonly decisionId?: string; readonly reason?: string } = {},
  ) {
    super(message);
    this.name = 'ServiceAuthorityError';
    this.status = STATUS[code];
  }
}

/** Raised for authorization patterns that were valid before the authority migration. */
export class ServiceMigrationError extends ServiceAuthorityError {
  constructor(message: string) {
    super('INVALID_REQUEST', `${message} See docs/AUTHORITY.md#migration.`);
    this.name = 'ServiceMigrationError';
  }
}

export function denied(message: string, details: ServiceAuthorityError['details'] = {}): ServiceAuthorityError {
  return new ServiceAuthorityError('DENIED', message, details);
}

export function invalidRequest(message: string): ServiceAuthorityError {
  return new ServiceAuthorityError('INVALID_REQUEST', message);
}

export function isServiceAuthorityError(error: unknown): error is ServiceAuthorityError {
  return error instanceof ServiceAuthorityError;
}
