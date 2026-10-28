import { randomUUID } from 'node:crypto';

import type { StateFirstDB } from '@feltdb/core';

import type { Secret, SecretAuditEvent, SecretResolutionFailureCode, SecretVersion } from '../secrets/models.js';

/**
 * Durable, value-free metadata for credentials stored through a host's
 * `SecretCustody` (`credential.store`): `Secrets`, `SecretVersions` and
 * `SecretAuditEvents` in the application Flow. These rows carry the logical id,
 * the credential reference, provider/kind classification, the version the host
 * assigned, timestamps, principal and purpose. They never carry the value.
 */
export interface SecretMetadataStore {
  /** Record that a new version was stored. Returns whether this was the reference's first version. */
  recordStored(input: SecretStoredRecord): Promise<{ readonly created: boolean }>;
  /** Record a refused or failed store (no version). */
  recordFailure(input: SecretFailureRecord): Promise<void>;
}

export interface SecretStoredRecord {
  readonly tenantId: string;
  /** The credential-ref id (`SecretReference.secretId`). */
  readonly secretId: string;
  /** The `credential-ref:<id>` itself: an opaque provider reference, never material. */
  readonly providerRef: string;
  readonly provider?: string;
  readonly kind?: string;
  readonly version: number;
  readonly storedAt: string;
  readonly principalId: string;
  readonly purpose: string;
}

export interface SecretFailureRecord {
  readonly tenantId: string;
  readonly secretId: string;
  readonly provider?: string;
  readonly principalId: string;
  readonly purpose: string;
  readonly reason: SecretResolutionFailureCode;
  readonly timestamp: string;
}

const SECRETS = 'Secrets';
const VERSIONS = 'SecretVersions';
const AUDIT = 'SecretAuditEvents';

export const secretMetadataCollectionNames = { secrets: SECRETS, versions: VERSIONS, audit: AUDIT } as const;

export class FeltDbSecretMetadataStore implements SecretMetadataStore {
  private readonly secrets;
  private readonly versions;
  private readonly audit;

  constructor(db: StateFirstDB) {
    this.secrets = db.collection<Secret>(SECRETS);
    this.versions = db.collection<SecretVersion>(VERSIONS);
    this.audit = db.collection<SecretAuditEvent>(AUDIT);
  }

  async recordStored(input: SecretStoredRecord): Promise<{ readonly created: boolean }> {
    const [existing] = await this.secrets.find({ tenantId: input.tenantId, name: input.secretId });
    let secret: Secret;
    if (existing) {
      secret = { ...existing, currentVersion: input.version, status: 'active', providerRef: input.providerRef, ...(input.provider ? { provider: input.provider } : {}), ...(input.kind ? { kind: input.kind } : {}) };
      await this.secrets.update(existing.id, secret);
      for (const previous of await this.versions.find({ secretId: existing.id, status: 'active' })) {
        await this.versions.update(previous.id, { ...previous, status: 'retired' });
      }
    } else {
      secret = {
        id: randomUUID(),
        tenantId: input.tenantId,
        name: input.secretId,
        currentVersion: input.version,
        status: 'active',
        providerRef: input.providerRef,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        createdAt: input.storedAt,
        createdBy: input.principalId,
      };
      await this.secrets.insert(secret, secret.id);
    }
    const version: SecretVersion = {
      id: randomUUID(), secretId: secret.id, tenantId: input.tenantId, version: input.version,
      providerRef: input.providerRef, status: 'active', createdAt: input.storedAt, createdBy: input.principalId,
    };
    await this.versions.insert(version, version.id);
    const event: SecretAuditEvent = {
      id: randomUUID(), type: existing ? 'secret.rotated' : 'secret.created', secretId: secret.id, version: input.version,
      tenantId: input.tenantId, principalId: input.principalId, timestamp: input.storedAt, result: 'success', purpose: input.purpose,
      ...(input.provider ? { provider: input.provider } : {}),
    };
    await this.audit.insert(event, event.id);
    return { created: !existing };
  }

  async recordFailure(input: SecretFailureRecord): Promise<void> {
    const [existing] = await this.secrets.find({ tenantId: input.tenantId, name: input.secretId });
    const event: SecretAuditEvent = {
      id: randomUUID(), type: 'secret.failed', secretId: existing?.id ?? input.secretId, tenantId: input.tenantId,
      principalId: input.principalId, timestamp: input.timestamp, result: 'failure', purpose: input.purpose, reason: input.reason,
      ...(input.provider ? { provider: input.provider } : {}),
    };
    await this.audit.insert(event, event.id);
  }
}
