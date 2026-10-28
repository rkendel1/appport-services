import type {
  RegisterSecretInput,
  ResolveSecretInput,
  RotateSecretInput,
  SecretMetadata,
  SecretOperationInput,
  ResolvedSecret,
  ScopedResolveSecretInput,
  SecretReference,
  SecretResolutionContext,
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

/**
 * The context a custody call carries: who asked, for which tenant, why, and
 * the AuthBoundry decision that allowed it. The same shape `withSecret` takes.
 */
export type SecretAccessContext = SecretResolutionContext;

/** What `SecretCustody.store` returns. Never the value. */
export interface SecretCustodyWriteResult {
  /** The version the host assigned to the stored material (increments on every store of the same reference). */
  readonly version: number;
  /** ISO 8601 time the host stored it. */
  readonly storedAt: string;
}

/** Whether material exists for a reference, without revealing it. */
export interface SecretCustodyStatus {
  readonly state: 'set' | 'missing' | 'revoked';
  readonly version?: number;
  readonly updatedAt?: string;
  /** Where the host keeps it, for display only, e.g. "local encrypted vault", "environment variable FELTKIT_CREDENTIAL_X". */
  readonly location?: string;
  /** Whether `store` can change it (false for env-var-only custody). */
  readonly writable: boolean;
}

/**
 * Credential custody with a write path, implemented by the HOST.
 *
 * AppPort Services owns the collection contract (authorization, audit,
 * versions, validation, redaction) and never keeps the value: it is handed to
 * `store` once, inside an allowed effect, and dropped. Where the material
 * lives (a vault, a secret manager, an encrypted file outside FeltDB) is the
 * host's decision. Secret values are never FeltDB fields.
 */
export interface SecretCustody<TSecret = string> extends ScopedSecretsResolver<TSecret> {
  /** Store a new version of the secret's material. Never returns the value. */
  store(input: {
    /** `secretId` is the credential-ref id; `tenantId`, `provider?`, `kind?`. */
    readonly reference: SecretReference;
    readonly value: TSecret;
    /** Same shape `withSecret` uses: tenantId, principalId, purpose, authorizationRef. */
    readonly context: SecretAccessContext;
  }): Promise<SecretCustodyWriteResult>;
  /** Whether material exists, without revealing it. */
  status(input: { readonly reference: SecretReference; readonly context: SecretAccessContext }): Promise<SecretCustodyStatus>;
  /** Optional: remove material (revoke). */
  remove?(input: { readonly reference: SecretReference; readonly context: SecretAccessContext }): Promise<void>;
}

/** True for a custody that can store and report status (has `withSecret`, `store` and `status`). */
export function isSecretCustody(value: unknown): value is SecretCustody {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const candidate = value as Partial<Record<'withSecret' | 'store' | 'status', unknown>>;
  return typeof candidate.withSecret === 'function' && typeof candidate.store === 'function' && typeof candidate.status === 'function';
}
