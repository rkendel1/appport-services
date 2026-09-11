import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';

import { runCli } from '../src/cli.js';

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
  assert.equal(
    await readFile(join(cwd, 'appport.toml'), 'utf8'),
    '# AppPort Services capabilities used by this application\n\nuse api\nuse webhooks\nuse jobs\n',
  );
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
  assert.equal(
    await readFile(join(cwd, 'appport.toml'), 'utf8'),
    '# AppPort Services capabilities used by this application\n\nuse api\nuse jobs\n',
  );
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
});
