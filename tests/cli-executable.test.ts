import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

import { validateUiContribution } from '@appport/protocol';

// dist/tests/cli-executable.test.js -> repository root.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function npm(args: readonly string[], cwd: string): string {
  return execFileSync('npm', [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
}

/**
 * An unused loopback port. These tests are about *which* port the host binds,
 * so each one owns an isolated port instead of competing for the default.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePromise) => probe.listen(0, '127.0.0.1', () => resolvePromise()));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  return port;
}

const delay = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Everything the process writes, so a failure can show why it never came up. */
function collect(child: ChildProcess): () => string {
  let text = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => { text += chunk; });
  }
  return () => text;
}

/** Poll `GET /v1/ui` until the host answers: discovery is the readiness probe. */
async function waitForDiscovery(port: number, child: ChildProcess, log: () => string, timeoutMs = 60_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the host exited before it was ready (code ${child.exitCode}, signal ${child.signalCode})\n${log()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/ui`);
      if (response.status === 200) return response;
      lastError = `GET /v1/ui answered ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`the host never answered GET /v1/ui on port ${port}: ${lastError}\n${log()}`);
}

/** SIGTERM the host and wait for it to release the port. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(30_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
}

/** The installed executable's own result. Never throws on a non-zero exit. */
function run(command: string, args: readonly string[], cwd: string): { status: number | null; output: string } {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}
let consumer: string;
let bin: string;
let version: string;

/**
 * A deployment created by the installed executable itself, so these tests never
 * fall back to the workspace copy: `init` runs the same `.bin` shim a consumer
 * runs, which also proves the shim works for an ordinary command.
 */
