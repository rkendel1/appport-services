import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { appport, CapabilityNotDeclaredError, createCapabilityPlan, parseAppPortConfig } from '../src/index.js';

test('appport contract initializes only declared capabilities', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-runtime-api-'));
  const config = join(path, 'appport.toml');
  await writeFile(config, 'use api\n');

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
