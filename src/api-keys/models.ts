/**
 * A resource a key may be used against. Every field that is set must equal
 * the requested resource; unset fields match anything. A rule with an `id`
 * never matches a collection request (list), which has no id.
 */
export interface ApiKeyResourceRule {
  /** Manifest resource type, e.g. "file" or "job". */
  readonly type?: string;
  readonly id?: string;
  /** Resource attributes the service sends AuthBoundry, e.g. { owner: "alice" }. */
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * The most a key may ever be used for. Restrictions only narrow: an operation
 * runs when the key's restrictions permit it AND AuthBoundry allows it. They
 * never grant anything AuthBoundry did not.
 */
export interface ApiKeyRestrictions {
  /** Manifest capability names (e.g. "files.read"). Anything not listed is denied. */
  readonly capabilities: readonly string[];
  /** When present, the requested resource must match at least one rule. */
  readonly resources?: readonly ApiKeyResourceRule[];
}

export interface ApiKey {
  readonly id: string;
  readonly tenantId: string;
  /** Application the key identifies callers for. Keys without one are refused. */
  readonly applicationId?: string;
  readonly name: string;
  readonly keyPrefix: string;
  /** Verifier only (salted scrypt, optionally keyed). Never the secret. */
  readonly secretHash: string;
  /** @deprecated Retained for stored-data compatibility only. Always empty for new keys; never authority. */
  readonly scopes: readonly string[];
  /** Absent: no ceiling beyond AuthBoundry. Present: deny anything outside it. */
  readonly restrictions?: ApiKeyRestrictions;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly revokedBy?: string;
  readonly lastUsedAt?: string;
  readonly updatedAt?: string;
  readonly updatedBy?: string;
  /** The key this one replaced by rotation. */
  readonly rotatedFrom?: string;
  /** The key that replaced this one. A key is rotated at most once. */
  readonly rotatedTo?: string;
  readonly rotatedAt?: string;
  readonly createdBy: string;
  readonly __version: number;
}

export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

export interface ApiKeyView {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId?: string;
  readonly name: string;
  readonly keyPrefix: string;
  /** @deprecated Always empty for new keys; scopes are not authority. */
  readonly scopes: readonly string[];
  readonly restrictions?: ApiKeyRestrictions;
  readonly status: ApiKeyStatus;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly revokedBy?: string;
  readonly lastUsedAt?: string;
  readonly updatedAt?: string;
  readonly updatedBy?: string;
  readonly rotatedFrom?: string;
  readonly rotatedTo?: string;
  readonly rotatedAt?: string;
  readonly createdBy: string;
}

export interface CreatedApiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  /** Returned once, here. It is not stored and cannot be retrieved again. */
  readonly secret: string;
}

export interface CreateApiKeyInput {
  /** Optional; must equal the caller's tenant. */
  readonly tenantId?: string;
  readonly name: string;
  /** @deprecated Rejected when non-empty. An API key identifies a caller; AuthBoundry authorizes it. */
  readonly scopes?: readonly string[];
  /** Ceiling on what the key may be used for. Omit for no ceiling beyond AuthBoundry. */
  readonly restrictions?: ApiKeyRestrictions;
  readonly expiresAt?: Date;
  /** @deprecated Must equal the verified caller when supplied. */
  readonly createdBy?: string;
}

export interface UpdateApiKeyInput {
  readonly tenantId?: string;
  readonly id: string;
  readonly name?: string;
  /** null removes the ceiling (AuthBoundry alone decides). */
  readonly restrictions?: ApiKeyRestrictions | null;
  /** null removes the expiry. */
  readonly expiresAt?: Date | null;
}

export interface RotateApiKeyInput {
  readonly tenantId?: string;
  readonly id: string;
  /**
   * How long the replaced key keeps working, in seconds. 0 (the default)
   * revokes it in the same commit that issues the replacement. Never extends
   * the replaced key's existing expiry.
   */
  readonly overlapSeconds?: number;
}

export interface RotatedApiKey extends CreatedApiKey {
  /** The key that was replaced. */
  readonly replaces: string;
  /** When the replaced key stops authenticating. */
  readonly replacedKeyValidUntil: string;
}

export interface RevokeApiKeyInput {
  readonly tenantId?: string;
  readonly id: string;
  /** @deprecated Must equal the verified caller when supplied. */
  readonly revokedBy?: string;
}

export interface RevokeAllApiKeysInput {
  readonly tenantId?: string;
  /** Revoke only keys this principal created. Omit for every key of the tenant and application. */
  readonly createdBy?: string;
}

export interface RevokeAllApiKeysResult {
  readonly revoked: readonly string[];
}

export interface ApiKeyListOptions {
  /** Defaults to every status. */
  readonly status?: ApiKeyStatus | 'all';
  readonly createdBy?: string;
  /** Page size, 1..500. */
  readonly limit?: number;
  /** Return keys after this key id (the last id of the previous page). */
  readonly after?: string;
}

export interface ApiKeyAuditQuery {
  readonly tenantId?: string;
  /** Events for one key. Omit for every key of the tenant and application. */
  readonly credentialId?: string;
  readonly limit?: number;
  /** Return events after this event id (the last id of the previous page). */
  readonly after?: string;
}

export type ApiKeyAuditType = 'api_key.created' | 'api_key.revoked' | 'api_key.authenticated' | 'api_key.updated' | 'api_key.rotated';

export interface ApiKeyAuditEvent {
  readonly id: string;
  readonly type: ApiKeyAuditType;
  readonly credentialId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly timestamp: string;
  readonly result: 'success' | 'revoked' | 'expired' | 'invalid_secret' | 'application_mismatch' | 'verifier_unavailable';
  /** Names of the fields an update changed. Never their secret values (keys have none to change). */
  readonly changes?: readonly string[];
  /** The other key in a rotation. */
  readonly relatedCredentialId?: string;
}
