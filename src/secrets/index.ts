export { SecretsService, InMemorySecretStore, InMemorySecretAuditSink, UnavailableSecretProvider } from './service.js';
export type { SecretStore, SecretAuditSink, SecretProvider, SecretsServiceOptions } from './service.js';
export type { Secret, SecretVersion, SecretMetadata, SecretStatus, SecretVersionStatus, SecretAuditEvent, SecretAuditEventType, RegisterSecretInput, RotateSecretInput, SecretOperationInput } from './models.js';
export {
  SecretError, SecretNotFoundError, SecretRevokedError, SecretExpiredError, SecretResolutionDeniedError,
  SecretProviderUnavailableError, InvalidSecretReferenceError, InvalidSecretLifecycleOperationError,
} from './errors.js';
