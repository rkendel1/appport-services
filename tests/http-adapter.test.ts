import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createApiKeyService,
  createApiKeyAuth,
  assertTenant,
  AuthenticationError,
  TenantMismatchError,
  RequestContext,
  type HttpRequest,
} from '../src/_internal.js';
import { principal as operator, TestAuthority } from './support/authority.js';

const allowAll = new TestAuthority({ allowAll: true });

async function createLocalService() {
  const path = await mkdtemp(join(tmpdir(), 'appport-adapter-test-'));
  const service = createApiKeyService({ mode: 'local', namespace: 'adapter-' + Math.random().toString(16).slice(2), path, authorizer: allowAll });
  return { service, path };
}

test('authenticateRequest with valid Bearer token returns principal', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });
  const created = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'test',
  }, operator({ principalId: 'user-1', tenantId: 'tenant-a' }));

  const request: HttpRequest = {
    headers: { authorization: `Bearer ${created.secret}` },
  };
  const result = await auth.authenticateRequest(request);

  assert.ok(result.principal);
  assert.equal(result.principal.tenantId, 'tenant-a');
  assert.equal('scopes' in result.principal, false);
  assert.equal(result.reason, undefined);
  await service.close();
});

test('authenticateRequest with missing header returns null with reason', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  const request: HttpRequest = { headers: {} };
  const result = await auth.authenticateRequest(request);

  assert.equal(result.principal, null);
  assert.equal(result.reason, 'missing');
  await service.close();
});

test('authenticateRequest with malformed header returns null with reason', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  const request: HttpRequest = { headers: { authorization: 'MalformedToken' } };
  const result = await auth.authenticateRequest(request);

  assert.equal(result.principal, null);
  assert.equal(result.reason, 'malformed');
  await service.close();
});

test('authenticateRequest with invalid secret returns null with reason', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  const request: HttpRequest = { headers: { authorization: 'Bearer invalid_secret' } };
  const result = await auth.authenticateRequest(request);

  assert.equal(result.principal, null);
  assert.equal(result.reason, 'invalid');
  await service.close();
});

test('require throws AuthenticationError for missing credential', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  const request: HttpRequest = { headers: {} };

  await assert.rejects(
    () => auth.require(request),
    (error: unknown) => {
      return (
        error instanceof AuthenticationError &&
        error.reason === 'missing'
      );
    },
  );
  await service.close();
});

test('require throws AuthenticationError for invalid credential', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  const request: HttpRequest = { headers: { authorization: 'Bearer invalid' } };

  await assert.rejects(
    () => auth.require(request),
    (error: unknown) => {
      return (
        error instanceof AuthenticationError &&
        error.reason === 'invalid'
      );
    },
  );
  await service.close();
});

test('authenticate returns null for missing credential without throwing', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  const request: HttpRequest = { headers: {} };
  const principal = await auth.authenticate(request);

  assert.equal(principal, null);
  await service.close();
});

test('authenticate returns null for invalid credential without throwing', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  const request: HttpRequest = { headers: { authorization: 'Bearer invalid' } };
  const principal = await auth.authenticate(request);

  assert.equal(principal, null);
  await service.close();
});

test('tenant isolation: request A with tenant A and request B with tenant B run concurrently without leakage', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  const keyA = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'test-a',
  }, operator({ principalId: 'user-1', tenantId: 'tenant-a' }));

  const keyB = await service.createApiKey({
    tenantId: 'tenant-b',
    name: 'test-b',
  }, operator({ principalId: 'user-2', tenantId: 'tenant-b' }));

  const requestA: HttpRequest = { headers: { authorization: `Bearer ${keyA.secret}` } };
  const requestB: HttpRequest = { headers: { authorization: `Bearer ${keyB.secret}` } };

  const [resultA, resultB] = await Promise.all([
    auth.authenticateRequest(requestA),
    auth.authenticateRequest(requestB),
  ]);

  assert.ok(resultA.principal);
  assert.ok(resultB.principal);
  assert.equal(resultA.principal.tenantId, 'tenant-a');
  assert.equal(resultB.principal.tenantId, 'tenant-b');
  assert.equal(resultA.principal.credentialId, keyA.id);
  assert.equal(resultB.principal.credentialId, keyB.id);
  await service.close();
});

test('repeated concurrent authentication does not lose valid principals', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });
  const keys = [
    await service.createApiKey({
      tenantId: 'tenant-a',
      name: 'stress-a',
    }, operator({ principalId: 'user-1', tenantId: 'tenant-a' })),
    await service.createApiKey({
      tenantId: 'tenant-b',
      name: 'stress-b',
    }, operator({ principalId: 'user-2', tenantId: 'tenant-b' })),
  ];

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) => {
      const key = keys[index % keys.length];
      return auth.authenticateRequest({
        headers: { authorization: `Bearer ${key.secret}` },
      });
    }),
  );

  assert.equal(
    results.every((result) => result.principal !== null),
    true,
    JSON.stringify(results),
  );
  assert.deepEqual(
    new Set(results.map((result) => result.principal?.tenantId)),
    new Set(['tenant-a', 'tenant-b']),
  );
  await service.close();
});

