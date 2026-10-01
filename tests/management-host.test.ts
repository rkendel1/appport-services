import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { validateUiContribution } from '@appport/protocol';

import {
  DEFAULT_MANAGEMENT_HOST,
  DEFAULT_MANAGEMENT_PORT,
  createServices,
  parseAppPortConfig,
  startManagementHost,
  UI_DISCOVERY_PATH,
  type ManagementHostRuntime,
} from '../src/index.js';
import { runCli } from '../src/cli.js';
import { TestAuthority, principal } from './support/authority.js';

const quiet = () => new Writable({ write(_chunk, _encoding, callback) { callback(); } });

/** A real deployment: `appport init`, then an ephemeral port and host-owned lifecycle. */
async function deployment(): Promise<{ cwd: string; namespace: string; application: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'appport-host-'));
  const io = { stdout: quiet(), stderr: quiet() };
  assert.equal(await runCli(['init'], io, undefined, cwd), 0, 'init must succeed');
  const path = join(cwd, 'appport.toml');
  await writeFile(path, (await readFile(path, 'utf8'))
    .replace('port = 4100', 'port = 0')
    .replace('[lifecycle]\nmanaged = true', '[lifecycle]\nmanaged = false'));
  const config = parseAppPortConfig(path);
  assert.equal(config.deployment.storage, 'durable');
  return { cwd, namespace: config.state.namespace, application: config.application.name };
}

async function serve(cwd: string, authority: TestAuthority, port = 0): Promise<ManagementHostRuntime> {
  return startManagementHost({ cwd, port, env: {}, authorizer: authority, installSignalHandlers: false, logger: () => {} });
}

test('the standalone host serves /v1/ui with a protocol-valid contribution, derived from the router', async () => {
  const { cwd, application } = await deployment();
  const host = await serve(cwd, new TestAuthority({ allowAll: true }));
  try {
    assert.equal(host.application, application);
    assert.ok(host.port > 0, 'an ephemeral port must be reported');

    const response = await fetch(`${host.url}${UI_DISCOVERY_PATH}`);
    assert.equal(response.status, 200);
    // Discovery is public metadata and must not be cached.
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const document = validateUiContribution(await response.json());
    assert.equal(document.protocol, 'AppPort/ui/1');
    assert.equal(document.product.id, 'appport-services');
    // The served document is the protocol's caller-filtered view: a caller
    // holding no asserted capabilities sees only the capability-free overview.
    assert.deepEqual(document.surfaces.map((surface) => surface.id), ['overview']);

    // The host's routes come from the full contribution, never a hard-coded list.
    assert.ok(host.routes.includes('/services'));
    assert.ok(host.routes.includes('/api-keys'));
    for (const route of host.routes) {
      assert.ok(
        host.contribution.surfaces.some((surface) => surface.route === route),
        `${route} must be part of the contribution`,
      );
    }
    // Every route the contribution advertises is actually mounted. The
    // capability-free pages answer anonymously; the packaged API-key page is the
    // one surface that requires an identity, because it drives all three
    // API-key capabilities (see docs/management.md).
    for (const route of host.routes) {
      const page = await fetch(`${host.url}${route}`);
      assert.equal(page.status === 401, route === '/api-keys', `${route} authentication expectation`);
    }
  } finally {
    await host.close();
  }
});

test('the standalone host enforces its own authentication boundary', async () => {
  const { cwd, namespace, application } = await deployment();
  const authority = new TestAuthority({ allowAll: true });
  const host = await serve(cwd, authority);
  const admin = createServices({ mode: 'local', namespace, path: join(cwd, '.appport/state'), application, authorizer: authority });
  try {
    const created = await admin.apiKeys.createApiKey({ name: 'operator', tenantId: 'tenant-a' }, principal({ principalId: 'ops-1', tenantId: 'tenant-a' }));

    // No credential at all.
    assert.equal((await fetch(`${host.url}/_appport/api/keys`)).status, 401);
    // An invalid AppPort credential.
    assert.equal((await fetch(`${host.url}/_appport/api/keys`, { headers: { authorization: 'Bearer app_live_not_a_real_key' } })).status, 401);
    // A real secret without the Bearer scheme is not a credential.
    assert.equal((await fetch(`${host.url}/_appport/api/keys`, { headers: { authorization: created.secret } })).status, 401);
    // A valid AppPort API key is the host's own identity.
    const authorized = await fetch(`${host.url}/_appport/api/keys`, { headers: { authorization: `Bearer ${created.secret}` } });
    assert.equal(authorized.status, 200);
    // The packaged API-key page opens for that identity and stays closed otherwise.
    assert.equal((await fetch(`${host.url}/api-keys`, { headers: { authorization: `Bearer ${created.secret}` } })).status, 200);
    assert.equal((await fetch(`${host.url}/api-keys`)).status, 401);

    // Revoking the credential closes the boundary again.
    await admin.apiKeys.revokeApiKey({ tenantId: 'tenant-a', id: created.id }, principal({ principalId: 'ops-1', tenantId: 'tenant-a' }));
    assert.equal((await fetch(`${host.url}/_appport/api/keys`, { headers: { authorization: `Bearer ${created.secret}` } })).status, 401);
  } finally {
    await admin.apiKeys.close();
    await host.close();
  }
});

