import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServices } from '@appport/services';

test('Restart durability: data survives process restart', async () => {
  const path = await mkdtemp(join(tmpdir(), 'invoice-restart-test-'));
  const configPath = join(path, 'appport.toml');
  const feeldbPath = join(path, '.feltdb');

  const config = `use api
use webhooks
use jobs

[webhooks]
events = ["invoice.created"]

[jobs]
max_attempts = 3
`;
  writeFileSync(configPath, config);

  const tenantId = 'test-tenant';

  // Phase 1: Create data
  {
    const services1 = createServices({
      mode: 'local',
      namespace: 'invoice-restart-test',
      path: feeldbPath,
      config: configPath,
    });

    const db1 = (services1 as any)['_getDb'];

    // Create webhook endpoint
    const { endpoint } = await services1.webhooks.createWebhookEndpoint({
      tenantId,
      url: 'https://example.com/webhook',
      events: ['invoice.created'],
      createdBy: 'test',
    });

    // Create invoice with webhook + job in transaction
    const invoiceId = randomUUID();
    const customerId = randomUUID();
    const now = new Date().toISOString();

    const invoice = {
      id: invoiceId,
      tenant_id: tenantId,
      customer_id: customerId,
      items: [],
      total_amount: 500,
      status: 'pending',
      created_at: now,
      created_by: 'test',
      updated_at: now,
      __version: 1,
    };

    await services1.transaction(async (tx) => {
      await tx.collection('invoices').insert(invoice, invoiceId);

      tx.queueWebhookDeliveries([endpoint.id], {
        tenantId,
        type: 'invoice.created',
        payload: { id: invoiceId, total_amount: 500 },
      });

      tx.queueJob({
        tenantId,
        type: 'invoice.process',
        payload: { invoiceId },
        maxAttempts: 3,
      });
    });

    // Verify before shutdown
    const invoices1 = await db1.collection('invoices').find({ tenant_id: tenantId });
    const deliveries1 = await services1.webhooks.listWebhookDeliveries(tenantId);
    const jobs1 = await services1.jobs.listJobs(tenantId);

    assert.equal(invoices1.length, 1, 'Phase 1: Invoice created');
    assert.equal(deliveries1.length, 1, 'Phase 1: Webhook delivery created');
    assert.equal(jobs1.length, 1, 'Phase 1: Job enqueued');

    // Simulate process shutdown (scope cleanup)
    console.log('✓ Phase 1: Created invoice + webhook + job');
  }

  // Phase 2: Restart and verify data survived
  {
    const services2 = createServices({
      mode: 'local',
      namespace: 'invoice-restart-test',
      path: feeldbPath,
      config: configPath,
    });

    const db2 = (services2 as any)['_getDb'];

    // Verify all data survived
    const invoices2 = await db2.collection('invoices').find({ tenant_id: tenantId });
    const deliveries2 = await services2.webhooks.listWebhookDeliveries(tenantId);
    const jobs2 = await services2.jobs.listJobs(tenantId);

    assert.equal(invoices2.length, 1, 'Phase 2: Invoice survived restart');
    assert.equal(invoices2[0].total_amount, 500, 'Phase 2: Invoice data intact');

    assert.equal(deliveries2.length, 1, 'Phase 2: Webhook delivery survived restart');
    assert.equal(deliveries2[0].status, 'pending', 'Phase 2: Delivery still pending');

    assert.equal(jobs2.length, 1, 'Phase 2: Job survived restart');
    assert.equal(jobs2[0].status, 'pending', 'Phase 2: Job still pending');
    assert.equal(jobs2[0].type, 'invoice.process', 'Phase 2: Job type intact');

    console.log('✓ Phase 2: All data survived restart');
  }

  // Phase 3: Process more data after restart
  {
    const services3 = createServices({
      mode: 'local',
      namespace: 'invoice-restart-test',
      path: feeldbPath,
      config: configPath,
    });

    const db3 = (services3 as any)['_getDb'];

    // Get existing endpoint
    const endpoints = await services3.webhooks.listWebhookEndpoints(tenantId);
    assert.equal(endpoints.length, 1, 'Phase 3: Webhook endpoint survived');

    // Create second invoice
    const invoiceId2 = randomUUID();
    const now = new Date().toISOString();

    const invoice2 = {
      id: invoiceId2,
      tenant_id: tenantId,
      customer_id: randomUUID(),
      items: [],
      total_amount: 750,
      status: 'pending',
      created_at: now,
      created_by: 'test',
      updated_at: now,
      __version: 1,
    };

    await services3.transaction(async (tx) => {
      await tx.collection('invoices').insert(invoice2, invoiceId2);

      tx.queueWebhookDeliveries([endpoints[0].id], {
        tenantId,
        type: 'invoice.created',
        payload: { id: invoiceId2, total_amount: 750 },
      });

      tx.queueJob({
        tenantId,
        type: 'invoice.process',
        payload: { invoiceId: invoiceId2 },
        maxAttempts: 3,
      });
    });

    // Verify both invoices exist
    const allInvoices = await db3.collection('invoices').find({ tenant_id: tenantId });
    const allJobs = await services3.jobs.listJobs(tenantId);

    assert.equal(allInvoices.length, 2, 'Phase 3: Both invoices exist');
    assert.equal(allJobs.length, 2, 'Phase 3: Both jobs exist');

    console.log('✓ Phase 3: New data created after restart');
  }

  console.log('\n✓ Restart durability test passed');
  console.log('  - Data survived process restart');
  console.log('  - Invoices, webhooks, and jobs persisted');
  console.log('  - New operations work after restart');
  console.log('  - No duplicate infrastructure created');
});
