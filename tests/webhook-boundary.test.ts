import assert from 'node:assert/strict';
import test from 'node:test';

import { ServiceAuthorityError } from '../src/authority/errors.js';
import { isForbiddenAddress, validateDestination } from '../src/authority/destination.js';
import type { VerifiedPrincipal } from '../src/authority/principal.js';
import { TestAuthority, TestCredentials } from './support/authority.js';
import { openStack, receiver, scratchPath, signInbound } from './support/stack.js';

const code = (expected: string) => (error: unknown) => error instanceof ServiceAuthorityError && error.code === expected;
const STRIPE_SECRET = 'whsec_stripe_inbound_secret';

async function inboundFixture(path?: string) {
  const authority = new TestAuthority();
  await authority.grant({ subject: 'ops', capability: 'webhooks.integrations.register', tenantId: 'tenant-a' });
  await authority.grant({ subject: 'integration:stripe', capability: 'webhooks.receive', tenantId: 'tenant-a' });
  await authority.grant({ subject: 'integration:stripe', capability: 'notifications.send', tenantId: 'tenant-a' });
  const credentials = new TestCredentials();
  const ref = credentials.put('stripe-signing', 'tenant-a', STRIPE_SECRET);
  credentials.put('other-signing', 'tenant-a', 'other-secret');
  const stack = await openStack({ path, authorizer: authority, credentials });
  const seen: { principal: VerifiedPrincipal; payload: unknown }[] = [];
  stack.services.webhooks.registerInboundHandler('stripe', async ({ event, principal }) => {
    seen.push({ principal, payload: event.payload });
    return stack.services.invoke('notifications.send', { recipient: 'finance', type: 'payment', title: 'Payment received' }, { principal });
  });
  return { authority, credentials, ref, stack, seen };
}

test('valid inbound webhook runs as the integration principal and the payload cannot choose principal or credential', async () => {
  const { stack, ref, seen, credentials } = await inboundFixture();
  try {
    const ops = stack.services.identify({ principalId: 'ops', principalType: 'user', tenantId: 'tenant-a' })!;
    const integration = await stack.services.webhooks.registerIntegration({ provider: 'stripe', signingCredentialRef: ref }, ops);
    assert.equal(integration.principalId, 'integration:stripe');
    const body = JSON.stringify({ id: 'evt_1', principal: 'admin', principalId: 'admin', actor: 'admin', tenantId: 'tenant-b', signingCredentialRef: 'credential-ref:other-signing' });
    const result = await stack.services.webhooks.receiveWebhook({ integrationId: integration.id, rawBody: body, headers: signInbound(STRIPE_SECRET, body, 'evt_1') });
    assert.equal(result.accepted, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].principal.principalId, 'integration:stripe');
    assert.equal(seen[0].principal.principalType, 'integration');
    assert.equal(seen[0].principal.tenantId, 'tenant-a');
    assert.equal(seen[0].principal.verifiedBy, 'integration');
    assert.deepEqual(credentials.resolutions.map((entry) => entry.reference.secretId), ['stripe-signing']);
    // A signature made with a credential the payload names is not accepted.
    const forged = JSON.stringify({ id: 'evt_2', signingCredentialRef: 'credential-ref:other-signing' });
    await assert.rejects(stack.services.webhooks.receiveWebhook({ integrationId: integration.id, rawBody: forged, headers: signInbound('other-secret', forged, 'evt_2') }), code('DENIED'));
  } finally {
    await stack.close();
  }
});

