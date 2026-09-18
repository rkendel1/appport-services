import type {
  RegisterSecretInput,
  ResolveSecretInput,
  RotateSecretInput,
  SecretMetadata,
  SecretOperationInput,
  ResolvedSecret,
  ScopedResolveSecretInput,
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

/**
 * Preferred server-execution contract for temporary secret access.
 *
 * AppPort declares this protocol only. AuthBoundry supplies the access decision;
 * AppBoundry implements provider resolution and invokes the callback.
 */
export interface ScopedSecretsResolver<TSecret = unknown> {
  withSecret<TResult>(
    input: ScopedResolveSecretInput,
    use: (secret: ResolvedSecret<TSecret>) => TResult | Promise<TResult>,
  ): Promise<TResult>;
}
