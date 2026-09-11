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
}

export class ApiKeyService {
  readonly runtime?: FeltDbServiceRuntime;
  private readonly now: () => Date;
  private authenticationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ApiKeyServiceOptions) {
    this.runtime = options.runtime;
    this.now = options.now ?? (() => new Date());
  }

  async createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const createdAt = this.now().toISOString();
      const prefix = `${API_KEY_SCHEME}_${randomBytes(3).toString('hex')}`;
      const secret = `${prefix}_${randomBytes(SECRET_BYTES).toString('base64url')}`;
      const apiKey: ApiKey = {
        id: randomUUID(),
        tenantId: input.tenantId,
        name: input.name,
        keyPrefix: prefix,
        secretHash: hashSecret(secret),
        scopes: [...input.scopes],
        createdAt,
        expiresAt: input.expiresAt?.toISOString(),
        revokedAt: undefined,
        lastUsedAt: undefined,
        createdBy: input.createdBy,
        __version: 1,
      };

      try {
        await this.options.store.create(apiKey);
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

  async revokeApiKey(input: RevokeApiKeyInput): Promise<ApiKeyView | null> {
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      const current = await this.options.store.get(input.id);
      if (!current || current.tenantId !== input.tenantId) {
        return null;
      }
      if (current.revokedAt) {
        return toView(current);
      }

      const revokedAt = this.now().toISOString();
      const updated = await this.options.store.revoke(current.id, current.__version, revokedAt);
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
    const prefix = parsePrefix(secret);
    if (!prefix) {
      return null;
    }

    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      const current = await this.options.store.findByPrefix(prefix);
      if (!current) {
        return null;
      }

      const now = this.now();
      const failure = authenticationFailure(current, secret, now);
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

      await this.recordSuccessfulAuthEvent(updated, now.toISOString());
      return toPrincipal(updated);
    }

    // Credential validity is determined by the latest successful read and hash
    // verification, not by availability of usage/audit bookkeeping writes.
    const current = await this.options.store.findByPrefix(prefix);
    if (!current) {
      return null;
    }
    const now = this.now();
    const failure = authenticationFailure(current, secret, now);
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
}

async function waitForUpdateRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(2 ** attempt, MAX_UPDATE_RETRY_DELAY_MS);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function toPrincipal(apiKey: ApiKey): AuthenticatedPrincipal {
  return {
    principalId: apiKey.id,
    principalType: 'api_key',
    tenantId: apiKey.tenantId,
    scopes: [...apiKey.scopes],
    credentialId: apiKey.id,
  };
}

function toView(apiKey: ApiKey): ApiKeyView {
  return {
    id: apiKey.id,
    tenantId: apiKey.tenantId,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    scopes: [...apiKey.scopes],
    createdAt: apiKey.createdAt,
    expiresAt: apiKey.expiresAt,
    revokedAt: apiKey.revokedAt,
    lastUsedAt: apiKey.lastUsedAt,
    createdBy: apiKey.createdBy,
  };
}

function parsePrefix(secret: string): string | null {
  const parts = secret.split('_', 4);
  if (parts.length !== 4) {
    return null;
  }
  if (parts[0] !== 'app' || parts[1] !== 'live' || !parts[2] || !parts[3]) {
    return null;
  }
  return parts.slice(0, 3).join('_');
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

function authenticationFailure(apiKey: ApiKey, secret: string, now: Date): ApiKeyAuditEvent['result'] | null {
  if (apiKey.revokedAt) {
    return 'revoked';
  }
  if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= now.getTime()) {
    return 'expired';
  }
  if (!verifySecret(secret, apiKey.secretHash)) {
    return 'invalid_secret';
  }
  return null;
}
