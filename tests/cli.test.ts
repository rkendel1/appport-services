import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';

import { parseFlowSpec } from '@feltdb/core';

import { runCli } from '../src/cli.js';
import { parseAppPortConfig } from '../src/runtime/dsl.js';
import { appport } from '../src/runtime/appport.js';

function capture(): { stream: Writable; output: () => string } {
  let value = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    output: () => value,
  };
}

test('init creates appport.toml with all capabilities by default', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'appport-init-'));
  const stdout = capture();
  const stderr = capture();

  const code = await runCli(['init'], { stdout: stdout.stream, stderr: stderr.stream }, undefined, cwd);

  assert.equal(code, 0);
  const contract = parseAppPortConfig(join(cwd, 'appport.toml'));
  assert.deepEqual(contract.capabilities, { api: true, webhooks: true, jobs: true });
  assert.equal(contract.application.name, cwd.split('/').at(-1)?.toLowerCase());
  assert.equal(contract.http.enabled, true);
  assert.equal(contract.events.streaming.enabled, true);
  const flow = parseFlowSpec(await readFile(join(cwd, 'feltdb.flow'), 'utf8'));
  assert.deepEqual(flow.collections.map((collection) => collection.name), [
    'ApiKeys', 'ApiKeyPrefixes', 'ApiKeyAuditEvents',
    'WebhookEndpoints', 'WebhookDeliveries', 'WebhookAuditEvents',
    'Jobs', 'JobSchedules', 'JobAuditEvents',
  ]);
  assert.match(stdout.output(), /Enabled: api, webhooks, jobs/);
  assert.equal(stderr.output(), '');
});

test('init --use creates only selected capabilities in canonical order', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'appport-init-use-'));
  const stdout = capture();
  const stderr = capture();

  const code = await runCli(
    ['init', '--use', 'jobs,api'],
    { stdout: stdout.stream, stderr: stderr.stream },
    undefined,
    cwd,
  );

  assert.equal(code, 0);
  assert.deepEqual(parseAppPortConfig(join(cwd, 'appport.toml')).capabilities, { api: true, webhooks: false, jobs: true });
  const flow = parseFlowSpec(await readFile(join(cwd, 'feltdb.flow'), 'utf8'));
  assert.deepEqual(flow.collections.map((collection) => collection.name), [
    'ApiKeys', 'ApiKeyPrefixes', 'ApiKeyAuditEvents',
    'Jobs', 'JobSchedules', 'JobAuditEvents',
  ]);
});

test('interactive init configures capabilities without requiring flags', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'appport-init-interactive-'));
  const stdout = capture();
  const stderr = capture();
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean };
  stdin.isTTY = true;
  setTimeout(() => stdin.write('y\n'), 5);
  setTimeout(() => stdin.write('n\n'), 10);
  setTimeout(() => stdin.write('y\n'), 15);

  const code = await runCli(
    ['init'],
    { stdin, stdout: stdout.stream, stderr: stderr.stream },
    undefined,
    cwd,
  );

  assert.equal(code, 0);
  assert.deepEqual(parseAppPortConfig(join(cwd, 'appport.toml')).capabilities, { api: true, webhooks: false, jobs: true });
  assert.match(stdout.output(), /Enable API keys/);
  assert.match(stdout.output(), /Enabled: api, jobs/);
});

test('init rejects unknown capabilities', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'appport-init-invalid-'));
  const stdout = capture();
  const stderr = capture();

  await assert.rejects(
    runCli(['init', '--use', 'api,queues'], { stdout: stdout.stream, stderr: stderr.stream }, undefined, cwd),
    /Unknown capability: queues/,
  );
});

test('init does not overwrite an existing appport.toml', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'appport-init-existing-'));
  const configPath = join(cwd, 'appport.toml');
  await writeFile(configPath, 'use api\n');
  const stdout = capture();
  const stderr = capture();

  await assert.rejects(
    runCli(['init'], { stdout: stdout.stream, stderr: stderr.stream }, undefined, cwd),
    /appport\.toml already exists/,
  );
  assert.equal(await readFile(configPath, 'utf8'), 'use api\n');
  await assert.rejects(readFile(join(cwd, 'feltdb.flow'), 'utf8'), /ENOENT/);
});

test('init does not partially write when feltdb.flow already exists', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'appport-init-existing-flow-'));
  const flowPath = join(cwd, 'feltdb.flow');
  await writeFile(flowPath, 'flow_version 1\n\napp existing {}\n');
  const stdout = capture();
  const stderr = capture();

  await assert.rejects(
    runCli(['init'], { stdout: stdout.stream, stderr: stderr.stream }, undefined, cwd),
    /feltdb\.flow already exists/,
  );
  await assert.rejects(readFile(join(cwd, 'appport.toml'), 'utf8'), /ENOENT/);
});

test('config migrate expands a legacy file and preserves a backup', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'appport-migrate-'));
  await writeFile(join(cwd, 'appport.toml'), 'use api\nuse jobs\n');
  const stdout = capture();
  const stderr = capture();

  assert.equal(await runCli(['config', 'migrate'], { stdout: stdout.stream, stderr: stderr.stream }, undefined, cwd), 0);
  assert.equal(await readFile(join(cwd, 'appport.toml.bak'), 'utf8'), 'use api\nuse jobs\n');
  const contract = parseAppPortConfig(join(cwd, 'appport.toml'));
  assert.equal(contract.http.enabled, true);
  assert.deepEqual(contract.capabilities, { api: true, webhooks: false, jobs: true });
});

test('operational CLI and runtime use the same contract-derived state', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'appport-cli-runtime-'));
  const stdout = capture(); const stderr = capture();
  await runCli(['init', '--use', 'api'], { stdout: stdout.stream, stderr: stderr.stream }, undefined, cwd);
  const configPath = join(cwd, 'appport.toml');
  await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('enabled = true\nhost = "127.0.0.1"', 'enabled = false\nhost = "127.0.0.1"'));
  const createdOut = capture();
  await runCli(['api-key', 'create', '--tenant', 'development', '--name', 'bootstrap', '--scope', 'example.read', '--created-by', 'init'], { stdout: createdOut.stream, stderr: stderr.stream }, undefined, cwd);
  const secret = /^secret: (.+)$/m.exec(createdOut.output())?.[1];
  assert.ok(secret);
  const application = await appport({ config: configPath });
  assert.equal((await application.api.keys.authenticateApiKey(secret))?.tenantId, 'development');
  await application.close();
});
