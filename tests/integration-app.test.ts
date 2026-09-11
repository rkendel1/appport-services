import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApiKeyService, createApiKeyAuth, assertTenant } from '../src/_internal.js';

async function createLocalService() {
  const path = await mkdtemp(join(tmpdir(), 'appport-integration-'));
  const service = createApiKeyService({ mode: 'local', namespace: 'integration-' + Math.random().toString(16).slice(2), path });
  return { service, path };
}

function createTestApp(auth: ReturnType<typeof createApiKeyAuth>) {
  return http.createServer(async (req, res) => {
    try {
      if (req.url === '/invoices' && req.method === 'GET') {
        const result = await auth.authenticateRequest(req);
        if (!result.principal) {
          if (result.reason === 'missing') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthenticated' }));
          } else {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
          }
          return;
        }

        assertTenant(result.principal, result.principal.tenantId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            tenant: result.principal.tenantId,
            scopes: result.principal.scopes,
            credentialId: result.principal.credentialId,
            invoices: ['inv-1', 'inv-2'],
          }),
        );
        return;
      }

      if (req.url === '/protected' && req.method === 'GET') {
        const principal = await auth.require(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ principalId: principal.principalId }));
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (error) {
      const err = error as Error & { reason?: string };
      if (err.reason === 'missing') {
        res.writeHead(401);
      } else {
        res.writeHead(403);
      }
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function makeRequest(
  server: http.Server,
  path: string,
  authHeader?: string,
): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as net.AddressInfo;
    const options: http.RequestOptions = {
      hostname: addr.address,
      port: addr.port,
      path,
      method: 'GET',
    };

    if (authHeader) {
      options.headers = { Authorization: authHeader };
    }

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

test('integration: valid key authenticates and returns principal data', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });
  const server = createTestApp(auth);

  const created = await service.createApiKey({
    tenantId: 'tenant-123',
    name: 'test',
    scopes: ['invoices.read'],
    createdBy: 'user-1',
  });

  await new Promise<void>((resolve) => server.listen(0, 'localhost', () => resolve()));
  const addr = server.address() as net.AddressInfo;

  try {
    const response = await makeRequest(server, '/invoices', `Bearer ${created.secret}`);
    const data = JSON.parse(response.body);

    assert.equal(response.statusCode, 200);
    assert.equal(data.tenant, 'tenant-123');
    assert.deepEqual(data.scopes, ['invoices.read']);
    assert.equal(data.credentialId, created.id);
    assert.ok(Array.isArray(data.invoices));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  }
});

test('integration: missing credential on optional endpoint returns 401', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });
  const server = createTestApp(auth);

  await new Promise<void>((resolve) => server.listen(0, 'localhost', () => resolve()));

  try {
    const response = await makeRequest(server, '/invoices');
    assert.equal(response.statusCode, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  }
});

test('integration: invalid credential on optional endpoint returns 403', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });
  const server = createTestApp(auth);

  await new Promise<void>((resolve) => server.listen(0, 'localhost', () => resolve()));

  try {
    const response = await makeRequest(server, '/invoices', 'Bearer invalid_key');
    assert.equal(response.statusCode, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  }
});

test('integration: revoked key is rejected', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });
  const server = createTestApp(auth);

  const created = await service.createApiKey({
    tenantId: 'tenant-123',
    name: 'test',
    scopes: ['invoices.read'],
    createdBy: 'user-1',
  });

  await service.revokeApiKey({ tenantId: 'tenant-123', id: created.id, revokedBy: 'user-2' });

  await new Promise<void>((resolve) => server.listen(0, 'localhost', () => resolve()));

  try {
    const response = await makeRequest(server, '/invoices', `Bearer ${created.secret}`);
    assert.equal(response.statusCode, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  }
});

test('integration: expired key is rejected', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });
  const server = createTestApp(auth);

  const created = await service.createApiKey({
    tenantId: 'tenant-123',
    name: 'test',
    scopes: ['invoices.read'],
    expiresAt: new Date(Date.now() - 5000),
    createdBy: 'user-1',
  });

  await new Promise<void>((resolve) => server.listen(0, 'localhost', () => resolve()));

  try {
    const response = await makeRequest(server, '/invoices', `Bearer ${created.secret}`);
    assert.equal(response.statusCode, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  }
});

test('integration: require() on protected endpoint rejects missing credential', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });
  const server = createTestApp(auth);

  await new Promise<void>((resolve) => server.listen(0, 'localhost', () => resolve()));

  try {
    const response = await makeRequest(server, '/protected');
    assert.equal(response.statusCode, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  }
});

test('integration: require() on protected endpoint accepts valid credential', async () => {
  const { service } = await createLocalService();
  const auth = createApiKeyAuth({ service });
  const server = createTestApp(auth);

  const created = await service.createApiKey({
    tenantId: 'tenant-123',
    name: 'test',
    scopes: ['read'],
    createdBy: 'user-1',
  });

  await new Promise<void>((resolve) => server.listen(0, 'localhost', () => resolve()));

  try {
    const response = await makeRequest(server, '/protected', `Bearer ${created.secret}`);
    const data = JSON.parse(response.body);

    assert.equal(response.statusCode, 200);
    assert.equal(data.principalId, created.id);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  }
});
