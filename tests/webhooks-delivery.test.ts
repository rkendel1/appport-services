import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createFeltDbRuntime,
  FeltDbWebhookEndpointStore,
  FeltDbWebhookDeliveryStore,
  FeltDbWebhookAuditSink,
  WebhookService,
  InMemoryWebhookSecretStore,
} from '../src/_internal.js';

async function createLocalWebhookService() {
  const path = await mkdtemp(join(tmpdir(), 'appport-webhooks-delivery-test-'));
  const runtime = createFeltDbRuntime({
    mode: 'local',
    namespace: 'webhooks-delivery-' + Math.random().toString(16).slice(2),
    path,
  });

  const service = new WebhookService({
    endpointStore: new FeltDbWebhookEndpointStore(runtime.db),
    deliveryStore: new FeltDbWebhookDeliveryStore(runtime.db),
    auditSink: new FeltDbWebhookAuditSink(runtime.db),
    secretStore: new InMemoryWebhookSecretStore(),
    maxRetryAttempts: 3,
  });

  return { service, runtime };
}

function createTestServer(
  responses: Array<{ statusCode: number; delay?: number }>,
): Promise<{ server: http.Server; port: number; requests: any[] }> {
  return new Promise((resolve) => {
    const requests: any[] = [];
    let requestIndex = 0;

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const config = responses[requestIndex] || { statusCode: 200 };
        requestIndex += 1;

        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        });

        const send = () => {
          res.writeHead(config.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        };

        if (config.delay) {
          setTimeout(send, config.delay);
        } else {
          send();
        }
      });
    });

    server.listen(0, 'localhost', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port, requests });
    });
  });
}

test('webhook delivery sends signed POST request', async () => {
  const { service, runtime } = await createLocalWebhookService();
  const { server, port, requests } = await createTestServer([{ statusCode: 200 }]);

  try {
    const { endpoint } = await service.createWebhookEndpoint({
      tenantId: 'tenant-a',
      url: `http://localhost:${port}/webhook`,
      events: ['invoice.created'],
      createdBy: 'user-1',
    });

    const deliveries = await service.emitWebhookEvent({
      tenantId: 'tenant-a',
      type: 'invoice.created',
      payload: { id: 'inv-123', amount: 100 },
    });

    const delivery = deliveries[0];
    const result = await service.deliverWebhook('tenant-a', delivery.id);

    assert.equal(result.success, true);
    assert.equal(result.statusCode, 200);
    assert.equal(requests.length, 1);

    const req = requests[0];
    assert.equal(req.method, 'POST');
    assert.ok(req.headers['x-appport-signature']);
    assert.equal(req.headers['content-type'], 'application/json');

    const payload = JSON.parse(req.body);
    assert.equal(payload.type, 'invoice.created');
    assert.equal(payload.data.id, 'inv-123');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.db.close();
  }
});

