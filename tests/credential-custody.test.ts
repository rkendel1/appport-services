import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  createManagementRouter, createServices, isSecretCustody, isServiceAuthorityError, ServiceAuthorityError,
  SERVICE_CAPABILITY_MANIFEST, CAPABILITY_CATALOG, createUiContribution,
  type AppPortServices, type CreateServicesOptions, type CredentialStoreResult, type CredentialStatusView, type PrincipalClaims,
} from '../src/index.js';
import { TestAuthority, TestCredentials } from './support/authority.js';
import { MemoryCustody } from './support/custody.js';

// A distinctive value: if any byte of it shows up anywhere durable or visible, the scan finds it.
const VALUE = 'Xq9Zk2LeakCanary-sk-ant-api03-7f3a9c2e5b1d4086-DO-NOT-LEAK';
/** True when the value, or a recognisable piece of it (a parser's quoted snippet), is in the text. */
const leaks = (text: unknown) => {
  const haystack = typeof text === 'string' ? text : JSON.stringify(text) ?? String(text);
  return [VALUE, VALUE.slice(0, 10), VALUE.slice(-12), '7f3a9c2e5b1d4086'].some((piece) => haystack.includes(piece));
};
const REF = 'credential-ref:anthropic';

const alice: PrincipalClaims = { principalId: 'alice', principalType: 'host_session', tenantId: 'tenant-a' };
const mallory: PrincipalClaims = { principalId: 'mallory', principalType: 'host_session', tenantId: 'tenant-a' };

const ALL = ['credential.store', 'credential.status', 'credential.attach', 'credential.rotate', 'credential.detach', 'configuration.read', 'configuration.write', 'webhooks.read', 'schedules.read'];

async function authority(grants: Readonly<Record<string, readonly string[]>> = { alice: ALL }): Promise<TestAuthority> {
  const authorizer = new TestAuthority();
  for (const [subject, capabilities] of Object.entries(grants)) {
    for (const capability of capabilities) await authorizer.grant({ subject, capability });
  }
  return authorizer;
}

async function services(options: Partial<CreateServicesOptions> & { grants?: Readonly<Record<string, readonly string[]>> } = {}) {
  const { grants, ...rest } = options;
  const authorizer = rest.authorizer as TestAuthority | undefined ?? await authority(grants);
  const custody = rest.credentials === undefined ? new MemoryCustody() : undefined;
  const app = createServices({ memory: true, namespace: `custody-${crypto.randomUUID()}`, application: 'custody-app', authorizer, ...(custody ? { credentials: custody } : {}), ...rest });
  return { app, authorizer, custody: (custody ?? rest.credentials) as MemoryCustody };
}

const who = (app: AppPortServices, claims: PrincipalClaims) => app.identify(claims)!;
const code = (expected: string) => (error: unknown) => isServiceAuthorityError(error) && error.code === expected;
const store = (app: AppPortServices, input: Record<string, unknown>, claims = alice) => app.invoke('credential.store', input, { principal: who(app, claims) }) as Promise<CredentialStoreResult>;
const status = (app: AppPortServices, input: Record<string, unknown>, claims = alice) => app.invoke('credential.status', input, { principal: who(app, claims) }) as Promise<CredentialStatusView[]>;

/** Every durable byte FeltDB holds for this instance: every operation, every row of every collection it touched, and its audit log. */
async function durableText(app: AppPortServices): Promise<string> {
  const operations = await app.db.exportOperations();
  const collections = [...new Set(operations.map((operation) => operation.collection))];
  const rows = await Promise.all(collections.map(async (name) => [name, await app.db.collection(name).list()] as const));
  return JSON.stringify({ operations, rows, audit: await app.db.auditEvents() });
}

