import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parseFlowSpec, validateFlowSpec } from '@feltdb/core';

test('appport.flow exists and is valid', () => {
  const flowPath = join(process.cwd(), 'appport.flow');
  const flowContent = readFileSync(flowPath, 'utf-8');

  assert.ok(flowContent, 'appport.flow exists and has content');

  const spec = parseFlowSpec(flowContent);
  assert.ok(spec, 'Flow spec parses successfully');

  const diagnostics = validateFlowSpec(spec);
  const errors = diagnostics.filter((d) => d.severity === 'error');

  assert.equal(errors.length, 0, `Flow spec should have no errors, got: ${errors.map((e) => e.message).join(', ')}`);
});

test('appport.flow has correct app name', () => {
  const flowPath = join(process.cwd(), 'appport.flow');
  const flowContent = readFileSync(flowPath, 'utf-8');
  const spec = parseFlowSpec(flowContent);

  assert.equal(spec.app, 'appport-services');
});

test('appport.flow defines API Key collections', () => {
  const flowPath = join(process.cwd(), 'appport.flow');
  const flowContent = readFileSync(flowPath, 'utf-8');
  const spec = parseFlowSpec(flowContent);

  const collectionNames = spec.collections.map((c) => c.name);

  assert.ok(collectionNames.includes('ApiKeys'), 'ApiKeys collection defined');
  assert.ok(collectionNames.includes('ApiKeyPrefixes'), 'ApiKeyPrefixes collection defined');
  assert.ok(collectionNames.includes('ApiKeyAuditEvents'), 'ApiKeyAuditEvents collection defined');

  // Verify ApiKeys fields
  const apiKeysCollection = spec.collections.find((c) => c.name === 'ApiKeys');
  assert.ok(apiKeysCollection);
  const fieldNames = apiKeysCollection!.fields.map((f) => f.name);

  assert.ok(fieldNames.includes('id'));
  assert.ok(fieldNames.includes('tenant_id'));
  assert.ok(fieldNames.includes('name'));
  assert.ok(fieldNames.includes('key_prefix'));
  assert.ok(fieldNames.includes('secret_hash'));
  assert.ok(fieldNames.includes('scopes'));
  assert.ok(fieldNames.includes('created_at'));
  assert.ok(fieldNames.includes('revoked_at'));
});

test('appport.flow defines Webhook collections', () => {
  const flowPath = join(process.cwd(), 'appport.flow');
  const flowContent = readFileSync(flowPath, 'utf-8');
  const spec = parseFlowSpec(flowContent);

  const collectionNames = spec.collections.map((c) => c.name);

  assert.ok(collectionNames.includes('WebhookEndpoints'), 'WebhookEndpoints collection defined');
  assert.ok(collectionNames.includes('WebhookDeliveries'), 'WebhookDeliveries collection defined');
  assert.ok(collectionNames.includes('WebhookAuditEvents'), 'WebhookAuditEvents collection defined');

  // Verify WebhookEndpoints fields
  const endpointsCollection = spec.collections.find((c) => c.name === 'WebhookEndpoints');
  assert.ok(endpointsCollection);
  const fieldNames = endpointsCollection!.fields.map((f) => f.name);

  assert.ok(fieldNames.includes('id'));
  assert.ok(fieldNames.includes('tenant_id'));
  assert.ok(fieldNames.includes('url'));
  assert.ok(fieldNames.includes('events'));
  assert.ok(fieldNames.includes('disabled_at'));

  // Verify WebhookDeliveries fields
  const deliveryCollection = spec.collections.find((c) => c.name === 'WebhookDeliveries');
  assert.ok(deliveryCollection);
  const deliveryFieldNames = deliveryCollection!.fields.map((f) => f.name);

  assert.ok(deliveryFieldNames.includes('status'));
  assert.ok(deliveryFieldNames.includes('attempt_count'));
  assert.ok(deliveryFieldNames.includes('next_attempt_at'));
  assert.ok(deliveryFieldNames.includes('payload'));
});

