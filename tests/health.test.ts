import assert from 'node:assert/strict';
import test from 'node:test';

import { createServices, type AppPortServices } from '../src/index.js';
import { TestAuthority, TestCredentials } from './support/authority.js';

const PUBLIC_DESTINATIONS = { lookup: async () => [{ address: '93.184.216.34', family: 4 as const }] };

function services(options: { authorizer?: boolean; credentials?: boolean } = {}): AppPortServices {
  return createServices({
    memory: true,
    namespace: `health-${crypto.randomUUID()}`,
    application: 'health-app',
    ...(options.authorizer === false ? {} : { authorizer: new TestAuthority({ allowAll: true }) }),
    ...(options.credentials ? { credentials: new TestCredentials() } : {}),
    webhookDestinationPolicy: PUBLIC_DESTINATIONS,
    configurationDeclarations: [
      { name: 'BILLING_API_KEY', kind: 'secret', required: true },
      { name: 'REGION', kind: 'variable', required: true },
      { name: 'OPTIONAL_FLAG', kind: 'variable', required: false },
    ],
  });
}

test('without an authorizer health is unconfigured and every service is disabled', async () => {
  const app = services({ authorizer: false });
  const health = await app.health();
  assert.equal(health.status, 'unconfigured');
  assert.equal(health.authority.state, 'unconfigured');
  assert.equal(health.authority.authorizer, false);
  for (const service of Object.values(health.services)) {
    assert.equal(service.state, 'disabled');
    assert.ok(service.reasons.includes('authorizer_unconfigured'));
  }
  assert.equal(health.application, 'health-app');
  assert.equal(typeof health.version, 'string');
  assert.ok(Date.parse(health.checkedAt));
});

test('a fresh deployment is ok, with nothing set up reported as unconfigured rather than failed', async () => {
  const app = services({ credentials: true });
  const health = await app.health();
  assert.equal(health.status, 'ok');
  assert.equal(health.authority.state, 'ok');
  assert.equal(health.services.apiKeys.state, 'unconfigured');
  assert.equal(health.services.webhooks.state, 'unconfigured');
  assert.equal(health.services.schedules.state, 'unconfigured');
  assert.equal(health.services.configuration.state, 'unconfigured');
  assert.equal(health.services.intelligence.state, 'unconfigured');
  assert.equal(health.services.jobs.state, 'ok');
  assert.equal(health.services.notifications.state, 'ok');
  assert.equal(health.services.files.state, 'ok');
  assert.deepEqual(health.attention, {
    failedWebhookDeliveries: 0, disabledWebhookEndpoints: 0, failedJobs: 0, failedNotifications: 0,
    failedNotificationDeliveries: 0, missingSecrets: 0, legacySecretValues: 0,
  });
  assert.deepEqual(health.cappedCounts, []);
});

