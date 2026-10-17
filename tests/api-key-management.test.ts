import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test from 'node:test';

import express from 'express';

import { createFeltDbRuntime, FeltDbAuditSink, FeltDbApiKeyStore, ApiKeyService, auditCollectionName } from '../src/_internal.js';
import type { ApiKeyStore } from '../src/storage/api-keys.js';
import type { ApiKey } from '../src/api-keys/models.js';
import { createManagementRouter, createServices, type PrincipalClaims } from '../src/index.js';
import { ServiceAuthorityError } from '../src/authority/errors.js';
import { principal as mint, testGateway, TestAuthority } from './support/authority.js';
import { openStack } from './support/stack.js';

const opsA = () => mint({ principalId: 'ops-1', tenantId: 'tenant-a' });
const opsB = () => mint({ principalId: 'ops-2', tenantId: 'tenant-b' });

const code = (expected: string, reason?: string) => (error: unknown) => {
  assert.ok(error instanceof ServiceAuthorityError, `expected ServiceAuthorityError, got ${String(error)}`);
  assert.equal(error.code, expected, error.message);
  if (reason) assert.equal(error.details.reason, reason);
  return true;
};

/** A clock tests can move. */
function clock(start = Date.now()) {
  let at = start;
  return { now: () => new Date(at), advance: (ms: number) => { at += ms; } };
}

async function localService(options: { authorizer?: TestAuthority; now?: () => Date; verifierKey?: string; store?: (inner: ApiKeyStore) => ApiKeyStore } = {}) {
  const path = await mkdtemp(join(tmpdir(), 'appport-keymgmt-'));
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: 'keymgmt-' + Math.random().toString(16).slice(2), path });
  const inner = new FeltDbApiKeyStore(runtime.db);
  const authorizer = options.authorizer ?? new TestAuthority({ allowAll: true });
  const gateway = testGateway(runtime.db, { authorizer });
  const make = (extra: { verifierKey?: string } = {}) => new ApiKeyService({
    store: options.store ? options.store(inner) : inner,
    auditSink: new FeltDbAuditSink(runtime.db),
    runtime,
    applicationId: 'test-app',
    authority: gateway,
    ...(options.now ? { now: options.now } : {}),
    ...(extra.verifierKey ?? options.verifierKey ? { verifierKey: extra.verifierKey ?? options.verifierKey } : {}),
  });
  return { service: make(), make, runtime, gateway, authorizer, path, inner };
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

test('update changes name, restrictions, and expiry without changing the secret, and is audited by field name', async () => {
  const { service, runtime } = await localService();
  const created = await service.createApiKey({ name: 'ci' }, opsA());
  const expiresAt = new Date(Date.now() + 3_600_000);
  const updated = await service.updateApiKey({ id: created.id, name: 'ci-deployer', restrictions: { capabilities: ['jobs.create', 'files.read'] }, expiresAt }, opsA());

  assert.equal(updated?.name, 'ci-deployer');
  assert.deepEqual(updated?.restrictions, { capabilities: ['files.read', 'jobs.create'] });
  assert.equal(updated?.expiresAt, expiresAt.toISOString());
  assert.equal(updated?.updatedBy, 'ops-1');
  assert.equal(updated?.status, 'active');
  assert.equal((await service.authenticateApiKey(created.secret))?.credentialId, created.id, 'the secret still authenticates');

  const cleared = await service.updateApiKey({ id: created.id, restrictions: null, expiresAt: null }, opsA());
  assert.equal(cleared?.restrictions, undefined);
  assert.equal(cleared?.expiresAt, undefined);
  // Read back from FeltDB, not the returned view: clearing must persist.
  const reread = await service.getApiKey('tenant-a', created.id);
  assert.equal(reread?.restrictions, undefined);
  assert.equal(reread?.expiresAt, undefined);
  assert.equal(reread?.name, 'ci-deployer');
  const stored = await runtime.db.collection<ApiKey>('api_keys').get(created.id);
  assert.ok(stored?.secretHash && stored.keyPrefix === created.prefix, 'credential identity survives the update');

  const events = await service.listApiKeyAuditEvents({ credentialId: created.id }, opsA());
  assert.deepEqual(events.filter((event) => event.type === 'api_key.updated').map((event) => event.changes), [['expiresAt', 'name', 'restrictions'], ['expiresAt', 'restrictions']]);
  assert.equal(JSON.stringify(await runtime.db.collection(auditCollectionName()).list()).includes(created.secret), false);

  await assert.rejects(service.updateApiKey({ id: created.id }, opsA()), code('INVALID_REQUEST'));
  await assert.rejects(service.updateApiKey({ id: created.id, restrictions: { capabilities: ['documents:read'] } }, opsA()), code('INVALID_REQUEST'));
  await assert.rejects(service.updateApiKey({ id: created.id, expiresAt: new Date('nope') }, opsA()), code('INVALID_REQUEST'));
  await service.revokeApiKey({ id: created.id }, opsA());
  await assert.rejects(service.updateApiKey({ id: created.id, name: 'again' }, opsA()), code('INVALID_REQUEST'));
  assert.equal(await service.updateApiKey({ id: 'missing', name: 'x' }, opsA()), null);
  await service.close();
});

