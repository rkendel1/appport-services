import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { createManagementRouter, createServices, getServiceCapability, type AppPortServices, type PrincipalClaims } from '../src/index.js';
import { TestAuthority } from './support/authority.js';

const PUBLIC_DESTINATIONS = { lookup: async () => [{ address: '93.184.216.34', family: 4 as const }] };
const claims: Record<string, PrincipalClaims> = {
  writer: { principalId: 'writer', principalType: 'host_session', tenantId: 'tenant-a' },
  endpointsOnly: { principalId: 'endpoints-only', principalType: 'host_session', tenantId: 'tenant-a' },
  deliveriesOnly: { principalId: 'deliveries-only', principalType: 'host_session', tenantId: 'tenant-a' },
  otherTenant: { principalId: 'other', principalType: 'host_session', tenantId: 'tenant-b' },
};

async function setup() {
  const authorizer = new TestAuthority();
  for (const capability of ['webhooks.register', 'webhooks.emit', 'webhooks.read', 'webhooks.deliveries.read']) await authorizer.grant({ subject: 'writer', capability });
  await authorizer.grant({ subject: 'endpoints-only', capability: 'webhooks.read' });
  await authorizer.grant({ subject: 'deliveries-only', capability: 'webhooks.deliveries.read' });
  await authorizer.grant({ subject: 'other', capability: 'webhooks.deliveries.read' });
  const services = createServices({ memory: true, namespace: `deliveries-${crypto.randomUUID()}`, application: 'hooks-app', authorizer, webhookDestinationPolicy: PUBLIC_DESTINATIONS });
  const writer = services.identify(claims.writer)!;
  const first = await services.webhooks.createWebhookEndpoint({ url: 'https://one.example.com/hook', events: ['invoice.created'], signingCredentialRef: 'credential-ref:whsec_one' }, writer);
  const second = await services.webhooks.createWebhookEndpoint({ url: 'https://two.example.com/hook', events: ['invoice.created', 'invoice.paid'], signingCredentialRef: 'credential-ref:whsec_two' }, writer);
  for (let index = 0; index < 3; index += 1) await services.webhooks.emitWebhookEvent({ type: 'invoice.created', payload: { index } }, writer);
  await services.webhooks.emitWebhookEvent({ type: 'invoice.paid', payload: {} }, writer);
  // Mark one delivery failed, as a worker would after exhausting retries.
  const failed = (await services.webhooks.listWebhookDeliveries('tenant-a', second.id))[0]!;
  await services.db.collection('webhook_deliveries').update(failed.id, { status: 'failed', lastError: 'HTTP 500' });
  return { services, first, second, failedId: failed.id };
}