test('invalid signature, stale timestamp, and missing headers are denied before the handler runs', async () => {
  const { stack, ref, seen } = await inboundFixture();
  try {
    const ops = stack.services.identify({ principalId: 'ops', principalType: 'user', tenantId: 'tenant-a' })!;
    const integration = await stack.services.webhooks.registerIntegration({ provider: 'stripe', signingCredentialRef: ref }, ops);
    const body = JSON.stringify({ id: 'evt_bad' });
    await assert.rejects(stack.services.webhooks.receiveWebhook({ integrationId: integration.id, rawBody: body, headers: signInbound('wrong-secret', body, 'evt_bad') }), code('DENIED'));
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await assert.rejects(stack.services.webhooks.receiveWebhook({ integrationId: integration.id, rawBody: body, headers: signInbound(STRIPE_SECRET, body, 'evt_old', stale) }), code('DENIED'));
    await assert.rejects(stack.services.webhooks.receiveWebhook({ integrationId: integration.id, rawBody: body, headers: {} }), code('INVALID_REQUEST'));
    await assert.rejects(stack.services.webhooks.receiveWebhook({ integrationId: 'unknown', rawBody: body, headers: signInbound(STRIPE_SECRET, body, 'evt_x') }), code('NOT_FOUND'));
    assert.equal(seen.length, 0);
  } finally {
    await stack.close();
  }
});

test('inbound replay is rejected durably, including after a process restart', async () => {
  const path = await scratchPath('appport-inbound-replay-');
  let fixture = await inboundFixture(path);
  const ops = fixture.stack.services.identify({ principalId: 'ops', principalType: 'user', tenantId: 'tenant-a' })!;
  const integration = await fixture.stack.services.webhooks.registerIntegration({ provider: 'stripe', signingCredentialRef: fixture.ref }, ops);
  const body = JSON.stringify({ id: 'evt_replay' });
  const headers = signInbound(STRIPE_SECRET, body, 'evt_replay');
  await fixture.stack.services.webhooks.receiveWebhook({ integrationId: integration.id, rawBody: body, headers });
  await assert.rejects(fixture.stack.services.webhooks.receiveWebhook({ integrationId: integration.id, rawBody: body, headers }), code('DENIED'));
  await fixture.stack.close();

  fixture = await inboundFixture(path);
  try {
    await assert.rejects(fixture.stack.services.webhooks.receiveWebhook({ integrationId: integration.id, rawBody: body, headers }), code('DENIED'));
    assert.equal(fixture.seen.length, 0);
    assert.equal((await fixture.stack.db.collection('notifications').list()).length, 1);
  } finally {
    await fixture.stack.close();
  }
});

test('an integration without an AuthBoundry grant cannot receive or cause effects', async () => {
  const { stack, ref, seen, authority, credentials } = await inboundFixture();
  try {
    const ops = stack.services.identify({ principalId: 'ops', principalType: 'user', tenantId: 'tenant-a' })!;
    const integration = await stack.services.webhooks.registerIntegration({ provider: 'stripe', signingCredentialRef: ref }, ops);
    authority.clearGrants();
    const body = JSON.stringify({ id: 'evt_ungranted' });
    await assert.rejects(stack.services.webhooks.receiveWebhook({ integrationId: integration.id, rawBody: body, headers: signInbound(STRIPE_SECRET, body, 'evt_ungranted') }), code('DENIED'));
    assert.equal(seen.length, 0);
    assert.equal(credentials.resolutions.length, 0, 'no credential resolution before authorization');
  } finally {
    await stack.close();
  }
});

test('destination policy rejects private, loopback, link-local, metadata, and unspecified destinations', async () => {
  for (const url of [
    'http://localhost/x', 'http://api.localhost/x', 'http://127.0.0.1/x', 'http://127.1.2.3/x', 'http://[::1]/x', 'http://0.0.0.0/x', 'http://[::]/x',
    'http://10.0.0.8/x', 'http://172.16.4.4/x', 'http://192.168.1.1/x', 'http://100.64.0.1/x', 'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/computeMetadata/v1', 'http://[fd00:ec2::254]/x', 'http://[fe80::1]/x', 'http://[::ffff:127.0.0.1]/x',
    'http://[::ffff:a9fe:a9fe]/x', 'ftp://example.com/x', 'http://user:pass@example.com/x', 'not a url',
  ]) {
    await assert.rejects(validateDestination(url), code('INVALID_REQUEST'), url);
  }
  // Resolution is what is trusted, not the string.
  const rebinding = { lookup: async () => [{ address: '93.184.216.34', family: 4 as const }, { address: '10.1.1.1', family: 4 as const }] };
  await assert.rejects(validateDestination('https://customer.example.com/events', rebinding), code('INVALID_REQUEST'));
  const publicOnly = { lookup: async () => [{ address: '93.184.216.34', family: 4 as const }] };
  assert.equal((await validateDestination('https://customer.example.com/events', publicOnly)).address.address, '93.184.216.34');
  assert.equal(isForbiddenAddress('8.8.8.8'), false);
  assert.equal(isForbiddenAddress('2606:4700:4700::1111'), false);
});