test('revoked credential fails authentication', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  const created = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'test',
  }, operator({ principalId: 'user-1', tenantId: 'tenant-a' }));

  await service.revokeApiKey({ tenantId: 'tenant-a', id: created.id }, operator({ principalId: 'user-2', tenantId: 'tenant-a' }));

  const request: HttpRequest = { headers: { authorization: `Bearer ${created.secret}` } };
  const result = await auth.authenticateRequest(request);

  assert.equal(result.principal, null);
  assert.equal(result.reason, 'invalid');
  await service.close();
});

test('expired credential fails authentication', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  const created = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'test',
    expiresAt: new Date(Date.now() - 5000),
  }, operator({ principalId: 'user-1', tenantId: 'tenant-a' }));

  const request: HttpRequest = { headers: { authorization: `Bearer ${created.secret}` } };
  const result = await auth.authenticateRequest(request);

  assert.equal(result.principal, null);
  assert.equal(result.reason, 'invalid');
  await service.close();
});

test('RequestContext maintains principal state without global mutation', async () => {
  const { service } = await createLocalService();
  const context1 = new RequestContext();
  const context2 = new RequestContext();

  const principal1 = operator({ principalId: 'id-1', principalType: 'api_key', tenantId: 'tenant-1', credentialId: 'cred-1' });

  const principal2 = operator({ principalId: 'id-2', principalType: 'api_key', tenantId: 'tenant-2', credentialId: 'cred-2' });

  context1.setPrincipal(principal1);
  context2.setPrincipal(principal2);

  assert.deepEqual(context1.getPrincipal(), principal1);
  assert.deepEqual(context2.getPrincipal(), principal2);
  assert.notEqual(context1.getPrincipal(), context2.getPrincipal());

  context1.clear();
  assert.equal(context1.getPrincipal(), undefined);
  assert.deepEqual(context2.getPrincipal(), principal2);
  await service.close();
});

test('assertTenant throws TenantMismatchError when tenants do not match', () => {
  const principal = operator({ principalId: 'id-1', principalType: 'api_key', tenantId: 'tenant-a', credentialId: 'cred-1' });

  assert.throws(
    () => assertTenant(principal, 'tenant-b'),
    (error: unknown) => {
      return (
        error instanceof TenantMismatchError &&
        error.principalTenant === 'tenant-a' &&
        error.expectedTenant === 'tenant-b'
      );
    },
  );
});

test('assertTenant does not throw when tenants match', () => {
  const principal = operator({ principalId: 'id-1', principalType: 'api_key', tenantId: 'tenant-a', credentialId: 'cred-1' });

  assert.doesNotThrow(() => assertTenant(principal, 'tenant-a'));
});

test('no cross-request principal leakage through multiple concurrent requests', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  const keys = await Promise.all(
    ['a', 'b', 'c', 'd', 'e'].map((suffix) =>
      service.createApiKey({
        tenantId: `tenant-${suffix}`,
        name: `test-${suffix}`,
      }, operator({ principalId: 'user-1', tenantId: `tenant-${suffix}` })),
    ),
  );

  const results = await Promise.all(
    keys.map((key) => {
      const request: HttpRequest = { headers: { authorization: `Bearer ${key.secret}` } };
      return auth.authenticateRequest(request);
    }),
  );

  for (let i = 0; i < results.length; i++) {
    assert.ok(results[i].principal);
    assert.equal(results[i].principal?.tenantId, `tenant-${String.fromCharCode(97 + i)}`);
    assert.equal(results[i].principal?.credentialId, keys[i].id);
  }

  await service.close();
});

test('authorization header as array is handled correctly', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  const created = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'test',
  }, operator({ principalId: 'user-1', tenantId: 'tenant-a' }));

  const request: HttpRequest = {
    headers: { authorization: [`Bearer ${created.secret}`] },
  };

  const result = await auth.authenticateRequest(request);

  assert.ok(result.principal);
  assert.equal(result.principal.tenantId, 'tenant-a');
  await service.close();
});

test('API key scopes are rejected with a migration error and never reach the principal', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });

  await assert.rejects(
    () => service.createApiKey({ tenantId: 'tenant-a', name: 'test', scopes: ['files.admin', 'notifications.admin'] }, operator({ principalId: 'user-1', tenantId: 'tenant-a' })),
    /API key scopes are no longer authority/,
  );
  const created = await service.createApiKey({ tenantId: 'tenant-a', name: 'test' }, operator({ principalId: 'user-1', tenantId: 'tenant-a' }));
  const result = await auth.authenticateRequest({ headers: { authorization: `Bearer ${created.secret}` } });

  assert.ok(result.principal);
  assert.equal('scopes' in result.principal, false);
  await service.close();
});
