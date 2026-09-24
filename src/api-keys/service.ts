import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

import type {
  ApiKey,
  ApiKeyAuditEvent,
  ApiKeyView,
  CreateApiKeyInput,
  CreatedApiKey,
  RevokeApiKeyInput,
} from './models.js';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { AuditSink, FeltDbServiceRuntime, ApiKeyStore } from '../storage/api-keys.js';
import { isConditionalConflict } from '../storage/api-keys.js';
import { ServiceAuthorityError, ServiceMigrationError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { mintVerifiedPrincipal, rejectCallerActor, requireVerifiedPrincipal, resolveTenant, type VerifiedPrincipal } from '../authority/principal.js';

const API_KEY_SCHEME = 'app_live';
const SECRET_BYTES = 32;
const SALT_BYTES = 16;
const MAX_CREATE_ATTEMPTS = 5;
const MAX_UPDATE_ATTEMPTS = 10;
const MAX_UPDATE_RETRY_DELAY_MS = 32;

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
}

export class ApiKeyScopesNotSupportedError extends ServiceMigrationError {
  constructor() {
    super('API key scopes are no longer authority. Old: API key + scopes -> service authority. New: API key -> identity; AuthBoundry -> authorization. Create the key without scopes and grant capabilities in AuthBoundry.');
    this.name = 'ApiKeyScopesNotSupportedError';
  }
}

export class ApiKeyService {
  readonly runtime?: FeltDbServiceRuntime;
  private readonly now: () => Date;
  private creationQueue: Promise<void> = Promise.resolve();
  private authenticationQueue: Promise<void> = Promise.resolve();
  private readonly knownPrefixes = new Map<string, string>();
  private readonly locallyCreatedKeys = new Map<string, ApiKey>();
  readonly applicationId: string;

  constructor(private readonly options: ApiKeyServiceOptions) {
    if (options.allowedScopes?.length) throw new ApiKeyScopesNotSupportedError();
    this.runtime = options.runtime;
    this.now = options.now ?? (() => new Date());
    this.applicationId = options.applicationId ?? options.authority?.application ?? 'default';
  }

  async createApiKey(input: CreateApiKeyInput, caller: VerifiedPrincipal): Promise<CreatedApiKey> {
    if (input.scopes?.length) throw new ApiKeyScopesNotSupportedError();
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor({ createdBy: input.createdBy }, principal);
    const tenantId = resolveTenant(input, principal);
    return this.gateway().execute('apikeys.create', principal, { type: 'api_key', tenantId }, { service: 'api-keys' },
      () => this.serialCreate({ ...input, tenantId, createdBy: principal.principalId }));
  }

