import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFeltDbRuntime, FeltDbFileAuditSink, FeltDbFileStore, FileService } from '../src/_internal.js';
import { ServiceAuthorityError } from '../src/authority/errors.js';
import type { File } from '../src/files/models.js';
import { principal as verified, testGateway, TestAuthority } from './support/authority.js';

/**
 * FileService.references: which live files name a storage key, by a bounded lookup on the
 * `storageKey` index. A caller releasing a file's bytes asks it first, and releases only on a
 * complete answer with no live file.
 */
const who = (id: string) => verified({ principalId: id, principalType: 'api_key', tenantId: 'tenant-a', credentialId: 'key' });

async function setup() {
  const authority = new TestAuthority();
  for (const capability of ['files.read', 'files.write', 'files.delete']) await authority.grant({ subject: 'owner-a', capability, tenantId: 'tenant-a', attributes: { owner: 'owner-a' } });
  // The reference lookup reads across owners (owner "*"): only a principal granted that may ask.
  await authority.grant({ subject: 'releaser', capability: 'files.read', tenantId: 'tenant-a', attributes: { owner: '*' } });
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: `refs-${Math.random()}`, path: await mkdtemp(join(tmpdir(), 'appport-refs-')) });
  const store = new FeltDbFileStore(runtime.db);
  const service = new FileService({ store, auditSink: new FeltDbFileAuditSink(runtime.db), authority: testGateway(runtime.db, { authorizer: authority }) });
  const create = (storageKey: string, name = 'f') => service.create({ tenantId: 'tenant-a', owner: 'owner-a', name, size: 1, storageKey }, who('owner-a'));
  /** Many records quickly (straight to the store): the volume the lookup must stay bounded at. */
  const fill = async (n: number, prefix: string) => {
    const now = new Date().toISOString();
    for (let i = 0; i < n; i++) {
      await store.create({ id: `${prefix}-${i}`, tenantId: 'tenant-a', applicationId: service['gateway']().application, owner: 'owner-a', name: 'f', size: 1, storageKey: `${prefix}/${i}`, createdAt: now, updatedAt: now, __version: 1 } as File);
    }
  };
  return { runtime, store, service, create, fill, releaser: who('releaser') };
}

test('a shared storage key: every live file naming it, and complete', async () => {
  const t = await setup();
  try {
    const a = await t.create('blob/shared', 'a');
    const b = await t.create('blob/shared', 'b');
    await t.create('blob/other');
    const refs = await t.service.references('tenant-a', 'blob/shared', t.releaser);
    assert.deepEqual({ ...refs, live: [...refs.live].sort() }, { storageKey: 'blob/shared', live: [a.id, b.id].sort(), complete: true });
  } finally {
    await t.runtime.db.close();
  }
});

test('soft-deleted files are not references; a key no file names is complete and empty', async () => {
  const t = await setup();
  try {
    const a = await t.create('blob/x');
    await t.service.delete('tenant-a', a.id, who('owner-a'));
    assert.deepEqual(await t.service.references('tenant-a', 'blob/x', t.releaser), { storageKey: 'blob/x', live: [], complete: true }, 'a deleted record keeps its key, but is not a reference');
    assert.deepEqual(await t.service.references('tenant-a', 'blob/never', t.releaser), { storageKey: 'blob/never', live: [], complete: true });
    await assert.rejects(t.service.references('tenant-a', '', t.releaser), /storageKey is required/);
    await assert.rejects(t.service.references('tenant-a', 'blob/x', t.releaser, { limit: 0 }), /limit/);
  } finally {
    await t.runtime.db.close();
  }
});

test('more live files than the limit, or more records than examined: complete is false (a lower bound, never "none")', async () => {
  const t = await setup();
  try {
    for (const n of ['a', 'b', 'c']) await t.create('blob/many', n);
    const one = await t.service.references('tenant-a', 'blob/many', t.releaser, { limit: 1 });
    assert.deepEqual([one.live.length, one.complete], [1, false]);
    // The store's examination bound: asked for 2 of 3 records naming the key, it says it stopped.
    const page = await t.store.findByStorageKey('tenant-a', 'blob/many', 2);
    assert.deepEqual([page.records.length, page.exhausted], [2, false]);
  } finally {
    await t.runtime.db.close();
  }
});

test('unauthorized: a caller without files.read across owners is refused; nothing is revealed', async () => {
  const t = await setup();
  try {
    await t.create('blob/secret');
    await assert.rejects(t.service.references('tenant-a', 'blob/secret', who('owner-a')), (error: unknown) => error instanceof ServiceAuthorityError && error.code === 'DENIED');
    await assert.rejects(t.service.references('tenant-a', 'blob/secret', who('stranger')), (error: unknown) => error instanceof ServiceAuthorityError && error.code === 'DENIED');
  } finally {
    await t.runtime.db.close();
  }
});

test('beyond 1,000 file records: the lookup answers from the index, and list() returns every record instead of refusing', async () => {
  const t = await setup();
  try {
    await t.fill(1_200, 'bulk');
    const a = await t.create('blob/needle', 'a');
    const b = await t.create('blob/needle', 'b');
    const refs = await t.service.references('tenant-a', 'blob/needle', t.releaser);
    assert.deepEqual({ live: [...refs.live].sort(), complete: refs.complete }, { live: [a.id, b.id].sort(), complete: true });
    const everything = await t.service.list('tenant-a', t.releaser);
    assert.equal(everything.length, 1_202, 'list() pages internally: complete, no QUERY_LIMIT_EXCEEDED');
  } finally {
    await t.runtime.db.close();
  }
});

test('a store without the lookup is refused, not answered as "no references"', async () => {
  const t = await setup();
  try {
    const legacy = { create: t.store.create.bind(t.store), get: t.store.get.bind(t.store), list: t.store.list.bind(t.store), update: t.store.update.bind(t.store) };
    const old = new FileService({ store: legacy, auditSink: new FeltDbFileAuditSink(t.runtime.db), authority: t.service['options'].authority });
    await assert.rejects(old.references('tenant-a', 'blob/x', t.releaser), /cannot look up references/);
  } finally {
    await t.runtime.db.close();
  }
});

test('every page of a lookup asks for the same limit: a managed authority binds its cursor to it', async () => {
  const t = await setup();
  try {
    await t.fill(0, 'none');
    const now = new Date().toISOString();
    for (let i = 0; i < 2_100; i++) await t.store.create({ id: `same-${i}`, tenantId: 'tenant-a', applicationId: t.service['gateway']().application, owner: 'owner-a', name: 'f', size: 1, storageKey: 'blob/same', createdAt: now, updatedAt: now, __version: 1 } as File);
    const db = t.runtime.db as unknown as { query: (request: { limit?: number }) => Promise<unknown> };
    const limits: number[] = [];
    const original = db.query.bind(db);
    db.query = (request) => { limits.push(Number(request.limit)); return original(request); };
    try {
      const found = await t.store.findByStorageKey('tenant-a', 'blob/same', 2_500);
      assert.deepEqual([found.records.length, found.exhausted], [2_100, true]);
      assert.ok(limits.length >= 3, `paged: ${limits}`);
      assert.equal(new Set(limits).size, 1, `one limit on every page, got ${limits}`);
    } finally {
      db.query = original;
    }
  } finally {
    await t.runtime.db.close();
  }
});
