import { randomUUID } from 'node:crypto';
import type { RegisterSecretInput, RotateSecretInput, Secret, SecretAuditEvent, SecretMetadata, SecretOperationInput, SecretVersion } from './models.js';
import { InvalidSecretLifecycleOperationError, InvalidSecretReferenceError, SecretExpiredError, SecretNotFoundError, SecretProviderUnavailableError, SecretResolutionDeniedError, SecretRevokedError } from './errors.js';

export interface SecretStore {
  create(secret: Secret, version: SecretVersion): Promise<void>;
  get(secretId: string): Promise<Secret | null>;
  getVersion(secretId: string, version: number): Promise<SecretVersion | null>;
  list(tenantId: string): Promise<readonly Secret[]>;
  rotate(secret: Secret, version: SecretVersion): Promise<void>;
  update(secret: Secret): Promise<void>;
  updateVersion(version: SecretVersion): Promise<void>;
}
export interface SecretAuditSink { record(event: SecretAuditEvent): Promise<void>; }
export interface SecretProvider {
  resolve(input: { tenantId: string; secretId: string; version: number; providerRef: string; principalId: string }): Promise<string>;
}

export class UnavailableSecretProvider implements SecretProvider {
  async resolve(input: { providerRef: string }): Promise<string> {
    throw new SecretProviderUnavailableError(input.providerRef);
  }
}

export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, Secret>();
  private readonly versions = new Map<string, SecretVersion>();
  async create(secret: Secret, version: SecretVersion): Promise<void> { this.secrets.set(secret.id, secret); this.versions.set(`${secret.id}:${version.version}`, version); }
  async get(secretId: string): Promise<Secret | null> { return this.secrets.get(secretId) ?? null; }
  async getVersion(secretId: string, version: number): Promise<SecretVersion | null> { return this.versions.get(`${secretId}:${version}`) ?? null; }
  async list(tenantId: string): Promise<readonly Secret[]> { return [...this.secrets.values()].filter((secret) => secret.tenantId === tenantId); }
  async rotate(secret: Secret, version: SecretVersion): Promise<void> { this.secrets.set(secret.id, secret); this.versions.set(`${secret.id}:${version.version}`, version); }
  async update(secret: Secret): Promise<void> { this.secrets.set(secret.id, secret); }
  async updateVersion(version: SecretVersion): Promise<void> { this.versions.set(`${version.secretId}:${version.version}`, version); }
}

export class InMemorySecretAuditSink implements SecretAuditSink {
  readonly events: SecretAuditEvent[] = [];
  async record(event: SecretAuditEvent): Promise<void> { this.events.push(event); }
}

export interface SecretsServiceOptions {
  store: SecretStore;
  provider: SecretProvider;
  auditSink: SecretAuditSink;
  now?: () => Date;
}

export class SecretsService {
  private readonly now: () => Date;
  constructor(private readonly options: SecretsServiceOptions) { this.now = options.now ?? (() => new Date()); }

  async registerSecret(input: RegisterSecretInput): Promise<SecretMetadata> {
    if (!input.providerRef.trim()) throw new InvalidSecretReferenceError();
    const createdAt = this.now().toISOString();
    const secret: Secret = { id: randomUUID(), tenantId: input.tenantId, name: input.name, currentVersion: 1, status: 'active', providerRef: input.providerRef, createdAt, expiresAt: input.expiresAt, createdBy: input.createdBy, __version: 1 };
    const version: SecretVersion = { id: randomUUID(), secretId: secret.id, tenantId: secret.tenantId, version: 1, providerRef: secret.providerRef, status: 'active', createdAt, expiresAt: secret.expiresAt, createdBy: input.createdBy, __version: 1 };
    await this.options.store.create(secret, version);
    await this.audit(secret, input.createdBy, 'secret.created', 1, 'success');
    return toMetadata(secret);
  }

  async describeSecret(input: SecretOperationInput): Promise<SecretMetadata | null> {
    const secret = await this.options.store.get(input.secretId);
    return secret && secret.tenantId === input.tenantId ? toMetadata(secret) : null;
  }

  async listSecrets(tenantId: string): Promise<readonly SecretMetadata[]> { return (await this.options.store.list(tenantId)).map(toMetadata); }

