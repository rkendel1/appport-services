#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createServices } from '@appport/services';
import { createFeltDB } from '@feltdb/core';

// Initialize unified AppPort Services
const services = createServices({
  mode: 'local',
  namespace: 'demo-services',
  path: './.feltdb/demo',
});

// Application-owned state: invoices use separate FeltDB instance
const appDb = createFeltDB({
  mode: 'local',
  namespace: 'demo-services',
  path: './.feltdb/demo',
});
const invoices = appDb.collection<any>('invoices');

const args = process.argv.slice(2);

async function main() {
  const command = args[0];
  const subcommand = args[1];

  try {
    if (command === 'api-key' && subcommand === 'create') {
      const key = await services.apiKeys.createApiKey({
        tenantId: 'demo-tenant',
        name: 'default',
        scopes: ['invoices.write'],
        createdBy: 'operator',
      });

      console.log(`✓ API Key created`);
      console.log(`  ID: ${key.id}`);
      console.log(`  Secret: ${key.secret}`);
      console.log(`  ⚠️  Save this secret—it is only returned once`);
    } else if (command === 'invoice' && subcommand === 'create') {
      const customer = args[3] || 'ACME Corp';
      const amount = parseInt(args[5]) || 1000;

      const invoiceId = randomUUID();
      const now = new Date().toISOString();

      await invoices.insert(
        {
          id: invoiceId,
          tenant_id: 'demo-tenant',
          customer,
          amount,
          status: 'pending',
          created_at: now,
          created_by: 'operator',
        },
        invoiceId,
      );

      // Create webhook delivery intent
      await services.webhooks.emitWebhookEvent({
        tenantId: 'demo-tenant',
        type: 'invoice.created',
        payload: { id: invoiceId, customer, amount },
      });

      // Enqueue job
      await services.jobs.enqueue({
        tenantId: 'demo-tenant',
        type: 'invoice.process',
        payload: { invoiceId },
        maxAttempts: 3,
      });

      console.log(`✓ Invoice created`);
      console.log(`  ID: ${invoiceId}`);
      console.log(`  Customer: ${customer}`);
      console.log(`  Amount: $${amount}`);
    } else if (command === 'invoice' && subcommand === 'list') {
      const allInvoices = await invoices.find({ tenant_id: 'demo-tenant' });
      if (allInvoices.length === 0) {
        console.log('No invoices found');
      } else {
        console.log(`${allInvoices.length} invoice(s):`);
        allInvoices.forEach((inv: any) => {
          console.log(`  ${inv.id} | ${inv.customer} | $${inv.amount} | ${inv.status}`);
        });
      }
    } else if (command === 'job' && subcommand === 'list') {
      const jobs = await services.jobs.listJobs('demo-tenant');
      if (jobs.length === 0) {
        console.log('No jobs found');
      } else {
        console.log(`${jobs.length} job(s):`);
        jobs.forEach((job: any) => {
          console.log(`  ${job.id.slice(0, 8)}... | ${job.type} | ${job.status} | attempt ${job.attemptCount}`);
        });
      }
    } else if (command === 'webhook' && subcommand === 'list-deliveries') {
      const deliveries = await services.webhooks.listWebhookDeliveries('demo-tenant');
      if (deliveries.length === 0) {
        console.log('No deliveries found');
      } else {
        console.log(`${deliveries.length} delivery(ies):`);
        deliveries.forEach((del: any) => {
          console.log(`  ${del.id.slice(0, 8)}... | ${del.eventType} | ${del.status} | attempt ${del.attemptCount}`);
        });
      }
    } else {
      console.error('Commands:');
      console.error('  api-key create');
      console.error('  invoice create [customer] [amount]');
      console.error('  invoice list');
      console.error('  job list');
      console.error('  webhook list-deliveries');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await appDb.close();
  }
}

main();
