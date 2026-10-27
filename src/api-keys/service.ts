import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

import type {
  ApiKey,
  ApiKeyAuditEvent,
  ApiKeyAuditQuery,
  ApiKeyListOptions,
  ApiKeyRestrictions,
  ApiKeyStatus,
  ApiKeyView,
  CreateApiKeyInput,
  CreatedApiKey,
  RevokeAllApiKeysInput,
  RevokeAllApiKeysResult,
  RevokeApiKeyInput,
  RotateApiKeyInput,
  RotatedApiKey,
  UpdateApiKeyInput,
} from './models.js';
import { normalizeRestrictions, restrictionsPermit, restrictionsWithin } from './restrictions.js';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { AuditSink, FeltDbServiceRuntime, ApiKeyStore } from '../storage/api-keys.js';
import { isConditionalConflict } from '../storage/api-keys.js';
import { bindCredentialCheck } from '../authority/credential-binding.js';
import { ServiceAuthorityError, ServiceMigrationError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { mintVerifiedPrincipal, rejectCallerActor, requireVerifiedPrincipal, resolveTenant, type VerifiedPrincipal } from '../authority/principal.js';

const API_KEY_SCHEME = 'app_live';
const SECRET_BYTES = 32;
const SALT_BYTES = 16;
const MIN_VERIFIER_KEY_BYTES = 32;
const MAX_CREATE_ATTEMPTS = 5;
const MAX_UPDATE_ATTEMPTS = 10;
const MAX_UPDATE_RETRY_DELAY_MS = 32;
const MAX_OVERLAP_SECONDS = 7 * 24 * 60 * 60;
const MAX_PAGE_SIZE = 500;
const DEFAULT_AUDIT_PAGE_SIZE = 100;
// Process-local lookup hints only; the authoritative record always wins.
const MAX_CACHED_PREFIXES = 10_000;
const MAX_LOCAL_KEYS = 1_000;

interface ApiKeyServiceOptions {
  readonly store: ApiKeyStore;
  readonly auditSink: AuditSink;
  readonly runtime?: FeltDbServiceRuntime;
  readonly now?: () => Date;
  /** Application whose callers these keys identify. Defaults to "default". */
  readonly applicationId?: string;
  /** Policy Enforcement Point. Without it, key management fails closed. */
  readonly authority?: ServiceGateway;
  /** @deprecated Rejected when non-empty: API key scopes are not authority. */
  readonly allowedScopes?: readonly string[];
  /**
   * Server-held key (at least 32 bytes) mixed into new verifiers with HMAC
   * before scrypt. It is never persisted. Keys created with it can only be
   * verified by services configured with the same key; without it they fail
   * closed. Existing keys keep verifying either way.
   */
  readonly verifierKey?: string | Uint8Array;
}

export class ApiKeyScopesNotSupportedError extends ServiceMigrationError {
  constructor() {
    super('API key scopes are no longer authority. Old: API key + scopes -> service authority. New: API key -> identity; AuthBoundry -> authorization. Create the key without scopes and grant capabilities in AuthBoundry.');
    this.name = 'ApiKeyScopesNotSupportedError';
  }
}

export class ApiKeyService {
  readonly runtime?: FeltDbServiceRuntime;
  private readonly options: Omit<ApiKeyServiceOptions, 'verifierKey'>;
  // Private field: absent from JSON.stringify, util.inspect, and spreads.
  readonly #verifierKey?: Buffer;
  private readonly now: () => Date;
  private creationQueue: Promise<void> = Promise.resolve();
  private authenticationQueue: Promise<void> = Promise.resolve();
  private readonly knownPrefixes = new Map<string, string>();
  private readonly locallyCreatedKeys = new Map<string, ApiKey>();
  readonly applicationId: string;

  constructor(options: ApiKeyServiceOptions) {
    if (options.allowedScopes?.length) throw new ApiKeyScopesNotSupportedError();
    const { verifierKey, ...rest } = options;
    this.options = rest;
    if (verifierKey !== undefined) {
      const key = Buffer.from(verifierKey);
      if (key.length < MIN_VERIFIER_KEY_BYTES) throw new Error(`API key verifierKey must be at least ${MIN_VERIFIER_KEY_BYTES} bytes`);
      this.#verifierKey = key;
    }
    this.runtime = options.runtime;
    this.now = options.now ?? (() => new Date());
    this.applicationId = options.applicationId ?? options.authority?.application ?? 'default';
  }

  async createApiKey(input: CreateApiKeyInput, caller: VerifiedPrincipal): Promise<CreatedApiKey> {
    if (input.scopes?.length) throw new ApiKeyScopesNotSupportedError();
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor({ createdBy: input.createdBy }, principal);
    const tenantId = resolveTenant(input, principal);
    const restrictions = input.restrictions === undefined ? undefined : normalizeRestrictions(input.restrictions);
    const expiresAt = input.expiresAt === undefined ? undefined : isoDate(input.expiresAt, 'expiresAt');
    return this.gateway().execute('apikeys.create', principal, { type: 'api_key', tenantId }, { service: 'api-keys' }, async () => {
      await this.assertWithinCaller(principal, restrictions, expiresAt);
      return this.serialCreate({ tenantId, name: input.name, restrictions, expiresAt, createdBy: principal.principalId });
    });
  }

  private gateway(): ServiceGateway {
    if (!this.options.authority) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'API key management has no AuthBoundry authority configured');
    return this.options.authority;
  }

  private async serialCreate(input: { tenantId: string; name: string; restrictions?: ApiKeyRestrictions; expiresAt?: string; createdBy: string }): Promise<CreatedApiKey> {
    const previous = this.creationQueue;
    let release!: () => void;
    this.creationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await this.createApiKeyWithSideEffects(input);
    } finally {
      release();
    }
  }

  private async createApiKeyWithSideEffects(input: { tenantId: string; name: string; restrictions?: ApiKeyRestrictions; expiresAt?: string; createdBy: string }): Promise<CreatedApiKey> {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new ServiceAuthorityError('INVALID_REQUEST', 'name must be a non-empty string');
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const { apiKey, secret } = this.issue(input);

      try {
        await this.options.store.create(apiKey);
        this.rememberPrefix(apiKey.keyPrefix, apiKey.id);
        this.rememberCreated(apiKey);
        await this.audit('api_key.created', apiKey, input.createdBy, apiKey.createdAt);
        return {
          id: apiKey.id,
          name: apiKey.name,
          prefix: apiKey.keyPrefix,
          secret,
        };
      } catch (error) {
        if (isConditionalConflict(error)) {
          continue;
        }
        throw error;
      }
    }

    throw new Error('Unable to create a unique API key after repeated FeltDB conflicts.');
  }

  /** Build a new key record and its one-time secret. Nothing is persisted here. */
  private issue(input: { tenantId: string; name: string; restrictions?: ApiKeyRestrictions; expiresAt?: string; createdBy: string; rotatedFrom?: string }): { apiKey: ApiKey; secret: string } {
    const prefix = `${API_KEY_SCHEME}_${randomBytes(3).toString('hex')}`;
    const secret = `${prefix}_${randomBytes(SECRET_BYTES).toString('base64url')}`;
    const apiKey: ApiKey = {
      id: randomUUID(),
      tenantId: input.tenantId,
      applicationId: this.applicationId,
      name: input.name,
      keyPrefix: prefix,
      secretHash: hashSecret(secret, this.#verifierKey),
      scopes: [],
      ...(input.restrictions ? { restrictions: input.restrictions } : {}),
      createdAt: this.now().toISOString(),
      expiresAt: input.expiresAt,
      revokedAt: undefined,
      lastUsedAt: undefined,
      ...(input.rotatedFrom ? { rotatedFrom: input.rotatedFrom } : {}),
      createdBy: input.createdBy,
      __version: 1,
    };
    return { apiKey, secret };
  }

  /**
   * Tenant-keyed read. It performs no authorization of its own: call it
   * through `invoke('apikeys.read', ...)` or the management routes, which ask
   * AuthBoundry first. Without options it returns every record of the tenant
   * (the pre-0.4.12 behaviour); with options it returns this application's
   * keys, filtered and paginated by `after` (a key id).
   */
  async listApiKeys(tenantId: string, options?: ApiKeyListOptions): Promise<readonly ApiKeyView[]> {
    const items = await this.options.store.list(tenantId);
    const now = this.now();
    if (options === undefined) return items.map((item) => toView(item, now));
    const query = listQuery(options);
    const matching = items
      .filter((item) => item.applicationId === this.applicationId)
      .filter((item) => query.status === 'all' || keyStatus(item, now) === query.status)
      .filter((item) => query.createdBy === undefined || item.createdBy === query.createdBy)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return page(matching, query.after, query.limit).map((item) => toView(item, now));
  }

  async getApiKey(tenantId: string, id: string): Promise<ApiKeyView | null> {
    const apiKey = await this.options.store.get(id);
    if (!apiKey || apiKey.tenantId !== tenantId) {
      return null;
    }
    return toView(apiKey, this.now());
  }

  /** Change a key's name, restrictions, or expiry. The secret never changes here; use rotateApiKey. */
  async updateApiKey(input: UpdateApiKeyInput, caller: VerifiedPrincipal): Promise<ApiKeyView | null> {
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor(input, principal);
    const tenantId = resolveTenant(input, principal);
    const id = requiredId(input?.id);
    const changes: { name?: string; restrictions?: ApiKeyRestrictions | null; expiresAt?: string | null } = {};
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim()) throw new ServiceAuthorityError('INVALID_REQUEST', 'name must be a non-empty string');
      changes.name = input.name;
    }
    if (input.restrictions !== undefined) changes.restrictions = input.restrictions === null ? null : normalizeRestrictions(input.restrictions);
    if (input.expiresAt !== undefined) changes.expiresAt = input.expiresAt === null ? null : isoDate(input.expiresAt, 'expiresAt');
    if (!Object.keys(changes).length) throw new ServiceAuthorityError('INVALID_REQUEST', 'Nothing to update: supply name, restrictions, or expiresAt');
    // Authorize before looking the key up, so existence is not disclosed to unauthorized callers.
    return this.gateway().execute('apikeys.update', principal, { type: 'api_key', tenantId, id }, { service: 'api-keys' },
      () => this.update(tenantId, id, changes, principal));
  }

  private async update(tenantId: string, id: string, changes: { name?: string; restrictions?: ApiKeyRestrictions | null; expiresAt?: string | null }, principal: VerifiedPrincipal): Promise<ApiKeyView | null> {
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      const current = await this.options.store.get(id);
      if (!this.owns(current, tenantId)) return null;
      if (current.revokedAt) throw new ServiceAuthorityError('INVALID_REQUEST', 'A revoked API key cannot be updated');

      const updatedAt = this.now().toISOString();
      const { restrictions: _restrictions, expiresAt: _expiresAt, ...base } = current;
      const restrictions = changes.restrictions === undefined ? current.restrictions : changes.restrictions ?? undefined;
      const expiresAt = changes.expiresAt === undefined ? current.expiresAt : changes.expiresAt ?? undefined;
      const next: ApiKey = {
        ...base,
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(restrictions ? { restrictions } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        updatedAt,
        updatedBy: principal.principalId,
      };
      if (changes.restrictions !== undefined || changes.expiresAt !== undefined) {
        await this.assertWithinCaller(principal, restrictions, expiresAt);
      }

      const result = await this.options.store.replace(current.id, current.__version, next);
      if (!result) {
        await waitForUpdateRetry(attempt);
        continue;
      }
      const updated = { ...next, __version: result.__version ?? current.__version + 1 };
      this.rememberLocal(updated);
      await this.audit('api_key.updated', updated, principal.principalId, updatedAt, { changes: Object.keys(changes).sort() });
      return toView(updated, this.now());
    }

    throw new Error(`Unable to update API key ${id} because concurrent FeltDB updates never settled.`);
  }

  /**
   * Issue a replacement secret for a key. The replacement keeps the key's
   * name, restrictions, and expiry. The replaced key is revoked in the same
   * atomic commit, or, with `overlapSeconds`, expires that many seconds later
   * (never later than it already would). A key is rotated at most once:
   * concurrent rotations of one key produce exactly one replacement.
   */
  async rotateApiKey(input: RotateApiKeyInput, caller: VerifiedPrincipal): Promise<RotatedApiKey | null> {
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor(input, principal);
    const tenantId = resolveTenant(input, principal);
    const id = requiredId(input?.id);
    const overlapSeconds = input.overlapSeconds ?? 0;
    if (!Number.isInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > MAX_OVERLAP_SECONDS) {
      throw new ServiceAuthorityError('INVALID_REQUEST', `overlapSeconds must be an integer from 0 to ${MAX_OVERLAP_SECONDS}`);
    }
    return this.gateway().execute('apikeys.rotate', principal, { type: 'api_key', tenantId, id }, { service: 'api-keys' },
      () => this.rotate(tenantId, id, overlapSeconds, principal));
  }

  private async rotate(tenantId: string, id: string, overlapSeconds: number, principal: VerifiedPrincipal): Promise<RotatedApiKey | null> {
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      const current = await this.options.store.get(id);
      if (!this.owns(current, tenantId)) return null;
      const now = this.now();
      if (current.rotatedTo) throw new ServiceAuthorityError('INVALID_REQUEST', 'This API key has already been rotated; rotate its replacement instead');
      const status = keyStatus(current, now);
      if (status !== 'active') throw new ServiceAuthorityError('INVALID_REQUEST', `A ${status} API key cannot be rotated`);
      // Rotation discloses a working secret with the key's authority, so the caller's ceiling must cover it.
      await this.assertWithinCaller(principal, current.restrictions, current.expiresAt);

      const rotatedAt = now.toISOString();
      const overlapEnd = new Date(now.getTime() + overlapSeconds * 1000).toISOString();
      const validUntil = current.expiresAt && current.expiresAt < overlapEnd ? current.expiresAt : overlapEnd;
      const { apiKey: replacement, secret } = this.issue({
        tenantId,
        name: current.name,
        restrictions: current.restrictions,
        expiresAt: current.expiresAt,
        createdBy: principal.principalId,
        rotatedFrom: current.id,
      });
      const retired: ApiKey = {
        ...current,
        rotatedTo: replacement.id,
        rotatedAt,
        ...(overlapSeconds === 0 ? { revokedAt: rotatedAt, revokedBy: principal.principalId } : { expiresAt: validUntil }),
      };

      try {
        await this.options.store.rotate(current, retired, replacement);
      } catch (error) {
        if (!isConditionalConflict(error)) throw error;
        await waitForUpdateRetry(attempt);
        continue;
      }
      this.rememberPrefix(replacement.keyPrefix, replacement.id);
      this.rememberCreated(replacement);
      this.rememberLocal({ ...retired, __version: current.__version + 1 });
      await this.audit('api_key.created', replacement, principal.principalId, rotatedAt, { relatedCredentialId: current.id });
      await this.audit('api_key.rotated', current, principal.principalId, rotatedAt, { relatedCredentialId: replacement.id });
      if (overlapSeconds === 0) await this.audit('api_key.revoked', current, principal.principalId, rotatedAt);
      return {
        id: replacement.id,
        name: replacement.name,
        prefix: replacement.keyPrefix,
        secret,
        replaces: current.id,
        replacedKeyValidUntil: overlapSeconds === 0 ? rotatedAt : validUntil,
      };
    }

    throw new Error(`Unable to rotate API key ${id} because concurrent FeltDB updates never settled.`);
  }

  async revokeApiKey(input: RevokeApiKeyInput, caller: VerifiedPrincipal): Promise<ApiKeyView | null> {
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor({ revokedBy: input.revokedBy }, principal);
    const tenantId = resolveTenant(input, principal);
    // Authorize before looking the key up, so existence is not disclosed to unauthorized callers.
    return this.gateway().execute('apikeys.revoke', principal, { type: 'api_key', tenantId, id: input.id }, { service: 'api-keys' },
      () => this.revoke({ tenantId, id: input.id, revokedBy: principal.principalId }));
  }

  /**
   * Revoke every active key of the caller's tenant and this application, or
   * only those created by `createdBy`. AuthBoundry is asked once, for
   * `apikeys.revoke` on the collection with attribute `createdBy` (`*` for
   * all). Each key is revoked with its own version check; keys created while
   * this runs may survive and are not reported.
   */
  async revokeAllApiKeys(input: RevokeAllApiKeysInput, caller: VerifiedPrincipal): Promise<RevokeAllApiKeysResult> {
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor({ revokedBy: (input as { revokedBy?: unknown })?.revokedBy, principal: (input as { principal?: unknown })?.principal }, principal);
    const tenantId = resolveTenant(input, principal);
    const createdBy = input?.createdBy;
    if (createdBy !== undefined && (typeof createdBy !== 'string' || !createdBy.trim())) throw new ServiceAuthorityError('INVALID_REQUEST', 'createdBy must be a non-empty string');
    return this.gateway().execute('apikeys.revoke', principal, { type: 'api_key', tenantId, attributes: { createdBy: createdBy ?? '*' } }, { service: 'api-keys' }, async () => {
      const candidates = (await this.options.store.list(tenantId))
        .filter((key) => this.owns(key, tenantId, { allowLegacy: true }) && !key.revokedAt)
        .filter((key) => createdBy === undefined || key.createdBy === createdBy)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const revoked: string[] = [];
      for (const key of candidates) {
        const result = await this.revoke({ tenantId, id: key.id, revokedBy: principal.principalId });
        if (result) revoked.push(result.id);
      }
      return { revoked };
    });
  }

  private async revoke(input: { tenantId: string; id: string; revokedBy: string }): Promise<ApiKeyView | null> {
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      const current = await this.options.store.get(input.id);
      if (!this.owns(current, input.tenantId, { allowLegacy: true })) {
        return null;
      }
      if (current.revokedAt) {
        return toView(current, this.now());
      }

      const revokedAt = this.now().toISOString();
      const result = await this.options.store.revoke(current.id, current.__version, revokedAt, input.revokedBy);
      const updated = result ? {
        ...current,
        revokedAt,
        revokedBy: input.revokedBy,
        __version: result.__version ?? current.__version + 1,
      } : null;
      if (!updated) {
        await waitForUpdateRetry(attempt);
        continue;
      }

      await this.audit('api_key.revoked', updated, input.revokedBy, revokedAt);
      this.rememberLocal(updated);
      return toView(updated, this.now());
    }

    throw new Error(`Unable to revoke API key ${input.id} because concurrent FeltDB updates never settled.`);
  }

  /** Lifecycle and usage events for this tenant's keys (or one key). Events never contain secrets or verifiers. */
  async listApiKeyAuditEvents(query: ApiKeyAuditQuery, caller: VerifiedPrincipal): Promise<readonly ApiKeyAuditEvent[]> {
    const principal = requireVerifiedPrincipal(caller);
    const tenantId = resolveTenant(query, principal);
    const credentialId = query?.credentialId === undefined ? undefined : requiredId(query.credentialId);
    const { limit, after } = listQuery({ limit: query?.limit ?? DEFAULT_AUDIT_PAGE_SIZE, after: query?.after });
    return this.gateway().execute('apikeys.audit', principal, { type: 'api_key', tenantId, ...(credentialId ? { id: credentialId } : {}) }, { service: 'api-keys' }, async () => {
      const sink = this.options.auditSink;
      if (typeof sink.list !== 'function') throw new ServiceAuthorityError('INVALID_REQUEST', 'The configured API key audit sink does not support reads');
      // Only events about this application's keys, so applications sharing a namespace stay apart.
      const owned = new Set((await this.options.store.list(tenantId)).filter((key) => this.owns(key, tenantId)).map((key) => key.id));
      const events = (await sink.list(tenantId))
        .filter((event) => event.tenantId === tenantId && owned.has(event.credentialId))
        .filter((event) => credentialId === undefined || event.credentialId === credentialId)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
      return page(events, after, limit).map(toAuditView);
    });
  }

  async authenticateApiKey(secret: string): Promise<AuthenticatedPrincipal | null> {
    const previous = this.authenticationQueue;
    let release!: () => void;
    this.authenticationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await this.authenticateApiKeyWithSideEffects(secret);
    } finally {
      release();
    }
  }

  private async authenticateApiKeyWithSideEffects(secret: string): Promise<AuthenticatedPrincipal | null> {
    const prefix = typeof secret === 'string' ? parseApiKeyPrefix(secret) : null;
    if (!prefix) {
      return null;
    }

    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      let current: ApiKey | null;
      try {
        current = await this.findApiKeyByPrefix(prefix);
      } catch {
        await waitForUpdateRetry(attempt);
        continue;
      }
      if (!current) {
        await waitForUpdateRetry(attempt);
        continue;
      }

      const now = this.now();
      const failure = this.authenticationFailure(current, secret, now);
      if (failure) {
        await this.recordAuthEvent(current, failure, now.toISOString());
        return null;
      }

      let updated: ApiKey | null;
      try {
        // Version-checked: a revoke, rotation, or update that lands after the
        // read above makes this fail, and the next attempt sees it.
        updated = await this.options.store.recordLastUsed(current.id, current.__version, now.toISOString());
      } catch {
        await waitForUpdateRetry(attempt);
        continue;
      }
      if (!updated) {
        await waitForUpdateRetry(attempt);
        continue;
      }
      updated = {
        ...current,
        lastUsedAt: updated.lastUsedAt ?? now.toISOString(),
        __version: updated.__version ?? current.__version + 1,
      };

      await this.recordSuccessfulAuthEvent(updated, now.toISOString());
      this.rememberLocal(updated);
      return this.toPrincipal(updated);
    }

    // Credential validity is determined by the latest successful read and hash
    // verification, not by availability of usage/audit bookkeeping writes.
    // If the authoritative read itself fails, authentication fails closed.
    const current = await this.findApiKeyByPrefix(prefix).catch(() => null);
    if (!current) {
      return null;
    }
    const now = this.now();
    const failure = this.authenticationFailure(current, secret, now);
    if (failure) {
      await this.recordAuthEvent(current, failure, now.toISOString()).catch(() => undefined);
      return null;
    }
    await this.recordSuccessfulAuthEvent(current, now.toISOString());
    return this.toPrincipal(current);
  }

  async close(): Promise<void> {
    // A host-supplied instance belongs to the host.
    if (this.runtime && this.runtime.owned === false) return;
    await Promise.resolve(this.runtime?.db.close());
  }

  /** An API key identifies its caller and application. It carries no scopes and grants nothing. */
  private toPrincipal(apiKey: ApiKey): AuthenticatedPrincipal {
    const principal = mintVerifiedPrincipal({
      principalId: apiKey.id,
      principalType: 'api_key',
      tenantId: apiKey.tenantId,
      applicationId: apiKey.applicationId,
      credentialId: apiKey.id,
    }, 'api_key');
    // Every operation this principal requests re-reads the authoritative
    // record: revocation, expiry, and restriction changes from any process
    // apply to principals that were authenticated before the change.
    bindCredentialCheck(principal, async (capability, resource) => {
      const current = await this.options.store.get(apiKey.id);
      const deny = (reason: string, message: string) => new ServiceAuthorityError('DENIED', message, { capability, reason });
      if (!current || current.tenantId !== principal.tenantId || current.applicationId !== this.applicationId) throw deny('credential_unknown', 'API key is unknown');
      const status = keyStatus(current, this.now());
      if (status === 'revoked') throw deny('credential_revoked', 'API key has been revoked');
      if (status === 'expired') throw deny('credential_expired', 'API key has expired');
      if (!restrictionsPermit(current.restrictions, capability, resource)) throw deny('credential_restricted', `API key restrictions do not permit ${capability} on this resource`);
    });
    return principal;
  }

  /**
   * A key-authenticated caller can only produce keys within its own ceiling:
   * restrictions it has, and an expiry no later than its own.
   */
  private async assertWithinCaller(principal: VerifiedPrincipal, restrictions: ApiKeyRestrictions | undefined, expiresAt: string | undefined): Promise<void> {
    if (principal.verifiedBy !== 'api_key' || !principal.credentialId) return;
    const callerKey = await this.options.store.get(principal.credentialId);
    if (!callerKey) throw new ServiceAuthorityError('DENIED', 'Calling API key is unknown', { reason: 'credential_unknown' });
    if (!restrictionsWithin(restrictions, callerKey.restrictions)) {
      throw new ServiceAuthorityError('DENIED', 'An API key cannot create, widen, or rotate a key broader than its own restrictions', { reason: 'exceeds_credential_restrictions' });
    }
    if (callerKey.expiresAt && (!expiresAt || expiresAt > callerKey.expiresAt)) {
      throw new ServiceAuthorityError('DENIED', 'An API key cannot create or extend a key that outlives it', { reason: 'exceeds_credential_lifetime' });
    }
  }

  /** The record exists and belongs to this tenant and application (legacy unbound keys only where allowed). */
  private owns(apiKey: ApiKey | null, tenantId: string, options: { allowLegacy?: boolean } = {}): apiKey is ApiKey {
    if (!apiKey || apiKey.tenantId !== tenantId) return false;
    return apiKey.applicationId === this.applicationId || (options.allowLegacy === true && apiKey.applicationId === undefined);
  }

  private authenticationFailure(apiKey: ApiKey, secret: string, now: Date): ApiKeyAuditEvent['result'] | null {
    if (apiKey.revokedAt) {
      return 'revoked';
    }
    if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= now.getTime()) {
      return 'expired';
    }
    const verified = verifySecret(secret, apiKey.secretHash, this.#verifierKey);
    if (verified === 'verifier_unavailable') {
      return 'verifier_unavailable';
    }
    if (!verified) {
      return 'invalid_secret';
    }
    // A key from another application (or a legacy key bound to none) identifies no caller here.
    if (apiKey.applicationId !== this.applicationId) {
      return 'application_mismatch';
    }
    return null;
  }

  private async audit(type: ApiKeyAuditEvent['type'], apiKey: ApiKey, principalId: string, timestamp: string, extra: Pick<ApiKeyAuditEvent, 'changes' | 'relatedCredentialId'> = {}): Promise<void> {
    await this.options.auditSink.record({
      id: randomUUID(),
      type,
      credentialId: apiKey.id,
      tenantId: apiKey.tenantId,
      principalId,
      timestamp,
      result: 'success',
      ...extra,
    });
  }

  private async recordAuthEvent(apiKey: ApiKey, result: ApiKeyAuditEvent['result'], timestamp: string): Promise<void> {
    await this.options.auditSink.record({
      id: randomUUID(),
      type: 'api_key.authenticated',
      credentialId: apiKey.id,
      tenantId: apiKey.tenantId,
      principalId: apiKey.id,
      timestamp,
      result,
    });
  }

  private async recordSuccessfulAuthEvent(apiKey: ApiKey, timestamp: string): Promise<void> {
    await this.recordAuthEvent(apiKey, 'success', timestamp).catch(() => undefined);
  }

  private async findApiKeyByPrefix(prefix: string): Promise<ApiKey | null> {
    const knownId = this.knownPrefixes.get(prefix);
    if (knownId) {
      // The authoritative record always wins. A failed read propagates so the
      // caller retries and, if it keeps failing, fails closed.
      const stored = await this.options.store.get(knownId);
      if (stored) {
        this.locallyCreatedKeys.delete(knownId);
        return stored;
      }
      // Embedded local FeltDB can briefly lag its just-committed key reads.
      // Only a key this process created (and whose later changes it applied
      // to this copy) is used, and only until the store returns it.
      // Managed deployments remain fail-closed and never use process-local state.
      if (this.runtime?.deployment.mode === 'local') {
        const local = this.locallyCreatedKeys.get(knownId);
        if (local) {
          return local;
        }
      }
    }

    const indexed = await this.options.store.findByPrefix(prefix);
    if (indexed) {
      this.rememberPrefix(prefix, indexed.id);
    }
    return indexed;
  }

  private rememberPrefix(prefix: string, id: string): void {
    this.knownPrefixes.delete(prefix);
    this.knownPrefixes.set(prefix, id);
    evictOldest(this.knownPrefixes, MAX_CACHED_PREFIXES);
  }

  private rememberCreated(apiKey: ApiKey): void {
    if (this.runtime?.deployment.mode !== 'local') return;
    this.locallyCreatedKeys.set(apiKey.id, apiKey);
    evictOldest(this.locallyCreatedKeys, MAX_LOCAL_KEYS);
  }

  /** Keep a tracked local copy in step with this process's own writes. Never starts tracking. */
  private rememberLocal(apiKey: ApiKey): void {
    if (this.locallyCreatedKeys.has(apiKey.id)) this.locallyCreatedKeys.set(apiKey.id, apiKey);
  }
}

