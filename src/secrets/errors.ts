export class SecretError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SecretError';
  }
}

export class SecretNotFoundError extends SecretError {
  constructor(secretId: string) { super(`Secret not found: ${secretId}`, 'secret_not_found'); this.name = 'SecretNotFoundError'; }
}
export class SecretRevokedError extends SecretError {
  constructor(secretId: string) { super(`Secret is revoked: ${secretId}`, 'secret_revoked'); this.name = 'SecretRevokedError'; }
}
export class SecretExpiredError extends SecretError {
  constructor(secretId: string) { super(`Secret is expired: ${secretId}`, 'secret_expired'); this.name = 'SecretExpiredError'; }
}
export class SecretResolutionDeniedError extends SecretError {
  constructor(secretId: string) { super(`Secret resolution denied: ${secretId}`, 'secret_resolution_denied'); this.name = 'SecretResolutionDeniedError'; }
}
export class SecretProviderUnavailableError extends SecretError {
  constructor(providerRef: string) { super(`Secret provider unavailable: ${providerRef}`, 'secret_provider_unavailable'); this.name = 'SecretProviderUnavailableError'; }
}
export class InvalidSecretReferenceError extends SecretError {
  constructor() { super('Secret provider reference is invalid', 'invalid_secret_reference'); this.name = 'InvalidSecretReferenceError'; }
}
export class InvalidSecretLifecycleOperationError extends SecretError {
  constructor(message: string) { super(message, 'invalid_secret_lifecycle_operation'); this.name = 'InvalidSecretLifecycleOperationError'; }
}
export class SecretTenantMismatchError extends SecretError {
  constructor(secretId: string) { super(`Secret tenant mismatch: ${secretId}`, 'tenant_mismatch'); this.name = 'SecretTenantMismatchError'; }
}
export class SecretInactiveError extends SecretError {
  constructor(secretId: string) { super(`Secret is inactive: ${secretId}`, 'secret_inactive'); this.name = 'SecretInactiveError'; }
}
export class SecretProviderMismatchError extends SecretError {
  constructor(secretId: string) { super(`Secret provider mismatch: ${secretId}`, 'provider_mismatch'); this.name = 'SecretProviderMismatchError'; }
}
export class SecretUnavailableError extends SecretError {
  constructor(secretId: string) { super(`Secret material is unavailable: ${secretId}`, 'secret_unavailable'); this.name = 'SecretUnavailableError'; }
}
export class SecretInternalError extends SecretError {
  constructor(secretId: string) { super(`Secret resolution failed internally: ${secretId}`, 'internal_error'); this.name = 'SecretInternalError'; }
}
