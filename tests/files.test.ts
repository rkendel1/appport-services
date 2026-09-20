import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFeltDbRuntime, FeltDbFileAuditSink, FeltDbFileStore, FileAuthorizationError, FileService } from '../src/_internal.js';
import type { AuthenticatedPrincipal } from '../src/contract/principals.js';

const principal = (id = 'owner-a', scopes = ['files.create', 'files.read', 'files.write', 'files.delete']): AuthenticatedPrincipal => ({
  principalId: id, principalType: 'api_key', tenantId: 'tenant-a', scopes, credentialId: 'key',
});

async function service(path: string) {
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: `files-${Math.random()}`, path });
  return {
    runtime,
    service: new FileService({
      store: new FeltDbFileStore(runtime.db),
      auditSink: new FeltDbFileAuditSink(runtime.db),
    }),
  };
}

test('files persist in FeltDB and update metadata durably', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-files-'));
  const first = await service(path);
  const created = await first.service.create({
    tenantId: 'tenant-a',
    owner: 'owner-a',
    name: 'invoice.pdf',
    size: 128,
    storageKey: 'blob/invoice.pdf',
    metadata: { invoiceId: 'inv-1' },
  }, principal());
  const updated = await first.service.update({
    tenantId: 'tenant-a',
    id: created.id,
    size: 256,
    checksum: 'abc123',
  }, principal());
  assert.equal(updated.size, 256);
  await first.runtime.db.close();

  const restarted = await service(path);
  const fetched = await restarted.service.get('tenant-a', created.id, principal());
  assert.equal(fetched.storageKey, 'blob/invoice.pdf');
  assert.equal(fetched.checksum, 'abc123');
  await restarted.runtime.db.close();
});

test('files enforce tenant and owner isolation', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-files-auth-'));
  const { runtime, service: files } = await service(path);
  const created = await files.create({
    tenantId: 'tenant-a',
    owner: 'owner-a',
    name: 'secret.txt',
    size: 1,
    storageKey: 'blob/secret.txt',
  }, principal());

  await assert.rejects(
    files.get('tenant-a', created.id, principal('owner-b', ['files.read'])),
    FileAuthorizationError,
  );
  assert.equal((await files.list('tenant-a', principal('owner-b', ['files.read']))).length, 0);
  await runtime.db.close();
});
