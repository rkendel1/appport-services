import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatFlowSpec, parseFlowSpec } from '@feltdb/core';

import { appport, CapabilityNotDeclaredError, createCapabilityPlan, parseAppPortConfig } from '../src/index.js';

async function writeApiFlow(path: string): Promise<void> {
  const template = await readFile(new URL('../../appport.flow', import.meta.url), 'utf8');
  const flow = parseFlowSpec(template);
  flow.collections = flow.collections.filter((collection) =>
    ['ApiKeys', 'ApiKeyPrefixes', 'ApiKeyAuditEvents'].includes(collection.name));
  await writeFile(join(path, 'feltdb.flow'), formatFlowSpec(flow));
}

test('appport contract initializes only declared capabilities', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-runtime-api-'));
  const config = join(path, 'appport.toml');
  await writeFile(config, 'use api\n');
  await writeApiFlow(path);

  const application = await appport({
    config,
    mode: 'local',
    namespace: 'runtime-api',
    path: join(path, '.feltdb'),
  });

  assert.deepEqual(application.plan.capabilities, ['api']);
  assert.ok(application.api.keys);
  assert.throws(() => application.webhooks, CapabilityNotDeclaredError);
  assert.throws(() => application.jobs, CapabilityNotDeclaredError);
  await application.close();
});

test('capability plan is deterministic regardless of declaration order', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-runtime-plan-'));
  const config = join(path, 'appport.toml');
  await writeFile(config, 'use jobs\nuse api\n');

  const plan = createCapabilityPlan(parseAppPortConfig(config));
  assert.deepEqual(plan.capabilities, ['api', 'jobs']);
});

test('use api block configures the API keys sub-capability', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-runtime-api-block-'));
  const config = join(path, 'appport.toml');
  await writeFile(config, 'use api {\n  keys = false\n}\n');
  await writeApiFlow(path);

  const application = await appport({
    config,
    mode: 'local',
    namespace: 'runtime-api-block',
    path: join(path, '.feltdb'),
  });

  assert.deepEqual(application.plan.capabilities, ['api']);
  assert.throws(() => application.api.keys, CapabilityNotDeclaredError);
  await application.close();
});

test('transaction helpers reject undeclared infrastructure', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-runtime-transaction-'));
  const config = join(path, 'appport.toml');
  await writeFile(config, 'use api\n');
  await writeApiFlow(path);
  const application = await appport({
    config,
    mode: 'local',
    namespace: 'runtime-transaction',
    path: join(path, '.feltdb'),
  });

  await assert.rejects(
    application.transaction(async (tx) => {
      tx.queueJob({ tenantId: 'tenant-a', type: 'hidden', payload: {} });
    }),
    CapabilityNotDeclaredError,
  );
  await application.close();
});

test('appport requires the authoritative feltdb.flow beside appport.toml', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-runtime-no-flow-'));
  const config = join(path, 'appport.toml');
  await writeFile(config, 'use api\n');

  await assert.rejects(appport({ config, memory: true }), /Cannot read authoritative feltdb\.flow/);
});

test('appport rejects disagreement between appport.toml and feltdb.flow', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-runtime-flow-mismatch-'));
  const config = join(path, 'appport.toml');
  await writeFile(config, 'use api\n');
  await writeFile(join(path, 'feltdb.flow'), 'flow_version 1\n\napp mismatch {}\n');

  await assert.rejects(appport({ config, memory: true }), /missing collections required by "use api"/);
});
