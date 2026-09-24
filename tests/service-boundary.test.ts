/**
 * Service-boundary suite: @appport/services is a Policy Enforcement Point.
 * No AuthBoundry authorization -> no service effect; no authorized
 * credential -> no provider credential.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createFeltDbRuntime, FeltDbApiKeyStore, FeltDbAuditSink, FeltDbJobStore, ApiKeyService, evidenceCollectionName, verifyWebhookSignature } from '../src/_internal.js';
import { parseAppPortConfigText } from '../src/runtime/dsl.js';
import { ServiceAuthorityError, ServiceMigrationError } from '../src/authority/errors.js';
import { assertEvidenceHasNoSecrets, type EffectEvidence } from '../src/authority/evidence.js';
import { LEGACY_SCOPE_MIGRATION, SERVICE_CAPABILITY_MANIFEST, serviceCapabilityManifestDigest } from '../src/authority/manifest.js';
import { consumeExecutionContext } from '../src/authority/context.js';
import type { ServiceAuthorizationRequest } from '../src/authority/authorizer.js';
import { decision, TestAuthority, TestCredentials } from './support/authority.js';
import { openStack, receiver, scratchPath, type Stack } from './support/stack.js';

const SIGNING_SECRET = 'whsec_boundary_signing_secret_value';
const code = (expected: string) => (error: unknown) => error instanceof ServiceAuthorityError && error.code === expected;

async function webhookFixture(options: { grants?: readonly string[]; mode?: TestAuthority['mode']; timeoutMs?: number } = {}) {
  const authority = new TestAuthority();
  const credentials = new TestCredentials();
  const ref = credentials.put('sign-a', 'tenant-a', SIGNING_SECRET);
  for (const capability of options.grants ?? ['webhooks.register', 'webhooks.emit', 'webhooks.deliver']) {
    await authority.grant({ subject: 'alice', capability, tenantId: 'tenant-a' });
  }
  const stack = await openStack({ authorizer: authority, credentials, timeoutMs: options.timeoutMs });
  const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
  const destination = await receiver();
  const endpoint = await stack.services.webhooks.createWebhookEndpoint({ url: destination.url, events: ['invoice.created'], signingCredentialRef: ref }, alice);
  const [delivery] = await stack.services.webhooks.emitWebhookEvent({ type: 'invoice.created', payload: { invoice: 'inv-1' } }, alice);
  if (options.mode) authority.mode = options.mode;
  return { authority, credentials, ref, stack, alice, destination, endpoint, delivery, close: async () => { await destination.close(); await stack.close(); } };
}

async function evidence(stack: Stack, tenantId = 'tenant-a'): Promise<EffectEvidence[]> {
  return stack.db.collection<EffectEvidence>(evidenceCollectionName()).find({ tenantId });
}

// -----------------------------------------------------------------------------
// Manifest
// -----------------------------------------------------------------------------

test('capability manifest is deterministic, frozen, operation-level, and has no admin capabilities', () => {
  const names = SERVICE_CAPABILITY_MANIFEST.map((capability) => capability.name);
  assert.deepEqual(names, [...names].sort());
  assert.equal(new Set(names).size, names.length);
  assert.ok(Object.isFrozen(SERVICE_CAPABILITY_MANIFEST));
  assert.ok(SERVICE_CAPABILITY_MANIFEST.every((capability) => Object.isFrozen(capability) && capability.version === 1 && capability.authorization.required === true));
  assert.ok(names.every((name) => !name.endsWith('.admin') && !name.includes('*')));
  for (const name of ['files.read', 'files.write', 'files.delete', 'notifications.send', 'notifications.read', 'schedules.create', 'schedules.read', 'schedules.cancel', 'configuration.read', 'configuration.write', 'credential.attach', 'webhooks.register', 'webhooks.remove', 'jobs.create']) {
    assert.ok(names.includes(name), `${name} declared`);
  }
  assert.equal(serviceCapabilityManifestDigest(), serviceCapabilityManifestDigest());
  assert.equal(LEGACY_SCOPE_MIGRATION['files.admin'], null);
  assert.equal(LEGACY_SCOPE_MIGRATION['notifications.create'], 'notifications.send');
});

test('invoke rejects undeclared and runtime-internal capabilities', async () => {
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    await assert.rejects(stack.services.invoke('files.admin', {}, { principal: alice }), code('INVALID_REQUEST'));
    await assert.rejects(stack.services.invoke('jobs.execute', {}, { principal: alice }), code('INVALID_REQUEST'));
    await assert.rejects(stack.services.invoke('webhooks.deliver', {}, { principal: alice }), code('INVALID_REQUEST'));
  } finally {
    await stack.close();
  }
});

// -----------------------------------------------------------------------------
// Authorization
// -----------------------------------------------------------------------------

test('allow: provider is called exactly once, signed with the custody credential, with evidence', async () => {
  const fixture = await webhookFixture();
  try {
    const result = await fixture.stack.services.webhooks.deliverWebhook('tenant-a', fixture.delivery.id);
    assert.equal(result.success, true);
    assert.equal(fixture.destination.requests.length, 1);
    const [request] = fixture.destination.requests;
    assert.ok(verifyWebhookSignature(SIGNING_SECRET, request.body, String(request.headers['x-appport-signature'])));
    assert.equal(fixture.credentials.resolutions.length, 1);
    const deliverDecision = fixture.authority.requests.find((entry) => entry.capability === 'webhooks.deliver');
    assert.ok(deliverDecision);
    assert.ok(fixture.credentials.resolutions[0].context.authorizationRef?.startsWith('dec_'));

    const rows = await evidence(fixture.stack);
    const delivered = rows.find((row) => row.capability === 'webhooks.deliver');
    assert.equal(delivered?.outcome, 'succeeded');
    assert.equal(delivered?.decision, 'allow');
    assert.ok(delivered?.decisionId);
    assert.equal(delivered?.credentialRef, fixture.ref);
    assert.equal(delivered?.principalId, 'alice');
    assert.equal(delivered?.provider, 'webhook');
    assert.ok(delivered?.startedAt && delivered.completedAt);
  } finally {
    await fixture.close();
  }
});

test('denied: no credential resolution and no provider call', async () => {
  const fixture = await webhookFixture({ grants: ['webhooks.register', 'webhooks.emit'] });
  try {
    const result = await fixture.stack.services.webhooks.deliverWebhook('tenant-a', fixture.delivery.id);
    assert.equal(result.success, false);
    assert.equal(result.code, 'DENIED');
    assert.equal(fixture.destination.requests.length, 0);
    assert.equal(fixture.credentials.resolutions.length, 0);
    assert.equal((await fixture.stack.services.webhooks.getWebhookDelivery('tenant-a', fixture.delivery.id))?.status, 'failed');
    const denied = (await evidence(fixture.stack)).find((row) => row.capability === 'webhooks.deliver');
    assert.equal(denied?.outcome, 'denied');
    assert.equal(denied?.decision, 'deny');
  } finally {
    await fixture.close();
  }
});

test('authority unavailable: no provider call, reported distinctly, retried later', async () => {
  const fixture = await webhookFixture({ mode: 'unavailable' });
  try {
    const result = await fixture.stack.services.webhooks.deliverWebhook('tenant-a', fixture.delivery.id);
    assert.equal(result.code, 'AUTHORITY_UNAVAILABLE');
    assert.equal(fixture.destination.requests.length, 0);
    assert.equal(fixture.credentials.resolutions.length, 0);
    assert.equal((await fixture.stack.services.webhooks.getWebhookDelivery('tenant-a', fixture.delivery.id))?.status, 'retrying');
  } finally {
    await fixture.close();
  }
});

test('timeout: no provider call, and a late allow never triggers execution', async () => {
  const fixture = await webhookFixture({ timeoutMs: 50 });
  try {
    fixture.authority.mode = 'allow-all';
    fixture.authority.delayMs = 200;
    const result = await fixture.stack.services.webhooks.deliverWebhook('tenant-a', fixture.delivery.id);
    assert.equal(result.code, 'AUTHORIZATION_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fixture.destination.requests.length, 0);
    assert.equal(fixture.credentials.resolutions.length, 0);
  } finally {
    await fixture.close();
  }
});

test('provider failure is reported as PROVIDER_ERROR, never as an authorization failure', async () => {
  const fixture = await webhookFixture();
  try {
    fixture.destination.status = 503;
    const result = await fixture.stack.services.webhooks.deliverWebhook('tenant-a', fixture.delivery.id);
    assert.equal(result.code, 'PROVIDER_ERROR');
    assert.equal(fixture.destination.requests.length, 1);
    const row = (await evidence(fixture.stack)).find((entry) => entry.capability === 'webhooks.deliver');
    assert.equal(row?.outcome, 'provider_error');
    assert.equal(row?.decision, 'allow');
  } finally {
    await fixture.close();
  }
});

test('no authorizer configured: every effect fails closed', async () => {
  const stack = await openStack();
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    await assert.rejects(stack.services.invoke('notifications.send', { recipient: 'bob', type: 't', title: 'x' }, { principal: alice }), code('AUTHORITY_UNAVAILABLE'));
    await assert.rejects(stack.services.apiKeys.createApiKey({ name: 'k' }, alice), code('AUTHORITY_UNAVAILABLE'));
    assert.equal((await stack.db.collection('notifications').list()).length, 0);
  } finally {
    await stack.close();
  }
});

test('a decision that does not match the request is not accepted as authority', async () => {
  const forging = { authorize: async (request: ServiceAuthorizationRequest) => ({ ...decision(request, true), capability: 'files.read' }) };
  const stack = await openStack({ authorizer: forging });
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    await assert.rejects(stack.services.invoke('files.write', { name: 'f', size: 1, storageKey: 'k' }, { principal: alice }), code('AUTHORITY_UNAVAILABLE'));
  } finally {
    await stack.close();
  }
});

test('no local authorization cache: AuthBoundry is asked for every operation', async () => {
  const authority = new TestAuthority();
  await authority.grant({ subject: 'alice', capability: 'files.write', tenantId: 'tenant-a' });
  const stack = await openStack({ authorizer: authority });
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    for (let index = 0; index < 3; index += 1) await stack.services.invoke('files.write', { name: `f${index}`, size: 1, storageKey: `k${index}` }, { principal: alice });
    assert.equal(authority.requests.filter((request) => request.capability === 'files.write').length, 3);
    // AuthBoundry withdraws the grant: the very next call is denied.
    authority.clearGrants();
    await assert.rejects(stack.services.invoke('files.write', { name: 'f3', size: 1, storageKey: 'k3' }, { principal: alice }), code('DENIED'));
  } finally {
    await stack.close();
  }
});

// -----------------------------------------------------------------------------
// API keys
// -----------------------------------------------------------------------------

test('API key scopes cannot grant authority anywhere', async () => {
  assert.throws(() => parseAppPortConfigText('use api\n[api.keys]\nscopes = ["files.admin", "notifications.admin"]\n'), /api\.keys\.scopes/);
  const runtime = createFeltDbRuntime({ memory: true, namespace: `scopes-${Math.random()}` });
  assert.throws(() => new ApiKeyService({ store: new FeltDbApiKeyStore(runtime.db), auditSink: new FeltDbAuditSink(runtime.db), allowedScopes: ['files.admin'] }), ServiceMigrationError);

  const authority = new TestAuthority();
  await authority.grant({ subject: 'ops', capability: 'apikeys.create', tenantId: 'tenant-a' });
  const stack = await openStack({ authorizer: authority });
  try {
    const ops = stack.services.identify({ principalId: 'ops', principalType: 'user', tenantId: 'tenant-a' })!;
    await assert.rejects(stack.services.apiKeys.createApiKey({ name: 'admin', scopes: ['files.admin', 'notifications.admin'] }, ops), ServiceMigrationError);
    const created = await stack.services.apiKeys.createApiKey({ name: 'caller' }, ops);
    const caller = await stack.services.apiKeys.authenticateApiKey(created.secret);
    assert.ok(caller);
    assert.equal(caller.principalId, created.id);
    assert.equal(caller.applicationId, 'boundary-app');
    assert.equal('scopes' in caller, false);
    // Identity alone grants nothing.
    await assert.rejects(stack.services.invoke('files.write', { name: 'f', size: 1, storageKey: 'k' }, { principal: caller }), code('DENIED'));
    await assert.rejects(stack.services.invoke('notifications.send', { recipient: 'x', type: 't', title: 't' }, { principal: caller }), code('DENIED'));
  } finally {
    await stack.close();
  }
});

test('revoked API key cannot execute; a key from application A cannot execute application B effects', async () => {
  const authority = new TestAuthority({ allowAll: true });
  const path = await scratchPath('appport-boundary-apps-');
  const appA = await openStack({ path, application: 'app-a', authorizer: authority });
  const ops = appA.services.identify({ principalId: 'ops', principalType: 'user', tenantId: 'tenant-a' })!;
  const keyA = await appA.services.apiKeys.createApiKey({ name: 'a' }, ops);
  const revoked = await appA.services.apiKeys.createApiKey({ name: 'revoked' }, ops);
  await appA.services.apiKeys.revokeApiKey({ id: revoked.id }, ops);
  assert.equal(await appA.services.apiKeys.authenticateApiKey(revoked.secret), null);
  const principalA = (await appA.services.apiKeys.authenticateApiKey(keyA.secret))!;
  assert.equal(principalA.applicationId, 'app-a');
  await appA.close();

  const appB = await openStack({ path, application: 'app-b', authorizer: authority });
  try {
    assert.equal(await appB.services.apiKeys.authenticateApiKey(keyA.secret), null);
    await assert.rejects(appB.services.invoke('files.write', { name: 'f', size: 1, storageKey: 'k' }, { principal: principalA }), code('DENIED'));
  } finally {
    await appB.close();
  }
});

// -----------------------------------------------------------------------------
// Actors
// -----------------------------------------------------------------------------

test('arbitrary actor strings and forged principals are rejected; verified principals are accepted', async () => {
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  try {
    const input = { recipient: 'bob', type: 'notice', title: 'hello' };
    await assert.rejects(stack.services.invoke('notifications.send', input, { principal: 'admin' as never }), ServiceMigrationError);
    await assert.rejects(stack.services.notifications.create(input, { principalId: 'admin', principalType: 'user', tenantId: 'tenant-a', verifiedBy: 'host' } as never), code('UNAUTHENTICATED'));
    await assert.rejects(stack.services.notifications.create(input, { principalId: 'admin', tenantId: 'tenant-a', scopes: ['notifications.admin'] } as never), ServiceMigrationError);
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    await assert.rejects(stack.services.invoke('notifications.send', { ...input, actor: 'admin' }, { principal: alice }), ServiceMigrationError);
    await assert.rejects(stack.services.invoke('jobs.create', { type: 'x', payload: {}, principal: { principalId: 'admin' } }, { principal: alice }), ServiceMigrationError);
    const created = await stack.services.invoke('notifications.send', input, { principal: alice }) as { id: string };
    assert.ok(created.id);
  } finally {
    await stack.close();
  }
});

test('the principal cannot be replaced after authorization and a context authorizes one effect', async () => {
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    const mallory = stack.services.identify({ principalId: 'mallory', principalType: 'user', tenantId: 'tenant-a' })!;
    const context = await stack.services.authorize('jobs.create', alice, { type: 'job', attributes: { jobType: 'x' } });
    assert.throws(() => { (context as { principal: unknown }).principal = mallory; }, TypeError);
    assert.throws(() => { (alice as { principalId: string }).principalId = 'admin'; }, TypeError);
    const forged = { ...context, principal: mallory };
    assert.throws(() => consumeExecutionContext(forged, 'jobs.create'), code('UNAUTHENTICATED'));
    assert.throws(() => consumeExecutionContext(context, 'files.write'), code('DENIED'));
    await stack.services.transaction(async (tx) => { tx.queueJob({ tenantId: 'tenant-a', type: 'x', payload: {} }, context); });
    await assert.rejects(stack.services.transaction(async (tx) => { tx.queueJob({ tenantId: 'tenant-a', type: 'x', payload: {} }, context); }), code('DENIED'));
    assert.equal((await stack.services.jobs.listJobs('tenant-a')).length, 1);
  } finally {
    await stack.close();
  }
});

// -----------------------------------------------------------------------------
// Credentials
// -----------------------------------------------------------------------------

test('raw provider credentials are never stored in service configuration', async () => {
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    const raw = 'sk_live_super_secret_provider_token';
    await assert.rejects(stack.services.invoke('credential.attach', { environment: 'production', name: 'SMTP', value: raw }, { principal: alice }), ServiceMigrationError);
    await assert.rejects(stack.services.invoke('credential.attach', { environment: 'production', name: 'SMTP', credentialRef: raw }, { principal: alice }), ServiceMigrationError);
    await assert.rejects(stack.services.webhooks.createWebhookEndpoint({ url: 'http://127.0.0.1:1/x', events: ['e'], signingCredentialRef: raw }, alice), ServiceMigrationError);
    const attached = await stack.services.invoke('credential.attach', { environment: 'production', name: 'SMTP', credentialRef: 'credential-ref:cred_123' }, { principal: alice }) as { credentialRef: string };
    assert.equal(attached.credentialRef, 'credential-ref:cred_123');
    await stack.close();
    const persisted = await readFile(join(stack.path, 'state.json'), 'utf8').catch(() => '');
    assert.equal(persisted.includes(raw), false);
  } finally {
    await stack.close().catch(() => undefined);
  }
});

test('credential access is only possible under a live authorized context', async () => {
  const credentials = new TestCredentials();
  const ref = credentials.put('cred-1', 'tenant-a', 'value');
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }), credentials });
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    const forged = { application: 'boundary-app', tenantId: 'tenant-a', principal: alice, capability: 'webhooks.deliver', authorization: { decisionId: 'dec_forged' }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await assert.rejects(stack.services.gateway.withCredential(forged as never, ref as never, 'x', () => 'used'), code('UNAUTHENTICATED'));
    assert.equal(credentials.resolutions.length, 0);
  } finally {
    await stack.close();
  }
});

test('revoked and cross-tenant credentials cannot execute provider effects', async () => {
  const fixture = await webhookFixture();
  try {
    fixture.credentials.revoke('sign-a');
    const revoked = await fixture.stack.services.webhooks.deliverWebhook('tenant-a', fixture.delivery.id);
    assert.equal(revoked.code, 'DENIED');
    assert.equal(fixture.destination.requests.length, 0);

    // tenant-b registers an endpoint pointing at tenant-a's credential reference.
    await fixture.authority.grant({ subject: 'bob', capability: 'webhooks.register', tenantId: 'tenant-b' });
    await fixture.authority.grant({ subject: 'bob', capability: 'webhooks.emit', tenantId: 'tenant-b' });
    await fixture.authority.grant({ subject: 'bob', capability: 'webhooks.deliver', tenantId: 'tenant-b' });
    fixture.credentials.put('sign-b-own', 'tenant-b', 'b-secret');
    const bob = fixture.stack.services.identify({ principalId: 'bob', principalType: 'user', tenantId: 'tenant-b' })!;
    await fixture.stack.services.webhooks.createWebhookEndpoint({ url: fixture.destination.url, events: ['invoice.created'], signingCredentialRef: 'credential-ref:sign-a' }, bob);
    const [delivery] = await fixture.stack.services.webhooks.emitWebhookEvent({ type: 'invoice.created', payload: {} }, bob);
    const crossTenant = await fixture.stack.services.webhooks.deliverWebhook('tenant-b', delivery.id);
    assert.equal(crossTenant.code, 'DENIED');
    assert.equal(fixture.destination.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

// -----------------------------------------------------------------------------
// Jobs
// -----------------------------------------------------------------------------

test('jobs run as a durable principal, and a revoked delegation stops future effects across restart', async () => {
  const authorityPath = await scratchPath('appport-authboundry-');
  const openAuthority = () => {
    const runtime = createFeltDbRuntime({ mode: 'local', namespace: 'authboundry', path: authorityPath });
    return { runtime, authority: new TestAuthority({ db: runtime.db }) };
  };
  let { runtime: authorityRuntime, authority } = openAuthority();
  await authority.grant({ subject: 'alice', capability: 'jobs.create', tenantId: 'tenant-a' });
  await authority.grant({ subject: 'alice', capability: 'jobs.retry', tenantId: 'tenant-a' });
  await authority.grant({ subject: 'alice', capability: 'jobs.execute', tenantId: 'tenant-a', delegationId: 'run-quote-agent' });
  await authority.grant({ subject: 'alice', capability: 'notifications.send', tenantId: 'tenant-a', delegationId: 'run-quote-agent' });

  const path = await scratchPath('appport-boundary-jobs-');
  let effects = 0;
  const register = (stack: Awaited<ReturnType<typeof openStack>>) => stack.services.jobs.register('quote.followup', async (_job, execution) => {
    assert.equal(execution.principal.principalId, 'alice');
    assert.equal(execution.principal.delegationId, 'run-quote-agent');
    assert.equal(execution.principal.verifiedBy, 'job');
    await stack.services.invoke('notifications.send', { recipient: 'customer', type: 'quote.followup', title: 'Following up' }, { principal: execution.principal });
    effects += 1;
  });

  let stack = await openStack({ path, authorizer: authority });
  register(stack);
  const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
  const job = await stack.services.jobs.enqueue({ type: 'quote.followup', payload: {}, delegationId: 'run-quote-agent' }, alice);
  const { authorizedBy, ...identity } = job.principal!;
  assert.deepEqual(identity, { principalId: 'alice', principalType: 'user', tenantId: 'tenant-a', delegationId: 'run-quote-agent' });
  assert.equal(authorizedBy, authority.requests.find((request) => request.capability === 'jobs.create') ? (await stack.db.collection<{ decisionId: string; capability: string }>(evidenceCollectionName()).find({ capability: 'jobs.create' }))[0]?.decisionId : undefined);
  assert.equal(await stack.services.jobs.executeJob('tenant-a', job.id, 'worker-1'), true);
  assert.equal(effects, 1);
  const executeRequest = authority.requests.find((request) => request.capability === 'jobs.execute');
  assert.equal(executeRequest?.context.delegation_id, 'run-quote-agent');
  assert.equal(executeRequest?.context.run_id, `${job.id}:1`);

  await authority.revokeDelegation('run-quote-agent');
  await stack.services.jobs.retry('tenant-a', job.id, alice);
  assert.equal(await stack.services.jobs.executeJob('tenant-a', job.id, 'worker-1'), false);
  assert.equal(effects, 1);
  assert.match((await stack.services.jobs.getJob('tenant-a', job.id))?.lastError ?? '', /^DENIED/);

  // Restart both the services and AuthBoundry: revoked authority stays revoked.
  await stack.close();
  await authorityRuntime.db.close();
  ({ runtime: authorityRuntime, authority } = openAuthority());
  stack = await openStack({ path, authorizer: authority });
  register(stack);
  try {
    const restarted = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    assert.equal((await stack.services.jobs.getJob('tenant-a', job.id))?.principal?.principalId, 'alice');
    await stack.services.jobs.retry('tenant-a', job.id, restarted);
    assert.equal(await stack.services.jobs.executeJob('tenant-a', job.id, 'worker-2'), false);
    assert.equal(effects, 1);
    assert.equal((await stack.db.collection('notifications').list()).length, 1);
  } finally {
    await stack.close();
    await authorityRuntime.db.close();
  }
});

test('anonymous job execution is denied without running the handler', async () => {
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  try {
    let ran = false;
    stack.services.jobs.register('legacy', async () => { ran = true; });
    const now = new Date().toISOString();
    await new FeltDbJobStore(stack.db).create({ id: crypto.randomUUID(), tenantId: 'tenant-a', type: 'legacy', payload: {}, status: 'pending', runAt: now, attemptCount: 0, maxAttempts: 3, createdAt: now, __version: 1 });
    const [job] = await stack.services.jobs.listJobs('tenant-a');
    assert.equal(await stack.services.jobs.executeJob('tenant-a', job.id, 'worker-1'), false);
    assert.equal(ran, false);
    const after = await stack.services.jobs.getJob('tenant-a', job.id);
    assert.equal(after?.status, 'failed');
    assert.match(after?.lastError ?? '', /anonymous job execution/);
  } finally {
    await stack.close();
  }
});

test('job metadata cannot become authority: forged durable principals and reserved collections are refused', async () => {
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  try {
    let ran = false;
    stack.services.jobs.register('payout', async () => { ran = true; });
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    // Application code cannot write service-owned collections through the public transaction API.
    await assert.rejects(stack.services.transaction(async (tx) => {
      await tx.collection('jobs').insert({ id: 'forged', tenantId: 'tenant-a', type: 'payout', status: 'pending' }, 'forged');
    }), code('DENIED'));
    await assert.rejects(stack.services.transaction(async (tx) => {
      tx.addOperation({ collection: 'service_effect_evidence', id: 'x', value: { decisionId: 'dec_forged' } });
    }), code('DENIED'));

    // A record that claims a principal (with or without a made-up decision id) is not identity.
    const now = new Date().toISOString();
    const store = new FeltDbJobStore(stack.db);
    for (const principal of [
      { principalId: 'admin', principalType: 'user', tenantId: 'tenant-a' },
      { principalId: 'admin', principalType: 'user', tenantId: 'tenant-a', authorizedBy: 'dec_made_up' },
    ]) {
      const id = crypto.randomUUID();
      await store.create({ id, tenantId: 'tenant-a', type: 'payout', payload: {}, status: 'pending', runAt: now, attemptCount: 0, maxAttempts: 3, createdAt: now, principal, __version: 1 });
      assert.equal(await stack.services.jobs.executeJob('tenant-a', id, 'worker-1'), false);
      assert.match((await stack.services.jobs.getJob('tenant-a', id))?.lastError ?? '', /DENIED: Durable principal/);
    }
    assert.equal(ran, false);

    // Reusing a real decision id under a different principal is also refused.
    const real = await stack.services.jobs.enqueue({ type: 'payout', payload: {} }, alice);
    const forgedId = crypto.randomUUID();
    await store.create({ id: forgedId, tenantId: 'tenant-a', type: 'payout', payload: {}, status: 'pending', runAt: now, attemptCount: 0, maxAttempts: 3, createdAt: now, principal: { ...real.principal!, principalId: 'admin' }, __version: 1 });
    assert.equal(await stack.services.jobs.executeJob('tenant-a', forgedId, 'worker-1'), false);
    assert.equal(ran, false);
    // The genuine job runs.
    assert.equal(await stack.services.jobs.executeJob('tenant-a', real.id, 'worker-1'), true);
    assert.equal(ran, true);
  } finally {
    await stack.close();
  }
});

// -----------------------------------------------------------------------------
// Tenant isolation (durable, across restart)
// -----------------------------------------------------------------------------

test('tenant isolation holds for configuration, credentials, webhooks, and jobs, including after restart', async () => {
  const authority = new TestAuthority({ allowAll: true });
  const credentials = new TestCredentials();
  const refA = credentials.put('cred-a', 'tenant-a', 'secret-a');
  const refB = credentials.put('cred-b', 'tenant-b', 'secret-b');
  const path = await scratchPath('appport-boundary-tenants-');
  let stack = await openStack({ path, authorizer: authority, credentials });
  const a = () => stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
  const b = () => stack.services.identify({ principalId: 'bob', principalType: 'user', tenantId: 'tenant-b' })!;
  await stack.services.invoke('credential.attach', { environment: 'production', name: 'SMTP', credentialRef: refA }, { principal: a() });
  await stack.services.invoke('credential.attach', { environment: 'production', name: 'SMTP', credentialRef: refB }, { principal: b() });
  const endpointB = await stack.services.webhooks.createWebhookEndpoint({ url: 'http://127.0.0.1:9/b', events: ['e'], signingCredentialRef: refB }, b());
  const jobB = await stack.services.jobs.enqueue({ type: 'x', payload: {} }, b());

  const check = async () => {
    // A -> A allowed
    const own = await stack.services.invoke('configuration.read', { environment: 'production' }, { principal: a() }) as { secrets: { credentialRef: string }[] };
    assert.deepEqual(own.secrets.map((secret) => secret.credentialRef), [refA]);
    // A -> B denied, B -> A denied
    await assert.rejects(stack.services.invoke('configuration.read', { tenantId: 'tenant-b', environment: 'production' }, { principal: a() }), code('DENIED'));
    await assert.rejects(stack.services.invoke('configuration.read', { tenantId: 'tenant-a', environment: 'production' }, { principal: b() }), code('DENIED'));
    await assert.rejects(stack.services.invoke('configuration.read', { applicationId: 'another-app', environment: 'production' }, { principal: a() }), code('DENIED'));
    await assert.rejects(stack.services.invoke('webhooks.remove', { tenantId: 'tenant-b', id: endpointB.id }, { principal: a() }), code('DENIED'));
    assert.equal(await stack.services.invoke('webhooks.remove', { id: endpointB.id }, { principal: a() }), null);
    await assert.rejects(stack.services.invoke('jobs.retry', { tenantId: 'tenant-b', id: jobB.id }, { principal: a() }), code('DENIED'));
    assert.equal(await stack.services.invoke('jobs.retry', { id: jobB.id }, { principal: a() }), null);
    assert.equal(await stack.services.jobs.executeJob('tenant-a', jobB.id, 'worker'), false);
    await assert.rejects(stack.services.webhooks.replayWebhookDelivery('tenant-b', 'any', a()), code('DENIED'));
    // A's credential reference cannot be bound into B's configuration by A.
    await assert.rejects(stack.services.invoke('credential.attach', { tenantId: 'tenant-b', environment: 'production', name: 'X', credentialRef: refA }, { principal: a() }), code('DENIED'));
  };

  await check();
  await stack.close();
  stack = await openStack({ path, authorizer: authority, credentials });
  try {
    await check();
    assert.equal((await stack.services.webhooks.getWebhookEndpoint('tenant-b', endpointB.id))?.disabledAt, undefined);
  } finally {
    await stack.close();
  }
});

// -----------------------------------------------------------------------------
// Evidence
// -----------------------------------------------------------------------------

test('evidence exists for every consequential effect, contains no secrets, and survives restart', async () => {
  const fixture = await webhookFixture();
  const apiAuthority = fixture.authority;
  await apiAuthority.grant({ subject: 'alice', capability: 'apikeys.create', tenantId: 'tenant-a' });
  const created = await fixture.stack.services.apiKeys.createApiKey({ name: 'k' }, fixture.alice);
  await fixture.stack.services.webhooks.deliverWebhook('tenant-a', fixture.delivery.id);
  const path = fixture.stack.path;
  await fixture.close();

  const stack = await openStack({ path });
  try {
    const rows = await evidence(stack);
    for (const capability of ['webhooks.register', 'webhooks.emit', 'webhooks.deliver', 'apikeys.create']) {
      const row = rows.find((entry) => entry.capability === capability);
      assert.equal(row?.outcome, 'succeeded', `${capability} evidence`);
      assert.equal(row?.application, 'boundary-app');
      assert.equal(row?.principalId, 'alice');
      assert.ok(row?.decisionId && row.requestId && row.resource.startsWith('appport://boundary-app/tenants/tenant-a/'));
    }
    const serialized = JSON.stringify(rows);
    assert.equal(serialized.includes(SIGNING_SECRET), false);
    assert.equal(serialized.includes(created.secret), false);
    assert.doesNotMatch(serialized, /app_live_[0-9a-f]{6}_/);
  } finally {
    await stack.close();
  }
  assert.throws(() => assertEvidenceHasNoSecrets({ credentialRef: 'sk_live_raw' as never }), /credential-ref/);
  assert.throws(() => assertEvidenceHasNoSecrets({ provider: 'Bearer abc' }), /credential material/);
  assert.throws(() => assertEvidenceHasNoSecrets({ apiKey: 'x' } as never), /not permitted/);
});
