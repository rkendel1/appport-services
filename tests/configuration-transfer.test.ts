import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONFIGURATION_EXPORT_FORMAT, CONFIGURATION_EXPORT_FORMAT_VERSION, ServiceMigrationError, VERSION, createServices,
  type AppPortServices, type ConfigurationExportDocument,
} from '../src/index.js';
import { TestAuthority, TestCredentials } from './support/authority.js';

const PUBLIC_DESTINATIONS = { lookup: async () => [{ address: '93.184.216.34', family: 4 as const }] };
const SIGNING_SECRET = 'whsec_SIGNING_MATERIAL_must_not_leak';
const LEGACY_RAW = 'LEGACY_RAW_SECRET_must_not_leak';
const CUSTODY_SECRET = 'sk_live_CUSTODY_MATERIAL_must_not_leak';

function open(authorizer: TestAuthority = new TestAuthority({ allowAll: true }), credentials = new TestCredentials()): AppPortServices {
  return createServices({ memory: true, namespace: `transfer-${crypto.randomUUID()}`, application: 'billing', authorizer, credentials, webhookDestinationPolicy: PUBLIC_DESTINATIONS });
}

async function seedSource() {
  const credentials = new TestCredentials();
  const signingRef = credentials.put('whsec_billing', 'acme', SIGNING_SECRET);
  const apiRef = credentials.put('stripe_key', 'acme', CUSTODY_SECRET);
  const source = open(new TestAuthority({ allowAll: true }), credentials);
  const ada = source.identify({ principalId: 'ada', principalType: 'user', tenantId: 'acme' })!;
  await source.configuration.createVariable({ environment: 'staging', name: 'REGION', value: 'eu-west-1', required: true }, ada);
  await source.configuration.createVariable({ environment: 'staging', name: 'FEATURE_X', value: 'on' }, ada);
  await source.configuration.createSecret({ environment: 'staging', name: 'STRIPE_KEY', credentialRef: apiRef, required: true }, ada);
  // A pre-reference binding that still stores a raw value.
  await source.db.collection('ConfigurationSecrets').insert({ id: 'legacy-1', tenantId: 'acme', applicationId: 'billing', environment: 'staging', name: 'OLD_TOKEN', value: LEGACY_RAW, credentialRef: 'credential-ref:old_token', required: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: 'ada' }, 'legacy-1');
  await source.webhooks.createWebhookEndpoint({ url: 'https://hooks.example.com/billing', events: ['invoice.paid', 'invoice.created'], signingCredentialRef: signingRef }, ada);
  const old = await source.webhooks.createWebhookEndpoint({ url: 'https://old.example.com/hook', events: ['invoice.created'], signingCredentialRef: signingRef }, ada);
  await source.webhooks.disableWebhookEndpoint({ id: old.id }, ada);
  await source.schedules.create({ type: 'invoice.reconcile', interval: '1h', payload: { batch: 100 } }, ada);
  // Exercise the signing secret once, so the custody value has been in play.
  await source.webhooks.emitWebhookEvent({ type: 'invoice.paid', payload: { id: 'inv-1' } }, ada);
  return { source, ada, signingRef, apiRef };
}

test('export is a versioned document of non-secret configuration; secret values never appear', async () => {
  const { source, ada, signingRef, apiRef } = await seedSource();
  const document = await source.configuration.export({ principal: ada, environment: 'staging' });

  assert.equal(document.format, CONFIGURATION_EXPORT_FORMAT);
  assert.equal(document.formatVersion, CONFIGURATION_EXPORT_FORMAT_VERSION);
  assert.equal(document.formatVersion, 1);
  assert.deepEqual(document.source, { application: 'billing', environment: 'staging', servicesVersion: VERSION });
  assert.deepEqual(document.variables, [
    { name: 'FEATURE_X', value: 'on', required: false },
    { name: 'REGION', value: 'eu-west-1', required: true },
  ]);
  assert.deepEqual(document.secrets, [
    { name: 'OLD_TOKEN', required: false, credentialRef: 'credential-ref:old_token' },
    { name: 'STRIPE_KEY', required: true, credentialRef: apiRef },
  ]);
  assert.deepEqual(document.webhookEndpoints, [{ url: 'https://hooks.example.com/billing', events: ['invoice.created', 'invoice.paid'], signingCredentialRef: signingRef }], 'disabled endpoints are not exported');
  assert.deepEqual(document.schedules, [{ type: 'invoice.reconcile', interval: '1h', payload: { batch: 100 } }]);

  const text = JSON.stringify(document);
  for (const secret of [SIGNING_SECRET, LEGACY_RAW, CUSTODY_SECRET]) assert.ok(!text.includes(secret), `export must not contain ${secret}`);
  for (const secret of document.secrets) assert.deepEqual(Object.keys(secret).sort(), ['credentialRef', 'name', 'required']);
  for (const endpoint of document.webhookEndpoints) assert.deepEqual(Object.keys(endpoint).sort(), ['events', 'signingCredentialRef', 'url']);
  assert.ok(!/__version|tenantId|createdBy/.test(text), 'no record internals or tenant identity');
});