test('appport.flow defines Job collections', () => {
  const flowPath = join(process.cwd(), 'appport.flow');
  const flowContent = readFileSync(flowPath, 'utf-8');
  const spec = parseFlowSpec(flowContent);

  const collectionNames = spec.collections.map((c) => c.name);

  assert.ok(collectionNames.includes('Jobs'), 'Jobs collection defined');
  assert.ok(collectionNames.includes('JobSchedules'), 'JobSchedules collection defined');
  assert.ok(collectionNames.includes('JobAuditEvents'), 'JobAuditEvents collection defined');

  // Verify Jobs fields
  const jobsCollection = spec.collections.find((c) => c.name === 'Jobs');
  assert.ok(jobsCollection);
  const fieldNames = jobsCollection!.fields.map((f) => f.name);

  assert.ok(fieldNames.includes('id'));
  assert.ok(fieldNames.includes('tenant_id'));
  assert.ok(fieldNames.includes('type'));
  assert.ok(fieldNames.includes('status'));
  assert.ok(fieldNames.includes('payload'));
  assert.ok(fieldNames.includes('attempt_count'));
  assert.ok(fieldNames.includes('lease_owner'));
  assert.ok(fieldNames.includes('lease_expires_at'));

  // Verify JobSchedules fields
  const scheduleCollection = spec.collections.find((c) => c.name === 'JobSchedules');
  assert.ok(scheduleCollection);
  const scheduleFieldNames = scheduleCollection!.fields.map((f) => f.name);

  assert.ok(scheduleFieldNames.includes('interval'));
  assert.ok(scheduleFieldNames.includes('next_run_at'));
  assert.ok(scheduleFieldNames.includes('enabled'));
});

test('appport.flow defines no secret fields in durable state', () => {
  const flowPath = join(process.cwd(), 'appport.flow');
  const flowContent = readFileSync(flowPath, 'utf-8');
  const spec = parseFlowSpec(flowContent);

  // Verify ApiKeys has secret_hash (hashed), not raw secret
  const apiKeysCollection = spec.collections.find((c) => c.name === 'ApiKeys');
  const apiKeysFieldNames = apiKeysCollection!.fields.map((f) => f.name);
  assert.ok(apiKeysFieldNames.includes('secret_hash'), 'ApiKeys stores hashed secrets only');
  assert.equal(
    apiKeysFieldNames.includes('secret'),
    false,
    'ApiKeys does not store raw secret',
  );

  // Verify no secrets in durable collections
  const allFieldNames = spec.collections.flatMap((c) => c.fields.map((f) => f.name));
  assert.equal(
    allFieldNames.includes('secret'),
    false,
    'No raw secrets in any durable collection',
  );
  assert.equal(
    allFieldNames.includes('signing_secret'),
    false,
    'No raw signing secrets in any durable collection',
  );
});

test('all collections are tenant-scoped', () => {
  const flowPath = join(process.cwd(), 'appport.flow');
  const flowContent = readFileSync(flowPath, 'utf-8');
  const spec = parseFlowSpec(flowContent);

  // All AppPort Services collections should have tenant_id field
  const expectedTenantScoped = [
    'ApiKeys',
    'ApiKeyPrefixes',
    'ApiKeyAuditEvents',
    'WebhookEndpoints',
    'WebhookDeliveries',
    'WebhookAuditEvents',
    'Jobs',
    'JobSchedules',
    'JobAuditEvents',
  ];

  for (const collectionName of expectedTenantScoped) {
    const collection = spec.collections.find((c) => c.name === collectionName);
    assert.ok(collection, `Collection ${collectionName} defined`);

    const hasTenantId = collection!.fields.some((f) => f.name === 'tenant_id');
    assert.ok(hasTenantId, `Collection ${collectionName} has tenant_id field`);
  }
});

test('appport.flow has expected tenant indexes', () => {
  const flowPath = join(process.cwd(), 'appport.flow');
  const flowContent = readFileSync(flowPath, 'utf-8');
  const spec = parseFlowSpec(flowContent);

  // Most collections should have tenant_idx for tenant-scoped queries
  const tenantIndexedCollections = [
    'ApiKeys',
    'WebhookEndpoints',
    'WebhookDeliveries',
    'Jobs',
    'JobSchedules',
  ];

  for (const collectionName of tenantIndexedCollections) {
    const collection = spec.collections.find((c) => c.name === collectionName);
    assert.ok(collection, `Collection ${collectionName} defined`);

    const hasTenantIndex = collection!.indexes.some(
      (i) => i.name === 'tenant_idx' && i.expression === '(tenant_id)',
    );
    assert.ok(hasTenantIndex, `Collection ${collectionName} has tenant_idx`);
  }
});
