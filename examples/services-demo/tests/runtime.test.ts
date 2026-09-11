import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseAppPortConfig } from '@appport/runtime';

test('demo is business behavior backed by a complete contract', async () => {
  const source = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');
  for (const forbidden of ['node:http', 'runtime.db', 'createServer', '.listen(', 'process.on(', 'SIGINT', 'SIGTERM', 'text/event-stream', 'access-control-allow']) {
    assert.equal(source.includes(forbidden), false, `application source must not contain ${forbidden}`);
  }
  const contract = parseAppPortConfig(new URL('../appport.toml', import.meta.url).pathname);
  assert.equal(contract.http.enabled, true);
  assert.equal(contract.events.streaming.enabled, true);
  assert.equal(contract.lifecycle.managed, true);
  assert.deepEqual(Object.keys(contract.jobs.types), ['invoice.process']);
});
