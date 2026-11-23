import assert from 'node:assert/strict';
import test from 'node:test';

import { createServices, isServiceAuthorityError } from '../src/index.js';
import { TestAuthority } from './support/authority.js';
import { MemoryCustody } from './support/custody.js';
import { receiver } from './support/stack.js';

const SETUP = { tenantId: 'tenant-a', principalId: 'host', purpose: 'test', authorizationRef: 'setup' };

function open(application: string, options: { authority?: TestAuthority; custody?: unknown; db?: unknown } = {}) {
  const services = createServices({
    ...(options.db ? { db: options.db } : { memory: true, namespace: `gaps-${crypto.randomUUID()}` }),
    application, authorizer: options.authority ?? new TestAuthority({ allowAll: true }),
    ...(options.custody ? { credentials: options.custody } : {}),
    webhookDestinationPolicy: { allowPrivateNetworks: true },
  } as never);
  return { services, host: services.identify({ principalId: 'host-1', principalType: 'user', tenantId: 'tenant-a' })! };
}

test('S3b: credentialBindings is a counts-free host read of names and references that writes no evidence', async () => {
  const { services, host } = open('meetings');
  await services.configuration.createSecret({ name: 'TURN_KEY', credentialRef: 'credential-ref:turn', environment: 'production', required: true }, host);
  await services.configuration.createSecret({ name: 'STT_KEY', credentialRef: 'credential-ref:stt', environment: 'staging' }, host);
  const other = open('other-app', { db: services.db });
  await other.services.configuration.createSecret({ name: 'OTHER', credentialRef: 'credential-ref:other', environment: 'production' }, other.host);
  const evidenceBefore = (await services.db.collection('service_effect_evidence').list()).length;
  const all = await services.credentialBindings({ tenantId: 'tenant-a' });
  assert.deepEqual(all.bindings.map((binding) => [binding.environment, binding.name, binding.credentialRef, binding.required]), [
    ['production', 'TURN_KEY', 'credential-ref:turn', true],
    ['staging', 'STT_KEY', 'credential-ref:stt', false],
  ]);
  assert.equal(all.truncated, false);
  assert.deepEqual((await services.credentialBindings({ environment: 'staging' })).bindings.map((binding) => binding.name), ['STT_KEY']);
  assert.equal((await services.credentialBindings({ limit: 1 })).truncated, true);
  assert.equal((await services.db.collection('service_effect_evidence').list()).length, evidenceBefore, 'no evidence written');
  await assert.rejects(services.credentialBindings({ limit: 0 }), /limit/);
});

test('S9a: credential.remove removes material from custody with audit and evidence, and can detach the binding', async () => {
  const custody = new MemoryCustody();
  const authority = new TestAuthority();
  const { services, host } = open('meetings', { authority, custody });
  await authority.grant({ subject: 'host-1', capability: 'credential.store' });
  await authority.grant({ subject: 'host-1', capability: 'credential.attach' });
  await services.configuration.storeCredential({ ref: 'credential-ref:calendar', value: 'cal-secret-1', name: 'CALENDAR_KEY', provider: 'calendar' }, host);
  await assert.rejects(services.configuration.removeCredential({ ref: 'credential-ref:calendar' }, host), /AuthBoundry denied credential\.remove/);
  assert.equal((await custody.status({ reference: { secretId: 'calendar', tenantId: 'tenant-a' }, context: SETUP })).state, 'set', 'a denied removal removes nothing');
  await authority.grant({ subject: 'host-1', capability: 'credential.remove' });
  await authority.grant({ subject: 'host-1', capability: 'credential.detach' });
  const result = await services.invoke('credential.remove', { ref: 'credential-ref:calendar', name: 'CALENDAR_KEY', provider: 'calendar' }, { principal: host }) as { removed: boolean; detached?: string };
  assert.deepEqual([result.removed, result.detached], [true, 'CALENDAR_KEY']);
  assert.equal((await custody.status({ reference: { secretId: 'calendar', tenantId: 'tenant-a' }, context: SETUP })).state, 'revoked');
  assert.deepEqual((await services.credentialBindings()).bindings, []);
  const secrets = await services.db.collection<{ name: string; status: string }>('Secrets').list();
  assert.deepEqual(secrets.map((secret) => [secret.name, secret.status]), [['calendar', 'revoked']]);
  const audit = await services.db.collection<{ type: string }>('SecretAuditEvents').list();
  assert.ok(audit.some((event) => event.type === 'secret.revoked'));
  const evidence = await services.db.collection<{ capability: string; credentialRef?: string; outcome: string }>('service_effect_evidence').list();
  assert.ok(evidence.some((row) => row.capability === 'credential.remove' && row.credentialRef === 'credential-ref:calendar' && row.outcome === 'succeeded'));
  assert.ok(evidence.some((row) => row.capability === 'credential.remove' && row.outcome === 'denied'));
  // Host-managed (read-only) material cannot be removed here.
  custody.hostManaged.add('env-only');
  await assert.rejects(services.configuration.removeCredential({ ref: 'credential-ref:env-only' }, host), (error: unknown) => isServiceAuthorityError(error) && error.code === 'CUSTODY_READ_ONLY');
});