async function waitForUpdateRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(2 ** attempt, MAX_UPDATE_RETRY_DELAY_MS);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function keyStatus(apiKey: ApiKey, now: Date): ApiKeyStatus {
  if (apiKey.revokedAt) return 'revoked';
  if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** The safe read model: an explicit allow-list of fields, so verifiers and storage metadata never leak. */
function toView(apiKey: ApiKey, now: Date): ApiKeyView {
  return {
    id: apiKey.id,
    tenantId: apiKey.tenantId,
    ...(apiKey.applicationId ? { applicationId: apiKey.applicationId } : {}),
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    scopes: [],
    ...(apiKey.restrictions ? { restrictions: apiKey.restrictions } : {}),
    status: keyStatus(apiKey, now),
    createdAt: apiKey.createdAt,
    // A cleared field is stored as null; the view reports it as absent.
    expiresAt: apiKey.expiresAt ?? undefined,
    revokedAt: apiKey.revokedAt ?? undefined,
    ...(apiKey.revokedBy ? { revokedBy: apiKey.revokedBy } : {}),
    lastUsedAt: apiKey.lastUsedAt ?? undefined,
    ...(apiKey.updatedAt ? { updatedAt: apiKey.updatedAt } : {}),
    ...(apiKey.updatedBy ? { updatedBy: apiKey.updatedBy } : {}),
    ...(apiKey.rotatedFrom ? { rotatedFrom: apiKey.rotatedFrom } : {}),
    ...(apiKey.rotatedTo ? { rotatedTo: apiKey.rotatedTo } : {}),
    ...(apiKey.rotatedAt ? { rotatedAt: apiKey.rotatedAt } : {}),
    createdBy: apiKey.createdBy,
  };
}

function toAuditView(event: ApiKeyAuditEvent): ApiKeyAuditEvent {
  return {
    id: event.id,
    type: event.type,
    credentialId: event.credentialId,
    tenantId: event.tenantId,
    principalId: event.principalId,
    timestamp: event.timestamp,
    result: event.result,
    ...(event.changes ? { changes: [...event.changes] } : {}),
    ...(event.relatedCredentialId ? { relatedCredentialId: event.relatedCredentialId } : {}),
  };
}

function listQuery(options: ApiKeyListOptions): { status: ApiKeyStatus | 'all'; createdBy?: string; limit: number; after?: string } {
  if (!options || typeof options !== 'object') throw new ServiceAuthorityError('INVALID_REQUEST', 'List options must be an object');
  const status = options.status ?? 'all';
  if (!['all', 'active', 'expired', 'revoked'].includes(status)) throw new ServiceAuthorityError('INVALID_REQUEST', 'status must be one of all, active, expired, revoked');
  const limit = options.limit ?? MAX_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new ServiceAuthorityError('INVALID_REQUEST', `limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  if (options.createdBy !== undefined && (typeof options.createdBy !== 'string' || !options.createdBy)) throw new ServiceAuthorityError('INVALID_REQUEST', 'createdBy must be a non-empty string');
  if (options.after !== undefined && (typeof options.after !== 'string' || !options.after)) throw new ServiceAuthorityError('INVALID_REQUEST', 'after must be a non-empty string');
  return { status, ...(options.createdBy !== undefined ? { createdBy: options.createdBy } : {}), limit, ...(options.after !== undefined ? { after: options.after } : {}) };
}

/** Keyset page over an already-sorted list. An unknown cursor yields an empty page rather than restarting. */
function page<T extends { readonly id: string }>(items: readonly T[], after: string | undefined, limit: number): T[] {
  const start = after === undefined ? 0 : items.findIndex((item) => item.id === after) + 1;
  if (after !== undefined && start === 0) return [];
  return items.slice(start, start + limit);
}

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ServiceAuthorityError('INVALID_REQUEST', 'id is required');
  return value;
}

function isoDate(value: unknown, property: string): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) throw new ServiceAuthorityError('INVALID_REQUEST', `${property} must be a valid date`);
  return date.toISOString();
}

export function parseApiKeyPrefix(secret: string): string | null {
  const match = /^(app_live_[0-9a-f]{6})_(.+)$/.exec(secret);
  return match?.[1] ?? null;
}

function verifierInput(secret: string, verifierKey: Buffer): Buffer {
  return createHmac('sha256', verifierKey).update(secret).digest();
}

function hashSecret(secret: string, verifierKey?: Buffer): string {
  const salt = randomBytes(SALT_BYTES);
  if (verifierKey) {
    const digest = scryptSync(verifierInput(secret, verifierKey), salt, 32);
    return `hmac-scrypt$${salt.toString('base64url')}$${digest.toString('base64url')}`;
  }
  const digest = scryptSync(secret, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

function verifySecret(secret: string, encodedHash: string, verifierKey?: Buffer): boolean | 'verifier_unavailable' {
  const [algorithm, saltValue, digestValue] = String(encodedHash).split('$');
  if ((algorithm !== 'scrypt' && algorithm !== 'hmac-scrypt') || !saltValue || !digestValue) {
    return false;
  }
  if (algorithm === 'hmac-scrypt' && !verifierKey) {
    return 'verifier_unavailable';
  }

  const salt = Buffer.from(saltValue, 'base64url');
  const expected = Buffer.from(digestValue, 'base64url');
  const input = algorithm === 'hmac-scrypt' ? verifierInput(secret, verifierKey!) : secret;
  const actual = scryptSync(input, salt, expected.length);
  return timingSafeEqual(actual, expected);
}