test('webhook registration applies the destination policy and emit cannot choose a destination', async () => {
  const authority = new TestAuthority({ allowAll: true });
  const credentials = new TestCredentials();
  const ref = credentials.put('sign', 'tenant-a', 'secret');
  let addresses = [{ address: '93.184.216.34', family: 4 as const }];
  const stack = await openStack({ authorizer: authority, credentials, destinations: { lookup: async () => addresses } });
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    await assert.rejects(stack.services.webhooks.createWebhookEndpoint({ url: 'http://169.254.169.254/latest', events: ['e'], signingCredentialRef: ref }, alice), code('INVALID_REQUEST'));
    await assert.rejects(stack.services.webhooks.createWebhookEndpoint({ url: 'http://127.0.0.1:8080/', events: ['e'], signingCredentialRef: ref }, alice), code('INVALID_REQUEST'));
    const endpoint = await stack.services.webhooks.createWebhookEndpoint({ url: 'https://customer.example.com/events', events: ['e'], signingCredentialRef: ref }, alice);
    assert.equal(endpoint.url, 'https://customer.example.com/events');
    assert.equal(endpoint.signingCredentialRef, ref);
    await assert.rejects(stack.services.invoke('webhooks.emit', { type: 'e', payload: {}, url: 'https://attacker.example.com' }, { principal: alice }), code('INVALID_REQUEST'));
    await assert.rejects(stack.services.invoke('webhooks.emit', { type: 'e', payload: {}, endpointId: endpoint.id }, { principal: alice }), code('INVALID_REQUEST'));

    // DNS now answers with a private address: delivery re-validates and never connects.
    const [delivery] = await stack.services.webhooks.emitWebhookEvent({ type: 'e', payload: {} }, alice);
    addresses = [{ address: '127.0.0.1', family: 4 }];
    const result = await stack.services.webhooks.deliverWebhook('tenant-a', delivery.id);
    assert.equal(result.success, false);
    assert.equal(result.code, 'INVALID_REQUEST');
    assert.equal(credentials.resolutions.length, 0);
  } finally {
    await stack.close();
  }
});

test('redirects are never followed, so a delivery cannot escape to a forbidden destination', async () => {
  const internal = await receiver();
  const redirecting = await receiver();
  redirecting.status = 302;
  redirecting.headers = { location: internal.url };
  const credentials = new TestCredentials();
  const ref = credentials.put('sign', 'tenant-a', 'secret');
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }), credentials });
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    await stack.services.webhooks.createWebhookEndpoint({ url: redirecting.url, events: ['e'], signingCredentialRef: ref }, alice);
    const [delivery] = await stack.services.webhooks.emitWebhookEvent({ type: 'e', payload: {} }, alice);
    const result = await stack.services.webhooks.deliverWebhook('tenant-a', delivery.id);
    assert.equal(result.success, false);
    assert.equal(result.code, 'PROVIDER_ERROR');
    assert.match(result.error ?? '', /redirects are not followed/);
    assert.equal(redirecting.requests.length, 1);
    assert.equal(internal.requests.length, 0);
    assert.equal((await stack.services.webhooks.getWebhookDelivery('tenant-a', delivery.id))?.status, 'failed');
  } finally {
    await stack.close();
    await internal.close();
    await redirecting.close();
  }
});
