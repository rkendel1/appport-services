import assert from 'node:assert/strict';
import test from 'node:test';

import { INTELLIGENCE_CATALOG, findIntelligenceModel, getIntelligenceProvider } from '../src/intelligence/catalog.js';
import { INTELLIGENCE_CREDENTIAL_NAME, INTELLIGENCE_SELECTION_NAME } from '../src/intelligence/service.js';
import { evidenceCollectionName } from '../src/authority/evidence.js';
import { ServiceMigrationError } from '../src/authority/errors.js';
import { configurationCollectionNames } from '../src/configuration/storage.js';
import { SERVICE_CAPABILITY_MANIFEST } from '../src/authority/manifest.js';
import { TestAuthority } from './support/authority.js';
import { openStack, type Stack } from './support/stack.js';

const SENTINEL = 'test-secret-do-not-return';
const ref = 'credential-ref:openai-key';
const rejects = (pattern: RegExp) => (error: unknown) => pattern.test((error as Error).message);

async function withStack(run: (stack: Stack, alice: ReturnType<Stack['services']['identify']> & object) => Promise<void>, path?: string) {
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }), path });
  try {
    await run(stack, stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!);
  } finally {
    await stack.close();
  }
}

test('catalog describes known providers and includes a custom OpenAI-compatible option', () => {
  const ids = INTELLIGENCE_CATALOG.map((provider) => provider.id);
  for (const id of ['openai', 'anthropic', 'opencode', 'ollama', 'custom']) assert.ok(ids.includes(id), id);
  assert.equal(getIntelligenceProvider('custom')?.protocol, 'openai-compatible');
  assert.equal(getIntelligenceProvider('custom')?.credential, 'optional');
  assert.equal(getIntelligenceProvider('nope'), undefined);
  assert.ok(findIntelligenceModel('anthropic', 'claude-opus-5-5'));
  assert.equal(findIntelligenceModel('anthropic', 'gpt-4o'), undefined);
  assert.ok(Object.isFrozen(INTELLIGENCE_CATALOG));
});

test('unconfigured intelligence is a normal state and resolves to nothing', async () => {
  await withStack(async (stack, alice) => {
    assert.deepEqual(await stack.services.invoke('intelligence.read', {}, { principal: alice }), { configured: false, environment: 'production', credentialConfigured: false });
    assert.equal(await stack.services.intelligence.resolveRuntime({}, alice), null);
    const catalog = await stack.services.invoke('intelligence.catalog', {}, { principal: alice }) as unknown[];
    assert.equal(catalog.length, INTELLIGENCE_CATALOG.length);
  });
});

test('known provider: default endpoint, catalog model, required credential', async () => {
  await withStack(async (stack, alice) => {
    const call = (input: Record<string, unknown>) => stack.services.invoke('intelligence.write', input, { principal: alice });
    await assert.rejects(call({ provider: 'anthropic', model: 'claude-opus-5-5' }), rejects(/requires a credential/));
    await assert.rejects(call({ provider: 'anthropic', model: 'not-a-model', credentialRef: ref }), rejects(/not available/));
    await assert.rejects(call({ provider: 'mystery', model: 'x' }), rejects(/Unknown provider/));
    await assert.rejects(call({ provider: 'anthropic', model: '' , credentialRef: ref}), rejects(/Model is required/));
    await assert.rejects(call({ provider: 'anthropic', model: 'claude-opus-5-5', endpoint: 'https://evil.example/v1', credentialRef: ref }), rejects(/custom endpoint/));
    assert.deepEqual(await stack.services.invoke('intelligence.read', {}, { principal: alice }), { configured: false, environment: 'production', credentialConfigured: false }, 'rejected writes leave nothing behind');

    const saved = await call({ provider: 'anthropic', model: 'claude-opus-5-5', credentialRef: ref }) as Record<string, unknown>;
    assert.equal(saved.provider, 'anthropic');
    assert.deepEqual(saved.endpoint, { kind: 'default', url: 'https://api.anthropic.com' });
    assert.equal(saved.credentialConfigured, true);
    assert.deepEqual(await stack.services.intelligence.resolveRuntime({}, alice), { provider: 'anthropic', protocol: 'anthropic', model: 'claude-opus-5-5', endpoint: 'https://api.anthropic.com', credentialRef: ref });
  });
});