test('list filters by status and creator and paginates with an id cursor; the no-option list is unchanged', async () => {
  const time = clock();
  const { service } = await localService({ now: time.now });
  const ids: string[] = [];
  for (const name of ['k1', 'k2', 'k3', 'k4']) { ids.push((await service.createApiKey({ name }, opsA())).id); time.advance(1000); }
  await service.createApiKey({ name: 'other' }, mint({ principalId: 'ops-9', tenantId: 'tenant-a' }));
  await service.revokeApiKey({ id: ids[1]! }, opsA());
  await service.updateApiKey({ id: ids[2]!, expiresAt: new Date(time.now().getTime() - 1) }, opsA());

  assert.equal((await service.listApiKeys('tenant-a')).length, 5);
  assert.deepEqual((await service.listApiKeys('tenant-a', { status: 'active', createdBy: 'ops-1' })).map((key) => key.name), ['k1', 'k4']);
  assert.deepEqual((await service.listApiKeys('tenant-a', { status: 'revoked' })).map((key) => key.name), ['k2']);
  assert.deepEqual((await service.listApiKeys('tenant-a', { status: 'expired' })).map((key) => key.name), ['k3']);
  const first = await service.listApiKeys('tenant-a', { limit: 2 });
  const second = await service.listApiKeys('tenant-a', { limit: 2, after: first.at(-1)!.id });
  const third = await service.listApiKeys('tenant-a', { limit: 2, after: second.at(-1)!.id });
  assert.deepEqual([...first, ...second, ...third].map((key) => key.name), ['k1', 'k2', 'k3', 'k4', 'other']);
  assert.deepEqual(await service.listApiKeys('tenant-a', { after: 'unknown-cursor' }), []);
  await assert.rejects(service.listApiKeys('tenant-a', { limit: 0 }), code('INVALID_REQUEST'));
  await assert.rejects(service.listApiKeys('tenant-a', { status: 'weird' as never }), code('INVALID_REQUEST'));
  await service.close();
});

test('malformed, unknown, expired, and revoked keys are rejected; nothing they present is persisted', async () => {
  const { service, path } = await localService();
  const created = await service.createApiKey({ name: 'prod' }, opsA());
  const marker = 'PRESENTEDWRONGSECRETMARKER';
  for (const value of ['', 'garbage', 'Bearer x', 'app_live_zzzzzz_abc', `${created.prefix}_${marker}`, 'app_live_000000_unknown', undefined as never, 42 as never]) {
    assert.equal(await service.authenticateApiKey(value), null, `rejects ${String(value)}`);
  }
  const persisted = await readFile(join(path, 'state.json'), 'utf8');
  assert.equal(persisted.includes(marker), false);
  assert.equal(persisted.includes(created.secret), false);
  await service.close();
});

// -----------------------------------------------------------------------------
// Restrictions: a ceiling that only narrows AuthBoundry
// -----------------------------------------------------------------------------