test('import plans in a dry run, applies, is idempotent, and lists the secrets the target must attach', async () => {
  const { source, ada } = await seedSource();
  const document = await source.configuration.export({ principal: ada, environment: 'staging' });
  const target = open();
  const bob = target.identify({ principalId: 'bob', principalType: 'user', tenantId: 'globex' })!;

  const plan = await target.configuration.import(JSON.parse(JSON.stringify(document)), { principal: bob, dryRun: true, environment: 'production' });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.environment, 'production');
  assert.deepEqual(plan.summary, { create: 4, update: 0, unchanged: 0, conflict: 0, missing: 2, skip: 0, failed: 0 });
  assert.ok(plan.items.every((item) => !item.applied));
  assert.deepEqual(plan.missingSecrets.map((secret) => secret.name), ['OLD_TOKEN', 'STRIPE_KEY']);
  assert.equal(plan.missingSecrets.find((secret) => secret.name === 'STRIPE_KEY')?.required, true);
  // A dry run writes nothing.
  const untouched = await target.configuration.list({ environment: 'production' }, bob);
  assert.equal(untouched.variables.length + untouched.secrets.length, 0);
  assert.deepEqual(await target.webhooks.listWebhookEndpoints('globex'), []);

  const applied = await target.configuration.import(document, { principal: bob, environment: 'production' });
  assert.deepEqual(applied.summary, { create: 4, update: 0, unchanged: 0, conflict: 0, missing: 2, skip: 0, failed: 0 });
  assert.ok(applied.items.filter((item) => item.action === 'create').every((item) => item.applied));
  const listed = await target.configuration.list({ environment: 'production' }, bob);
  assert.deepEqual(listed.variables.map((variable) => [variable.name, variable.value, variable.required]).sort(), [['FEATURE_X', 'on', false], ['REGION', 'eu-west-1', true]]);
  assert.equal(listed.secrets.length, 0, 'credential bindings are never created by an import');
  const endpoints = await target.webhooks.listWebhookEndpoints('globex');
  assert.equal(endpoints.length, 1);
  assert.deepEqual([...endpoints[0]!.events].sort(), ['invoice.created', 'invoice.paid']);
  assert.equal(endpoints[0]!.createdBy, 'bob', 'created as the importing principal');
  assert.equal((await target.schedules.list('globex', bob)).length, 1);

  const again = await target.configuration.import(document, { principal: bob, environment: 'production' });
  assert.deepEqual(again.summary, { create: 0, update: 0, unchanged: 4, conflict: 0, missing: 2, skip: 0, failed: 0 });
});

test('differences are conflicts unless overwrite is set', async () => {
  const { source, ada } = await seedSource();
  const document = await source.configuration.export({ principal: ada, environment: 'staging' });
  const target = open();
  const bob = target.identify({ principalId: 'bob', principalType: 'user', tenantId: 'globex' })!;
  await target.configuration.createVariable({ environment: 'staging', name: 'REGION', value: 'us-east-1' }, bob);
  await target.configuration.createSecret({ environment: 'staging', name: 'STRIPE_KEY', credentialRef: 'credential-ref:globex_stripe' }, bob);
  await target.webhooks.createWebhookEndpoint({ url: 'https://hooks.example.com/billing', events: ['invoice.created'], signingCredentialRef: 'credential-ref:globex_whsec' }, bob);
  await target.schedules.create({ type: 'invoice.reconcile', interval: '1h', payload: { batch: 5 } }, bob);

  const conflicts = await target.configuration.import(document, { principal: bob });
  const action = (kind: string, key: string) => conflicts.items.find((item) => item.kind === kind && item.key === key)?.action;
  assert.equal(conflicts.environment, 'staging', 'defaults to the source environment');
  assert.equal(action('variable', 'REGION'), 'conflict');
  assert.equal(action('variable', 'FEATURE_X'), 'create');
  assert.equal(action('secret', 'STRIPE_KEY'), 'unchanged', 'a bound name is kept, with its own reference');
  assert.equal(action('webhookEndpoint', 'https://hooks.example.com/billing'), 'conflict');
  assert.equal(action('schedule', 'invoice.reconcile@1h'), 'conflict');
  assert.equal((await target.configuration.list({ environment: 'staging' }, bob)).variables.find((variable) => variable.name === 'REGION')?.value, 'us-east-1');

  const overwritten = await target.configuration.import(document, { principal: bob, overwrite: true });
  const updated = (kind: string, key: string) => overwritten.items.find((item) => item.kind === kind && item.key === key);
  assert.equal(updated('variable', 'REGION')?.action, 'update');
  assert.equal(updated('variable', 'REGION')?.applied, true);
  assert.equal(updated('webhookEndpoint', 'https://hooks.example.com/billing')?.action, 'update');
  assert.equal(updated('schedule', 'invoice.reconcile@1h')?.action, 'update');
  const listed = await target.configuration.list({ environment: 'staging' }, bob);
  assert.equal(listed.variables.find((variable) => variable.name === 'REGION')?.value, 'eu-west-1');
  assert.equal(listed.secrets.find((secret) => secret.name === 'STRIPE_KEY')?.credentialRef, 'credential-ref:globex_stripe', 'a binding is never replaced');
  const active = (await target.webhooks.listWebhookEndpoints('globex')).filter((endpoint) => !endpoint.disabledAt);
  assert.equal(active.length, 1);
  assert.deepEqual([...active[0]!.events].sort(), ['invoice.created', 'invoice.paid']);
  const schedules = (await target.schedules.list('globex', bob)).filter((schedule) => schedule.enabled);
  assert.deepEqual(schedules.map((schedule) => schedule.payload), [{ batch: 100 }]);
});

