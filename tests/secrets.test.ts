import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemorySecretAuditSink,
  InMemorySecretStore,
  InvalidSecretLifecycleOperationError,
  SecretExpiredError,
  SecretRevokedError,
  SecretsService,
} from '../src/index.js';

function makeService(value = 'material'): { service: SecretsService; audit: InMemorySecretAuditSink } {
  const audit = new InMemorySecretAuditSink();
  return {
    audit,
    service: new SecretsService({
      store: new InMemorySecretStore(),
      provider: { resolve: async () => value },
      auditSink: audit,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    }),
  };
}

test('Secrets metadata and resolution are distinct operations', async () => {
  const { service, audit } = makeService();
  const metadata = await service.registerSecret({ tenantId: 'tenant-a', name: 'database', providerRef: 'vault://db', createdBy: 'operator' });
  assert.equal('providerRef' in metadata, true);
  assert.equal('secret' in metadata, false);
  const resolved = await service.resolveSecret({ tenantId: 'tenant-a', secretId: metadata.id, principalId: 'worker' });
  assert.equal(resolved, 'material');
  assert.equal(audit.events.some((event) => event.type === 'secret.resolved'), true);
  assert.equal(JSON.stringify(audit.events).includes('material'), false);
});

test('Secrets rotate and revoke without changing logical identity', async () => {
  const { service } = makeService();
  const first = await service.registerSecret({ tenantId: 'tenant-a', name: 'database', providerRef: 'vault://db/1', createdBy: 'operator' });
  const rotated = await service.rotateSecret({ tenantId: 'tenant-a', secretId: first.id, providerRef: 'vault://db/2', rotatedBy: 'operator' });
  assert.equal(rotated.id, first.id);
  assert.equal(rotated.currentVersion, 2);
  await service.revokeSecret({ tenantId: 'tenant-a', secretId: first.id, principalId: 'operator' });
  await assert.rejects(
    service.resolveSecret({ tenantId: 'tenant-a', secretId: first.id, principalId: 'worker' }),
    SecretRevokedError,
  );
});

test('Secrets reject expired and invalid lifecycle operations', async () => {
  const { service } = makeService();
  const expired = await service.registerSecret({ tenantId: 'tenant-a', name: 'old', providerRef: 'vault://old', createdBy: 'operator', expiresAt: '2025-01-01T00:00:00.000Z' });
  await assert.rejects(service.resolveSecret({ tenantId: 'tenant-a', secretId: expired.id, principalId: 'worker' }), SecretExpiredError);
  await service.retireSecret({ tenantId: 'tenant-a', secretId: expired.id, principalId: 'operator' });
  await assert.rejects(
    service.rotateSecret({ tenantId: 'tenant-a', secretId: expired.id, providerRef: 'vault://new', rotatedBy: 'operator' }),
    InvalidSecretLifecycleOperationError,
  );
});