/** Collect everything written to the console and the process streams while `work` runs. */
async function captureOutput<T>(work: () => Promise<T>): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const originals = methods.map((name) => console[name]);
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  for (const name of methods) console[name] = (...args: unknown[]) => { chunks.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg)).join(' ')); };
  process.stdout.write = ((chunk: unknown) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const result = await work();
    return { result, output: chunks.join('\n') };
  } finally {
    methods.forEach((name, index) => { console[name] = originals[index]!; });
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` };
}

async function management(app: AppPortServices, principal: () => PrincipalClaims | null = () => alice) {
  const host = express();
  host.use(createManagementRouter({ services: app, authority: app.gateway, authenticate: () => principal() }));
  return listen(host);
}

const close = (server: Server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('SecretCustody is recognised by shape; a resolver is not one', () => {
  assert.equal(isSecretCustody(new MemoryCustody()), true);
  assert.equal(isSecretCustody(new TestCredentials()), false);
  assert.equal(isSecretCustody({ withSecret() {}, store() {} }), false);
  assert.equal(isSecretCustody(null), false);
  assert.equal(isSecretCustody('credential-ref:x'), false);
});

test('credential.store and credential.status are declared, discoverable and on the Secrets page', () => {
  const store = SERVICE_CAPABILITY_MANIFEST.find((capability) => capability.name === 'credential.store');
  const status = SERVICE_CAPABILITY_MANIFEST.find((capability) => capability.name === 'credential.status');
  assert.deepEqual({ ...store, authorization: { ...store!.authorization } }, { name: 'credential.store', version: 1, service: 'configuration', operation: 'storeCredential', effect: 'consequential', invocable: true, authorization: { required: true, resource: 'credential' } });
  assert.deepEqual({ ...status, authorization: { ...status!.authorization } }, { name: 'credential.status', version: 1, service: 'configuration', operation: 'credentialStatus', effect: 'observation', invocable: true, authorization: { required: true, resource: 'credential' } });
  const credentials = CAPABILITY_CATALOG.find((descriptor) => descriptor.id === 'credentials')!;
  assert.ok(credentials.operations.includes('store') && credentials.operations.includes('status'));
  const secrets = createUiContribution({ configuration: true })!.surfaces.find((surface) => surface.id === 'secrets')!;
  assert.ok(secrets.capabilities.includes('credential.store') && secrets.capabilities.includes('credential.status'));
});

test('an authorized principal stores a value through invoke: custody holds it, Services records only ref and version', async () => {
  const { app, authorizer, custody } = await services();
  const result = await store(app, { ref: REF, value: VALUE, provider: 'anthropic', kind: 'api_key' });
  assert.deepEqual(Object.keys(result).sort(), ['ref', 'storedAt', 'version']);
  assert.equal(result.ref, REF);
  assert.equal(result.version, 1);
  assert.ok(Date.parse(result.storedAt));
  assert.equal(custody.peek('tenant-a', 'anthropic'), VALUE, 'the host custody received the value');

  const storeCall = custody.calls.find((call) => call.op === 'store')!;
  assert.deepEqual(storeCall.reference, { secretId: 'anthropic', tenantId: 'tenant-a', provider: 'anthropic', kind: 'api_key' });
  assert.equal(storeCall.context.principalId, 'alice');
  assert.equal(storeCall.context.purpose, 'credential.store');
  assert.match(storeCall.context.authorizationRef!, /^dec_/, 'custody gets the AuthBoundry decision');

  // AuthBoundry was asked for exactly this capability on this reference.
  const request = authorizer.requests.find((candidate) => candidate.capability === 'credential.store')!;
  assert.equal(request.resource.attributes?.credentialRef, REF);
  assert.equal(leaks(JSON.stringify(authorizer.requests)), false);

  // Evidence: the reference and the version, nothing else.
  const evidence = (await app.db.collection<Record<string, unknown>>('service_effect_evidence').list()).filter((row) => row.capability === 'credential.store');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.outcome, 'succeeded');
  assert.equal(evidence[0]!.credentialRef, REF);
  assert.equal(evidence[0]!.credentialVersion, 1);

  // Value-free version metadata and audit.
  const [secret] = await app.db.collection<Record<string, unknown>>('Secrets').list();
  assert.equal(secret!.name, 'anthropic');
  assert.equal(secret!.providerRef, REF);
  assert.equal(secret!.currentVersion, 1);
  const versions = await app.db.collection<Record<string, unknown>>('SecretVersions').list();
  assert.deepEqual(versions.map((row) => [row.version, row.status, row.createdBy]), [[1, 'active', 'alice']]);
  const audit = await app.db.collection<Record<string, unknown>>('SecretAuditEvents').list();
  assert.deepEqual(audit.map((row) => [row.type, row.result, row.version, row.principalId, row.purpose]), [['secret.created', 'success', 1, 'alice', 'credential.store']]);
  assert.equal(leaks(await durableText(app)), false);
});

test('a denied principal is refused and nothing reaches custody', async () => {
  const { app, custody } = await services();
  await assert.rejects(store(app, { ref: REF, value: VALUE }, mallory), code('DENIED'));
  assert.equal(custody.size, 0);
  assert.equal(custody.calls.length, 0, 'custody is not even asked for status before authorization');
  assert.equal((await app.db.collection('SecretVersions').list()).length, 0);
  const denial = (await app.db.collection<Record<string, unknown>>('service_effect_evidence').list()).find((row) => row.capability === 'credential.store');
  assert.equal(denial?.outcome, 'denied');
  assert.equal(leaks(await durableText(app)), false);
});

test('read-only custody is CUSTODY_READ_ONLY with an actionable message, and nothing is stored', async () => {
  // A resolver-only custody (the 0.7 shape).
  const resolverOnly = await services({ credentials: new TestCredentials() });
  await assert.rejects(store(resolverOnly.app, { ref: REF, value: VALUE }), (error: unknown) => {
    assert.ok(error instanceof ServiceAuthorityError);
    assert.equal(error.code, 'CUSTODY_READ_ONLY');
    assert.equal(error.status, 409);
    assert.match(error.message, /read-only/);
    assert.match(error.message, /SecretCustody|secret manager/);
    assert.equal(leaks(error.message), false);
    return true;
  });
  await assert.rejects(status(resolverOnly.app, { ref: REF }), code('CUSTODY_READ_ONLY'));

  // No custody at all.
  const none = await services({ credentials: undefined });
  const bare = createServices({ memory: true, namespace: `custody-${crypto.randomUUID()}`, authorizer: none.authorizer });
  await assert.rejects(store(bare, { ref: REF, value: VALUE }), (error: unknown) => isServiceAuthorityError(error) && error.code === 'CUSTODY_READ_ONLY' && /No credential custody is configured/.test(error.message));

  // A custody that reports the reference as host-managed (an environment variable).
  const { app, custody } = await services();
  custody.hostManaged.add('anthropic');
  await assert.rejects(store(app, { ref: REF, value: VALUE }), (error: unknown) => {
    assert.ok(isServiceAuthorityError(error));
    assert.equal(error.code, 'CUSTODY_READ_ONLY');
    assert.match(error.message, /environment variable FELTKIT_CREDENTIAL_ANTHROPIC/);
    assert.match(error.message, /set it there/);
    return true;
  });
  assert.equal(custody.size, 0);
  assert.equal(custody.calls.some((call) => call.op === 'store'), false);
  const evidence = (await app.db.collection<Record<string, unknown>>('service_effect_evidence').list()).find((row) => row.capability === 'credential.store');
  assert.equal(evidence?.failureCode, 'CUSTODY_READ_ONLY');
  const [failure] = await app.db.collection<Record<string, unknown>>('SecretAuditEvents').list();
  assert.equal(failure?.type, 'secret.failed');
  assert.equal(failure?.result, 'failure');
});

test('credential.status reports set, missing and revoked without revealing the value', async () => {
  const { app, custody } = await services();
  await store(app, { ref: 'credential-ref:openai', value: VALUE });
  await store(app, { ref: 'credential-ref:old', value: `${VALUE}-old` });
  await custody.remove({ reference: { secretId: 'old', tenantId: 'tenant-a' }, context: { tenantId: 'tenant-a', principalId: 'host', purpose: 'test' } });
  const statuses = await status(app, { refs: ['credential-ref:openai', 'credential-ref:never-set', 'credential-ref:old'] });
  assert.deepEqual(statuses.map((entry) => [entry.ref, entry.state, entry.version, entry.writable]), [
    ['credential-ref:openai', 'set', 1, true],
    ['credential-ref:never-set', 'missing', undefined, true],
    ['credential-ref:old', 'revoked', 1, true],
  ]);
  assert.equal(statuses[0]!.location, 'test memory custody');
  assert.equal(leaks(JSON.stringify(statuses)), false);
  const single = await status(app, { ref: 'credential-ref:openai' });
  assert.equal(single.length, 1);
  assert.equal(single[0]!.state, 'set');
  // Observation is authorized like any capability.
  await assert.rejects(status(app, { ref: 'credential-ref:openai' }, mallory), code('DENIED'));
  await assert.rejects(status(app, {}), code('INVALID_REQUEST'));
  await assert.rejects(status(app, { ref: 'not-a-ref' }), code('INVALID_REQUEST'));
});

test('storing again rotates: the version increments and the previous version is retired', async () => {
  const { app, custody } = await services();
  assert.equal((await store(app, { ref: REF, value: `${VALUE}-1` })).version, 1);
  assert.equal((await store(app, { ref: REF, value: `${VALUE}-2` })).version, 2);
  assert.equal(custody.peek('tenant-a', 'anthropic'), `${VALUE}-2`);
  const versions = (await app.db.collection<Record<string, unknown>>('SecretVersions').list()).sort((a, b) => Number(a.version) - Number(b.version));
  assert.deepEqual(versions.map((row) => [row.version, row.status]), [[1, 'retired'], [2, 'active']]);
  const audit = (await app.db.collection<Record<string, unknown>>('SecretAuditEvents').list()).map((row) => row.type).sort();
  assert.deepEqual(audit, ['secret.created', 'secret.rotated']);
  assert.equal((await app.db.collection<Record<string, unknown>>('Secrets').list())[0]!.currentVersion, 2);
  const [current] = await status(app, { ref: REF });
  assert.equal(current!.version, 2);
  const text = await durableText(app);
  assert.equal(leaks(text), false);
});

test('store with name creates the configuration binding, then re-points it; the binding change is authorized first', async () => {
  const { app, custody, authorizer } = await services();
  const created = await store(app, { ref: REF, value: VALUE, name: 'ANTHROPIC_API_KEY', environment: 'development' });
  assert.equal(created.binding?.name, 'ANTHROPIC_API_KEY');
  assert.equal(created.binding?.credentialRef, REF);
  assert.equal(created.binding?.environment, 'development');
  assert.equal('value' in created.binding!, false);
  const listed = await app.invoke('configuration.read', { environment: 'development' }, { principal: who(app, alice) }) as { secrets: Array<{ name: string; credentialRef: string }> };
  assert.deepEqual(listed.secrets.map((secret) => [secret.name, secret.credentialRef]), [['ANTHROPIC_API_KEY', REF]]);

  // Same reference again: the binding is unchanged, no attach/rotate needed.
  const again = await store(app, { ref: REF, value: `${VALUE}-2`, name: 'ANTHROPIC_API_KEY', environment: 'development' });
  assert.equal(again.version, 2);
  assert.equal(again.binding?.credentialRef, REF);

  // A different reference: the binding is rotated to it.
  const moved = await store(app, { ref: 'credential-ref:anthropic-2', value: VALUE, name: 'ANTHROPIC_API_KEY', environment: 'development' });
  assert.equal(moved.binding?.credentialRef, 'credential-ref:anthropic-2');
  assert.ok(authorizer.requests.some((request) => request.capability === 'credential.attach'));
  assert.ok(authorizer.requests.some((request) => request.capability === 'credential.rotate'));

  // Without credential.attach the binding is refused before the value reaches custody.
  const limited = await services({ grants: { alice: ['credential.store', 'credential.status'] } });
  await assert.rejects(store(limited.app, { ref: REF, value: VALUE, name: 'ANTHROPIC_API_KEY' }), code('DENIED'));
  assert.equal(limited.custody.size, 0);
  // A name taken by a variable is refused before anything is stored.
  await app.invoke('configuration.write', { name: 'REGION', value: 'eu', environment: 'production' }, { principal: who(app, alice) });
  const before = custody.size;
  await assert.rejects(store(app, { ref: 'credential-ref:region', value: VALUE, name: 'REGION' }), /already exists as a variable/);
  assert.equal(custody.size, before);
  assert.equal(leaks(await durableText(app)), false);
});

test('a credential reference given as the value, an empty value and malformed input are refused without echoing them', async () => {
  const { app, custody } = await services();
  for (const value of ['credential-ref:anthropic', '  credential-ref:other  ', 'credential-ref:']) {
    await assert.rejects(store(app, { ref: REF, value }), (error: unknown) => {
      assert.ok(isServiceAuthorityError(error));
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.match(error.message, /credential reference, not credential material/);
      assert.equal(error.message.includes(value.trim()), false);
      return true;
    });
  }
  for (const value of ['', '   ', undefined, 42, null]) await assert.rejects(store(app, { ref: REF, value }), code('INVALID_REQUEST'));
  await assert.rejects(store(app, { ref: REF, value: 'x'.repeat(65_537) }), code('INVALID_REQUEST'));
  // A raw key pasted into the reference field is refused, and the message does not repeat it.
  await assert.rejects(store(app, { ref: VALUE, value: VALUE }), (error: unknown) => isServiceAuthorityError(error) && !leaks(error.message));
  await assert.rejects(store(app, { ref: REF, value: VALUE, name: 'lower-case' }), (error: unknown) => error instanceof Error && !leaks(error.message));
  await assert.rejects(store(app, { ref: REF, value: VALUE, provider: 'not a label!' }), code('INVALID_REQUEST'));
  assert.equal(custody.size, 0);
  assert.equal(custody.calls.length, 0);
});

test('a custody failure never carries the value back, whatever the host raised', async () => {
  const { app, custody } = await services();
  custody.failStore = (value) => new Error(`provider rejected key ${value}`);
  await assert.rejects(store(app, { ref: REF, value: VALUE }), (error: unknown) => {
    assert.ok(isServiceAuthorityError(error));
    assert.equal(error.code, 'AUTHORITY_UNAVAILABLE');
    assert.equal(leaks(error.message), false);
    assert.equal(leaks(String(error.stack)), false);
    assert.equal(leaks(JSON.stringify(error.details)), false);
    return true;
  });
  custody.failStore = (value) => new ServiceAuthorityError('DENIED', `policy refused ${value}`, { reason: value });
  await assert.rejects(store(app, { ref: REF, value: VALUE }), (error: unknown) => isServiceAuthorityError(error) && error.code === 'DENIED' && !leaks(error.message) && !leaks(JSON.stringify(error.details)));
  const evidence = (await app.db.collection<Record<string, unknown>>('service_effect_evidence').list()).filter((row) => row.capability === 'credential.store');
  assert.deepEqual(evidence.map((row) => row.outcome).sort(), ['denied', 'failed']);
  assert.equal(leaks(await durableText(app)), false);
});

test('health() reports missing material per binding when custody can report status', async () => {
  const { app, custody } = await services();
  await store(app, { ref: REF, value: VALUE, name: 'ANTHROPIC_API_KEY' });
  await app.invoke('credential.attach', { name: 'OPENAI_API_KEY', credentialRef: 'credential-ref:openai', environment: 'production' }, { principal: who(app, alice) });
  const health = await app.health({ tenantId: 'tenant-a' });
  const configuration = health.services.configuration;
  assert.equal(configuration.counts.missingMaterial, 1);
  assert.ok(configuration.reasons.includes('missing_material'));
  assert.equal(configuration.state, 'degraded');
  assert.equal(health.attention.missingCredentialMaterial, 1);
  const bindings = [...configuration.bindings!].sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(bindings.map((binding) => [binding.name, binding.environment, binding.state, binding.version]), [
    ['ANTHROPIC_API_KEY', 'production', 'set', 1],
    ['OPENAI_API_KEY', 'production', 'missing', undefined],
  ]);
  assert.equal(JSON.stringify(health).includes('credential-ref:'), false, 'health still returns no credential reference');
  assert.equal(leaks(JSON.stringify(health)), false);
  assert.ok(custody.calls.some((call) => call.op === 'status' && call.context.purpose === 'health'));

  // A resolver-only host keeps the 0.7 health shape.
  const legacy = await services({ credentials: new TestCredentials() });
  const legacyHealth = await legacy.app.health({ tenantId: 'tenant-a' });
  assert.equal('missingMaterial' in legacyHealth.services.configuration.counts, false);
  assert.equal(legacyHealth.services.configuration.bindings, undefined);
  assert.equal('missingCredentialMaterial' in legacyHealth.attention, false);
});

test('the management Secrets page: POST a value through the router, then GET shows it set and never the value', async () => {
  const { app, custody } = await services();
  const { server, base } = await management(app);
  try {
    const page = await fetch(`${base}/secrets`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /"page":"secrets"/);
    assert.match(html, /type: 'password'/, 'the value field is a password input');
    assert.match(html, /\/credentials/, 'the page posts to the credential.store route');

    const headers = { 'content-type': 'application/json' };
    const posted = await fetch(`${base}/v1/configuration/credentials`, { method: 'POST', headers, body: JSON.stringify({ ref: REF, value: VALUE, name: 'ANTHROPIC_API_KEY', provider: 'anthropic' }) });
    assert.equal(posted.status, 201);
    const postedText = await posted.text();
    assert.equal(leaks(postedText), false);
    const body = JSON.parse(postedText) as CredentialStoreResult;
    assert.equal(body.version, 1);
    assert.equal(body.binding?.name, 'ANTHROPIC_API_KEY');
    assert.equal(custody.peek('tenant-a', 'anthropic'), VALUE);

    const statusResponse = await fetch(`${base}/v1/configuration/credentials/status?ref=${encodeURIComponent(REF)}&ref=${encodeURIComponent('credential-ref:unset')}`);
    assert.equal(statusResponse.status, 200);
    const statusText = await statusResponse.text();
    assert.equal(leaks(statusText), false);
    assert.deepEqual((JSON.parse(statusText) as CredentialStatusView[]).map((entry) => [entry.ref, entry.state]), [[REF, 'set'], ['credential-ref:unset', 'missing']]);

    for (const path of ['/v1/configuration', '/secrets', '/configuration', '/v1/ui']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(leaks(await response.text()), false, `${path} does not contain the value`);
    }

    // Refusals through the router never echo the value either.
    const asReference = await fetch(`${base}/v1/configuration/credentials`, { method: 'POST', headers, body: JSON.stringify({ ref: VALUE, value: VALUE }) });
    assert.equal(asReference.status, 400);
    assert.equal(leaks(await asReference.text()), false);
    const empty = await fetch(`${base}/v1/configuration/credentials`, { method: 'POST', headers, body: JSON.stringify({ ref: REF, value: '' }) });
    assert.equal(empty.status, 400);
    // A body that is not JSON (the value left unquoted): the parser's own message quotes the body.
    const malformed = await fetch(`${base}/v1/configuration/credentials`, { method: 'POST', headers, body: `{"ref":"${REF}","value": ${VALUE}}` });
    assert.equal(malformed.status, 400);
    assert.equal(leaks(await malformed.text()), false);
  } finally {
    await close(server);
  }

  // Read-only custody through the router: 409 with the actionable message.
  const readOnly = await services({ credentials: new TestCredentials() });
  const host = await management(readOnly.app);
  try {
    const refused = await fetch(`${host.base}/v1/configuration/credentials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: REF, value: VALUE }) });
    assert.equal(refused.status, 409);
    const text = await refused.text();
    assert.equal(leaks(text), false);
    assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, 'CUSTODY_READ_ONLY');
  } finally {
    await close(host.server);
  }
});

