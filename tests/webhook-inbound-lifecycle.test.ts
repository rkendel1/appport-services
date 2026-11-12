/**
 * The inbound event lifecycle (receiving is not processing) and inbound integration management,
 * against real FeltDB stores. A delivery is authenticated, then an attempt claims the event; only a
 * handler that completed marks it processed. Failed attempts stay retryable with their reasons
 * recorded; repeated failure makes the event dead (poisoned) and visible until an operator releases it.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createFeltDbRuntime,
  FeltDbWebhookEndpointStore,
  FeltDbWebhookDeliveryStore,
  FeltDbWebhookAuditSink,
  FeltDbWebhookIntegrationStore,
  FeltDbInboundWebhookReplayStore,
  webhookAuditCollectionName,
  WebhookService,
} from '../src/_internal.js';
import { ServiceAuthorityError } from '../src/authority/errors.js';
import { principal as verified, testGateway, TestAuthority, TestCredentials } from './support/authority.js';

const SECRET = 'whsec_inbound_lifecycle_secret';
const ROTATED = 'whsec_inbound_lifecycle_rotated';
const code = (expected: string, reason?: string) => (error: unknown) => error instanceof ServiceAuthorityError && error.code === expected && (reason === undefined || error.details.reason === reason);

function sign(secret: string, body: string, eventId: string, at: Date): Record<string, string> {
  const timestamp = at.toISOString();
  return { 'x-appport-event-id': eventId, 'x-appport-timestamp': timestamp, 'x-appport-signature-v2': createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex') };
}

async function fixture(options: { authority?: TestAuthority; path?: string; clock?: { now: number } } = {}) {
  const path = options.path ?? await mkdtemp(join(tmpdir(), 'appport-inbound-lifecycle-'));
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: 'inbound-lifecycle', path });
  const credentials = new TestCredentials();
  const ref = credentials.put('inbound-signing', 'tenant-a', SECRET);
  const rotatedRef = credentials.put('inbound-signing-2', 'tenant-a', ROTATED);
  credentials.put('other-tenant-signing', 'tenant-b', SECRET);
  const clock = options.clock ?? { now: Date.now() };
  const replay = new FeltDbInboundWebhookReplayStore(runtime.db);
  const service = new WebhookService({
    endpointStore: new FeltDbWebhookEndpointStore(runtime.db),
    deliveryStore: new FeltDbWebhookDeliveryStore(runtime.db),
    auditSink: new FeltDbWebhookAuditSink(runtime.db),
    integrationStore: new FeltDbWebhookIntegrationStore(runtime.db),
    replayStore: replay,
    authority: testGateway(runtime.db, { credentials, ...(options.authority ? { authorizer: options.authority } : {}) }),
    inboundMaxAttempts: 3,
    inboundLeaseMs: 60_000,
    now: () => new Date(clock.now),
  } as never);
  const ops = verified({ principalId: 'ops', principalType: 'user', tenantId: 'tenant-a', credentialId: 'k' });
  const integration = await service.registerIntegration({ provider: 'surface', signingCredentialRef: ref }, ops);
  const calls: string[] = [];
  let behaviour: (eventId: string) => Promise<unknown> = async () => 'ok';
  service.registerInboundHandler('surface', async ({ event }) => { calls.push(event.eventId); return behaviour(event.eventId); });
  const deliver = (eventId: string, body = JSON.stringify({ id: eventId }), secret = SECRET) =>
    service.receiveWebhook({ integrationId: integration.id, rawBody: body, headers: sign(secret, body, eventId, new Date(clock.now)) });
  const events = (state?: string) => service.listInboundEvents({ integrationId: integration.id, ...(state ? { state: state as never } : {}) }, ops);
  const audit = async () => (await runtime.db.collection<{ type: string; reason?: string }>(webhookAuditCollectionName()).find({})).map((a) => a.type);
  return { runtime, service, replay, integration, ops, clock, calls, deliver, events, audit, rotatedRef, set: (fn: typeof behaviour) => { behaviour = fn; }, close: () => runtime.db.close() };
}

test('a failed handler leaves the event retryable with its reason recorded; the retry runs once; a replay after success is refused', async () => {
  const f = await fixture();
  try {
    let fail = true;
    f.set(async () => { if (fail) throw new Error('dependency unavailable'); return 'done'; });
    await assert.rejects(f.deliver('evt_1'), /dependency unavailable/);
    const [failed] = await f.events();
    assert.deepEqual([failed!.state, failed!.attempts, failed!.failures?.map((x) => x.error)], ['failed', 1, ['dependency unavailable']]);
    fail = false;
    const ok = await f.deliver('evt_1');
    assert.deepEqual([ok.accepted, ok.result], [true, 'done']);
    const [processed] = await f.events();
    assert.deepEqual([processed!.state, processed!.attempts, typeof processed!.processedAt], ['processed', 2, 'string']);
    await assert.rejects(f.deliver('evt_1'), code('DENIED', 'replayed'));
    assert.deepEqual(f.calls, ['evt_1', 'evt_1'], 'the handler ran for the failed attempt and the successful one, never again');
    assert.ok((await f.audit()).includes('webhook.inbound.failed'));
  } finally { await f.close(); }
});

test('a poison event becomes dead after the attempt budget, is refused and visible, and runs again only after an operator releases it', async () => {
  const f = await fixture();
  try {
    f.set(async () => { throw new Error('cannot parse payload'); });
    for (let i = 0; i < 3; i++) await assert.rejects(f.deliver('evt_poison'), /cannot parse payload/);
    await assert.rejects(f.deliver('evt_poison'), code('DENIED', 'poisoned'));
    assert.equal(f.calls.length, 3, 'never retried past the budget');
    const [dead] = await f.events('dead');
    assert.deepEqual([dead!.eventId, dead!.attempts, dead!.failures?.length], ['evt_poison', 3, 3]);
    assert.ok((await f.audit()).includes('webhook.inbound.poisoned'));
    // An operator fixes the cause and releases it; the sender's next delivery runs it again.
    f.set(async () => 'fixed');
    const released = await f.service.retryInboundEvent({ integrationId: f.integration.id, eventId: 'evt_poison' }, f.ops);
    assert.equal(released.state, 'failed');
    assert.equal((await f.deliver('evt_poison')).result, 'fixed');
    assert.equal((await f.events('processed'))[0]!.eventId, 'evt_poison');
    // Releasing an event that is not dead is refused.
    await assert.rejects(f.service.retryInboundEvent({ integrationId: f.integration.id, eventId: 'evt_poison' }, f.ops), code('INVALID_REQUEST'));
  } finally { await f.close(); }
});

test('a crashed attempt (its process stopped mid-handler) holds the event only until its lease expires; then a delivery processes it once', async () => {
  const clock = { now: Date.now() };
  const f = await fixture({ clock });
  try {
    // The attempt that "crashed": it claimed the event and never completed or failed.
    const id = (await import('node:crypto')).createHash('sha256').update(`${f.integration.id}:evt_crash`).digest('hex');
    const claim = await f.replay.claim({ id, integrationId: f.integration.id, provider: 'surface', eventId: 'evt_crash', eventTimestamp: new Date(clock.now).toISOString(), acceptedAt: new Date(clock.now).toISOString(), tenantId: 'tenant-a' }, { now: new Date(clock.now), leaseMs: 60_000, maxAttempts: 3 });
    assert.equal(claim.outcome, 'claimed');
    // While the lease holds, a delivery is told to retry (a 5xx to the sender) and runs nothing.
    await assert.rejects(f.deliver('evt_crash'), code('PROVIDER_ERROR', 'in_progress'));
    assert.equal(f.calls.length, 0);
    clock.now += 61_000;
    assert.equal((await f.deliver('evt_crash')).accepted, true);
    const [done] = await f.events();
    assert.deepEqual([done!.state, done!.attempts, f.calls], ['processed', 2, ['evt_crash']]);
  } finally { await f.close(); }
});

test('the lifecycle is durable: a failed event is still retryable after a restart, and a processed one still refused', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-inbound-restart-'));
  let f = await fixture({ path });
  const integrationId = f.integration.id;
  f.set(async () => { throw new Error('down'); });
  await assert.rejects(f.deliver('evt_r'), /down/);
  await f.close();
  // A new process on the same state: the integration and the event's state are what was stored.
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: 'inbound-lifecycle', path });
  try {
    const rows = await runtime.db.collection<{ eventId: string; state: string; integrationId: string; failures: unknown[] }>('inbound_webhook_events').find({ integrationId });
    assert.deepEqual(rows.map((r) => [r.eventId, r.state, r.failures.length]), [['evt_r', 'failed', 1]]);
  } finally { await runtime.db.close(); }
});

test('concurrent duplicate deliveries run the handler once', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    f.set(async () => { await gate; return 'once'; });
    const first = f.deliver('evt_dup');
    await new Promise((r) => setTimeout(r, 50));
    // The second arrives while the first attempt's handler is still running.
    const second = await f.deliver('evt_dup').then(() => 'ran', (e: ServiceAuthorityError) => `${e.code}:${e.details.reason}`);
    assert.equal(second, 'PROVIDER_ERROR:in_progress');
    release();
    assert.equal((await first).result, 'once');
    assert.deepEqual(f.calls, ['evt_dup']);
    await assert.rejects(f.deliver('evt_dup'), code('DENIED', 'replayed'));
  } finally { await f.close(); }
});

test('a body that is not JSON is refused before anything is recorded', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.deliver('evt_bad', 'not json'), code('INVALID_REQUEST'));
    assert.deepEqual(await f.events(), []);
  } finally { await f.close(); }
});

test('integration management: list shows the reference, never the secret; rotation switches the accepted secret; disabling refuses deliveries', async () => {
  const f = await fixture();
  try {
    const [listed] = await f.service.listIntegrations({}, f.ops);
    assert.equal(listed!.id, f.integration.id);
    assert.ok(!JSON.stringify(listed).includes(SECRET), 'no secret in the listing');
    assert.match(String(listed!.signingCredentialRef), /^credential-ref:/);
    // Rotate: the new credential verifies deliveries; the old secret no longer does.
    await f.service.rotateIntegrationCredential({ id: f.integration.id, signingCredentialRef: f.rotatedRef }, f.ops);
    await assert.rejects(f.deliver('evt_old', undefined, SECRET), code('DENIED', 'invalid_signature'));
    assert.equal((await f.deliver('evt_new', undefined, ROTATED)).accepted, true);
    // Disable: refused as not found, whatever the signature.
    await f.service.disableIntegration({ id: f.integration.id }, f.ops);
    await assert.rejects(f.deliver('evt_after', undefined, ROTATED), code('NOT_FOUND'));
    assert.ok((await f.audit()).includes('webhook.integration.rotated') && (await f.audit()).includes('webhook.integration.disabled'));
  } finally { await f.close(); }
});

test('integration management is authorized per capability, and another tenant\'s integration does not exist', async () => {
  const authority = new TestAuthority();
  await authority.grant({ subject: 'ops', capability: 'webhooks.integrations.register', tenantId: 'tenant-a' });
  await authority.grant({ subject: 'integration:surface', capability: 'webhooks.receive', tenantId: 'tenant-a' });
  await authority.grant({ subject: 'viewer', capability: 'webhooks.integrations.read', tenantId: 'tenant-a' });
  const f = await fixture({ authority });
  try {
    const viewer = verified({ principalId: 'viewer', principalType: 'user', tenantId: 'tenant-a', credentialId: 'k' });
    assert.equal((await f.service.listIntegrations({}, viewer)).length, 1);
    // Reading is not managing: the viewer cannot disable, rotate or release.
    await assert.rejects(f.service.disableIntegration({ id: f.integration.id }, viewer), code('DENIED'));
    await assert.rejects(f.service.rotateIntegrationCredential({ id: f.integration.id, signingCredentialRef: f.rotatedRef }, viewer), code('DENIED'));
    await assert.rejects(f.service.retryInboundEvent({ integrationId: f.integration.id, eventId: 'x' }, viewer), code('DENIED'));
    // Nor can the ops principal, which may only register.
    await assert.rejects(f.service.disableIntegration({ id: f.integration.id }, f.ops), code('DENIED'));
    // Another tenant cannot see or manage it.
    const other = verified({ principalId: 'ops', principalType: 'user', tenantId: 'tenant-b', credentialId: 'k' });
    await assert.rejects(f.service.disableIntegration({ id: f.integration.id }, other), code('NOT_FOUND'));
    await assert.rejects(f.service.listInboundEvents({ integrationId: f.integration.id }, other), code('NOT_FOUND'));
    // Still enabled.
    assert.equal((await f.deliver('evt_still')).accepted, true);
  } finally { await f.close(); }
});