async function deployment(name: string): Promise<string> {
  const cwd = join(consumer, 'deployments', name);
  await mkdir(cwd, { recursive: true });
  execFileSync(bin, ['init'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return cwd;
}

before(async () => {
  const staging = await mkdtemp(join(tmpdir(), 'appport-exec-'));
  const packDir = join(staging, 'tarball');
  consumer = join(staging, 'consumer');
  await mkdir(packDir);
  await mkdir(consumer);

  // Pack exactly what npm would publish (dist is built by `npm test` first).
  const packed = JSON.parse(npm(['pack', '--pack-destination', packDir, '--json'], repoRoot)) as Array<{ version: string; filename: string }>;
  assert.equal(packed.length, 1);
  version = packed[0]!.version;
  await writeFile(join(consumer, 'package.json'), `${JSON.stringify({ name: 'appport-services-executable', private: true, type: 'module' }, null, 2)}\n`);
  npm(['install', join(packDir, packed[0]!.filename), '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error'], consumer);

  // The advertised bin declaration produced a real executable.
  const installed = JSON.parse(await readFile(join(consumer, 'node_modules/@appport/services/package.json'), 'utf8')) as { bin?: Record<string, string> };
  assert.equal(installed.bin?.['appport-services'], 'dist/src/cli.js');
  bin = join(consumer, 'node_modules', '.bin', 'appport-services');
}, { timeout: 300_000 });

after(async () => {
  if (consumer) await rm(consumer, { recursive: true, force: true });
});
// npm executes the `bin` target through the generated symlink, so
// process.argv[1] is `node_modules/.bin/appport-services` while the module's own
// URL is the real `dist/src/cli.js`. Comparing those two literally meant the
// entrypoint check never matched an installed package.
test('node_modules/.bin/appport-services runs the CLI instead of exiting 0 with no output', { timeout: 120_000 }, async () => {
  const cwd = await deployment('unknown-command');
  const result = run(bin, ['bogus'], cwd);

  // The regression being fixed: exit 0, no output, CLI never executed.
  assert.ok(!(result.status === 0 && result.output.trim() === ''), 'must not exit 0 without executing the CLI');
  assert.notEqual(result.status, null, 'the executable must terminate rather than hang');
  assert.notEqual(result.status, 0, 'an unknown command must fail');
  assert.notEqual(result.output.trim(), '', 'the executable must produce output');
  assert.match(result.output, /Usage:/, 'the CLI must print its usage for an unknown command');
  for (const command of ['init', 'serve', 'config migrate', 'api-key', 'webhook', 'job']) {
    assert.ok(result.output.includes(command), `usage must still document ${command}`);
  }
});

// macOS resolves /tmp -> /private/tmp and version managers shim prefixes, so an
// installation prefix is routinely a symlink. Resolution must still match.
test('the executable runs through a symlinked installation prefix', { timeout: 120_000 }, async () => {
  const linked = join(consumer, 'linked-prefix');
  await symlink(consumer, linked, 'dir');
  const result = run(join(linked, 'node_modules', '.bin', 'appport-services'), ['bogus'], consumer);
  assert.equal(result.status, 1, 'the CLI must report an unknown command through a symlinked prefix');
  assert.match(result.output, /Usage:/);
});
test('serve --port binds the requested port and serves AppPort/ui/1', { timeout: 120_000 }, async () => {
  const cwd = await deployment('serve-port');
  const port = await freePort();
  const child = spawn(bin, ['serve', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = collect(child);
  try {
    const response = await waitForDiscovery(port, child, log);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type')?.split(';')[0], 'application/json');
    const document = validateUiContribution(await response.json());
    assert.equal(document.protocol, 'AppPort/ui/1');
    assert.equal(document.product.id, 'appport-services');
    assert.equal(document.product.version, version, 'the document reports the packed package version');
    assert.match(log(), new RegExp(`listening on http://127\\.0\\.0\\.1:${port}\\b`), '--port must select the bind port');
  } finally {
    await stop(child);
  }
});

test('serve --host --port applies both values', { timeout: 120_000 }, async () => {
  const cwd = await deployment('serve-host-port');
  const port = await freePort();
  const child = spawn(bin, ['serve', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = collect(child);
  try {
    const response = await waitForDiscovery(port, child, log);
    assert.equal(response.status, 200);
    assert.equal(validateUiContribution(await response.json()).protocol, 'AppPort/ui/1');
    assert.match(log(), new RegExp(`listening on http://127\\.0\\.0\\.1:${port}\\b`), 'both --host and --port must be applied');
  } finally {
    await stop(child);
  }
});

// Precedence is CLI -> appport.toml [http] -> package defaults. A bare `serve`
// must still honour the contract, and an explicit flag must override it.
test('a bare serve honours appport.toml, and an explicit --port overrides it', { timeout: 180_000 }, async () => {
  const cwd = await deployment('serve-config');
  const configured = await freePort();
  const overridden = await freePort();
  const config = join(cwd, 'appport.toml');
  await writeFile(config, (await readFile(config, 'utf8')).replace('port = 4100', `port = ${configured}`));

  const fromConfig = spawn(bin, ['serve'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const configLog = collect(fromConfig);
  try {
    const response = await waitForDiscovery(configured, fromConfig, configLog);
    assert.equal(response.status, 200, 'a bare serve must answer on the configured port');
    assert.equal(validateUiContribution(await response.json()).protocol, 'AppPort/ui/1');
  } finally {
    await stop(fromConfig);
  }

  const fromFlag = spawn(bin, ['serve', '--port', String(overridden)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const flagLog = collect(fromFlag);
  try {
    const response = await waitForDiscovery(overridden, fromFlag, flagLog);
    assert.equal(response.status, 200, '--port must override appport.toml');
    assert.equal(validateUiContribution(await response.json()).protocol, 'AppPort/ui/1');
  } finally {
    await stop(fromFlag);
  }
});

// The host owns its lifecycle: it starts, stays up while serving, and stops
// cleanly on SIGTERM. No new lifecycle abstraction is introduced.
test('the executable runs the host through start, discovery, and SIGTERM', { timeout: 120_000 }, async () => {
  const cwd = await deployment('serve-lifecycle');
  const port = await freePort();
  const child = spawn(bin, ['serve', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = collect(child);
  await waitForDiscovery(port, child, log);

  // Still serving. Discovery is public; management operations are not, and the
  // boundary must not be weakened to make an endpoint usable as a probe.
  const discovery = await fetch(`http://127.0.0.1:${port}/v1/ui`);
  assert.equal(discovery.status, 200);
  assert.equal(discovery.headers.get('content-type')?.split(';')[0], 'application/json');
  assert.equal((await fetch(`http://127.0.0.1:${port}/services`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/_appport/api/keys`)).status, 401);
  assert.equal(child.exitCode, null, 'the host must remain alive while serving');

  const exited = new Promise<number | null>((resolvePromise) => child.once('exit', (code) => resolvePromise(code)));
  child.kill('SIGTERM');
  const code = await Promise.race([exited, delay(30_000).then(() => 'timeout' as const)]);
  assert.notEqual(code, 'timeout', 'SIGTERM must terminate the host');
  assert.match(log(), /received SIGTERM/, 'the host must log its own shutdown');
});