test('local OpenAI-compatible provider works without a credential and with a custom endpoint', async () => {
  await withStack(async (stack, alice) => {
    const call = (input: Record<string, unknown>) => stack.services.invoke('intelligence.write', input, { principal: alice });
    const local = await call({ provider: 'custom', model: 'local-model', endpoint: 'http://localhost:11434/v1/' }) as Record<string, unknown>;
    assert.deepEqual(local.endpoint, { kind: 'custom', url: 'http://localhost:11434/v1' });
    assert.equal(local.credentialConfigured, false);
    assert.equal((await stack.services.intelligence.resolveRuntime({}, alice))?.credentialRef, undefined);

    await assert.rejects(call({ provider: 'custom', model: 'm' }), rejects(/requires an endpoint/));
    await assert.rejects(call({ provider: 'custom', model: 'm', endpoint: 'not a url' }), rejects(/valid URL/));
    await assert.rejects(call({ provider: 'custom', model: 'm', endpoint: 'ftp://x/v1' }), rejects(/http or https/));
    await assert.rejects(call({ provider: 'custom', model: 'm', endpoint: 'https://user:pw@host/v1' }), rejects(/embed credentials/));
    await assert.rejects(call({ provider: 'custom', model: 'm', endpoint: 'https://host/v1?key=abc' }), rejects(/query string/));
    await assert.rejects(call({ provider: 'custom', model: 'm', endpoint: 'http://api.example.com/v1' }), rejects(/Plain http/));
    await call({ provider: 'custom', model: 'm', endpoint: 'http://192.168.1.20:8080/v1' });
    await call({ provider: 'ollama', model: 'llama3' });
    assert.equal((await stack.services.intelligence.resolveRuntime({}, alice))?.endpoint, 'http://localhost:11434/v1');
  });
});

test('credential replacement and removal never reveal the previous value; raw credentials are refused', async () => {
  await withStack(async (stack, alice) => {
    const invoke = (capability: string, input: Record<string, unknown>) => stack.services.invoke(capability, input, { principal: alice });
    await invoke('intelligence.write', { provider: 'custom', model: 'm', endpoint: 'http://localhost:1234/v1' });
    await assert.rejects(invoke('intelligence.credential.set', { credentialRef: SENTINEL }), (e: unknown) => e instanceof ServiceMigrationError && !(e as Error).message.includes(SENTINEL));
    await assert.rejects(invoke('intelligence.credential.set', { apiKey: SENTINEL, credentialRef: ref }), ServiceMigrationError);
    await assert.rejects(invoke('intelligence.write', { provider: 'custom', model: 'm', endpoint: 'http://localhost:1234/v1', token: SENTINEL }), ServiceMigrationError);

    const first = await invoke('intelligence.credential.set', { credentialRef: 'credential-ref:one' }) as Record<string, unknown>;
    assert.equal(first.credentialConfigured, true);
    const second = await invoke('intelligence.credential.set', { credentialRef: 'credential-ref:two' });
    assert.ok(!JSON.stringify(second).includes('credential-ref'), 'view exposes no credential reference');
    assert.equal((await stack.services.intelligence.resolveRuntime({}, alice))?.credentialRef, 'credential-ref:two');

    const removed = await invoke('intelligence.credential.remove', {}) as Record<string, unknown>;
    assert.equal(removed.credentialConfigured, false);
    assert.equal((await stack.services.intelligence.resolveRuntime({}, alice))?.credentialRef, undefined);

    await invoke('intelligence.write', { provider: 'openai', model: 'gpt-4o', credentialRef: ref });
    await assert.rejects(invoke('intelligence.credential.remove', {}), rejects(/requires a credential/));
  });
});

test('a credential is not carried to a different provider or endpoint', async () => {
  await withStack(async (stack, alice) => {
    const invoke = (input: Record<string, unknown>) => stack.services.invoke('intelligence.write', input, { principal: alice }) as Promise<Record<string, unknown>>;
    await invoke({ provider: 'custom', model: 'm', endpoint: 'https://models.example.com/v1', credentialRef: ref });
    const sameDestination = await invoke({ provider: 'custom', model: 'other-model', endpoint: 'https://models.example.com/v1' });
    assert.equal(sameDestination.credentialConfigured, true, 'changing only the model keeps the credential');
    const moved = await invoke({ provider: 'custom', model: 'm', endpoint: 'https://elsewhere.example.com/v1' });
    assert.equal(moved.credentialConfigured, false, 'a new destination drops the old credential');
    assert.equal((await stack.services.intelligence.resolveRuntime({}, alice))?.credentialRef, undefined);
    await assert.rejects(invoke({ provider: 'openai', model: 'gpt-4o' }), rejects(/requires a credential/));
  });
});

test('resolve is runtime-internal and ownership comes from the principal', async () => {
  await withStack(async (stack, alice) => {
    await assert.rejects(stack.services.invoke('intelligence.resolve', {}, { principal: alice }), /runtime-internal/);
    await assert.rejects(stack.services.invoke('intelligence.read', { tenantId: 'tenant-b' }, { principal: alice }), /Cross-tenant/);
    await assert.rejects(stack.services.invoke('intelligence.read', { applicationId: 'other-app' }, { principal: alice }), /different application/);
    await stack.services.invoke('intelligence.write', { provider: 'custom', model: 'm', endpoint: 'http://localhost:1/v1' }, { principal: alice });
    const bob = stack.services.identify({ principalId: 'bob', principalType: 'user', tenantId: 'tenant-b' })!;
    assert.equal(((await stack.services.invoke('intelligence.read', {}, { principal: bob })) as { configured: boolean }).configured, false);
  });
});