test('restrictions are default-deny, resource-scoped, checked before AuthBoundry, and never grant', async () => {
  const authorizer = new TestAuthority({ allowAll: true });
  const stack = await openStack({ authorizer });
  try {
    const services = stack.services;
    const admin = services.identify({ principalId: 'admin', principalType: 'user', tenantId: 'tenant-a' })!;
    const created = await services.apiKeys.createApiKey({
      name: 'reader',
      restrictions: { capabilities: ['files.read'], resources: [{ type: 'file', attributes: { owner: 'alice' } }] },
    }, admin);
    const key = (await services.apiKeys.authenticateApiKey(created.secret))!;
    assert.equal('restrictions' in key, false, 'the principal carries no permissions');

    await services.authorize('files.read', key, { type: 'file', attributes: { owner: 'alice' } });
    const asked = authorizer.requests.length;
    await assert.rejects(services.authorize('files.read', key, { type: 'file', attributes: { owner: 'bob' } }), code('DENIED', 'credential_restricted'));
    await assert.rejects(services.authorize('files.write', key, { type: 'file', attributes: { owner: 'alice' } }), code('DENIED', 'credential_restricted'));
    await assert.rejects(services.invoke('jobs.create', { type: 'x', payload: {} }, { principal: key }), code('DENIED', 'credential_restricted'));
    assert.equal(authorizer.requests.length, asked, 'AuthBoundry is not asked for what the key can never do');

    // Within the ceiling, AuthBoundry still decides: no grant, no effect.
    authorizer.mode = 'grants';
    await assert.rejects(services.authorize('files.read', key, { type: 'file', attributes: { owner: 'alice' } }), code('DENIED'));

    // An empty capability list denies everything.
    authorizer.mode = 'allow-all';
    const none = await services.apiKeys.createApiKey({ name: 'none', restrictions: { capabilities: [] } }, admin);
    const nobody = (await services.apiKeys.authenticateApiKey(none.secret))!;
    await assert.rejects(services.authorize('files.read', nobody, { type: 'file', attributes: { owner: 'alice' } }), code('DENIED', 'credential_restricted'));

    // A rule with an id never matches a collection read.
    const single = await services.apiKeys.createApiKey({ name: 'one-file', restrictions: { capabilities: ['files.read'], resources: [{ type: 'file', id: 'f-1' }] } }, admin);
    const one = (await services.apiKeys.authenticateApiKey(single.secret))!;
    await services.authorize('files.read', one, { type: 'file', id: 'f-1' });
    await assert.rejects(services.authorize('files.read', one, { type: 'file' }), code('DENIED', 'credential_restricted'));

    // Narrowing a live key applies to principals authenticated before the change.
    await services.apiKeys.updateApiKey({ id: created.id, restrictions: { capabilities: [] } }, admin);
    await assert.rejects(services.authorize('files.read', key, { type: 'file', attributes: { owner: 'alice' } }), code('DENIED', 'credential_restricted'));

    for (const restrictions of [{ capabilities: ['files.*'] }, { capabilities: ['jobs.execute'] }, { capabilities: 'files.read' }, { capabilities: ['files.read'], resources: [{}] }, { capabilities: ['files.read'], resources: [{ type: 'nope' }] }, { capabilities: [], extra: true }]) {
      await assert.rejects(services.apiKeys.createApiKey({ name: 'bad', restrictions: restrictions as never }, admin), code('INVALID_REQUEST'), JSON.stringify(restrictions));
    }
  } finally {
    await stack.close();
  }
});

test('an api_key principal not bound to a live credential is refused', async () => {
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  try {
    const forged = mint({ principalId: 'k', principalType: 'api_key', tenantId: 'tenant-a', credentialId: 'k' }, 'api_key');
    await assert.rejects(stack.services.authorize('files.read', forged, { type: 'file' }), code('DENIED', 'credential_unbound'));
  } finally {
    await stack.close();
  }
});

