export type { SecretsProtocol, ScopedSecretsResolver } from './protocol.js';
export type { Secret, SecretVersion, SecretMetadata, SecretStatus, SecretVersionStatus, SecretAuditEvent, SecretAuditEventType, RegisterSecretInput, RotateSecretInput, SecretOperationInput, ResolveSecretInput, SecretReference, SecretResolutionContext, ScopedResolveSecretInput, ResolvedSecret, SecretResolutionFailureCode } from './models.js';
export {
  SecretError, SecretNotFoundError, SecretRevokedError, SecretExpiredError, SecretResolutionDeniedError,
  SecretProviderUnavailableError, InvalidSecretReferenceError, InvalidSecretLifecycleOperationError,
  SecretTenantMismatchError, SecretInactiveError, SecretProviderMismatchError, SecretUnavailableError, SecretInternalError,
} from './errors.js';
