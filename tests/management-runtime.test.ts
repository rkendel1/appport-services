import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  API_KEY_MANAGEMENT_CAPABILITIES,
  APPPORT_UI_CONTRIBUTIONS,
  createManagementRouter,
  createServices,
  type ApiKeyManagementCapability,
  type AuthenticatedPrincipal,
} from '../src/index.js';

const principals: Record<string, AuthenticatedPrincipal> = {
  alice: { principalId: 'alice', principalType: 'host_session', tenantId: 'tenant-a', scopes: [] },
  bob: { principalId: 'bob', principalType: 'host_session', tenantId: 'tenant-b', scopes: [] },
};

async function startHost(permissions: Readonly<Record<string, readonly ApiKeyManagementCapability[]>>) {
  const services = createServices({ memory: true, namespace: `management-${crypto.randomUUID()}` });
  return { services, ...await mountHost(services, permissions) };
}

async function mountHost(services: ReturnType<typeof createServices>, permissions: Readonly<Record<string, readonly ApiKeyManagementCapability[]>>) {
  const app = express();
  app.use(createManagementRouter({
    services,
    authenticate: (request) => principals[String(request.headers['x-test-principal'])] ?? null,
    authorize: (capability, { principal }) => permissions[principal.principalId]?.includes(capability) ?? false,
    includeConfiguration: false,
    includeUi: false,
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return { server, base };
}

async function stopHost(server: Server, services: ReturnType<typeof createServices>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await services.apiKeys.close();
}

const allCapabilities = Object.values(API_KEY_MANAGEMENT_CAPABILITIES);

test('exported management router composes an existing service instance with host authorization and tenant isolation', async () => {
  const { services, server, base } = await startHost({ alice: allCapabilities, bob: allCapabilities });
  try {
    const creation = await fetch(`${base}/_appport/api/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'alice' },
      body: JSON.stringify({ name: 'production', scopes: ['invoices.read'], tenantId: 'tenant-b', createdBy: 'attacker' }),
    });
    assert.equal(creation.status, 201);
    const created = await creation.json() as { id: string; secret: string };
    assert.match(created.secret, /^app_live_/);

    const aliceList = await fetch(`${base}/_appport/api/keys`, { headers: { 'x-test-principal': 'alice' } });
    assert.equal(aliceList.status, 200);
    const aliceKeys = await aliceList.json() as Record<string, unknown>[];
    assert.equal(aliceKeys.length, 1);
    assert.equal(aliceKeys[0].tenantId, 'tenant-a');
    assert.equal(aliceKeys[0].createdBy, 'alice');
    assert.equal('secret' in aliceKeys[0], false);
    assert.equal('secretHash' in aliceKeys[0], false);
    assert.equal(JSON.stringify(aliceKeys).includes(created.secret), false);

    const bobKeys = await fetch(`${base}/_appport/api/keys`, { headers: { 'x-test-principal': 'bob' } }).then((response) => response.json()) as unknown[];
    assert.deepEqual(bobKeys, []);

    const crossTenantRevoke = await fetch(`${base}/_appport/api/keys/${created.id}`, { method: 'DELETE', headers: { 'x-test-principal': 'bob' } });
    assert.equal(crossTenantRevoke.status, 204);
    assert.equal((await services.apiKeys.getApiKey('tenant-a', created.id))?.revokedAt, undefined);

    const revoke = await fetch(`${base}/_appport/api/keys/${created.id}`, { method: 'DELETE', headers: { 'x-test-principal': 'alice' } });
    assert.equal(revoke.status, 204);
    assert.equal((await revoke.text()).includes(created.secret), false);
    const afterRevoke = await fetch(`${base}/_appport/api/keys`, { headers: { 'x-test-principal': 'alice' } }).then((response) => response.json());
    assert.deepEqual(afterRevoke, []);
  } finally {
    await stopHost(server, services);
  }
});

test('management API rejects missing principals and enforces each operation capability server-side', async () => {
  const cases: readonly [ApiKeyManagementCapability, string, string][] = [
    [API_KEY_MANAGEMENT_CAPABILITIES.read, 'GET', '/_appport/api/keys'],
    [API_KEY_MANAGEMENT_CAPABILITIES.create, 'POST', '/_appport/api/keys'],
    [API_KEY_MANAGEMENT_CAPABILITIES.revoke, 'DELETE', '/_appport/api/keys/missing'],
  ];

  for (const [capability, method, path] of cases) {
    const { services, server, base } = await startHost({ alice: [capability] });
    try {
      const init: RequestInit = {
        method,
        headers: { 'content-type': 'application/json', 'x-test-principal': 'alice' },
        ...(method === 'POST' ? { body: JSON.stringify({ name: 'allowed', scopes: [] }) } : {}),
      };
      const allowed = await fetch(base + path, init);
      assert.notEqual(allowed.status, 403, `${capability} should allow its operation`);

      const missing = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json' } });
      assert.equal(missing.status, 401);

      const deniedHost = await startHost({ alice: [] });
      try {
        const denied = await fetch(deniedHost.base + path, init);
        assert.equal(denied.status, 403);
        const body = await denied.text();
        assert.match(body, new RegExp(capability.replace('.', '\\.')));
        assert.doesNotMatch(body, /app_live_/);
      } finally {
        await stopHost(deniedHost.server, deniedHost.services);
      }
    } finally {
      await stopHost(server, services);
    }
  }
});

test('API key UI contribution declares the exact capabilities used by the page', () => {
  assert.deepEqual(APPPORT_UI_CONTRIBUTIONS, [{
    protocol: 'AppPort/ui/1',
    id: 'api-keys',
    requiredCapabilities: ['apikeys.read', 'apikeys.create', 'apikeys.revoke'],
  }]);
});

test('packaged API-key UI requires its complete capability set and unsupported surfaces are not mounted', async () => {
  const services = createServices({ memory: true, namespace: `management-ui-${crypto.randomUUID()}` });
  let permissions: readonly ApiKeyManagementCapability[] = [API_KEY_MANAGEMENT_CAPABILITIES.read];
  const app = express();
  app.use(createManagementRouter({
    services: { apiKeys: services.apiKeys },
    authenticate: () => principals.alice,
    authorize: (capability) => permissions.includes(capability),
    includeConfiguration: false,
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    assert.equal((await fetch(`${base}/api-keys`)).status, 403);
    permissions = allCapabilities;
    const page = await fetch(`${base}/api-keys`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Create API key/);
    assert.equal((await fetch(`${base}/jobs`)).status, 404);
  } finally {
    await stopHost(server, services);
  }
});

test('composable runtime mounts existing webhook and job contracts against the supplied services', async () => {
  const { services, server, base } = await startHost({ alice: allCapabilities });
  try {
    const headers = { 'content-type': 'application/json', 'x-test-principal': 'alice' };
    const webhook = await fetch(`${base}/_appport/webhooks`, {
      method: 'POST', headers, body: JSON.stringify({ url: 'https://example.com/hook', events: ['invoice.created'], tenantId: 'tenant-b' }),
    });
    assert.equal(webhook.status, 201);
    const webhooks = await fetch(`${base}/_appport/webhooks`, { headers }).then((response) => response.json()) as { tenantId: string }[];
    assert.equal(webhooks.length, 1);
    assert.equal(webhooks[0].tenantId, 'tenant-a');

    const job = await fetch(`${base}/_appport/jobs`, {
      method: 'POST', headers, body: JSON.stringify({ type: 'invoice.process', payload: { id: 'one' }, tenantId: 'tenant-b' }),
    });
    assert.equal(job.status, 201);
    const jobs = await fetch(`${base}/_appport/jobs`, { headers }).then((response) => response.json()) as { tenantId: string }[];
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].tenantId, 'tenant-a');
  } finally {
    await stopHost(server, services);
  }
});

test('management API-key state remains durable across service recreation and revoke', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-management-durable-'));
  const namespace = `management-durable-${crypto.randomUUID()}`;
  const first = createServices({ mode: 'local', path, namespace });
  const firstHost = await mountHost(first, { alice: allCapabilities });
  const creation = await fetch(`${firstHost.base}/_appport/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-principal': 'alice' },
    body: JSON.stringify({ name: 'durable', scopes: [] }),
  });
  const created = await creation.json() as { id: string; secret: string };
  await stopHost(firstHost.server, first);

  const second = createServices({ mode: 'local', path, namespace });
  const secondHost = await mountHost(second, { alice: allCapabilities });
  try {
    const listed = await fetch(`${secondHost.base}/_appport/api/keys`, { headers: { 'x-test-principal': 'alice' } }).then((response) => response.json()) as { id: string }[];
    assert.equal(listed.some((key) => key.id === created.id), true);
    assert.equal(JSON.stringify(listed).includes(created.secret), false);
    assert.equal((await fetch(`${secondHost.base}/_appport/api/keys/${created.id}`, { method: 'DELETE', headers: { 'x-test-principal': 'alice' } })).status, 204);
  } finally {
    await stopHost(secondHost.server, second);
  }

  const third = createServices({ mode: 'local', path, namespace });
  try {
    assert.ok((await third.apiKeys.getApiKey('tenant-a', created.id))?.revokedAt);
  } finally {
    await third.apiKeys.close();
  }
});