test('a key cannot create, widen, extend, or rotate a key broader than itself', async () => {
  const { service } = await localService();
  const expiresAt = new Date(Date.now() + 3_600_000);
  const manager = await service.createApiKey({ name: 'manager', expiresAt, restrictions: { capabilities: ['apikeys.create', 'apikeys.update', 'apikeys.rotate', 'files.read'] } }, opsA());
  const caller = (await service.authenticateApiKey(manager.secret))!;
  const broad = await service.createApiKey({ name: 'broad' }, opsA());

  await assert.rejects(service.createApiKey({ name: 'x' }, caller), code('DENIED', 'exceeds_credential_restrictions'));
  await assert.rejects(service.createApiKey({ name: 'x', expiresAt, restrictions: { capabilities: ['files.write'] } }, caller), code('DENIED', 'exceeds_credential_restrictions'));
  await assert.rejects(service.createApiKey({ name: 'x', restrictions: { capabilities: ['files.read'] } }, caller), code('DENIED', 'exceeds_credential_lifetime'));
  await assert.rejects(service.createApiKey({ name: 'x', expiresAt: new Date(expiresAt.getTime() + 1000), restrictions: { capabilities: ['files.read'] } }, caller), code('DENIED', 'exceeds_credential_lifetime'));
  await assert.rejects(service.rotateApiKey({ id: broad.id }, caller), code('DENIED', 'exceeds_credential_restrictions'));
  assert.equal((await service.getApiKey('tenant-a', broad.id))?.rotatedTo, undefined, 'a refused rotation changes nothing');

  const child = await service.createApiKey({ name: 'child', expiresAt, restrictions: { capabilities: ['files.read'] } }, caller);
  await assert.rejects(service.updateApiKey({ id: child.id, restrictions: null }, caller), code('DENIED', 'exceeds_credential_restrictions'));
  assert.ok(await service.updateApiKey({ id: child.id, name: 'renamed' }, caller), 'renaming does not widen');
  assert.ok(await service.rotateApiKey({ id: child.id }, caller));
  await service.close();
});

// -----------------------------------------------------------------------------
// Rotation
// -----------------------------------------------------------------------------

test('rotation without overlap revokes the old key in the same commit and discloses the new secret once', async () => {
  const { service, path } = await localService();
  const original = await service.createApiKey({ name: 'svc', restrictions: { capabilities: ['files.read'] } }, opsA());
  const rotated = (await service.rotateApiKey({ id: original.id }, opsA()))!;

  assert.equal(rotated.replaces, original.id);
  assert.equal(rotated.name, 'svc');
  assert.notEqual(rotated.secret, original.secret);
  assert.equal(await service.authenticateApiKey(original.secret), null);
  assert.equal((await service.authenticateApiKey(rotated.secret))?.credentialId, rotated.id);

  const old = await service.getApiKey('tenant-a', original.id);
  const replacement = await service.getApiKey('tenant-a', rotated.id);
  assert.equal(old?.status, 'revoked');
  assert.equal(old?.rotatedTo, rotated.id);
  assert.equal(replacement?.rotatedFrom, original.id);
  assert.deepEqual(replacement?.restrictions, { capabilities: ['files.read'] });
  for (const view of [old, replacement]) {
    assert.equal('secret' in view!, false);
    assert.equal('secretHash' in view!, false);
  }
  const types = (await service.listApiKeyAuditEvents({}, opsA())).map((event) => `${event.type}:${event.credentialId === original.id ? 'old' : 'new'}`);
  assert.ok(types.includes('api_key.rotated:old') && types.includes('api_key.created:new') && types.includes('api_key.revoked:old'), types.join());
  const persisted = await readFile(join(path, 'state.json'), 'utf8');
  assert.equal(persisted.includes(rotated.secret), false);

  await assert.rejects(service.rotateApiKey({ id: original.id }, opsA()), code('INVALID_REQUEST'), 'a replaced key is not rotated again');
  await assert.rejects(service.rotateApiKey({ id: rotated.id, overlapSeconds: -1 }, opsA()), code('INVALID_REQUEST'));
  await assert.rejects(service.rotateApiKey({ id: rotated.id, overlapSeconds: 8 * 24 * 3600 }, opsA()), code('INVALID_REQUEST'));
  assert.equal(await service.rotateApiKey({ id: 'missing' }, opsA()), null);
  await service.close();
});

test('rotation overlap keeps the old key valid only for the window, never beyond its existing expiry', async () => {
  const time = clock();
  const { service } = await localService({ now: time.now });
  const original = await service.createApiKey({ name: 'svc' }, opsA());
  const rotated = (await service.rotateApiKey({ id: original.id, overlapSeconds: 60 }, opsA()))!;
  assert.equal(rotated.replacedKeyValidUntil, new Date(time.now().getTime() + 60_000).toISOString());

  time.advance(30_000);
  assert.equal((await service.authenticateApiKey(original.secret))?.credentialId, original.id, 'old key works during the overlap');
  assert.ok(await service.authenticateApiKey(rotated.secret));
  time.advance(31_000);
  assert.equal(await service.authenticateApiKey(original.secret), null, 'old key stops after the overlap');
  assert.ok(await service.authenticateApiKey(rotated.secret));

  const short = await service.createApiKey({ name: 'short', expiresAt: new Date(time.now().getTime() + 10_000) }, opsA());
  const capped = (await service.rotateApiKey({ id: short.id, overlapSeconds: 3600 }, opsA()))!;
  assert.equal(capped.replacedKeyValidUntil, new Date(time.now().getTime() + 10_000).toISOString());
  assert.equal((await service.getApiKey('tenant-a', capped.id))?.expiresAt, capped.replacedKeyValidUntil, 'the replacement keeps the expiry');

  const expired = await service.createApiKey({ name: 'expired', expiresAt: new Date(time.now().getTime() - 1) }, opsA());
  await assert.rejects(service.rotateApiKey({ id: expired.id }, opsA()), code('INVALID_REQUEST'));
  await service.close();
});