test('authorization is required for every intelligence capability', async () => {
  const authority = new TestAuthority();
  const stack = await openStack({ authorizer: authority });
  try {
    const alice = stack.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    await assert.rejects(stack.services.invoke('intelligence.read', {}, { principal: alice }), (e: { code?: string }) => e.code === 'DENIED');
    await assert.rejects(stack.services.invoke('intelligence.write', { provider: 'custom', model: 'm', endpoint: 'http://localhost:1/v1' }, { principal: alice }), (e: { code?: string }) => e.code === 'DENIED');
    await authority.grant({ subject: 'alice', capability: 'intelligence.read' });
    assert.equal(((await stack.services.invoke('intelligence.read', {}, { principal: alice })) as { configured: boolean }).configured, false);
  } finally {
    await stack.close();
  }
});

test('durable configuration survives a process restart without exposing the credential; the sentinel appears nowhere', async () => {
  const first = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  const path = first.path;
  const responses: unknown[] = [];
  try {
    const alice = first.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    responses.push(await first.services.invoke('intelligence.write', { provider: 'openai', model: 'gpt-4o', credentialRef: ref }, { principal: alice }));
    await assert.rejects(first.services.invoke('intelligence.write', { provider: 'openai', model: 'gpt-4o', credentialRef: SENTINEL }, { principal: alice }), (e: Error) => { responses.push(e.message); return true; });
  } finally {
    await first.close();
  }

  const second = await openStack({ path, authorizer: new TestAuthority({ allowAll: true }) });
  try {
    const alice = second.services.identify({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' })!;
    const read = await second.services.invoke('intelligence.read', {}, { principal: alice }) as Record<string, unknown>;
    responses.push(read, await second.services.invoke('intelligence.catalog', {}, { principal: alice }), JSON.stringify(second.services.discovery));
    assert.equal(read.configured, true);
    assert.equal(read.provider, 'openai');
    assert.equal(read.model, 'gpt-4o');
    assert.equal(read.credentialConfigured, true);
    assert.equal((await second.services.intelligence.resolveRuntime({}, alice))?.credentialRef, ref);

    // The configuration lives in the existing configuration collections, not a new store.
    const variables = await second.db.collection(configurationCollectionNames.variables).list() as { name: string }[];
    const secrets = await second.db.collection(configurationCollectionNames.secrets).list() as { name: string }[];
    assert.deepEqual(variables.map((v) => v.name), [INTELLIGENCE_SELECTION_NAME]);
    assert.deepEqual(secrets.map((s) => s.name), [INTELLIGENCE_CREDENTIAL_NAME]);

    const everything = JSON.stringify([
      responses,
      variables, secrets,
      await second.db.collection(configurationCollectionNames.audit).list(),
      await second.db.collection(evidenceCollectionName()).list(),
    ]);
    assert.ok(!everything.includes(SENTINEL), 'credential sentinel must not appear in responses, persisted state, audit, or evidence');
    assert.ok(!JSON.stringify(responses).includes(ref), 'client responses carry no credential reference');
  } finally {
    await second.close();
  }
});

test('the Intelligence page is a discoverable surface and the management adapter returns no credential', async () => {
  const { createServer } = await import('node:http');
  const { default: express } = await import('express');
  const { createManagementRouter, createUiContribution } = await import('../src/index.js');
  const stack = await openStack({ authorizer: new TestAuthority({ allowAll: true }) });
  const app = express();
  app.use(createManagementRouter({ services: stack.services, authority: stack.services.gateway, authenticate: () => ({ principalId: 'alice', principalType: 'user', tenantId: 'tenant-a' }) }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const surface = createUiContribution(stack.services)!.surfaces.find((entry) => entry.id === 'intelligence');
    assert.equal(surface?.route, '/intelligence');
    assert.ok(surface!.capabilities.every((name) => SERVICE_CAPABILITY_MANIFEST.some((c) => c.name === name)));

    const page = await (await fetch(`${base}/intelligence`)).text();
    assert.match(page, /<h1>Intelligence<\/h1>/);
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(page), 'page uses no browser storage');
    assert.match(await (await fetch(`${base}/services`)).text(), /href="\/intelligence"/);

    const put = await fetch(`${base}/v1/intelligence`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'openai', model: 'gpt-4o', credentialRef: ref }) });
    const saved = await put.text();
    assert.equal(put.status, 200, saved);
    assert.ok(!saved.includes(ref) && JSON.parse(saved).credentialConfigured === true);
    const raw = await fetch(`${base}/v1/intelligence/credential`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: SENTINEL, credentialRef: ref }) });
    assert.equal(raw.status >= 400, true);
    assert.ok(!(await raw.text()).includes(SENTINEL));
    const read = await (await fetch(`${base}/v1/intelligence`)).text();
    assert.ok(!read.includes(ref) && !read.includes(SENTINEL));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stack.close();
  }
});
