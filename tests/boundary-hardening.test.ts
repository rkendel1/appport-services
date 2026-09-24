/**
 * Regression coverage for review findings on the service boundary:
 * resource-type binding, credential binding, delegation attestation,
 * legacy secret stripping, application scoping, update field allow-listing,
 * and transaction endpoint/delegation binding.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FeltDbConfigurationStore, FeltDbJobStore } from '../src/_internal.js';
import { ServiceAuthorityError } from '../src/authority/errors.js';
import type { ConfigurationSecret } from '../src/configuration/models.js';
import { TestAuthority, TestCredentials } from './support/authority.js';
import { openStack, scratchPath } from './support/stack.js';

const code = (expected: string) => (error: unknown) => error instanceof ServiceAuthorityError && error.code === expected;
const PUBLIC = { lookup: async () => [{ address: '93.184.216.34', family: 4 as const }] };

test('a capability is bound to its declared resource type', async () => {
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    await assert.rejects(stack.services.authorize('jobs.create', alice, { type: 'file' }), code('INVALID_REQUEST'));
    await assert.rejects(stack.services.gateway.execute('files.write', alice, { type: 'job', tenantId: 'tenant-a' }, { service: 'x' }, async () => 'ran'), code('INVALID_REQUEST'));
  } finally {
    await stack.close();
  }
});

test('an execution context resolves only the credential it was authorized for', async () => {
  const credentials = new TestCredentials();
  const allowed = credentials.put('cred-allowed', 'tenant-a', 'allowed-value');
  const other = credentials.put('cred-other', 'tenant-a', 'other-value');
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }), credentials });
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    const context = await stack.services.authorize('credential.attach', alice, { type: 'credential', attributes: { credentialRef: allowed } });
    await assert.rejects(stack.services.gateway.run(context, { service: 'test' }, (_ctx, tools) => tools.withCredential(other as never, 'probe', ({ value }) => value)), code('DENIED'));
    assert.equal(credentials.resolutions.length, 0);
    const second = await stack.services.authorize('credential.attach', alice, { type: 'credential', attributes: { credentialRef: allowed } });
    assert.equal(await stack.services.gateway.run(second, { service: 'test' }, (_ctx, tools) => tools.withCredential(allowed as never, 'probe', ({ value }) => value)), 'allowed-value');
  } finally {
    await stack.close();
  }
});

test('attestation binds the delegation: a real decision cannot be reused with another delegation', async () => {
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  try {
    let runs = 0;
    stack.services.jobs.register('agent.task', async () => { runs += 1; });
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    const real = await stack.services.jobs.enqueue({ type: 'agent.task', payload: {}, delegationId: 'del-narrow' }, alice);
    const now = new Date().toISOString();
    const forgedId = crypto.randomUUID();
    await new FeltDbJobStore(stack.db).create({ ...real, id: forgedId, status: 'pending', runAt: now, principal: { ...real.principal!, delegationId: 'del-broad' }, __version: 1 });
    assert.equal(await stack.services.jobs.executeJob('tenant-a', forgedId, 'worker'), false);
    assert.equal(runs, 0);
    assert.equal(await stack.services.jobs.executeJob('tenant-a', real.id, 'worker'), true);
    assert.equal(runs, 1);
  } finally {
    await stack.close();
  }
});

test('rotating a legacy secret row removes its stored raw value', async () => {
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  try {
    const store = new FeltDbConfigurationStore(stack.db);
    const now = new Date().toISOString();
    const legacy = { id: crypto.randomUUID(), tenantId: 'tenant-a', applicationId: 'boundary-app', environment: 'production', name: 'SMTP', value: 'legacy-raw-password', required: false, createdAt: now, updatedAt: now, createdBy: 'old', __version: 1 };
    await store.saveSecret(legacy as unknown as ConfigurationSecret);
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    const listed = await stack.services.invoke('configuration.read', { environment: 'production' }, { principal: alice });
    assert.equal(JSON.stringify(listed).includes('legacy-raw-password'), false);
    await stack.services.invoke('credential.rotate', { environment: 'production', name: 'SMTP', credentialRef: 'credential-ref:smtp' }, { principal: alice });
    const stored = await store.getSecret({ tenantId: 'tenant-a', applicationId: 'boundary-app', environment: 'production' }, 'SMTP');
    assert.equal(stored?.credentialRef, 'credential-ref:smtp');
    assert.equal('value' in (stored ?? {}), false);
  } finally {
    await stack.close();
  }
});

test('file updates cannot overwrite owner, tenant, application, or lifecycle fields', async () => {
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    const file = await stack.services.invoke('files.write', { name: 'a.pdf', size: 1, storageKey: 'k' }, { principal: alice }) as { id: string };
    const updated = await stack.services.invoke('files.write', { id: file.id, name: 'b.pdf', owner: 'mallory', applicationId: 'other', deletedAt: 'x', createdAt: 'x', __version: 99 }, { principal: alice }) as Record<string, unknown>;
    assert.equal(updated.name, 'b.pdf');
    assert.equal(updated.owner, 'alice');
    assert.equal(updated.applicationId, 'boundary-app');
    assert.equal(updated.deletedAt, undefined);
    assert.notEqual(updated.createdAt, 'x');
  } finally {
    await stack.close();
  }
});

test('records are scoped by application when applications share a FeltDB namespace', async () => {
  const authorizer = new TestAuthority({ allowAll: true });
  const credentials = new TestCredentials();
  const ref = credentials.put('sign', 'tenant-a', 'secret');
  const path = await scratchPath('appport-shared-namespace-');
  const appA = await openStack({ path, application: 'app-a', authorizer, credentials, destinations: PUBLIC });
  const a = appA.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
  const file = await appA.services.invoke('files.write', { name: 'a.pdf', size: 1, storageKey: 'k' }, { principal: a }) as { id: string };
  const notice = await appA.services.invoke('notifications.send', { recipient: 'alice', type: 't', title: 'x' }, { principal: a }) as { id: string };
  const endpoint = await appA.services.webhooks.createWebhookEndpoint({ url: 'https://a.example.com/hook', events: ['e'], signingCredentialRef: ref }, a);
  const job = await appA.services.jobs.enqueue({ type: 'x', payload: {} }, a);
  const schedule = await appA.services.jobs.scheduleRecurring({ type: 'x', payload: {}, interval: '1h' }, a);
  await appA.services.apiKeys.createApiKey({ name: 'a-key' }, a);
  await appA.close();

  const appB = await openStack({ path, application: 'app-b', authorizer, credentials, destinations: PUBLIC });
  try {
    const b = appB.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    assert.deepEqual(await appB.services.invoke('files.read', {}, { principal: b }), []);
    await assert.rejects(appB.services.invoke('files.read', { id: file.id }, { principal: b }), /File not found/);
    assert.deepEqual((await appB.services.invoke('notifications.read', {}, { principal: b }) as { items: unknown[] }).items, []);
    await assert.rejects(appB.services.invoke('notifications.read', { id: notice.id }, { principal: b }), /Notification not found/);
    assert.deepEqual(await appB.services.invoke('webhooks.read', {}, { principal: b }), []);
    assert.deepEqual(await appB.services.invoke('jobs.read', {}, { principal: b }), []);
    assert.deepEqual(await appB.services.invoke('apikeys.read', {}, { principal: b }), []);
    assert.deepEqual(await appB.services.invoke('schedules.read', {}, { principal: b }), []);
    assert.equal(await appB.services.invoke('schedules.read', { id: schedule.id }, { principal: b }), null);
    assert.deepEqual(await appB.services.webhooks.emitWebhookEvent({ type: 'e', payload: {} }, b), []);
    assert.equal(await appB.services.invoke('webhooks.remove', { id: endpoint.id }, { principal: b }), null);
    assert.equal(await appB.services.invoke('jobs.retry', { id: job.id }, { principal: b }), null);
    assert.equal(await appB.services.invoke('schedules.cancel', { id: schedule.id }, { principal: b }), null);
    assert.equal(await appB.services.jobs.executeJob('tenant-a', job.id, 'worker'), false);
  } finally {
    await appB.close();
  }
});

test('transactions validate caller-supplied endpoint ids, event type, recipient, and delegation', async () => {
  const credentials = new TestCredentials();
  const refA = credentials.put('sign-a', 'tenant-a', 'secret');
  const refB = credentials.put('sign-b', 'tenant-b', 'secret');
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }), credentials, destinations: PUBLIC });
  try {
    const a = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    const b = stack.services.identify({ principalId: 'bob', principalType: 'user', tenantId: 'tenant-b' })!;
    const own = await stack.services.webhooks.createWebhookEndpoint({ url: 'https://a.example.com/e', events: ['invoice.created'], signingCredentialRef: refA }, a);
    const unsubscribed = await stack.services.webhooks.createWebhookEndpoint({ url: 'https://a.example.com/o', events: ['other'], signingCredentialRef: refA }, a);
    const foreign = await stack.services.webhooks.createWebhookEndpoint({ url: 'https://b.example.com/e', events: ['invoice.created'], signingCredentialRef: refB }, b);
    const emit = () => stack.services.authorize('webhooks.emit', a, { type: 'webhook_event', attributes: { eventType: 'invoice.created' } });

    for (const endpointId of [foreign.id, unsubscribed.id, 'made-up']) {
      const context = await emit();
      await assert.rejects(stack.services.transaction(async (tx) => {
        tx.queueWebhookDeliveries([endpointId], { tenantId: 'tenant-a', type: 'invoice.created', payload: {} }, context);
      }), code('DENIED'), endpointId);
    }
    assert.equal((await stack.services.webhooks.listWebhookDeliveries('tenant-a')).length, 0);
    assert.equal((await stack.services.webhooks.listWebhookDeliveries('tenant-b')).length, 0);

    // A context issued without an event type does not cover an arbitrary event.
    const untyped = await stack.services.authorize('webhooks.emit', a, { type: 'webhook_event' });
    await assert.rejects(stack.services.transaction(async (tx) => {
      tx.queueWebhookDeliveries([own.id], { tenantId: 'tenant-a', type: 'invoice.created', payload: {} }, untyped);
    }), code('DENIED'));

    const valid = await emit();
    await stack.services.transaction(async (tx) => {
      tx.queueWebhookDeliveries([own.id], { tenantId: 'tenant-a', type: 'invoice.created', payload: {} }, valid);
    });
    assert.equal((await stack.services.webhooks.listWebhookDeliveries('tenant-a')).length, 1);

    const jobContext = await stack.services.authorize('jobs.create', a, { type: 'job', attributes: { jobType: 'x' } });
    await assert.rejects(stack.services.transaction(async (tx) => {
      tx.queueJob({ tenantId: 'tenant-a', type: 'x', payload: {}, delegationId: 'someone-elses-delegation' }, jobContext);
    }), code('DENIED'));
    const notifyContext = await stack.services.authorize('notifications.send', a, { type: 'notification', attributes: { recipient: 'alice' } });
    await assert.rejects(stack.services.transaction(async (tx) => {
      tx.queueNotification({ tenantId: 'tenant-a', recipient: 'mallory', type: 't', title: 'x' }, notifyContext);
    }), code('DENIED'));
    assert.equal((await stack.services.jobs.listJobs('tenant-a')).length, 0);
  } finally {
    await stack.close();
  }
});
