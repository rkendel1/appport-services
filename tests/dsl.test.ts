import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import test from 'node:test';

import { parseAppPortConfig } from '../src/runtime/dsl.js';
import { createServices } from '../src/index.js';

test('DSL: parse minimal configuration', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsl-test-'));

  const config = `api = true
webhooks = true
jobs = true
`;
  const configPath = join(tempDir, 'appport.toml');
  writeFileSync(configPath, config);

  const parsed = parseAppPortConfig(configPath);
  assert.equal(parsed.capabilities.api, true);
  assert.equal(parsed.capabilities.webhooks, true);
  assert.equal(parsed.capabilities.jobs, true);
});

test('DSL: parse with webhook events configuration', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsl-test-'));

  const config = `api = true
jobs = true

[webhooks]
events = ["invoice.created", "invoice.paid"]
`;
  const configPath = join(tempDir, 'appport.toml');
  writeFileSync(configPath, config);

  const parsed = parseAppPortConfig(configPath);
  assert.equal(parsed.capabilities.webhooks, true);
  assert.deepEqual(parsed.webhooks?.events, ['invoice.created', 'invoice.paid']);
});

test('DSL: parse with jobs max_attempts configuration', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsl-test-'));

  const config = `api = true

[jobs]
max_attempts = 5
`;
  const configPath = join(tempDir, 'appport.toml');
  writeFileSync(configPath, config);

  const parsed = parseAppPortConfig(configPath);
  assert.equal(parsed.capabilities.jobs, true);
  assert.equal(parsed.jobs?.max_attempts, 5);
});

test('DSL: selective capability enablement', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsl-test-'));

  const config = `api = true
`;
  const configPath = join(tempDir, 'appport.toml');
  writeFileSync(configPath, config);

  const parsed = parseAppPortConfig(configPath);
  assert.equal(parsed.capabilities.api, true);
  assert.equal(parsed.capabilities.webhooks, false);
  assert.equal(parsed.capabilities.jobs, false);
});

test('DSL: section enables capability without flag', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsl-test-'));

  const config = `api = true

[jobs]
max_attempts = 3
`;
  const configPath = join(tempDir, 'appport.toml');
  writeFileSync(configPath, config);

  const parsed = parseAppPortConfig(configPath);
  assert.equal(parsed.capabilities.api, true);
  assert.equal(parsed.capabilities.jobs, true, 'jobs enabled by section presence');
  assert.equal(parsed.jobs?.max_attempts, 3);
});

test('DSL: invalid syntax fails clearly', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsl-test-'));

  const config = `api = true
invalid toml [[[
`;
  const configPath = join(tempDir, 'appport.toml');
  writeFileSync(configPath, config);

  assert.throws(
    () => parseAppPortConfig(configPath),
    /Invalid TOML syntax/,
  );
});

test('DSL: unknown capability fails', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsl-test-'));

  const config = `api = true
unknown_thing = true
`;
  const configPath = join(tempDir, 'appport.toml');
  writeFileSync(configPath, config);

  assert.throws(
    () => parseAppPortConfig(configPath),
    /Unknown configuration/,
  );
});

test('DSL: invalid webhook events type fails', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsl-test-'));

  const config = `[webhooks]
events = "not-an-array"
`;
  const configPath = join(tempDir, 'appport.toml');
  writeFileSync(configPath, config);

  assert.throws(
    () => parseAppPortConfig(configPath),
    /webhooks.events must be an array/,
  );
});

test('DSL: invalid jobs max_attempts type fails', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsl-test-'));

  const config = `[jobs]
max_attempts = "five"
`;
  const configPath = join(tempDir, 'appport.toml');
  writeFileSync(configPath, config);

  assert.throws(
    () => parseAppPortConfig(configPath),
    /jobs.max_attempts must be a number/,
  );
});

test('DSL: invalid jobs max_attempts value fails', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsl-test-'));

  const config = `[jobs]
max_attempts = 0
`;
  const configPath = join(tempDir, 'appport.toml');
  writeFileSync(configPath, config);

  assert.throws(
    () => parseAppPortConfig(configPath),
    /jobs.max_attempts must be a positive integer/,
  );
});

test('DSL: missing config file fails clearly', () => {
  const configPath = '/nonexistent/appport.toml';

  assert.throws(
    () => parseAppPortConfig(configPath),
    /Cannot read appport.toml/,
  );
});

test('DSL: createServices accepts config option', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dsl-services-test-'));
  const configPath = join(path, 'appport.toml');

  const config = `api = true
webhooks = true
jobs = true
`;
  writeFileSync(configPath, config);

  const services = createServices({
    mode: 'local',
    namespace: 'dsl-test',
    path: join(path, '.feltdb'),
    config: configPath,
  });

  // Verify services are created
  assert.ok(services.apiKeys);
  assert.ok(services.webhooks);
  assert.ok(services.jobs);
});

test('DSL: programmatic API unchanged', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dsl-compat-test-'));

  // Test that createServices still works without config
  const services = createServices({
    mode: 'local',
    namespace: 'dsl-compat-test',
    path: join(path, '.feltdb'),
  });

  assert.ok(services.apiKeys);
  assert.ok(services.webhooks);
  assert.ok(services.jobs);
  assert.ok(services.transaction);
});

test('DSL: atomic transaction works with DSL-configured services', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dsl-transaction-test-'));
  const configPath = join(path, 'appport.toml');

  const config = `api = true
webhooks = true
jobs = true
`;
  writeFileSync(configPath, config);

  const services = createServices({
    mode: 'local',
    namespace: 'dsl-transaction-test',
    path: join(path, '.feltdb'),
    config: configPath,
  });

  const tenantId = 'test-tenant';

  // Pre-create webhook endpoint
  await services.webhooks.createWebhookEndpoint({
    tenantId,
    url: 'https://example.com/webhook',
    events: ['test.event'],
    createdBy: 'test',
  });

  // Transaction should work
  let transactionExecuted = false;
  await services.transaction(async (tx) => {
    const endpoints = await services.webhooks.listWebhookEndpoints(tenantId);
    tx.queueWebhookDeliveries(
      endpoints.map((e) => e.id),
      {
        tenantId,
        type: 'test.event',
        payload: { test: true },
      },
    );
    transactionExecuted = true;
  });

  assert.equal(transactionExecuted, true, 'transaction callback executed');

  // Verify webhook delivery was queued
  const deliveries = await services.webhooks.listWebhookDeliveries(tenantId);
  assert.equal(deliveries.length, 1, 'webhook delivery created in transaction');
});
