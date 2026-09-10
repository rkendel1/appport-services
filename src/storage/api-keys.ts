import {
  ConditionalConflictError,
  type AuthorityScope,
  type FeltDBOptions,
  type FeltDBDeploymentConfig,
  type FeltDBDeploymentResolution,
  type StateFirstDB,
  createFeltDB,
  resolveFeltDBDeployment,
} from '@feltdb/core';

import type { ApiKey, ApiKeyAuditEvent } from '../api-keys/models.js';

const API_KEYS_COLLECTION = 'api_keys';
const API_KEY_PREFIXES_COLLECTION = 'api_key_prefixes';
const API_KEY_AUDIT_COLLECTION = 'api_key_audit_events';

interface ApiKeyPrefixRecord {
  readonly id: string;
  readonly apiKeyId: string;
  readonly tenantId: string;
  readonly createdAt: string;
  readonly __version: number;
}

export interface ApiKeyStore {
  create(apiKey: ApiKey): Promise<void>;
  get(id: string): Promise<ApiKey | null>;
  findByPrefix(prefix: string): Promise<ApiKey | null>;
  list(tenantId: string): Promise<readonly ApiKey[]>;
  revoke(id: string, expectedVersion: number, revokedAt: string): Promise<ApiKey | null>;
  recordLastUsed(id: string, expectedVersion: number, lastUsedAt: string): Promise<ApiKey | null>;
}

export interface AuditSink {
  record(event: ApiKeyAuditEvent): Promise<void>;
}

export interface FeltDbServiceRuntime {
  readonly db: StateFirstDB;
  readonly deployment: FeltDBDeploymentResolution;
}

export interface CreateFeltDbRuntimeOptions extends FeltDBOptions {}

export function createFeltDbRuntime(options: CreateFeltDbRuntimeOptions = {}): FeltDbServiceRuntime {
  const deployment = resolveRuntimeDeployment(options);
  const db = createFeltDB(options);
  return { db, deployment };
}

export class FeltDbApiKeyStore implements ApiKeyStore {
  private readonly apiKeys;
  private readonly prefixes;

  constructor(private readonly db: StateFirstDB) {
    this.apiKeys = db.collection<ApiKey>(API_KEYS_COLLECTION);
    this.prefixes = db.collection<ApiKeyPrefixRecord>(API_KEY_PREFIXES_COLLECTION);
  }

  async create(apiKey: ApiKey): Promise<void> {
    await this.db.transaction({
      operations: [
        {
          collection: API_KEYS_COLLECTION,
          id: apiKey.id,
          requireAbsent: true,
          value: { ...apiKey },
        },
        {
          collection: API_KEY_PREFIXES_COLLECTION,
          id: apiKey.keyPrefix,
          requireAbsent: true,
          value: {
            id: apiKey.keyPrefix,
            apiKeyId: apiKey.id,
            tenantId: apiKey.tenantId,
            createdAt: apiKey.createdAt,
            __version: 1,
          },
        },
      ],
    });
  }

  async get(id: string): Promise<ApiKey | null> {
    return this.apiKeys.get(id);
  }

  async findByPrefix(prefix: string): Promise<ApiKey | null> {
    const pointer = await this.prefixes.get(prefix);
    if (!pointer) {
      return null;
    }
    return this.apiKeys.get(pointer.apiKeyId);
  }

  async list(tenantId: string): Promise<readonly ApiKey[]> {
    return this.apiKeys.find({ tenantId });
  }

  async revoke(id: string, expectedVersion: number, revokedAt: string): Promise<ApiKey | null> {
    const result = await this.apiKeys.updateIfVersion(id, expectedVersion, { revokedAt });
    return result.updated ? result.item ?? null : null;
  }

  async recordLastUsed(id: string, expectedVersion: number, lastUsedAt: string): Promise<ApiKey | null> {
    const result = await this.apiKeys.updateIfVersion(id, expectedVersion, { lastUsedAt });
    return result.updated ? result.item ?? null : null;
  }
}

export class FeltDbAuditSink implements AuditSink {
  private readonly auditCollection;

  constructor(db: StateFirstDB) {
    this.auditCollection = db.collection<ApiKeyAuditEvent>(API_KEY_AUDIT_COLLECTION);
  }

  async record(event: ApiKeyAuditEvent): Promise<void> {
    await this.auditCollection.insert({ ...event }, event.id);
  }
}

export function isConditionalConflict(error: unknown): error is ConditionalConflictError {
  return error instanceof ConditionalConflictError;
}

export function auditCollectionName(): string {
  return API_KEY_AUDIT_COLLECTION;
}

function resolveRuntimeDeployment(options: CreateFeltDbRuntimeOptions): FeltDBDeploymentResolution {
  if (options.server) {
    return resolveFeltDBDeployment({
      namespace: options.namespace,
      mode: 'remote',
      url: options.server.url,
      token: options.server.token,
      applicationId: options.server.applicationId,
      environment: options.server.environment,
      requestTimeoutMs: options.server.requestTimeoutMs,
    });
  }

  if (options.browser) {
    return resolveFeltDBDeployment({ ...options, mode: 'browser' });
  }

  if (options.memory) {
    return resolveFeltDBDeployment({ ...options, mode: 'memory' });
  }

  return resolveFeltDBDeployment(options as FeltDBDeploymentConfig);
}
