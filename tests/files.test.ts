import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFeltDbRuntime, FeltDbFileAuditSink, FeltDbFileStore, FileService } from '../src/_internal.js';
import { ServiceAuthorityError } from '../src/authority/errors.js';
import { principal as verified, testGateway, TestAuthority } from './support/authority.js';

const principal = (id = 'owner-a') => verified({ principalId: id, principalType: 'api_key', tenantId: 'tenant-a', credentialId: 'key' });

/** AuthBoundry policy used here: owners may read and write their own files. */
async function ownerPolicy(): Promise<TestAuthority> {
  const authority = new TestAuthority();
  for (const owner of ['owner-a', 'owner-b']) {
    for (const capability of ['files.read', 'files.write', 'files.delete']) {
      await authority.grant({ subject: owner, capability, tenantId: 'tenant-a', attributes: { owner } });
    }
  }
  return authority;
}

async function service(path: string, authority?: TestAuthority) {
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: `files-${Math.random()}`, path });
  return {
    runtime,
    service: new FileService({
      store: new FeltDbFileStore(runtime.db),
      auditSink: new FeltDbFileAuditSink(runtime.db),
      authority: testGateway(runtime.db, { authorizer: authority ?? await ownerPolicy() }),
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

test('files enforce tenant and owner isolation through AuthBoundry', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-files-auth-'));
  const { runtime, service: files } = await service(path);
  const created = await files.create({
    tenantId: 'tenant-a',
    owner: 'owner-a',
    name: 'secret.txt',
    size: 1,
    storageKey: 'blob/secret.txt',
  }, principal());

  await assert.rejects(files.get('tenant-a', created.id, principal('owner-b')), (error: unknown) => error instanceof ServiceAuthorityError && error.code === 'DENIED');
  await assert.rejects(files.list('tenant-a', principal('owner-b')), (error: unknown) => error instanceof ServiceAuthorityError && error.code === 'DENIED');
  assert.equal((await files.list('tenant-a', principal('owner-b'), { owner: 'owner-b' })).length, 0);
  await assert.rejects(files.get('tenant-b', created.id, principal()), (error: unknown) => error instanceof ServiceAuthorityError && error.code === 'DENIED');
  await runtime.db.close();
});