test('concurrent rotations of one key produce exactly one replacement', async () => {
  const { service, make } = await localService();
  const other = make();
  const original = await service.createApiKey({ name: 'svc' }, opsA());
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => (index % 2 ? other : service).rotateApiKey({ id: original.id }, opsA())));
  const won = results.filter((result) => result.status === 'fulfilled');
  assert.equal(won.length, 1, JSON.stringify(results.map((result) => result.status)));
  for (const result of results) if (result.status === 'rejected') code('INVALID_REQUEST')(result.reason);
  const successors = (await service.listApiKeys('tenant-a', {})).filter((key) => key.rotatedFrom === original.id);
  assert.equal(successors.length, 1);
  assert.equal((await service.getApiKey('tenant-a', original.id))?.rotatedTo, successors[0]!.id);
  await service.close();
});

// -----------------------------------------------------------------------------
// Revocation, concurrency, isolation
// -----------------------------------------------------------------------------

test('revocation by an independent manager applies at once, including to principals already authenticated', async () => {
  const { service, make, gateway } = await localService();
  const second = make();
  const created = await service.createApiKey({ name: 'svc' }, opsA());
  const principal = (await service.authenticateApiKey(created.secret))!;
  await gateway.authorize('files.read', principal, { type: 'file', tenantId: 'tenant-a' });

  await second.revokeApiKey({ id: created.id }, opsA());
  assert.equal(await service.authenticateApiKey(created.secret), null, 'the first manager sees the revoke');
  await assert.rejects(gateway.authorize('files.read', principal, { type: 'file', tenantId: 'tenant-a' }), code('DENIED', 'credential_revoked'));
  await service.close();
});

test('revoke racing authentication: once revoke resolves, no authentication succeeds', async () => {
  const { service, make } = await localService();
  const other = make();
  const created = await service.createApiKey({ name: 'svc' }, opsA());
  const attempts = Array.from({ length: 8 }, () => other.authenticateApiKey(created.secret));
  const revoked = await service.revokeApiKey({ id: created.id }, opsA());
  await Promise.all(attempts);
  assert.equal(revoked?.status, 'revoked');
  for (let index = 0; index < 4; index += 1) {
    assert.equal(await other.authenticateApiKey(created.secret), null);
    assert.equal(await service.authenticateApiKey(created.secret), null);
  }
  // An update racing a revoke: both settle, and the key ends revoked either way.
  const target = await service.createApiKey({ name: 'race' }, opsA());
  const [update, revoke] = await Promise.allSettled([
    other.updateApiKey({ id: target.id, name: 'race-2' }, opsA()),
    service.revokeApiKey({ id: target.id }, opsA()),
  ]);
  assert.equal(revoke.status, 'fulfilled');
  if (update.status === 'rejected') code('INVALID_REQUEST')(update.reason);
  assert.equal((await service.getApiKey('tenant-a', target.id))?.status, 'revoked');
  assert.equal(await other.authenticateApiKey(target.secret), null);
  await service.close();
});