  async resolveSecret(input: SecretOperationInput): Promise<string> {
    const secret = await this.requireSecret(input);
    const version = await this.options.store.getVersion(secret.id, secret.currentVersion);
    if (!version) throw new SecretNotFoundError(secret.id);
    if (secret.status === 'revoked' || version.status === 'revoked') throw new SecretRevokedError(secret.id);
    if (secret.status !== 'active' || version.status !== 'active') throw new SecretResolutionDeniedError(secret.id);
    if (isExpired(secret.expiresAt) || isExpired(version.expiresAt)) throw new SecretExpiredError(secret.id);
    try {
      const value = await this.options.provider.resolve({ tenantId: secret.tenantId, secretId: secret.id, version: version.version, providerRef: version.providerRef, principalId: input.principalId });
      await this.audit(secret, input.principalId, 'secret.resolved', version.version, 'success');
      return value;
    } catch (error) {
      await this.audit(secret, input.principalId, 'secret.failed', version.version, 'failure');
      throw error;
    }
  }

  async rotateSecret(input: RotateSecretInput): Promise<SecretMetadata> {
    if (!input.providerRef.trim()) throw new InvalidSecretReferenceError();
    const current = await this.requireSecret({ tenantId: input.tenantId, secretId: input.secretId, principalId: input.rotatedBy });
    if (current.status !== 'active') throw new InvalidSecretLifecycleOperationError('Only active secrets can be rotated');
    const createdAt = this.now().toISOString();
    const version: SecretVersion = { id: randomUUID(), secretId: current.id, tenantId: current.tenantId, version: current.currentVersion + 1, providerRef: input.providerRef, status: 'active', createdAt, expiresAt: input.expiresAt, createdBy: input.rotatedBy, __version: 1 };
    const updated: Secret = { ...current, currentVersion: version.version, providerRef: version.providerRef, expiresAt: version.expiresAt, __version: current.__version + 1 };
    await this.options.store.rotate(updated, version);
    await this.audit(updated, input.rotatedBy, 'secret.rotated', version.version, 'success');
    return toMetadata(updated);
  }

  async revokeSecret(input: SecretOperationInput): Promise<SecretMetadata> {
    const current = await this.requireSecret(input);
    if (current.status === 'retired') throw new InvalidSecretLifecycleOperationError('Retired secrets cannot be revoked');
    const revokedAt = this.now().toISOString();
    const updated = { ...current, status: 'revoked' as const, revokedAt, __version: current.__version + 1 };
    const version = await this.options.store.getVersion(current.id, current.currentVersion);
    await this.options.store.update(updated);
    if (version) await this.options.store.updateVersion({ ...version, status: 'revoked', revokedAt, __version: version.__version + 1 });
    await this.audit(updated, input.principalId, 'secret.revoked', current.currentVersion, 'success');
    return toMetadata(updated);
  }

  async retireSecret(input: SecretOperationInput): Promise<SecretMetadata> {
    const current = await this.requireSecret(input);
    if (current.status === 'retired') return toMetadata(current);
    const retiredAt = this.now().toISOString();
    const updated = { ...current, status: 'retired' as const, retiredAt, __version: current.__version + 1 };
    await this.options.store.update(updated);
    await this.audit(updated, input.principalId, 'secret.retired', current.currentVersion, 'success');
    return toMetadata(updated);
  }

  private async requireSecret(input: SecretOperationInput): Promise<Secret> {
    const secret = await this.options.store.get(input.secretId);
    if (!secret || secret.tenantId !== input.tenantId) throw new SecretNotFoundError(input.secretId);
    return secret;
  }
  private async audit(secret: Secret, principalId: string, type: SecretAuditEvent['type'], version: number, result: SecretAuditEvent['result']): Promise<void> {
    await this.options.auditSink.record({ id: randomUUID(), type, secretId: secret.id, version, tenantId: secret.tenantId, principalId, timestamp: this.now().toISOString(), result });
  }
}

function toMetadata(secret: Secret): SecretMetadata { const { __version: _version, ...metadata } = secret; return metadata; }
function isExpired(value?: string): boolean { return value !== undefined && Date.parse(value) <= Date.now(); }