test('2xx status marks delivery as delivered', async () => {
  const { service, runtime } = await createLocalWebhookService();
  const { server, port } = await createTestServer([
    { statusCode: 200 },
    { statusCode: 201 },
  ]);

  try {
    const { endpoint } = await service.createWebhookEndpoint({
      tenantId: 'tenant-a',
      url: `http://localhost:${port}/webhook`,
      events: ['test'],
      createdBy: 'user-1',
    });

    const deliveries = await service.emitWebhookEvent({
      tenantId: 'tenant-a',
      type: 'test',
      payload: {},
    });

    const delivery = deliveries[0];
    const result = await service.deliverWebhook('tenant-a', delivery.id);

    assert.equal(result.success, true);

    const fetched = await service.getWebhookDelivery('tenant-a', delivery.id);
    assert.equal(fetched?.status, 'delivered');
    assert.ok(fetched?.deliveredAt);
    assert.equal(fetched?.attemptCount, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.db.close();
  }
});

test('5xx status marks delivery as retrying', async () => {
  const { service, runtime } = await createLocalWebhookService();
  const { server, port } = await createTestServer([{ statusCode: 500 }]);

  try {
    const { endpoint } = await service.createWebhookEndpoint({
      tenantId: 'tenant-a',
      url: `http://localhost:${port}/webhook`,
      events: ['test'],
      createdBy: 'user-1',
    });

    const deliveries = await service.emitWebhookEvent({
      tenantId: 'tenant-a',
      type: 'test',
      payload: {},
    });

    const delivery = deliveries[0];
    const result = await service.deliverWebhook('tenant-a', delivery.id);

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 500);

    const fetched = await service.getWebhookDelivery('tenant-a', delivery.id);
    assert.equal(fetched?.status, 'retrying');
    assert.ok(fetched?.nextAttemptAt);
    assert.equal(fetched?.attemptCount, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.db.close();
  }
});

test('terminal 4xx status marks delivery as failed', async () => {
  const { service, runtime } = await createLocalWebhookService();
  const { server, port } = await createTestServer([{ statusCode: 404 }]);

  try {
    const { endpoint } = await service.createWebhookEndpoint({
      tenantId: 'tenant-a',
      url: `http://localhost:${port}/webhook`,
      events: ['test'],
      createdBy: 'user-1',
    });

    const deliveries = await service.emitWebhookEvent({
      tenantId: 'tenant-a',
      type: 'test',
      payload: {},
    });

    const delivery = deliveries[0];
    const result = await service.deliverWebhook('tenant-a', delivery.id);

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 404);

    const fetched = await service.getWebhookDelivery('tenant-a', delivery.id);
    assert.equal(fetched?.status, 'failed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.db.close();
  }
});

test('timeout status is retryable', async () => {
  const { service, runtime } = await createLocalWebhookService();
  const { server, port } = await createTestServer([{ statusCode: 200, delay: 60000 }]);

  try {
    const { endpoint } = await service.createWebhookEndpoint({
      tenantId: 'tenant-a',
      url: `http://localhost:${port}/webhook`,
      events: ['test'],
      createdBy: 'user-1',
    });

    const deliveries = await service.emitWebhookEvent({
      tenantId: 'tenant-a',
      type: 'test',
      payload: {},
    });

    const delivery = deliveries[0];
    const result = await service.deliverWebhook('tenant-a', delivery.id);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('timeout') || result.error?.includes('Timeout'));

    const fetched = await service.getWebhookDelivery('tenant-a', delivery.id);
    assert.equal(fetched?.status, 'retrying');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.db.close();
  }
});

test('429 status is retryable', async () => {
  const { service, runtime } = await createLocalWebhookService();
  const { server, port } = await createTestServer([{ statusCode: 429 }]);

  try {
    const { endpoint } = await service.createWebhookEndpoint({
      tenantId: 'tenant-a',
      url: `http://localhost:${port}/webhook`,
      events: ['test'],
      createdBy: 'user-1',
    });

    const deliveries = await service.emitWebhookEvent({
      tenantId: 'tenant-a',
      type: 'test',
      payload: {},
    });

    const delivery = deliveries[0];
    const result = await service.deliverWebhook('tenant-a', delivery.id);

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 429);

    const fetched = await service.getWebhookDelivery('tenant-a', delivery.id);
    assert.equal(fetched?.status, 'retrying');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.db.close();
  }
});

