import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';
import type { Request, Response } from 'express';
import { createApiKeyService, apiKeyAuth, requireApiKeyAuth, assertTenant } from '../src/index.js';

async function createLocalService() {
  const path = await mkdtemp(join(tmpdir(), 'appport-express-'));
  const service = createApiKeyService({ mode: 'local', namespace: 'express-' + Math.random().toString(16).slice(2), path });
  return { service, path };
}

function makeRequest(
  app: express.Application,
  method: string,
  path: string,
  authHeader?: string,
): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = new (require('http').IncomingMessage)();
    const response = new (require('http').ServerResponse)();

    const mockReq = request as any;
    const mockRes = response as any;
    const mockNext = (err?: any) => {
      if (err) {
        mockRes.statusCode = 500;
        mockRes.end(JSON.stringify({ error: err.message }));
      }
    };

    mockReq.method = method;
    mockReq.url = path;
    mockReq.headers = authHeader ? { authorization: authHeader } : {};

    const endChunks: Buffer[] = [];
    mockRes.write = (chunk: Buffer | string) => {
      endChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    mockRes.end = (chunk?: Buffer | string) => {
      if (chunk) {
        endChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(endChunks).toString('utf8');
      resolve({ statusCode: mockRes.statusCode, body });
    };
    mockRes.writeHead = (statusCode: number, headers?: Record<string, string>) => {
      mockRes.statusCode = statusCode;
    };

    app(mockReq, mockRes, mockNext);
  });
}

test('Express middleware: optional auth allows unauthenticated requests', async () => {
  const { service } = await createLocalService();
  const app = express();

  app.use(apiKeyAuth(service));
  app.get('/invoices', (req: Request, res: Response) => {
    if (req.auth) {
      res.json({ authenticated: true, tenant: req.auth.tenantId });
    } else {
      res.json({ authenticated: false });
    }
  });

  const errorHandler = (err: any, req: Request, res: Response) => {
    res.status(500).json({ error: err.message });
  };
  app.use(errorHandler);

  const created = await service.createApiKey({
    tenantId: 'tenant-123',
    name: 'test',
    scopes: ['read'],
    createdBy: 'user-1',
  });

  const request: express.Request = {
    headers: { authorization: `Bearer ${created.secret}` },
  } as any;
  const response: express.Response = {} as any;

  const middleware = apiKeyAuth(service);
  await new Promise<void>((resolve) => {
    middleware(request, response, () => {
      assert.ok(request.auth);
      assert.equal(request.auth.tenantId, 'tenant-123');
      resolve();
    });
  });

  await service.close();
});

test('Express middleware: required auth rejects unauthenticated requests', async () => {
  const { service } = await createLocalService();

  const request: express.Request = {
    headers: {},
  } as any;
  const response: express.Response = {} as any;

  let errorCaught: any = null;
  const middleware = requireApiKeyAuth(service);
  await new Promise<void>((resolve) => {
    middleware(request, response, (err) => {
      errorCaught = err;
      resolve();
    });
  });

  assert.ok(errorCaught);
  assert.equal(errorCaught.reason, 'missing');

  await service.close();
});

test('Express middleware: request.auth populated with valid credential', async () => {
  const { service } = await createLocalService();

  const created = await service.createApiKey({
    tenantId: 'tenant-456',
    name: 'test',
    scopes: ['invoices.read', 'invoices.write'],
    createdBy: 'user-2',
  });

  const request: express.Request = {
    headers: { authorization: `Bearer ${created.secret}` },
  } as any;
  const response: express.Response = {} as any;

  const middleware = apiKeyAuth(service);
  await new Promise<void>((resolve) => {
    middleware(request, response, () => {
      assert.ok(request.auth);
      assert.equal(request.auth.principalId, created.id);
      assert.equal(request.auth.tenantId, 'tenant-456');
      assert.deepEqual(request.auth.scopes, ['invoices.read', 'invoices.write']);
      resolve();
    });
  });

  await service.close();
});

test('Express middleware: request context is isolated per request', async () => {
  const { service } = await createLocalService();

  const key1 = await service.createApiKey({
    tenantId: 'tenant-a',
    name: 'key1',
    scopes: ['read'],
    createdBy: 'user-1',
  });

  const key2 = await service.createApiKey({
    tenantId: 'tenant-b',
    name: 'key2',
    scopes: ['write'],
    createdBy: 'user-2',
  });

  const middleware = apiKeyAuth(service);

  const request1: express.Request = {
    headers: { authorization: `Bearer ${key1.secret}` },
  } as any;
  const request2: express.Request = {
    headers: { authorization: `Bearer ${key2.secret}` },
  } as any;

  const response: express.Response = {} as any;

  const results: Array<{ tenantId: string; contextTenant: string }> = [];

  await Promise.all([
    new Promise<void>((resolve) => {
      middleware(request1, response, () => {
        results.push({
          tenantId: request1.auth?.tenantId || 'none',
          contextTenant: request1.authContext?.getPrincipal()?.tenantId || 'none',
        });
        resolve();
      });
    }),
    new Promise<void>((resolve) => {
      middleware(request2, response, () => {
        results.push({
          tenantId: request2.auth?.tenantId || 'none',
          contextTenant: request2.authContext?.getPrincipal()?.tenantId || 'none',
        });
        resolve();
      });
    }),
  ]);

  const result1 = results.find((r) => r.tenantId === 'tenant-a');
  const result2 = results.find((r) => r.tenantId === 'tenant-b');

  assert.ok(result1);
  assert.ok(result2);
  assert.equal(result1.contextTenant, 'tenant-a');
  assert.equal(result2.contextTenant, 'tenant-b');

  await service.close();
});

test('Express: assertTenant integration with principal', async () => {
  const { service } = await createLocalService();

  const created = await service.createApiKey({
    tenantId: 'tenant-xyz',
    name: 'test',
    scopes: ['read'],
    createdBy: 'user-1',
  });

  const request: express.Request = {
    headers: { authorization: `Bearer ${created.secret}` },
  } as any;
  const response: express.Response = {} as any;

  const middleware = apiKeyAuth(service);
  await new Promise<void>((resolve) => {
    middleware(request, response, () => {
      if (request.auth) {
        const principal = request.auth;
        assert.doesNotThrow(() => assertTenant(principal, 'tenant-xyz'));
        assert.throws(() => assertTenant(principal, 'other-tenant'));
      }
      resolve();
    });
  });

  await service.close();
});
