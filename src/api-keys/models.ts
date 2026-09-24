export interface ApiKey {
  readonly id: string;
  readonly tenantId: string;
  /** Application the key identifies callers for. Keys without one are refused. */
  readonly applicationId?: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly secretHash: string;
  /** @deprecated Retained for stored-data compatibility only. Always empty for new keys; never authority. */
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
  readonly applicationId?: string;
  readonly name: string;
  readonly keyPrefix: string;
  /** @deprecated Always empty for new keys; scopes are not authority. */
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
  /** Optional; must equal the caller's tenant. */
  readonly tenantId?: string;
  readonly name: string;
  /** @deprecated Rejected when non-empty. An API key identifies a caller; AuthBoundry authorizes it. */
  readonly scopes?: readonly string[];
  readonly expiresAt?: Date;
  /** @deprecated Must equal the verified caller when supplied. */
  readonly createdBy?: string;
}

export interface RevokeApiKeyInput {
  readonly tenantId?: string;
  readonly id: string;
  /** @deprecated Must equal the verified caller when supplied. */
  readonly revokedBy?: string;
}

export interface ApiKeyAuditEvent {
  readonly id: string;
  readonly type: 'api_key.created' | 'api_key.revoked' | 'api_key.authenticated';
  readonly credentialId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly timestamp: string;
  readonly result: 'success' | 'revoked' | 'expired' | 'invalid_secret' | 'application_mismatch';
}
