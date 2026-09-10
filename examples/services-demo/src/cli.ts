#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  createApiKeyService,
  createFeltDbRuntime,
  FeltDbWebhookEndpointStore,
  FeltDbWebhookDeliveryStore,
  FeltDbWebhookAuditSink,
  WebhookService,
  EncryptedWebhookSecretStore,
  FeltDbJobStore,
  FeltDbJobScheduleStore,
  FeltDbJobAuditSink,
  JobService,
} from '@appport/services';
import { FeltDbInvoiceStore } from './invoice-store.js';
import { InvoiceService } from './invoice-service.js';

const runtime = createFeltDbRuntime({
  mode: 'local',
  namespace: 'demo-services',
  path: './.feltdb/demo',
});

const apiKeyService = createApiKeyService({
  mode: 'local',
  namespace: 'demo-services',
  path: './.feltdb/demo',
});

const webhookService = new WebhookService({
  endpointStore: new FeltDbWebhookEndpointStore(runtime.db),
  deliveryStore: new FeltDbWebhookDeliveryStore(runtime.db),
  auditSink: new FeltDbWebhookAuditSink(runtime.db),
  secretStore: new EncryptedWebhookSecretStore(),
});

const jobService = new JobService({
  jobStore: new FeltDbJobStore(runtime.db),
  scheduleStore: new FeltDbJobScheduleStore(runtime.db),
  auditSink: new FeltDbJobAuditSink(runtime.db),
});

const invoiceStore = new FeltDbInvoiceStore(runtime.db);
const invoiceService = new InvoiceService(invoiceStore, webhookService, jobService);

const args = process.argv.slice(2);

async function main() {
  const command = args[0];
  const subcommand = args[1];

  try {
    if (command === 'api-key' && subcommand === 'create') {
      const tenantIdx = args.indexOf('--tenant');
      const nameIdx = args.indexOf('--name');
      const scopeIdx = args.indexOf('--scope');
      const createdByIdx = args.indexOf('--created-by');

      const tenant = args[tenantIdx + 1];
      const name = args[nameIdx + 1];
      const scope = args[scopeIdx + 1];
      const createdBy = args[createdByIdx + 1];

      if (!tenant || !name || !scope || !createdBy) {
        console.error('Usage: appport api-key create --tenant <id> --name <name> --scope <scope> --created-by <user>');
        process.exit(1);
      }

      const key = await apiKeyService.createApiKey({
        tenantId: tenant,
        name,
        scopes: [scope],
        createdBy,
      });

      console.log(`✓ API Key created`);
      console.log(`  ID: ${key.id}`);
      console.log(`  Name: ${key.name}`);
      console.log(`  Secret: ${key.secret}`);
      console.log(`  ⚠️  Save this secret—it is only returned once`);
    } else if (command === 'invoice' && subcommand === 'create') {
      const tenantIdx = args.indexOf('--tenant');
      const customerIdx = args.indexOf('--customer');
      const amountIdx = args.indexOf('--amount');

      const tenant = args[tenantIdx + 1];
      const customer = args[customerIdx + 1];
      const amount = parseFloat(args[amountIdx + 1]);

      if (!tenant || !customer || isNaN(amount)) {
        console.error('Usage: appport invoice create --tenant <id> --customer <name> --amount <number>');
        process.exit(1);
      }

      // Create a fake principal for demo purposes
      const principal = {
        principalId: 'demo-operator',
        principalType: 'api_key' as const,
        tenantId: tenant,
        scopes: ['invoices.write'],
        credentialId: 'demo-key',
      };

      const invoice = await invoiceService.createInvoice(principal, customer, amount);

      console.log(`✓ Invoice created`);
      console.log(`  ID: ${invoice.id}`);
      console.log(`  Customer: ${invoice.customer}`);
      console.log(`  Amount: $${invoice.amount}`);
      console.log(`  Status: ${invoice.status}`);
    } else if (command === 'invoice' && subcommand === 'list') {
      const tenantIdx = args.indexOf('--tenant');
      const tenant = args[tenantIdx + 1];

      if (!tenant) {
        console.error('Usage: appport invoice list --tenant <id>');
        process.exit(1);
      }

      const invoices = await invoiceStore.list(tenant);

      if (invoices.length === 0) {
        console.log('No invoices found');
      } else {
        console.log(`${invoices.length} invoice(s):`);
        invoices.forEach((inv) => {
          console.log(`  ${inv.id} | ${inv.customer} | $${inv.amount} | ${inv.status}`);
        });
      }
    } else if (command === 'job' && subcommand === 'list') {
      const tenantIdx = args.indexOf('--tenant');
      const tenant = args[tenantIdx + 1];

      if (!tenant) {
        console.error('Usage: appport job list --tenant <id>');
        process.exit(1);
      }

      const jobs = await jobService.listJobs(tenant);

      if (jobs.length === 0) {
        console.log('No jobs found');
      } else {
        console.log(`${jobs.length} job(s):`);
        jobs.forEach((job) => {
          console.log(`  ${job.id} | ${job.type} | ${job.status} | attempt ${job.attemptCount}`);
        });
      }
    } else if (command === 'webhook' && subcommand === 'list-deliveries') {
      const tenantIdx = args.indexOf('--tenant');
      const tenant = args[tenantIdx + 1];

      if (!tenant) {
        console.error('Usage: appport webhook list-deliveries --tenant <id>');
        process.exit(1);
      }

      const deliveries = await webhookService.listDeliveries(tenant);

      if (deliveries.length === 0) {
        console.log('No deliveries found');
      } else {
        console.log(`${deliveries.length} delivery(ies):`);
        deliveries.forEach((del) => {
          console.log(`  ${del.id} | ${del.eventType} | ${del.status} | attempt ${del.attemptCount}`);
        });
      }
    } else {
      console.error('Available commands:');
      console.error('  api-key create           Create API key for tenant');
      console.error('  invoice create           Create invoice');
      console.error('  invoice list             List invoices');
      console.error('  job list                 List jobs');
      console.error('  webhook list-deliveries  List webhook deliveries');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await runtime.db.close();
  }
}

main();
