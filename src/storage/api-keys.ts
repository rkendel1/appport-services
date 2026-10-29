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

export interface ApiKeyPrefixRecord {
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
  revoke(id: string, expectedVersion: number, revokedAt: string, revokedBy?: string): Promise<ApiKey | null>;
  recordLastUsed(id: string, expectedVersion: number, lastUsedAt: string): Promise<ApiKey | null>;
  /** Compare-and-set the whole record. Null when another writer moved it past expectedVersion. */
  replace(id: string, expectedVersion: number, next: ApiKey): Promise<ApiKey | null>;
  /**
   * Retire `current` and issue `replacement` in one atomic commit fenced on
   * `current.__version`. Throws a conditional conflict if another writer
   * (a revoke, update, authentication, or a second rotation) got there first.
   */
  rotate(current: ApiKey, retired: ApiKey, replacement: ApiKey): Promise<void>;
}

export interface AuditSink {
  record(event: ApiKeyAuditEvent): Promise<void>;
  /** Optional read side. Without it, audit reads fail with INVALID_REQUEST. */
  list?(tenantId: string): Promise<readonly ApiKeyAuditEvent[]>;
}

export interface FeltDbServiceRuntime {
  readonly db: StateFirstDB;
  readonly deployment: FeltDBDeploymentResolution;
  /**
   * False when the host supplied the instance. AppPort Services never closes an
   * instance it does not own; the host that opened it closes it.
   */
  readonly owned: boolean;
}

export interface CreateFeltDbRuntimeOptions extends FeltDBOptions {
  /**
   * An existing FeltDB instance to use instead of opening one. Hosts that already
   * own their application's instance pass it here so services share it, rather
   * than opening a second instance over the same (or different) state.
   */
  readonly db?: StateFirstDB;
}

export function createFeltDbRuntime(options: CreateFeltDbRuntimeOptions = {}): FeltDbServiceRuntime {
  const { db: existing, ...feltdbOptions } = options;
  if (existing) {
    // The instance knows its own deployment mode. It is not re-resolved from options:
    // the host already connected it (a remote instance carries its URL and token
    // internally, and resolving "remote" without them would throw).
    const deployment: FeltDBDeploymentResolution = {
      mode: existing.capabilities().deployment,
      namespace: feltdbOptions.namespace ?? 'default',
      source: 'explicit',
    };
    return { db: existing, deployment, owned: false };
  }
  const deployment = resolveRuntimeDeployment(feltdbOptions);
  const db = createFeltDB(feltdbOptions);
  return { db, deployment, owned: true };
}

export class FeltDbApiKeyStore implements ApiKeyStore {
  private readonly apiKeys;
  private readonly prefixes;

  constructor(private readonly db: StateFirstDB) {
    this.apiKeys = db.collection<ApiKey>(API_KEYS_COLLECTION);
    this.prefixes = db.collection<ApiKeyPrefixRecord>(API_KEY_PREFIXES_COLLECTION);
  }

  async create(apiKey: ApiKey): Promise<void> {
    await this.db.transaction({ operations: issueOperations(apiKey) });
  }

  async rotate(current: ApiKey, retired: ApiKey, replacement: ApiKey): Promise<void> {
    await this.db.transaction({
      operations: [
        // The writer owns __version: advancing it excludes a second rotation
        // (or any other writer) that read the same version.
        { collection: API_KEYS_COLLECTION, id: current.id, expectedVersion: current.__version, value: { ...retired, __version: current.__version + 1 } },
        ...issueOperations(replacement),
      ],
    });
  }

  async replace(id: string, expectedVersion: number, next: ApiKey): Promise<ApiKey | null> {
    const current = await this.apiKeys.get(id);
    if (!current) return null;
    const { __version: _ignored, ...value } = next;
    // updateIfVersion merges, so a field cleared in `next` must be written as null to be removed.
    const cleared = Object.fromEntries(Object.keys(current).filter((key) => key !== '__version' && !(key in value)).map((key) => [key, null]));
    const result = await this.apiKeys.updateIfVersion(id, expectedVersion, { ...cleared, ...value } as Partial<ApiKey>);
    return result.updated ? result.item ?? null : null;
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

  async revoke(id: string, expectedVersion: number, revokedAt: string, revokedBy?: string): Promise<ApiKey | null> {
    const current = await this.apiKeys.get(id);
    if (!current) return null;
    // FeltDB local CAS can persist the update object as the whole record.
    // Submit a complete value so a metadata update cannot erase credential identity.
    const result = await this.apiKeys.updateIfVersion(id, expectedVersion, { ...current, revokedAt, ...(revokedBy ? { revokedBy } : {}) });
    return result.updated ? result.item ?? null : null;
  }

  async recordLastUsed(id: string, expectedVersion: number, lastUsedAt: string): Promise<ApiKey | null> {
    const current = await this.apiKeys.get(id);
    if (!current) return null;
    const result = await this.apiKeys.updateIfVersion(id, expectedVersion, { ...current, lastUsedAt });
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

  async list(tenantId: string): Promise<readonly ApiKeyAuditEvent[]> {
    return this.auditCollection.find({ tenantId });
  }
}

function issueOperations(apiKey: ApiKey) {
  return [
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
  ];
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
