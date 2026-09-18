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

export interface SecretAuditEvent {
  id: string;
  type: SecretAuditEventType;
  secretId: string;
  version?: number;
  tenantId: string;
  principalId: string;
  timestamp: string;
  result: 'success' | 'failure';
}