  private gateway(): ServiceGateway {
    if (!this.options.authority) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'API key management has no AuthBoundry authority configured');
    return this.options.authority;
  }

  private async serialCreate(input: { tenantId: string; name: string; expiresAt?: Date; createdBy: string }): Promise<CreatedApiKey> {
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

  private async createApiKeyWithSideEffects(input: { tenantId: string; name: string; expiresAt?: Date; createdBy: string }): Promise<CreatedApiKey> {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new ServiceAuthorityError('INVALID_REQUEST', 'name must be a non-empty string');
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const createdAt = this.now().toISOString();
      const prefix = `${API_KEY_SCHEME}_${randomBytes(3).toString('hex')}`;
      const secret = `${prefix}_${randomBytes(SECRET_BYTES).toString('base64url')}`;
      const apiKey: ApiKey = {
        id: randomUUID(),
        tenantId: input.tenantId,
        applicationId: this.applicationId,
        name: input.name,
        keyPrefix: prefix,
        secretHash: hashSecret(secret),
        scopes: [],
        createdAt,
        expiresAt: input.expiresAt?.toISOString(),
        revokedAt: undefined,
        lastUsedAt: undefined,
        createdBy: input.createdBy,
        __version: 1,
      };

      try {
        await this.options.store.create(apiKey);
        this.knownPrefixes.set(apiKey.keyPrefix, apiKey.id);
        this.locallyCreatedKeys.set(apiKey.id, apiKey);
        await this.options.auditSink.record({
          id: randomUUID(),
          type: 'api_key.created',
          credentialId: apiKey.id,
          tenantId: apiKey.tenantId,
          principalId: input.createdBy,
          timestamp: createdAt,
          result: 'success',
        });
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

  async listApiKeys(tenantId: string): Promise<readonly ApiKeyView[]> {
    const items = await this.options.store.list(tenantId);
    return items.map(toView);
  }

  async getApiKey(tenantId: string, id: string): Promise<ApiKeyView | null> {
    const apiKey = await this.options.store.get(id);
    if (!apiKey || apiKey.tenantId !== tenantId) {
      return null;
    }
    return toView(apiKey);
  }

  async revokeApiKey(input: RevokeApiKeyInput, caller: VerifiedPrincipal): Promise<ApiKeyView | null> {
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor({ revokedBy: input.revokedBy }, principal);
    const tenantId = resolveTenant(input, principal);
    // Authorize before looking the key up, so existence is not disclosed to unauthorized callers.
    return this.gateway().execute('apikeys.revoke', principal, { type: 'api_key', tenantId, id: input.id }, { service: 'api-keys' },
      () => this.revoke({ tenantId, id: input.id, revokedBy: principal.principalId }));
  }

  private async revoke(input: { tenantId: string; id: string; revokedBy: string }): Promise<ApiKeyView | null> {
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      const current = await this.options.store.get(input.id);
      if (!current || current.tenantId !== input.tenantId) {
        return null;
      }
      if (current.revokedAt) {
        return toView(current);
      }

      const revokedAt = this.now().toISOString();
      const result = await this.options.store.revoke(current.id, current.__version, revokedAt);
      const updated = result ? {
        ...current,
        revokedAt,
        __version: result.__version ?? current.__version + 1,
      } : null;
      if (!updated) {
        await waitForUpdateRetry(attempt);
        continue;
      }

      await this.options.auditSink.record({
        id: randomUUID(),
        type: 'api_key.revoked',
        credentialId: updated.id,
        tenantId: updated.tenantId,
        principalId: input.revokedBy,
        timestamp: revokedAt,
        result: 'success',
      });
      this.locallyCreatedKeys.set(updated.id, updated);
      return toView(updated);
    }

    throw new Error(`Unable to revoke API key ${input.id} because concurrent FeltDB updates never settled.`);
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
    const prefix = parseApiKeyPrefix(secret);
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
      const failure = authenticationFailure(current, secret, now, this.applicationId);
      if (failure) {
        await this.recordAuthEvent(current, failure, now.toISOString());
        return null;
      }

      let updated: ApiKey | null;
      try {
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
      this.locallyCreatedKeys.set(updated.id, updated);
      return toPrincipal(updated);
    }

    // Credential validity is determined by the latest successful read and hash
    // verification, not by availability of usage/audit bookkeeping writes.
    const current = await this.findApiKeyByPrefix(prefix).catch(() => null);
    if (!current) {
      return null;
    }
    const now = this.now();
    const failure = authenticationFailure(current, secret, now, this.applicationId);
    if (failure) {
      await this.recordAuthEvent(current, failure, now.toISOString());
      return null;
    }
    await this.recordSuccessfulAuthEvent(current, now.toISOString());
    return toPrincipal(current);
  }

  async close(): Promise<void> {
    await Promise.resolve(this.runtime?.db.close());
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
      const stored = await this.options.store.get(knownId).catch(() => null);
      if (stored) {
        const local = this.locallyCreatedKeys.get(knownId);
        const canReconcile = local
          && this.runtime?.deployment.mode === 'local'
          && stored.id === local.id
          && stored.tenantId === local.tenantId
          && stored.keyPrefix === local.keyPrefix
          && stored.secretHash === local.secretHash;
        const complete = local && this.runtime?.deployment.mode === 'local'
          ? canReconcile
            ? {
              ...local,
              revokedAt: stored.revokedAt ?? local.revokedAt,
              lastUsedAt: stored.lastUsedAt ?? local.lastUsedAt,
              __version: Math.max(stored.__version ?? 0, local.__version),
            }
            : local
          : stored;
        this.locallyCreatedKeys.set(knownId, complete);
        return complete;
      }
      // Embedded local FeltDB can briefly lag its just-committed key reads.
      // Managed deployments remain fail-closed and never use process-local state.
      if (this.runtime?.deployment.mode === 'local') {
        const local = this.locallyCreatedKeys.get(knownId);
        if (local) {
          return local;
        }
      }
    }

    const indexed = await this.options.store.findByPrefix(prefix).catch(() => null);
    if (indexed) {
      this.knownPrefixes.set(prefix, indexed.id);
    }
    return indexed;
  }
}

async function waitForUpdateRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(2 ** attempt, MAX_UPDATE_RETRY_DELAY_MS);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/** An API key identifies its caller and application. It carries no scopes and grants nothing. */
function toPrincipal(apiKey: ApiKey): AuthenticatedPrincipal {
  return mintVerifiedPrincipal({
    principalId: apiKey.id,
    principalType: 'api_key',
    tenantId: apiKey.tenantId,
    applicationId: apiKey.applicationId,
    credentialId: apiKey.id,
  }, 'api_key');
}

function toView(apiKey: ApiKey): ApiKeyView {
  return {
    id: apiKey.id,
    tenantId: apiKey.tenantId,
    ...(apiKey.applicationId ? { applicationId: apiKey.applicationId } : {}),
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    scopes: [],
    createdAt: apiKey.createdAt,
    expiresAt: apiKey.expiresAt,
    revokedAt: apiKey.revokedAt,
    lastUsedAt: apiKey.lastUsedAt,
    createdBy: apiKey.createdBy,
  };
}

export function parseApiKeyPrefix(secret: string): string | null {
  const match = /^(app_live_[0-9a-f]{6})_(.+)$/.exec(secret);
  return match?.[1] ?? null;
}

function hashSecret(secret: string): string {
  const salt = randomBytes(SALT_BYTES);
  const digest = scryptSync(secret, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

function verifySecret(secret: string, encodedHash: string): boolean {
  const [algorithm, saltValue, digestValue] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !digestValue) {
    return false;
  }

  const salt = Buffer.from(saltValue, 'base64url');
  const expected = Buffer.from(digestValue, 'base64url');
  const actual = scryptSync(secret, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

function authenticationFailure(apiKey: ApiKey, secret: string, now: Date, applicationId: string): ApiKeyAuditEvent['result'] | null {
  if (apiKey.revokedAt) {
    return 'revoked';
  }
  if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= now.getTime()) {
    return 'expired';
  }
  if (!verifySecret(secret, apiKey.secretHash)) {
    return 'invalid_secret';
  }
  // A key from another application (or a legacy key bound to none) identifies no caller here.
  if (apiKey.applicationId !== applicationId) {
    return 'application_mismatch';
  }
  return null;
}