async function mount(services: AppPortServices) {
  const app = express();
  app.use(createManagementRouter({
    services,
    authority: services.gateway,
    authenticate: (request) => claims[String(request.headers['x-test-principal'])] ?? null,
    includeConfiguration: false,
    includeUi: false,
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const get = (path: string, who: string) => fetch(`${base}${path}`, { headers: { 'x-test-principal': who } });
  return { server, get };
}

test('webhooks.deliveries.read is a declared observation capability on webhook_delivery resources', () => {
  const capability = getServiceCapability('webhooks.deliveries.read');
  assert.ok(capability);
  assert.equal(capability.effect, 'observation');
  assert.equal(capability.invocable, true);
  assert.equal(capability.authorization.resource, 'webhook_delivery');
  assert.ok(getServiceCapability('webhooks.read'), 'webhooks.read is kept');
});

test('deliveries are listed and read under webhooks.deliveries.read, bounded and filtered', async () => {
  const { services, first, second, failedId } = await setup();
  const reader = services.identify(claims.deliveriesOnly)!;

  const all = await services.webhooks.readWebhookDeliveries({}, reader);
  assert.equal(all.length, 7, '3 events to two endpoints, 1 to one');
  assert.equal((await services.webhooks.readWebhookDeliveries({ endpointId: first.id }, reader)).length, 3);
  const failed = await services.webhooks.readWebhookDeliveries({ status: 'failed' }, reader);
  assert.deepEqual(failed.map((delivery) => delivery.id), [failedId]);
  assert.equal((await services.webhooks.readWebhookDeliveries({ endpointId: second.id, status: 'pending' }, reader)).length, 3);
  assert.equal((await services.webhooks.readWebhookDeliveries({ limit: 2 }, reader)).length, 2);
  await assert.rejects(services.webhooks.readWebhookDeliveries({ limit: 0 }, reader), (error: { code?: string }) => error.code === 'INVALID_REQUEST');
  await assert.rejects(services.webhooks.readWebhookDeliveries({ limit: 201 }, reader), (error: { code?: string }) => error.code === 'INVALID_REQUEST');
  await assert.rejects(services.webhooks.readWebhookDeliveries({ status: 'dead' as never }, reader), (error: { code?: string }) => error.code === 'INVALID_REQUEST');

  const one = await services.webhooks.readWebhookDelivery({ id: failedId }, reader);
  assert.equal(one?.status, 'failed');
  assert.equal(await services.webhooks.readWebhookDelivery({ id: 'missing' }, reader), null);

  // Through invoke, the public dispatcher.
  assert.equal((await services.invoke('webhooks.deliveries.read', { status: 'failed' }, { principal: reader }) as unknown[]).length, 1);
  assert.equal(((await services.invoke('webhooks.deliveries.read', { id: failedId }, { principal: reader })) as { id: string }).id, failedId);

  // Tenant isolation: another tenant's caller sees none of them.
  const outsider = services.identify(claims.otherTenant)!;
  assert.deepEqual(await services.webhooks.readWebhookDeliveries({}, outsider), []);
  assert.equal(await services.webhooks.readWebhookDelivery({ id: failedId }, outsider), null);
  await assert.rejects(services.webhooks.readWebhookDeliveries({ tenantId: 'tenant-a' } as never, outsider), (error: { code?: string }) => error.code === 'DENIED');
  await services.apiKeys.close();
});

test('webhooks.read and webhooks.deliveries.read are independent', async () => {
  const { services } = await setup();
  const endpointsOnly = services.identify(claims.endpointsOnly)!;
  const deliveriesOnly = services.identify(claims.deliveriesOnly)!;
  await assert.rejects(services.webhooks.readWebhookDeliveries({}, endpointsOnly), (error: { code?: string }) => error.code === 'DENIED');
  assert.equal((await services.invoke('webhooks.read', {}, { principal: endpointsOnly }) as unknown[]).length, 2, 'webhooks.read keeps working for endpoints');
  await assert.rejects(services.invoke('webhooks.read', {}, { principal: deliveriesOnly }), (error: { code?: string }) => error.code === 'DENIED');
  await services.apiKeys.close();
});

test('deliveries to another application\'s endpoints are not returned', async () => {
  const { services } = await setup();
  // A second application sharing the namespace and tenant.
  const neighbour = createServices({ db: services.db, application: 'neighbour-app', authorizer: new TestAuthority({ allowAll: true }) });
  const reader = neighbour.identify(claims.deliveriesOnly)!;
  assert.deepEqual(await neighbour.webhooks.readWebhookDeliveries({}, reader), []);
  await services.apiKeys.close();
});

test('the management router serves GET /_appport/webhooks/deliveries[/:id] under webhooks.deliveries.read', async () => {
  const { services, failedId, first } = await setup();
  const { server, get } = await mount(services);
  try {
    const listed = await get('/_appport/webhooks/deliveries?status=failed', 'deliveriesOnly');
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json() as Array<{ id: string }>).map((delivery) => delivery.id), [failedId]);
    const byEndpoint = await get(`/_appport/webhooks/deliveries?endpointId=${first.id}&limit=2`, 'deliveriesOnly');
    assert.equal((await byEndpoint.json() as unknown[]).length, 2);
    assert.equal((await get('/_appport/webhooks/deliveries?limit=0', 'deliveriesOnly')).status, 400);
    assert.equal((await get(`/_appport/webhooks/deliveries/${failedId}`, 'deliveriesOnly')).status, 200);
    assert.equal((await get('/_appport/webhooks/deliveries/missing', 'deliveriesOnly')).status, 404);
    assert.equal((await get('/_appport/webhooks/deliveries', 'endpointsOnly')).status, 403, 'webhooks.read does not grant delivery reads');
    assert.equal((await get('/_appport/webhooks', 'endpointsOnly')).status, 200, 'endpoint reads are unchanged');
    assert.equal((await get('/_appport/webhooks/deliveries', 'nobody')).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await services.apiKeys.close();
  }
});
