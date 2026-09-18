export type SecretStatus = 'active' | 'revoked' | 'retired';
export type SecretVersionStatus = 'active' | 'revoked' | 'retired';
export type SecretAuditEventType = 'secret.created' | 'secret.resolved' | 'secret.rotated' | 'secret.revoked' | 'secret.retired' | 'secret.failed';

export interface Secret {
  id: string;
  tenantId: string;
  name: string;
  currentVersion: number;
  status: SecretStatus;
  providerRef: string;
  provider?: string;
  accountId?: string;
  kind?: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  retiredAt?: string;
  createdBy: string;
}

export interface SecretVersion {
  id: string;
  secretId: string;
  tenantId: string;
  version: number;
  providerRef: string;
  status: SecretVersionStatus;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  createdBy: string;
}

export type SecretMetadata = Omit<Secret, '__version'>;

export interface RegisterSecretInput {
  tenantId: string;
  name: string;
  providerRef: string;
  provider?: string;
  accountId?: string;
  kind?: string;
  createdBy: string;
  expiresAt?: string;
}

export interface RotateSecretInput {
  tenantId: string;
  secretId: string;
  providerRef: string;
  rotatedBy: string;
  expiresAt?: string;
}

export interface SecretOperationInput {
  tenantId: string;
  secretId: string;
  principalId: string;
}

export interface ResolveSecretInput extends SecretOperationInput {}

/** Opaque reference safe to carry through Work, Evidence, and application state. */
export interface SecretReference {
  secretId: string;
  tenantId: string;
  provider?: string;
  accountId?: string;
  kind?: string;
}

/** Context for AuthBoundry and AppBoundry; it is not an authorization decision. */
export interface SecretResolutionContext {
  tenantId: string;
  principalId: string;
  purpose: string;
  authorizationRef?: string;
}

export interface ScopedResolveSecretInput {
  reference: SecretReference;
  context: SecretResolutionContext;
}

/** Temporary execution material supplied by AppBoundry inside the callback only. */
export interface ResolvedSecret<T = unknown> {
  readonly value: T;
  readonly secretId: string;
  readonly version: number;
  readonly provider?: string;
  readonly accountId?: string;
  readonly kind?: string;
}

export type SecretResolutionFailureCode =
  | 'secret_not_found'
  | 'secret_resolution_denied'
  | 'tenant_mismatch'
  | 'secret_inactive'
  | 'secret_revoked'
  | 'provider_mismatch'
  | 'secret_unavailable'
  | 'internal_error';

export interface SecretAuditEvent {
  id: string;
  type: SecretAuditEventType;
  secretId: string;
  version?: number;
  tenantId: string;
  principalId: string;
  timestamp: string;
  result: 'success' | 'failure';
  purpose?: string;
  provider?: string;
  reason?: SecretResolutionFailureCode;
}
