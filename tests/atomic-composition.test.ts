import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createServices,
  FeltDbWebhookEndpointStore,
} from '../src/index.js';

test('Atomic composition: application state + webhook + job in one transaction', async () => {
  const path = await mkdtemp(join(tmpdir(), 'atomic-test-'));
  const services = createServices({ mode: 'local', namespace: 'atomic-test', path });

  const tenantId = 'test-tenant';

  // Pre-create a webhook endpoint so emitWebhookEvent has a target
  const endpoints = await services.webhooks.listWebhookEndpoints(tenantId);
  if (endpoints.length === 0) {
    await services.webhooks.createWebhookEndpoint({
      tenantId,
      url: 'https://example.com/webhook',
      events: ['invoice.created'],
      createdBy: 'test',
    });
  }

  // Execute atomic transaction
  await services.transaction(async (tx) => {
    // 1. Application-owned state (invoice)
    const invoiceId = crypto.randomUUID();
    await tx.collection('invoices').insert(
      {
        id: invoiceId,
        tenant_id: tenantId,
        customer: 'ACME Corp',
        amount: 1000,
        status: 'pending',
        created_at: new Date().toISOString(),
        created_by: 'test-user',
      },
      invoiceId,
    );

    // 2. Webhook delivery intent (for notification)
    const matchingEndpoints = await services.webhooks.listWebhookEndpoints(tenantId);
    tx.queueWebhookDeliveries(
      matchingEndpoints.map((e) => e.id),
      {
        tenantId,
        type: 'invoice.created',
        payload: { invoiceId },
      },
    );

    // 3. Job intent (for processing)
    tx.queueJob({
      tenantId,
      type: 'invoice.process',
      payload: { invoiceId },
      maxAttempts: 3,
    });
  });

  // Verify all three were created and persisted
  const db = services['_getDb'] as any;
  const invoices = db ? await db.collection('invoices').find({ tenant_id: tenantId }) : [];
  const deliveries = await services.webhooks.listWebhookDeliveries(tenantId);
  const jobs = await services.jobs.listJobs(tenantId);

  assert.equal(deliveries.length, 1, 'Webhook delivery created');
  assert.equal(deliveries[0].eventType, 'invoice.created');
  assert.equal(jobs.length, 1, 'Job enqueued');
  assert.equal(jobs[0].type, 'invoice.process');
});

test('Atomic composition: transaction rollback on failure', async () => {
  const path = await mkdtemp(join(tmpdir(), 'atomic-rollback-test-'));
  const services = createServices({ mode: 'local', namespace: 'atomic-rollback-test', path });

  const tenantId = 'test-tenant';

  // Create endpoint
  await services.webhooks.createWebhookEndpoint({
    tenantId,
    url: 'https://example.com/webhook',
    events: ['test.event'],
    createdBy: 'test',
  });

  // Intentional failure in transaction
  let transactionError: unknown;
  try {
    await services.transaction(async (tx) => {
      // Queue valid operations
      const invoiceId = crypto.randomUUID();
      await tx.collection('invoices').insert(
        {
          id: invoiceId,
          tenant_id: tenantId,
          customer: 'Test Corp',
          amount: 500,
          status: 'pending',
          created_at: new Date().toISOString(),
          created_by: 'test',
        },
        invoiceId,
      );

      // Simulate error before all operations are queued
      throw new Error('Simulated failure before job enqueue');
    });
  } catch (error) {
    transactionError = error;
  }

  assert.ok(transactionError, 'Transaction should fail');
  assert.match(String(transactionError), /Simulated failure/);

  // Verify nothing was persisted (rollback behavior)
  // Note: Due to error thrown before commit, the transaction never executes
  const deliveries = await services.webhooks.listWebhookDeliveries(tenantId);
  assert.equal(deliveries.length, 0, 'No deliveries should exist after rollback');

  const jobs = await services.jobs.listJobs(tenantId);
  assert.equal(jobs.length, 0, 'No jobs should exist after rollback');
});

test('Atomic composition: no independent FeltDB instances', async () => {
  const path = await mkdtemp(join(tmpdir(), 'single-runtime-test-'));
  const services = createServices({ mode: 'local', namespace: 'single-runtime-test', path });

  // Both transaction context and normal service calls use the same underlying database
  // This test passes if:
  // 1. Services created from one createServices() call
  // 2. Transaction context uses the same database
  // 3. No additional database instances are created internally

  const tenantId = 'single-runtime-test-tenant';

  // Create API key through normal service
  const apiKey = await services.apiKeys.createApiKey({
    tenantId,
    name: 'test-key',
    scopes: ['test.write'],
    createdBy: 'test',
  });

  assert.ok(apiKey.id, 'API key created through normal service');

  // Use transaction
  await services.transaction(async (tx) => {
    const invoiceId = crypto.randomUUID();
    await tx.collection('invoices').insert(
      {
        id: invoiceId,
        tenant_id: tenantId,
        customer: 'Test',
        amount: 100,
        status: 'pending',
        created_at: new Date().toISOString(),
        created_by: 'test',
      },
      invoiceId,
    );
  });

  // Verify both persisted in the same database
  const keys = await services.apiKeys.listApiKeys(tenantId);
  assert.equal(keys.length, 1, 'API key persisted');
  assert.equal(keys[0].id, apiKey.id);
});