test('health reports degraded services and the counts needing attention', async () => {
  const app = services({ credentials: true });
  const ada = app.identify({ principalId: 'ada', principalType: 'user', tenantId: 'acme' })!;
  const db = app.db;

  await app.apiKeys.createApiKey({ name: 'ci' }, ada);
  const kept = await app.webhooks.createWebhookEndpoint({ url: 'https://one.example.com/hook', events: ['a'], signingCredentialRef: 'credential-ref:one' }, ada);
  const removed = await app.webhooks.createWebhookEndpoint({ url: 'https://two.example.com/hook', events: ['a'], signingCredentialRef: 'credential-ref:two' }, ada);
  await app.webhooks.disableWebhookEndpoint({ id: removed.id }, ada);
  const [delivery] = await app.webhooks.emitWebhookEvent({ type: 'a', payload: {} }, ada);
  assert.equal(delivery!.endpointId, kept.id);
  await db.collection('webhook_deliveries').update(delivery!.id, { status: 'failed' });

  const job = await app.jobs.enqueue({ type: 'report', payload: {} }, ada);
  await db.collection('jobs').update(job.id, { status: 'failed' });
  await app.schedules.create({ type: 'report', interval: '1h', payload: {} }, ada);

  await db.collection('notification_deliveries').insert({ id: 'nd-1', tenantId: 'acme', status: 'failed' }, 'nd-1');
  await db.collection('notifications').insert({ id: 'n-1', tenantId: 'acme', applicationId: 'health-app', status: 'failed' }, 'n-1');

  await app.configuration.createVariable({ environment: 'production', name: 'REGION', value: 'eu' }, ada);
  // A pre-reference row that still holds a raw value.
  await db.collection('ConfigurationSecrets').insert({ id: 's-1', tenantId: 'acme', applicationId: 'health-app', environment: 'production', name: 'LEGACY_TOKEN', value: 'raw', credentialRef: 'credential-ref:legacy', required: false }, 's-1');
  // Intelligence selected for a provider that requires a credential, with none bound.
  await db.collection('ConfigurationVariables').insert({ id: 'v-ai', tenantId: 'acme', applicationId: 'health-app', environment: 'production', name: 'INTELLIGENCE_CONFIG', value: JSON.stringify({ provider: 'openai', model: 'gpt-4o' }), required: false }, 'v-ai');

  const health = await app.health({ tenantId: 'acme' });
  assert.equal(health.status, 'degraded');
  assert.equal(health.tenantId, 'acme');
  assert.equal(health.services.apiKeys.state, 'ok');
  assert.equal(health.services.apiKeys.counts.active, 1);
  assert.equal(health.services.webhooks.state, 'degraded');
  assert.deepEqual(health.services.webhooks.reasons, ['failed_deliveries']);
  assert.deepEqual(health.services.webhooks.counts, { endpoints: 2, activeEndpoints: 1, disabledEndpoints: 1, pendingDeliveries: 0, retryingDeliveries: 0, failedDeliveries: 1 });
  assert.equal(health.services.jobs.state, 'degraded');
  assert.equal(health.services.jobs.counts.failed, 1);
  assert.equal(health.services.schedules.state, 'ok');
  assert.equal(health.services.schedules.counts.enabled, 1);
  assert.equal(health.services.notifications.state, 'degraded');
  assert.equal(health.services.configuration.state, 'degraded');
  assert.deepEqual(health.services.configuration.counts, { variables: 2, secrets: 1, missingRequired: 1, legacySecretValues: 1 });
  assert.equal(health.services.intelligence.state, 'degraded');
  assert.equal(health.services.intelligence.counts.missingCredentials, 1);
  assert.deepEqual(health.attention, {
    failedWebhookDeliveries: 1, disabledWebhookEndpoints: 1, failedJobs: 1, failedNotifications: 1,
    failedNotificationDeliveries: 1, missingSecrets: 2, legacySecretValues: 1,
  });

  // Another tenant sees none of it.
  const other = await app.health({ tenantId: 'globex' });
  assert.equal(other.services.webhooks.counts.endpoints, 0);
  assert.equal(other.attention.failedJobs, 0);

  // No raw value or record reaches the report.
  assert.ok(!JSON.stringify(health).includes('raw'));
});

test('webhook endpoints without credential custody are degraded; all endpoints disabled is disabled', async () => {
  const app = services();
  const ada = app.identify({ principalId: 'ada', principalType: 'user', tenantId: 'acme' })!;
  const endpoint = await app.webhooks.createWebhookEndpoint({ url: 'https://one.example.com/hook', events: ['a'], signingCredentialRef: 'credential-ref:one' }, ada);
  let health = await app.health();
  assert.equal(health.authority.state, 'degraded');
  assert.deepEqual(health.services.webhooks.reasons, ['credentials_unconfigured']);
  assert.equal(health.status, 'degraded');
  await app.webhooks.disableWebhookEndpoint({ id: endpoint.id }, ada);
  health = await app.health();
  assert.equal(health.services.webhooks.state, 'disabled');
  assert.equal(health.status, 'ok');
});

test('every count is bounded by countLimit and reports when it was capped', async () => {
  const app = services({ credentials: true });
  const ada = app.identify({ principalId: 'ada', principalType: 'user', tenantId: 'acme' })!;
  for (let index = 0; index < 3; index += 1) {
    const job = await app.jobs.enqueue({ type: 'report', payload: { index } }, ada);
    await app.db.collection('jobs').update(job.id, { status: 'failed' });
  }
  const health = await app.health({ countLimit: 2 });
  assert.equal(health.countLimit, 2);
  assert.equal(health.services.jobs.counts.failed, 2);
  assert.ok(health.cappedCounts.includes('jobs.failed'));
  assert.equal((await app.health()).services.jobs.counts.failed, 3);
  await assert.rejects(app.health({ countLimit: 0 }), RangeError);
  await assert.rejects(app.health({ countLimit: 10_001 }), RangeError);
});
