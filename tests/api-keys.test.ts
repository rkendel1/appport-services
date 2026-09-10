import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApiKeyService, createFeltDbRuntime, FeltDbAuditSink, FeltDbApiKeyStore, ApiKeyService, authenticateBearerToken, auditCollectionName } from '../src/index.js';

async function createLocalService(prefix = 'appport-services-test-'): Promise<{ service: ApiKeyService; path: string }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: prefix + Math.random().toString(16).slice(2), path });
  const service = new ApiKeyService({
    store: new FeltDbApiKeyStore(runtime.db),
    auditSink: new FeltDbAuditSink(runtime.db),
    runtime,
  });
  return { service, path };
}

test('creates key, returns secret once, persists hash, tenant, and scopes', async () => {
  const { service } = await createLocalService();
  const created = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'production',
    scopes: ['invoices.read', 'users.read'],
    createdBy: 'ops-1',
  });

  const fetched = await service.getApiKey('tenant-a', created.id);
  const stored = await service.runtime?.db.collection('api_keys').get(created.id) as Record<string, unknown> | null;

  assert.ok(fetched);
  assert.equal(fetched?.tenantId, 'tenant-a');
  assert.deepEqual(fetched?.scopes, ['invoices.read', 'users.read']);
  assert.ok(created.secret.startsWith(`${created.prefix}_`));
  assert.ok(stored);
  assert.equal('secret' in (stored ?? {}), false);
  assert.equal('secretHash' in (stored ?? {}), true);
  assert.notEqual(stored?.secretHash, created.secret);
  await service.close();
});

test('get and list never return raw secrets', async () => {
  const { service } = await createLocalService();
  const created = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'production',
    scopes: ['invoices.read'],
    createdBy: 'ops-1',
  });

  const fetched = await service.getApiKey('tenant-a', created.id);
  const listed = await service.listApiKeys('tenant-a');

  assert.ok(fetched);
  assert.equal('secret' in fetched, false);
  assert.equal('secretHash' in fetched, false);
  assert.equal('secret' in listed[0], false);
  await service.close();
});

test('valid secret authenticates a machine principal and updates last used', async () => {
  const { service } = await createLocalService();
  const created = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'production',
    scopes: ['invoices.read'],
    expiresAt: new Date(Date.now() + 60_000),
    createdBy: 'ops-1',
  });

  const principal = await service.authenticateApiKey(created.secret);
  const stored = await service.runtime?.db.collection('api_keys').get(created.id) as Record<string, unknown> | null;

  assert.deepEqual(principal, {
    principalId: created.id,
    principalType: 'api_key',
    tenantId: 'tenant-a',
    scopes: ['invoices.read'],
    credentialId: created.id,
  });
  assert.ok(stored?.lastUsedAt);
  assert.equal('isAllowed' in (principal ?? {}), false);
  await service.close();
});

test('invalid, unknown, revoked, and expired keys fail', async () => {
  const { service } = await createLocalService();
  const created = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'production',
    scopes: ['invoices.read'],
    expiresAt: new Date(Date.now() + 5_000),
    createdBy: 'ops-1',
  });
  const expired = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'expired',
    scopes: ['invoices.read'],
    expiresAt: new Date(Date.now() - 5_000),
    createdBy: 'ops-1',
  });

  await service.revokeApiKey({ tenantId: 'tenant-a', id: created.id, revokedBy: 'ops-2' });

  assert.equal(await service.authenticateApiKey(`${created.secret}x`), null);
  assert.equal(await service.authenticateApiKey('app_live_missing_secret'), null);
  assert.equal(await service.authenticateApiKey(created.secret), null);
  assert.equal(await service.authenticateApiKey(expired.secret), null);
  await service.close();
});

test('tenant isolation prevents cross-tenant access and preserves owning tenant on auth', async () => {
  const { service } = await createLocalService();
  const created = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'production',
    scopes: ['invoices.read'],
    createdBy: 'ops-1',
  });
  const other = await service.createApiKey({
    tenantId: 'tenant-b',
    name: 'staging',
    scopes: ['users.read'],
    createdBy: 'ops-2',
  });

  assert.equal(await service.getApiKey('tenant-b', created.id), null);
  assert.equal(await service.revokeApiKey({ tenantId: 'tenant-b', id: created.id, revokedBy: 'ops-2' }), null);
  assert.deepEqual((await service.listApiKeys('tenant-a')).map((item) => item.id), [created.id]);
  assert.deepEqual((await service.listApiKeys('tenant-b')).map((item) => item.id), [other.id]);
  assert.equal((await service.authenticateApiKey(created.secret))?.tenantId, 'tenant-a');
  await service.close();
});

test('bearer adapter authenticates without tenant override input', async () => {
  const { service } = await createLocalService();
  const created = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'production',
    scopes: ['invoices.read'],
    createdBy: 'ops-1',
  });

  const principal = await authenticateBearerToken('Bearer ' + created.secret, service);

  assert.equal(principal?.tenantId, 'tenant-a');
  await service.close();
});

test('raw secret is absent from FeltDB records and durable audit records', async () => {
  const { service, path } = await createLocalService();
  const created = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'production',
    scopes: ['invoices.read'],
    createdBy: 'ops-1',
  });
  await service.authenticateApiKey(created.secret);

  const auditRecords = await service.runtime?.db.collection(auditCollectionName()).list() as Array<Record<string, unknown>>;
  const persisted = await readFile(join(path, 'state.json'), 'utf8');

  assert.equal(persisted.includes(created.secret), false);
  assert.equal(JSON.stringify(auditRecords).includes(created.secret), false);
  await service.close();
});

test('generated secrets have high entropy and wrong secrets fail', async () => {
  const { service } = await createLocalService();
  const created = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'production',
    scopes: ['invoices.read'],
    createdBy: 'ops-1',
  });

  assert.ok(created.secret.length >= 40);
  assert.equal(await service.authenticateApiKey(created.secret.replace(/.$/, 'x')), null);
  await service.close();
});

test('restart preserves credentials with real FeltDB file persistence', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-services-restart-'));
  const namespace = 'restart-' + Math.random().toString(16).slice(2);
  const first = createApiKeyService({ mode: 'local', namespace, path });
  const created = await first.createApiKey({
    tenantId: 'tenant-a',
    name: 'production',
    scopes: ['invoices.read'],
    createdBy: 'ops-1',
  });
  await first.close();

  const second = createApiKeyService({ mode: 'local', namespace, path });
  const principal = await second.authenticateApiKey(created.secret);

  assert.equal(principal?.credentialId, created.id);
  await second.close();
});

test('restart then revoke then restart fails authentication', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-services-revoke-'));
  const namespace = 'revoke-' + Math.random().toString(16).slice(2);
  const first = createApiKeyService({ mode: 'local', namespace, path });
  const created = await first.createApiKey({
    tenantId: 'tenant-a',
    name: 'production',
    scopes: ['invoices.read'],
    createdBy: 'ops-1',
  });
  await first.close();

  const second = createApiKeyService({ mode: 'local', namespace, path });
  await second.revokeApiKey({ tenantId: 'tenant-a', id: created.id, revokedBy: 'ops-2' });
  await second.close();

  const third = createApiKeyService({ mode: 'local', namespace, path });
  assert.equal(await third.authenticateApiKey(created.secret), null);
  await third.close();
});
