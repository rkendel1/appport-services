import type {
  RegisterSecretInput,
  ResolveSecretInput,
  RotateSecretInput,
  SecretMetadata,
  SecretOperationInput,
} from './models.js';

/**
 * Provider- and authorization-neutral Secrets capability.
 *
 * Implementing boundaries supply storage, authorization, and provider
 * execution. This package only defines the operation contract.
 */
export interface SecretsProtocol {
  registerSecret(input: RegisterSecretInput): Promise<SecretMetadata>;
  describeSecret(input: SecretOperationInput): Promise<SecretMetadata | null>;
  listSecrets(tenantId: string): Promise<readonly SecretMetadata[]>;
  resolveSecret(input: ResolveSecretInput): Promise<unknown>;
  rotateSecret(input: RotateSecretInput): Promise<SecretMetadata>;
  revokeSecret(input: SecretOperationInput): Promise<SecretMetadata>;
  retireSecret(input: SecretOperationInput): Promise<SecretMetadata>;
}