test('the value appears nowhere: no FeltDB row or file, evidence, audit event, error, export, log line, or management response', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-custody-scan-'));
  const authorizer = await authority({ alice: ALL });
  const custody = new MemoryCustody();
  const app = createServices({ mode: 'local', path, namespace: 'custody-scan', application: 'custody-app', authorizer, credentials: custody });
  const seen: string[] = [];
  const keep = (value: unknown) => { seen.push(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)); return value; };
  const keepError = (error: unknown) => { seen.push(error instanceof Error ? `${error.name} ${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}` : String(error)); return true; };

  const { output } = await captureOutput(async () => {
    // Every path that touches the value: success, rotation, binding, failures, refusals.
    keep(await store(app, { ref: REF, value: VALUE, provider: 'anthropic', kind: 'api_key', name: 'ANTHROPIC_API_KEY' }));
    keep(await store(app, { ref: REF, value: `${VALUE}-rotated`, name: 'ANTHROPIC_API_KEY' }));
    keep(await store(app, { ref: 'credential-ref:staging', value: VALUE, name: 'ANTHROPIC_API_KEY', environment: 'staging' }));
    await store(app, { ref: REF, value: VALUE }, mallory).catch(keepError);
    await store(app, { ref: VALUE, value: VALUE }).catch(keepError);
    await store(app, { ref: REF, value: 'credential-ref:x' }).catch(keepError);
    custody.failStore = (value) => new Error(`host failed for ${value}`);
    await store(app, { ref: REF, value: VALUE }).catch(keepError);
    custody.failStore = undefined;
    custody.hostManaged.add('env-only');
    await store(app, { ref: 'credential-ref:env-only', value: VALUE }).catch(keepError);

    keep(await status(app, { refs: [REF, 'credential-ref:staging', 'credential-ref:env-only'] }));
    keep(await app.invoke('configuration.read', { environment: 'production' }, { principal: who(app, alice) }));
    keep(await app.health({ tenantId: 'tenant-a' }));
    keep(await app.health());
    for (const environment of ['production', 'staging'] as const) keep(await app.configuration.export({ principal: who(app, alice), environment }));

    const { server, base } = await management(app);
    try {
      const headers = { 'content-type': 'application/json' };
      for (const body of [
        JSON.stringify({ ref: 'credential-ref:router', value: VALUE, name: 'ROUTER_KEY' }),
        JSON.stringify({ ref: VALUE, value: VALUE }),
        `{"ref":"${REF}","value": ${VALUE}}`,
      ]) keep(await (await fetch(`${base}/v1/configuration/credentials`, { method: 'POST', headers, body })).text());
      for (const route of ['/secrets', '/configuration', '/intelligence', '/services', '/v1/configuration', `/v1/configuration/credentials/status?ref=${encodeURIComponent(REF)}`, '/v1/ui']) {
        keep(await (await fetch(`${base}${route}`)).text());
      }
    } finally {
      await close(server);
    }
  });

  // The host custody holds the material; nothing else does.
  assert.equal(custody.peek('tenant-a', 'anthropic'), `${VALUE}-rotated`);
  assert.equal(custody.peek('tenant-a', 'router'), VALUE);

  const evidence = await app.db.collection('service_effect_evidence').list();
  const audits = await Promise.all(['SecretAuditEvents', 'ConfigurationAuditEvents', 'SecretVersions', 'Secrets', 'ConfigurationSecrets'].map((name) => app.db.collection(name).list()));
  const durable = await durableText(app);
  assert.ok(durable.includes(REF), 'the scan sees the reference, so it would see the value');
  assert.ok(evidence.length > 10 && audits.every((rows) => rows.length > 0));
  assert.equal(leaks(durable), false, 'no FeltDB operation, row, or audit event contains the value');
  assert.equal(leaks(JSON.stringify(evidence)), false, 'no evidence contains the value');
  assert.equal(leaks(JSON.stringify(audits)), false, 'no audit event or version row contains the value');
  assert.equal(leaks(seen.join('\n')), false, 'no result, error, export, health report, or management response contains the value');
  assert.equal(leaks(output), false, 'nothing logged contains the value');
  assert.equal(leaks(JSON.stringify(authorizer.requests)), false, 'AuthBoundry never sees the value');
  assert.equal(leaks(JSON.stringify(custody.calls)), false, 'custody metadata calls carry only the reference');
  await app.apiKeys.close?.();

  // The durable files on disk, byte for byte.
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(path);
  assert.ok(files.length > 0);
  let sawReference = false;
  for (const file of files) {
    const bytes = await readFile(file);
    assert.equal(leaks(bytes.toString('latin1')), false, `${file} does not contain the value`);
    sawReference ||= bytes.includes(REF);
  }
  assert.ok(sawReference, 'the files hold the reference, so the scan reads the right state');
});
