import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { appport, parseAppPortConfigText } from '../src/index.js';
import { runCli } from '../src/cli.js';

/** Compute's control plane defaults to this port (`compute`, `compute start`). */
const COMPUTE_CONTROL_PLANE_PORT = 8787;

async function init(): Promise<{ path: string; text: string }> {
  const path = await mkdtemp(join(tmpdir(), 'appport-boundaries-'));
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  await runCli(['init', '--use', 'api,jobs,webhooks'], { stdout: sink, stderr: sink }, undefined, path);
  return { path, text: await readFile(join(path, 'appport.toml'), 'utf8') };
}

// `appport()` is an application runtime, not a management application. It serves
// the application's routes and the `/_appport/*` JSON contract; the packaged
// management pages and the AppPort/ui/1 contribution are served only by a host
// that mounts `createManagementRouter` — either an embedded application host or
// `appport-services serve` (see docs/management.md). This is intentional:
// mounting the pages in every application runtime would turn every AppPort
// application into a management application and expose pages that Bearer-only
// standalone mode cannot authenticate.
test('the standalone runtime serves the service API and no management pages or UI contribution', async () => {
  const { path, text } = await init();
  const config = join(path, 'appport.toml');
  await writeFile(config, text.replace('port = 4100', 'port = 0').replace('[authorization]\nenabled = true', '[authorization]\nenabled = false'));
  const application = await appport({ config, path: join(path, '.state'), memory: true });
  try {
    const base = application.http!.url;
    assert.equal((await fetch(`${base}/_appport/health`)).status, 200);
    for (const route of ['/services', '/api-keys', '/jobs', '/webhooks', '/configuration']) {
      const response = await fetch(`${base}${route}`);
      assert.notEqual(response.headers.get('content-type')?.split(';')[0], 'text/html', `${route} served a page`);
    }
    const discovery = await fetch(`${base}/v1/ui`);
    assert.notEqual(discovery.status, 200);
    assert.doesNotMatch(await discovery.text(), /AppPort\/ui\/1/);
  } finally { await application.close(); }
});

// There are two defaults and they are different on purpose. A *generated*
// application states its port explicitly (4100) so it never collides with the
// Compute control plane. The *parser* default for an `appport.toml` that enables
// HTTP but omits the port stays 8787: changing it would silently move every
// existing application that relies on it.
test('a generated application states a port that is not the Compute control plane\'s', async () => {
  const { text } = await init();
  const generated = parseAppPortConfigText(text);
  assert.equal(generated.http.port, 4100);
  assert.notEqual(generated.http.port, COMPUTE_CONTROL_PLANE_PORT);
  assert.match(text, /^port = 4100$/m);
});

test('the parser default for an omitted port is the documented legacy value', () => {
  const omitted = parseAppPortConfigText('version = "1"\n[application]\nname = "x"\n[http]\nenabled = true\n');
  assert.equal(omitted.http.port, COMPUTE_CONTROL_PLANE_PORT);
  assert.equal(parseAppPortConfigText('version = "1"\n[application]\nname = "x"\n[http]\nenabled = true\nport = 4100\n').http.port, 4100);
});

// `@appport/services` is built and tested against the *published*
// `@appport/protocol`. If the installed one stops providing what the UI
// contribution needs, fail here rather than after publishing.
test('the installed @appport/protocol satisfies the declared range and provides the UI contract', async () => {
  const declared = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).dependencies['@appport/protocol'] as string;
  const installed = JSON.parse(await readFile(new URL('../../node_modules/@appport/protocol/package.json', import.meta.url), 'utf8')).version as string;
  const parse = (version: string) => version.replace(/^[^\d]*/, '').split('.').map(Number);
  const [floorMajor, floorMinor, floorPatch] = parse(declared);
  const [major, minor, patch] = parse(installed);
  assert.equal(major, floorMajor, `${installed} is not in ${declared}`);
  assert.ok(minor > floorMinor! || (minor === floorMinor && patch! >= floorPatch!), `${installed} is below ${declared}`);
  const protocol = await import('@appport/protocol');
  assert.equal(protocol.UI_PROTOCOL_ID, 'AppPort/ui/1');
  assert.equal(protocol.UI_DISCOVERY_PATH, '/v1/ui');
  assert.equal(typeof protocol.validateUiContribution, 'function');
  assert.equal(typeof protocol.filterUiContribution, 'function');
});