test('tenant isolation: another tenant cannot read, update, rotate, revoke, revoke-all, or audit a key', async () => {
  const { service } = await localService();
  const a = await service.createApiKey({ name: 'a' }, opsA());
  const b = await service.createApiKey({ name: 'b' }, opsB());

  for (const attempt of [
    () => service.updateApiKey({ tenantId: 'tenant-a', id: a.id, name: 'x' }, opsB()),
    () => service.rotateApiKey({ tenantId: 'tenant-a', id: a.id }, opsB()),
    () => service.revokeApiKey({ tenantId: 'tenant-a', id: a.id }, opsB()),
    () => service.revokeAllApiKeys({ tenantId: 'tenant-a' }, opsB()),
    () => service.listApiKeyAuditEvents({ tenantId: 'tenant-a' }, opsB()),
  ]) await assert.rejects(attempt(), code('DENIED', 'tenant_mismatch'));
  // Without a tenant, the caller's own tenant is used and the other tenant's key is not found.
  assert.equal(await service.updateApiKey({ id: a.id, name: 'x' }, opsB()), null);
  assert.equal(await service.rotateApiKey({ id: a.id }, opsB()), null);
  assert.equal(await service.revokeApiKey({ id: a.id }, opsB()), null);
  assert.deepEqual(await service.listApiKeyAuditEvents({ credentialId: a.id }, opsB()), []);
  assert.deepEqual((await service.revokeAllApiKeys({}, opsB())).revoked, [b.id]);
  assert.ok(await service.authenticateApiKey(a.secret), 'tenant A key survives tenant B revoke-all');
  assert.equal(await service.authenticateApiKey(b.secret), null);
  await service.close();
});

test('revoke-all is one authorized bulk operation, optionally limited to one creator', async () => {
  const authorizer = new TestAuthority();
  const { service } = await localService({ authorizer });
  await authorizer.grant({ subject: 'ops-1', capability: 'apikeys.create' });
  const mine = await service.createApiKey({ name: 'mine' }, opsA());
  const theirs = await service.createApiKey({ name: 'theirs' }, mint({ principalId: 'ops-3', tenantId: 'tenant-a' })).catch(() => null);
  assert.equal(theirs, null, 'ops-3 has no grant');
  await authorizer.grant({ subject: 'ops-3', capability: 'apikeys.create' });
  const other = await service.createApiKey({ name: 'theirs' }, mint({ principalId: 'ops-3', tenantId: 'tenant-a' }));

  await assert.rejects(service.revokeAllApiKeys({}, opsA()), code('DENIED'));
  await authorizer.grant({ subject: 'ops-1', capability: 'apikeys.revoke', attributes: { createdBy: 'ops-1' } });
  await assert.rejects(service.revokeAllApiKeys({}, opsA()), code('DENIED'), 'all-creator revoke needs createdBy=*');
  assert.deepEqual((await service.revokeAllApiKeys({ createdBy: 'ops-1' }, opsA())).revoked, [mine.id]);
  assert.ok(await service.authenticateApiKey(other.secret));
  const request = authorizer.requests.at(-1)!;
  assert.equal(request.resource.attributes?.createdBy, 'ops-1');
  await service.close();
});

// -----------------------------------------------------------------------------
// Failure paths
// -----------------------------------------------------------------------------

test('fails closed when the authoritative store or AuthBoundry is unavailable', async () => {
  let failReads = false;
  const { service, authorizer, inner, gateway } = await localService({
    store: (store) => new Proxy(store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if ((property === 'get' || property === 'findByPrefix') && typeof value === 'function') {
          return (...args: unknown[]) => failReads ? Promise.reject(new Error('feltdb down')) : (value as Function).apply(target, args);
        }
        return typeof value === 'function' ? (value as Function).bind(target) : value;
      },
    }),
  });
  const created = await service.createApiKey({ name: 'svc' }, opsA());
  const principal = (await service.authenticateApiKey(created.secret))!;

  failReads = true;
  assert.equal(await service.authenticateApiKey(created.secret), null, 'authentication fails closed');
  await assert.rejects(gateway.authorize('files.read', principal, { type: 'file', tenantId: 'tenant-a' }), code('AUTHORITY_UNAVAILABLE', 'credential_store_unavailable'));
  failReads = false;

  authorizer.mode = 'unavailable';
  await assert.rejects(service.rotateApiKey({ id: created.id }, opsA()), code('AUTHORITY_UNAVAILABLE'));
  await assert.rejects(service.updateApiKey({ id: created.id, name: 'x' }, opsA()), code('AUTHORITY_UNAVAILABLE'));
  await assert.rejects(service.listApiKeyAuditEvents({}, opsA()), code('AUTHORITY_UNAVAILABLE'));
  const stored = await inner.get(created.id) as ApiKey;
  assert.equal(stored.rotatedTo, undefined);
  assert.equal(stored.name, 'svc');
  assert.equal((await inner.list('tenant-a')).length, 1, 'no replacement was issued');
  await service.close();
});

