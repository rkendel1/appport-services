export interface ApiKey {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly secretHash: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly lastUsedAt?: string;
  readonly createdBy: string;
  readonly __version: number;
}

export interface ApiKeyView {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly lastUsedAt?: string;
  readonly createdBy: string;
}

export interface CreatedApiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly secret: string;
}

export interface CreateApiKeyInput {
  readonly tenantId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: Date;
  readonly createdBy: string;
}

export interface RevokeApiKeyInput {
  readonly tenantId: string;
  readonly id: string;
  readonly revokedBy: string;
}

export interface ApiKeyAuditEvent {
  readonly id: string;
  readonly type: 'api_key.created' | 'api_key.revoked' | 'api_key.authenticated';
  readonly credentialId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly timestamp: string;
  readonly result: 'success' | 'revoked' | 'expired' | 'invalid_secret';
}