test('import refuses unknown versions and any secret value, and every write is authorized', async () => {
  const { source, ada } = await seedSource();
  const document = await source.configuration.export({ principal: ada, environment: 'staging' });
  const target = open();
  const bob = target.identify({ principalId: 'bob', principalType: 'user', tenantId: 'globex' })!;

  await assert.rejects(target.configuration.import({ ...document, formatVersion: 2 }, { principal: bob }), (error: { code?: string }) => error.code === 'INVALID_REQUEST');
  await assert.rejects(target.configuration.import({ ...document, format: 'something-else' }, { principal: bob }), (error: { code?: string }) => error.code === 'INVALID_REQUEST');
  await assert.rejects(target.configuration.import({ ...document, secrets: [{ name: 'STRIPE_KEY', credentialRef: 'credential-ref:x', value: 'sk_live_x' }] }, { principal: bob }), ServiceMigrationError);
  await assert.rejects(target.configuration.import({ ...document, webhookEndpoints: [{ url: 'https://a.example.com', events: ['x'], signingSecret: 'whsec_x' }] }, { principal: bob }), ServiceMigrationError);
  await assert.rejects(target.configuration.import({ ...document, secrets: [{ name: 'STRIPE_KEY', credentialRef: 'sk_live_raw' }] }, { principal: bob }), (error: { code?: string }) => error.code === 'INVALID_REQUEST');
  await assert.rejects(target.configuration.import('not json', { principal: bob }), (error: { code?: string }) => error.code === 'INVALID_REQUEST');
  await assert.rejects(target.configuration.import(document, { principal: { principalId: 'forged' } as never }));

  // Reads allowed, writes denied: the plan is produced and every write fails as DENIED.
  const readOnly = new TestAuthority();
  for (const capability of ['configuration.read', 'webhooks.read', 'schedules.read']) await readOnly.grant({ subject: 'carol', capability });
  const guarded = open(readOnly);
  const carol = guarded.identify({ principalId: 'carol', principalType: 'user', tenantId: 'initech' })!;
  const dry = await guarded.configuration.import(document, { principal: carol, dryRun: true });
  assert.equal(dry.summary.create, 4);
  const denied = await guarded.configuration.import(document, { principal: carol });
  assert.equal(denied.summary.failed, 4);
  assert.ok(denied.items.filter((item) => item.action === 'create').every((item) => !item.applied && item.error?.code === 'DENIED'));
  // And an export needs its reads.
  const nobody = guarded.identify({ principalId: 'dave', principalType: 'user', tenantId: 'initech' })!;
  await assert.rejects(guarded.configuration.export({ principal: nobody }), (error: { code?: string }) => error.code === 'DENIED');
});

test('an export document survives a JSON round trip unchanged', async () => {
  const { source, ada } = await seedSource();
  const document: ConfigurationExportDocument = await source.configuration.export({ principal: ada, environment: 'staging' });
  assert.deepEqual(JSON.parse(JSON.stringify(document)), document);
  const target = open();
  const bob = target.identify({ principalId: 'bob', principalType: 'user', tenantId: 'globex' })!;
  const report = await target.configuration.import(JSON.stringify(document), { principal: bob, dryRun: true });
  assert.equal(report.summary.create, 4);
});