test('the standalone host needs no external control-plane credential and never weakens the boundary', async () => {
  const { cwd } = await deployment();
  // No authorizer, no identity adapter, no operator token anywhere.
  const host = await startManagementHost({ cwd, port: 0, env: {}, installSignalHandlers: false, logger: () => {} });
  try {
    // Discovery and the packaged pages are reachable with nothing configured.
    assert.equal((await fetch(`${host.url}${UI_DISCOVERY_PATH}`)).status, 200);
    assert.equal((await fetch(`${host.url}/services`)).status, 200);
    // Management operations fail closed rather than being weakened.
    assert.equal((await fetch(`${host.url}/_appport/api/keys`)).status, 401);
  } finally {
    await host.close();
  }
});

test('the standalone host owns durable state that survives a restart', async () => {
  const { cwd, namespace, application } = await deployment();
  const authority = new TestAuthority({ allowAll: true });
  const first = await serve(cwd, authority);
  const admin = createServices({ mode: 'local', namespace, path: join(cwd, '.appport/state'), application, authorizer: authority });
  const created = await admin.apiKeys.createApiKey({ name: 'operator', tenantId: 'tenant-a' }, principal({ principalId: 'ops-1', tenantId: 'tenant-a' }));
  await admin.apiKeys.close();
  await first.close();

  // A brand new process reading the same deployment still knows the credential.
  const second = await serve(cwd, authority);
  try {
    const response = await fetch(`${second.url}/_appport/api/keys`, { headers: { authorization: `Bearer ${created.secret}` } });
    assert.equal(response.status, 200);
    const listed = await response.json() as Array<{ id: string }>;
    assert.equal(listed.find((key) => key.id === created.id)?.id, created.id);
  } finally {
    await second.close();
  }
});

test('a port collision fails with an actionable message rather than a raw EADDRINUSE', async () => {
  const { cwd } = await deployment();
  const authority = new TestAuthority({ allowAll: true });
  const first = await serve(cwd, authority);
  try {
    await assert.rejects(() => serve(cwd, authority, first.port), /already in use.*--port/s);
  } finally {
    await first.close();
  }
});

test('closing the host is idempotent and releases the port', async () => {
  const { cwd } = await deployment();
  const authority = new TestAuthority({ allowAll: true });
  const first = await serve(cwd, authority);
  const { port } = first;
  await first.close();
  await first.close();
  // The port is free again, so a replacement host can take it.
  await (await serve(cwd, authority, port)).close();
});

test('the documented defaults are loopback and never the Compute control-plane port', () => {
  assert.equal(DEFAULT_MANAGEMENT_HOST, '127.0.0.1');
  assert.equal(DEFAULT_MANAGEMENT_PORT, 4100);
  assert.notEqual(DEFAULT_MANAGEMENT_PORT, 8787);
});

test('the serve command is discoverable and every existing command is still offered', async () => {
  let text = '';
  const stderr = new Writable({
    write(chunk, _encoding, callback) { text += String(chunk); callback(); },
  }) as unknown as NodeJS.WritableStream;
  assert.equal(await runCli(['nonsense'], { stdout: quiet(), stderr }), 1);
  for (const command of ['init', 'serve', 'config migrate', 'api-key', 'webhook', 'job']) {
    assert.ok(text.includes(command), `usage must still document ${command}`);
  }
});