test('S3a: webhook delivery counts in health() are per application; S8: replay keeps the owner and refuses delivered', async () => {
  const hook = await receiver();
  const custody = new MemoryCustody();
  await custody.store({ reference: { secretId: 'signing', tenantId: 'tenant-a' }, value: 'whsec_test', context: SETUP });
  try {
    const authority = new TestAuthority({ allowAll: true });
    const a = open('meetings', { authority, custody });
    const b = open('billing', { authority, custody, db: a.services.db });
    for (const app of [a, b]) await app.services.webhooks.createWebhookEndpoint({ url: hook.url, events: ['meeting.ended'], signingCredentialRef: 'credential-ref:signing' }, app.host);
    hook.status = 500;
    const [failing] = await a.services.webhooks.emitWebhookEvent({ type: 'meeting.ended', payload: { id: 1 } }, a.host);
    await b.services.webhooks.emitWebhookEvent({ type: 'meeting.ended', payload: { id: 2 } }, b.host);
    await b.services.webhooks.emitWebhookEvent({ type: 'meeting.ended', payload: { id: 3 } }, b.host);
    assert.equal(failing!.applicationId, 'meetings');
    const health = await a.services.health({ tenantId: 'tenant-a' });
    assert.equal(health.services.webhooks.counts.pendingDeliveries, 1, 'only this application\'s deliveries');
    assert.equal((await a.services.health({ tenantId: 'tenant-a', webhookDeliveryScope: 'namespace' })).services.webhooks.counts.pendingDeliveries, 3);

    // A different principal replays a's failed delivery: the owner stays the emitter.
    const operator = a.services.identify({ principalId: 'operator-1', principalType: 'user', tenantId: 'tenant-a' })!;
    for (let attempt = 0; attempt < 6; attempt++) await a.services.webhooks.deliverWebhook('tenant-a', failing!.id).catch(() => undefined);
    const replayed = (await a.services.webhooks.replayWebhookDelivery('tenant-a', failing!.id, operator))!;
    assert.deepEqual([replayed.status, replayed.principal?.principalId, replayed.replayedBy], ['pending', 'host-1', 'operator-1']);
    const replayRequest = authority.requests.filter((request) => request.capability === 'webhooks.replay').at(-1)!;
    assert.equal(replayRequest.resource.attributes?.owner, 'host-1');
    hook.status = 200;
    const delivered = await a.services.webhooks.deliverWebhook('tenant-a', failing!.id);
    assert.equal(delivered.success, true);
    const deliverRequest = authority.requests.filter((request) => request.capability === 'webhooks.deliver').at(-1)!;
    assert.equal(deliverRequest.subject.id, 'host-1', 'the attempt is authorized as the original principal');
    await assert.rejects(a.services.webhooks.replayWebhookDelivery('tenant-a', failing!.id, operator), (error: unknown) => isServiceAuthorityError(error) && error.code === 'INVALID_REQUEST' && error.details.reason === 'delivery_delivered');
  } finally {
    await hook.close();
  }
});