// -----------------------------------------------------------------------------
// Audit and keyed verification
// -----------------------------------------------------------------------------

test('audit events are authorized, paginated, application-scoped, and free of secrets and verifiers', async () => {
  const { service, runtime } = await localService();
  const created = await service.createApiKey({ name: 'svc' }, opsA());
  await service.authenticateApiKey(created.secret);
  await service.authenticateApiKey(`${created.prefix}_wrong`);
  await service.updateApiKey({ id: created.id, name: 'svc-2' }, opsA());
  await service.revokeApiKey({ id: created.id }, opsA());

  const all = await service.listApiKeyAuditEvents({ credentialId: created.id }, opsA());
  assert.deepEqual(all.map((event) => `${event.type}:${event.result}`).sort(), ['api_key.authenticated:invalid_secret', 'api_key.authenticated:success', 'api_key.created:success', 'api_key.revoked:success', 'api_key.updated:success'].sort());
  const firstPage = await service.listApiKeyAuditEvents({ credentialId: created.id, limit: 2 }, opsA());
  const rest = await service.listApiKeyAuditEvents({ credentialId: created.id, after: firstPage.at(-1)!.id }, opsA());
  assert.deepEqual([...firstPage, ...rest].map((event) => event.id), all.map((event) => event.id));

  const stored = await runtime.db.collection<ApiKey>('api_keys').get(created.id);
  const dump = JSON.stringify(all);
  assert.equal(dump.includes(created.secret), false);
  assert.equal(dump.includes(stored!.secretHash), false);

  // Another application sharing the namespace sees none of these events.
  const foreign = new ApiKeyService({ store: new FeltDbApiKeyStore(runtime.db), auditSink: new FeltDbAuditSink(runtime.db), applicationId: 'other-app', authority: testGateway(runtime.db, { application: 'other-app' }) });
  assert.deepEqual(await foreign.listApiKeyAuditEvents({}, mint({ principalId: 'ops-1', tenantId: 'tenant-a' })), []);

  const writeOnly = new ApiKeyService({ store: new FeltDbApiKeyStore(runtime.db), auditSink: { record: async () => undefined }, applicationId: 'test-app', authority: testGateway(runtime.db) });
  await assert.rejects(writeOnly.listApiKeyAuditEvents({}, opsA()), code('INVALID_REQUEST'));
  await service.close();
});

test('a server-held verifier key keys new verifiers, stays off the service object, and fails closed without it', async () => {
  const verifierKey = 'k'.repeat(48);
  const { service, make, runtime } = await localService({ verifierKey });
  const keyed = await service.createApiKey({ name: 'keyed' }, opsA());
  const stored = await runtime.db.collection<ApiKey>('api_keys').get(keyed.id);
  assert.match(stored!.secretHash, /^hmac-scrypt\$/);
  assert.ok(await service.authenticateApiKey(keyed.secret));
  // What a logger would print: the key is in a private field, never an enumerable or inspected one.
  assert.equal(inspect(service, { depth: 4 }).includes(verifierKey), false);
  assert.equal(Object.values({ ...service }).some((value) => value === verifierKey || inspect(value, { depth: 2 }).includes(verifierKey)), false);

  const unkeyed = make({ verifierKey: undefined });
  const plain = new ApiKeyService({ store: new FeltDbApiKeyStore(runtime.db), auditSink: new FeltDbAuditSink(runtime.db), applicationId: 'test-app', authority: testGateway(runtime.db) });
  assert.equal(await plain.authenticateApiKey(keyed.secret), null, 'no verifier key: refused');
  const wrong = make({ verifierKey: 'w'.repeat(48) });
  assert.equal(await wrong.authenticateApiKey(keyed.secret), null, 'wrong verifier key: refused');
  const results = (await service.listApiKeyAuditEvents({ credentialId: keyed.id }, opsA())).map((event) => event.result);
  assert.ok(results.includes('verifier_unavailable'));

  // Keys created before the verifier key was configured keep working.
  const legacy = await plain.createApiKey({ name: 'legacy' }, opsA());
  assert.ok(await service.authenticateApiKey(legacy.secret));
  assert.ok(unkeyed);
  assert.throws(() => make({ verifierKey: 'short' }), /at least 32 bytes/);
  await service.close();
});

