import assert from 'node:assert/strict';
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
} from '../src/_internal.js';
import { principal as verified, testGateway, TestCredentials, LOCAL_DESTINATIONS } from './support/authority.js';

const caller = (tenantId: string) => verified({ principalId: 'user-1', principalType: 'api_key', tenantId, credentialId: 'key' });
const credentials = new TestCredentials();
const SIGNING_REF = credentials.put('signing-a', 'tenant-a', 'whsec_test_signing_secret');
credentials.put('signing-a-b', 'tenant-b', 'whsec_test_signing_secret_b');
/** Resolve every hostname to a public documentation-safe address so tests need no DNS. */
const PUBLIC_DESTINATIONS = { lookup: async () => [{ address: '93.184.216.34', family: 4 as const }] };

async function createLocalWebhookService() {
  const path = await mkdtemp(join(tmpdir(), 'appport-webhooks-test-'));
  const runtime = createFeltDbRuntime({
    mode: 'local',
    namespace: 'webhooks-' + Math.random().toString(16).slice(2),
    path,
  });

  const service = new WebhookService({
    endpointStore: new FeltDbWebhookEndpointStore(runtime.db),
    deliveryStore: new FeltDbWebhookDeliveryStore(runtime.db),
    auditSink: new FeltDbWebhookAuditSink(runtime.db),
    authority: testGateway(runtime.db, { credentials }),
    destinationPolicy: PUBLIC_DESTINATIONS,
  });

  return { service, runtime };
}

