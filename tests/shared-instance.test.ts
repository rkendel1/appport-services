import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFeltDB } from '@feltdb/core';

import { createServices } from '../src/_internal.js';
import { TestAuthority } from './support/authority.js';

const options = { authorizer: new TestAuthority({ allowAll: true }) };

test('createServices({ db }) runs every service on the host-supplied instance', async () => {
  const path = await mkdtemp(join(tmpdir(), 'shared-instance-'));
  const db = createFeltDB({ mode: 'local', namespace: 'host-app', path });
  const services = createServices({ db, application: 'host-app', ...options });
  assert.equal(services._getDb, db, 'no second instance was opened');

  const principal = services.identify({ principalId: 'ada', principalType: 'user', tenantId: 'acme' })!;
  const created = await services.apiKeys.createApiKey({ name: 'shared' }, principal);
  const file = await services.files.create({ name: 'a.txt', size: 1, storageKey: 'k' }, principal);

  // The host sees service state and evidence through its own handle.
  assert.ok(await db.collection('api_keys').get(created.id));
  assert.ok(await db.collection('files').get(file.id));
  assert.ok((await db.collection('service_effect_evidence').find({})).length > 0);

  // Application state written by the host is visible inside a services transaction, and vice versa.
  await db.collection('invoices').insert({ total: 10 }, 'inv-1');
  await services.transaction(async (tx) => {
    await tx.collection<{ total: number }>('invoices').insert({ total: 20 }, 'inv-2');
  });
  assert.equal(((await db.collection<{ total: number }>('invoices').get('inv-2')) as { total: number }).total, 20);

  // Closing services does not close the host's instance.
  await services.apiKeys.close();
  assert.ok(await db.collection('invoices').get('inv-1'), 'the host instance is still open');
  await db.close();
});

test('createServices() without db still opens and owns its own instance', async () => {
  const path = await mkdtemp(join(tmpdir(), 'owned-instance-'));
  const services = createServices({ mode: 'local', namespace: 'standalone', path, ...options });
  assert.ok(services._getDb);
  assert.equal(services.db, services._getDb, 'services.db is the instance services opened');
  assert.equal(services.ownsDb, true);
  assert.equal(services.usesInstance(services.db), true);
  const other = createFeltDB({ memory: true, namespace: 'standalone' });
  assert.equal(services.usesInstance(other), false, 'a different instance with the same namespace is not the one in use');
  await other.close();
  await services.apiKeys.close();
});

test('services.db and services.usesInstance(db) report the host-supplied instance (local, memory, remote)', async () => {
  const path = await mkdtemp(join(tmpdir(), 'uses-instance-'));
  const local = createFeltDB({ mode: 'local', namespace: 'uses-local', path });
  const memory = createFeltDB({ memory: true, namespace: 'uses-memory' });
  // A remote instance connects lazily, so constructing services needs no server.
  const remote = createFeltDB({ namespace: 'uses-remote', server: { url: 'http://127.0.0.1:9', token: 'test-token' } });
  for (const db of [local, memory, remote]) {
    const services = createServices({ db, application: 'uses', ...options });
    assert.equal(services.db, db);
    assert.equal(services.ownsDb, false, 'a host-supplied instance is never owned');
    assert.equal(services.usesInstance(db), true);
    for (const other of [local, memory, remote].filter((candidate) => candidate !== db)) assert.equal(services.usesInstance(other), false);
    assert.equal(services.usesInstance(undefined), false);
    assert.equal(services.usesInstance({}), false);
  }
  // Read-only: the property cannot be pointed at another instance.
  const services = createServices({ db: memory, application: 'uses', ...options });
  assert.throws(() => { (services as { db: unknown }).db = local; });
  assert.equal(services.db, memory);
  await local.close();
  await memory.close();
});

test('createServices({ db }) accepts every deployment mode of a host instance, including remote', async () => {
  const memory = createFeltDB({ memory: true, namespace: 'host-memory' });
  assert.equal(createServices({ db: memory, application: 'm', ...options })._getDb, memory);
  // A remote instance connects lazily, so constructing services needs no server.
  const remote = createFeltDB({ namespace: 'host-remote', server: { url: 'http://127.0.0.1:9', token: 'test-token' } });
  const services = createServices({ db: remote, application: 'r', ...options });
  assert.equal(services._getDb, remote);
  await memory.close();
});