// -----------------------------------------------------------------------------
// Public surfaces: invoke and the management routes
// -----------------------------------------------------------------------------

test('invoke exposes update, rotate, revoke-all, and audit through declared capabilities', async () => {
  const authorizer = new TestAuthority({ allowAll: true });
  const stack = await openStack({ authorizer });
  try {
    const { services } = stack;
    const admin = services.identify({ principalId: 'admin', principalType: 'user', tenantId: 'tenant-a' })!;
    const created = await services.invoke('apikeys.create', { name: 'svc' }, { principal: admin }) as { id: string; secret: string };
    assert.equal((await services.invoke('apikeys.update', { id: created.id, name: 'svc-2' }, { principal: admin }) as { name: string }).name, 'svc-2');
    const rotated = await services.invoke('apikeys.rotate', { id: created.id, overlapSeconds: 0 }, { principal: admin }) as { id: string };
    assert.deepEqual((await services.invoke('apikeys.read', { status: 'active' }, { principal: admin }) as Array<{ id: string }>).map((key) => key.id), [rotated.id]);
    assert.ok((await services.invoke('apikeys.audit', { credentialId: created.id }, { principal: admin }) as unknown[]).length >= 3);
    assert.deepEqual(await services.invoke('apikeys.revoke', { all: true }, { principal: admin }), { revoked: [rotated.id] });
    assert.ok(['apikeys.update', 'apikeys.rotate', 'apikeys.audit'].every((name) => authorizer.requests.some((request) => request.capability === name)));
    assert.ok(services.capabilities.some((capability) => capability.name === 'apikeys.rotate'));
  } finally {
    await stack.close();
  }
});

test('management routes edit, rotate, revoke-all, and audit keys with AuthBoundry authorization', async () => {
  const authorizer = new TestAuthority();
  const services = createServices({ memory: true, namespace: `keymgmt-http-${crypto.randomUUID()}`, authorizer });
  const alice: PrincipalClaims = { principalId: 'alice', principalType: 'host_session', tenantId: 'tenant-a' };
  for (const capability of ['apikeys.read', 'apikeys.create', 'apikeys.revoke', 'apikeys.update', 'apikeys.rotate']) await authorizer.grant({ subject: 'alice', capability });
  const app = express();
  app.use(createManagementRouter({ services, authority: services.gateway, authenticate: () => alice, includeConfiguration: false, includeUi: false }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/_appport/api/keys`;
  const call = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const createdResponse = await call('', 'POST', { name: 'svc', restrictions: { capabilities: ['files.read'] }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string; secret: string };

    const listed = await (await call('')).json() as Array<Record<string, unknown>>;
    assert.equal(JSON.stringify(listed).includes(created.secret), false);
    assert.deepEqual(listed[0]!.restrictions, { capabilities: ['files.read'] });

    const patched = await call(`/${created.id}`, 'PATCH', { name: 'svc-2', restrictions: null });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json() as { name: string }).name, 'svc-2');
    assert.equal((await call('/missing', 'PATCH', { name: 'x' })).status, 404);
    assert.equal((await call(`/${created.id}`, 'PATCH', { expiresAt: 'not-a-date' })).status, 400);

    const rotatedResponse = await call(`/${created.id}/rotate`, 'POST', { overlapSeconds: 30 });
    assert.equal(rotatedResponse.status, 201);
    const rotated = await rotatedResponse.json() as { id: string; secret: string; replaces: string };
    assert.equal(rotated.replaces, created.id);
    assert.ok(rotated.secret.startsWith('app_live_'));
    assert.equal((await call(`/${created.id}/rotate`, 'POST', {})).status, 400, 'already rotated');

    assert.equal((await call(`/${created.id}/audit`)).status, 403, 'audit needs apikeys.audit');
    await authorizer.grant({ subject: 'alice', capability: 'apikeys.audit' });
    const audit = await (await call(`/${created.id}/audit`)).json() as Array<{ type: string }>;
    assert.ok(audit.some((event) => event.type === 'api_key.rotated'));
    assert.equal(JSON.stringify(audit).includes(rotated.secret), false);

    const revokedAll = await (await call('/revoke-all', 'POST', {})).json() as { revoked: string[] };
    assert.deepEqual(revokedAll.revoked.sort(), [created.id, rotated.id].sort());
    assert.deepEqual(await (await call('')).json(), []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await services.apiKeys.close();
  }
});