test('creates webhook endpoint bound to a signing credential reference', async () => {
  const { service, runtime } = await createLocalWebhookService();

  const endpoint = await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook',
    events: ['invoice.created', 'invoice.paid'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  assert.ok(endpoint.id);
  assert.equal(endpoint.tenantId, 'tenant-a');
  assert.equal(endpoint.url, 'https://example.com/webhook');
  assert.deepEqual(endpoint.events, ['invoice.created', 'invoice.paid']);
  assert.equal(endpoint.signingCredentialRef, SIGNING_REF);
  assert.equal(JSON.stringify(endpoint).includes('whsec_test_signing_secret'), false);

  const fetched = await service.getWebhookEndpoint('tenant-a', endpoint.id);
  assert.ok(fetched);
  assert.equal(fetched.url, endpoint.url);

  await runtime.db.close();
});

test('list webhook endpoints by tenant', async () => {
  const { service, runtime } = await createLocalWebhookService();

  await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/a',
    events: ['test'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/b',
    events: ['test'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  await service.createWebhookEndpoint({
    tenantId: 'tenant-b',
    url: 'https://example.com/c',
    events: ['test'],
    signingCredentialRef: 'credential-ref:signing-a-b',
  }, caller('tenant-b'));

  const tenantAEndpoints = await service.listWebhookEndpoints('tenant-a');
  const tenantBEndpoints = await service.listWebhookEndpoints('tenant-b');

  assert.equal(tenantAEndpoints.length, 2);
  assert.equal(tenantBEndpoints.length, 1);

  await runtime.db.close();
});

test('tenant isolation prevents cross-tenant access', async () => {
  const { service, runtime } = await createLocalWebhookService();

  const endpoint = await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook',
    events: ['test'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  const fetched = await service.getWebhookEndpoint('tenant-b', endpoint.id);
  assert.equal(fetched, null);

  await runtime.db.close();
});

test('disable webhook endpoint prevents new deliveries', async () => {
  const { service, runtime } = await createLocalWebhookService();

  const endpoint = await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook',
    events: ['invoice.created'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  await service.disableWebhookEndpoint({
    tenantId: 'tenant-a',
    id: endpoint.id,
  }, caller('tenant-a'));

  const deliveries = await service.emitWebhookEvent({
    tenantId: 'tenant-a',
    type: 'invoice.created',
    payload: { id: '123' },
  }, caller('tenant-a'));

  assert.equal(deliveries.length, 0);

  await runtime.db.close();
});

test('emit event creates deliveries for matching endpoints', async () => {
  const { service, runtime } = await createLocalWebhookService();

  const ep1 = await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook1',
    events: ['invoice.created'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  const ep2 = await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook2',
    events: ['invoice.created', 'invoice.paid'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  const ep3 = await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook3',
    events: ['invoice.paid'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  const deliveries = await service.emitWebhookEvent({
    tenantId: 'tenant-a',
    type: 'invoice.created',
    payload: { id: '123' },
  }, caller('tenant-a'));

  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.some((d) => d.endpointId === ep1.id));
  assert.ok(deliveries.some((d) => d.endpointId === ep2.id));
  assert.equal(deliveries.some((d) => d.endpointId === ep3.id), false);

  await runtime.db.close();
});

test('no deliveries created for non-matching events', async () => {
  const { service, runtime } = await createLocalWebhookService();

  await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook',
    events: ['invoice.created'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  const deliveries = await service.emitWebhookEvent({
    tenantId: 'tenant-a',
    type: 'user.created',
    payload: { id: 'user-123' },
  }, caller('tenant-a'));

  assert.equal(deliveries.length, 0);

  await runtime.db.close();
});

test('event emission is tenant-scoped', async () => {
  const { service, runtime } = await createLocalWebhookService();

  const ep1 = await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook1',
    events: ['test'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  const ep2 = await service.createWebhookEndpoint({
    tenantId: 'tenant-b',
    url: 'https://example.com/webhook2',
    events: ['test'],
    signingCredentialRef: 'credential-ref:signing-a-b',
  }, caller('tenant-b'));

  const deliveriesA = await service.emitWebhookEvent({
    tenantId: 'tenant-a',
    type: 'test',
    payload: {},
  }, caller('tenant-a'));

  const deliveriesB = await service.emitWebhookEvent({
    tenantId: 'tenant-b',
    type: 'test',
    payload: {},
  }, caller('tenant-b'));

  assert.equal(deliveriesA.length, 1);
  assert.equal(deliveriesB.length, 1);
  assert.equal(deliveriesA[0].endpointId, ep1.id);
  assert.equal(deliveriesB[0].endpointId, ep2.id);

  await runtime.db.close();
});

test('delivery status transitions through state machine', async () => {
  const { service, runtime } = await createLocalWebhookService();

  const endpoint = await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook',
    events: ['test'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  const deliveries = await service.emitWebhookEvent({
    tenantId: 'tenant-a',
    type: 'test',
    payload: { id: '123' },
  }, caller('tenant-a'));

  const delivery = deliveries[0];
  assert.equal(delivery.status, 'pending');
  assert.equal(delivery.attemptCount, 0);

  await runtime.db.close();
});

test('replay resets delivery state for failed deliveries', async () => {
  const { service, runtime } = await createLocalWebhookService();

  const endpoint = await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook',
    events: ['test'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  const deliveries = await service.emitWebhookEvent({
    tenantId: 'tenant-a',
    type: 'test',
    payload: { id: '123' },
  }, caller('tenant-a'));

  const delivery = deliveries[0];

  const replayed = await service.replayWebhookDelivery('tenant-a', delivery.id, caller('tenant-a'));

  assert.ok(replayed);
  assert.equal(replayed.status, 'pending');
  assert.equal(replayed.attemptCount, 0);
  assert.equal(replayed.lastError, undefined);
  assert.equal(replayed.deliveredAt, undefined);

  await runtime.db.close();
});

test('replay respects disabled endpoint', async () => {
  const { service, runtime } = await createLocalWebhookService();

  const endpoint = await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook',
    events: ['test'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  const deliveries = await service.emitWebhookEvent({
    tenantId: 'tenant-a',
    type: 'test',
    payload: { id: '123' },
  }, caller('tenant-a'));

  const delivery = deliveries[0];

  await service.disableWebhookEndpoint({
    tenantId: 'tenant-a',
    id: endpoint.id,
  }, caller('tenant-a'));

  const replayed = await service.replayWebhookDelivery('tenant-a', delivery.id, caller('tenant-a'));

  assert.equal(replayed, null);

  await runtime.db.close();
});

test('list deliveries filtered by endpoint', async () => {
  const { service, runtime } = await createLocalWebhookService();

  const ep1 = await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook1',
    events: ['test'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  const ep2 = await service.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook2',
    events: ['test'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  await service.emitWebhookEvent({
    tenantId: 'tenant-a',
    type: 'test',
    payload: { id: '123' },
  }, caller('tenant-a'));

  const allDeliveries = await service.listWebhookDeliveries('tenant-a');
  const ep1Deliveries = await service.listWebhookDeliveries('tenant-a', ep1.id);
  const ep2Deliveries = await service.listWebhookDeliveries('tenant-a', ep2.id);

  assert.equal(allDeliveries.length, 2);
  assert.equal(ep1Deliveries.length, 1);
  assert.equal(ep2Deliveries.length, 1);

  await runtime.db.close();
});

test('restart preserves endpoints and deliveries', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-webhooks-restart-'));
  const namespace = 'restart-' + Math.random().toString(16).slice(2);

  const firstRuntime = createFeltDbRuntime({ mode: 'local', namespace, path });
  const first = new WebhookService({
    endpointStore: new FeltDbWebhookEndpointStore(firstRuntime.db),
    deliveryStore: new FeltDbWebhookDeliveryStore(firstRuntime.db),
    auditSink: new FeltDbWebhookAuditSink(firstRuntime.db),
    authority: testGateway(firstRuntime.db, { credentials }),
    destinationPolicy: PUBLIC_DESTINATIONS,
  });

  const endpoint = await first.createWebhookEndpoint({
    tenantId: 'tenant-a',
    url: 'https://example.com/webhook',
    events: ['test'],
    signingCredentialRef: SIGNING_REF,
  }, caller('tenant-a'));

  const deliveries = await first.emitWebhookEvent({
    tenantId: 'tenant-a',
    type: 'test',
    payload: { id: '123' },
  }, caller('tenant-a'));

  await firstRuntime.db.close();
  const runtime = createFeltDbRuntime({ mode: 'local', namespace, path });
  const second = new WebhookService({
    endpointStore: new FeltDbWebhookEndpointStore(runtime.db),
    deliveryStore: new FeltDbWebhookDeliveryStore(runtime.db),
    auditSink: new FeltDbWebhookAuditSink(runtime.db),
    authority: testGateway(runtime.db, { credentials }),
  });

  const fetched = await second.getWebhookEndpoint('tenant-a', endpoint.id);
  const fetchedDelivery = await second.getWebhookDelivery('tenant-a', deliveries[0].id);

  assert.ok(fetched);
  assert.equal(fetched.url, endpoint.url);
  assert.ok(fetchedDelivery);
  assert.equal(fetchedDelivery.status, 'pending');

  await runtime.db.close();
});