test('multiple retries with exponential backoff', async () => {
  const { service, runtime } = await createLocalWebhookService();
  const { server, port } = await createTestServer([
    { statusCode: 500 },
    { statusCode: 500 },
    { statusCode: 200 },
  ]);

  try {
    const { endpoint } = await service.createWebhookEndpoint({
      tenantId: 'tenant-a',
      url: `http://localhost:${port}/webhook`,
      events: ['test'],
      createdBy: 'user-1',
    });

    const deliveries = await service.emitWebhookEvent({
      tenantId: 'tenant-a',
      type: 'test',
      payload: {},
    });

    const deliveryId = deliveries[0].id;

    let fetched = await service.getWebhookDelivery('tenant-a', deliveryId);
    assert.equal(fetched?.status, 'pending');
    assert.equal(fetched?.attemptCount, 0);

    const result1 = await service.deliverWebhook('tenant-a', deliveryId);
    assert.equal(result1.success, false);

    fetched = await service.getWebhookDelivery('tenant-a', deliveryId);
    assert.equal(fetched?.status, 'retrying');
    assert.equal(fetched?.attemptCount, 1);
    const nextAttempt1 = fetched?.nextAttemptAt;

    const result2 = await service.deliverWebhook('tenant-a', deliveryId);
    assert.equal(result2.success, false);

    fetched = await service.getWebhookDelivery('tenant-a', deliveryId);
    assert.equal(fetched?.status, 'retrying');
    assert.equal(fetched?.attemptCount, 2);
    const nextAttempt2 = fetched?.nextAttemptAt;

    assert.ok(
      new Date(nextAttempt2!).getTime() > new Date(nextAttempt1!).getTime(),
      'backoff increases with attempts',
    );

    const result3 = await service.deliverWebhook('tenant-a', deliveryId);
    assert.equal(result3.success, true);

    fetched = await service.getWebhookDelivery('tenant-a', deliveryId);
    assert.equal(fetched?.status, 'delivered');
    assert.equal(fetched?.attemptCount, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.db.close();
  }
});

test('max retry attempts marks delivery as failed', async () => {
  const { service, runtime } = await createLocalWebhookService();
  const { server, port } = await createTestServer([
    { statusCode: 500 },
    { statusCode: 500 },
    { statusCode: 500 },
  ]);

  try {
    const { endpoint } = await service.createWebhookEndpoint({
      tenantId: 'tenant-a',
      url: `http://localhost:${port}/webhook`,
      events: ['test'],
      createdBy: 'user-1',
    });

    const deliveries = await service.emitWebhookEvent({
      tenantId: 'tenant-a',
      type: 'test',
      payload: {},
    });

    const deliveryId = deliveries[0].id;

    for (let i = 0; i < 3; i++) {
      await service.deliverWebhook('tenant-a', deliveryId);
    }

    const fetched = await service.getWebhookDelivery('tenant-a', deliveryId);
    assert.equal(fetched?.status, 'failed');
    assert.equal(fetched?.attemptCount, 3);
    assert.ok(fetched?.lastError);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.db.close();
  }
});

test('delivery already delivered cannot be re-delivered', async () => {
  const { service, runtime } = await createLocalWebhookService();
  const { server, port, requests } = await createTestServer([{ statusCode: 200 }]);

  try {
    const { endpoint } = await service.createWebhookEndpoint({
      tenantId: 'tenant-a',
      url: `http://localhost:${port}/webhook`,
      events: ['test'],
      createdBy: 'user-1',
    });

    const deliveries = await service.emitWebhookEvent({
      tenantId: 'tenant-a',
      type: 'test',
      payload: {},
    });

    const deliveryId = deliveries[0].id;

    const result1 = await service.deliverWebhook('tenant-a', deliveryId);
    assert.equal(result1.success, true);
    assert.equal(requests.length, 1);

    const result2 = await service.deliverWebhook('tenant-a', deliveryId);
    assert.equal(result2.success, true);
    assert.equal(requests.length, 1, 'no second delivery made');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.db.close();
  }
});

test('concurrent delivery attempts claim only once', async () => {
  const { service, runtime } = await createLocalWebhookService();
  const { server, port, requests } = await createTestServer([{ statusCode: 200 }]);

  try {
    const { endpoint } = await service.createWebhookEndpoint({
      tenantId: 'tenant-a',
      url: `http://localhost:${port}/webhook`,
      events: ['test'],
      createdBy: 'user-1',
    });

    const deliveries = await service.emitWebhookEvent({
      tenantId: 'tenant-a',
      type: 'test',
      payload: {},
    });

    const deliveryId = deliveries[0].id;

    const results = await Promise.all([
      service.deliverWebhook('tenant-a', deliveryId),
      service.deliverWebhook('tenant-a', deliveryId),
      service.deliverWebhook('tenant-a', deliveryId),
    ]);

    const successCount = results.filter((r) => r.success).length;
    assert.equal(successCount, 3, 'all report success');
    assert.equal(requests.length, 1, 'only one HTTP request made');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.db.close();
  }
});
