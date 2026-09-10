#!/usr/bin/env node

import {
  createFeltDbRuntime,
  FeltDbJobStore,
  FeltDbJobScheduleStore,
  FeltDbJobAuditSink,
  JobService,
  FeltDbWebhookDeliveryStore,
  WebhookService,
  FeltDbWebhookEndpointStore,
  FeltDbWebhookAuditSink,
  EncryptedWebhookSecretStore,
} from '@appport/services';

const runtime = createFeltDbRuntime({
  mode: 'local',
  namespace: 'demo-services',
  path: './.feltdb/demo',
});

const jobService = new JobService({
  jobStore: new FeltDbJobStore(runtime.db),
  scheduleStore: new FeltDbJobScheduleStore(runtime.db),
  auditSink: new FeltDbJobAuditSink(runtime.db),
});

const webhookService = new WebhookService({
  endpointStore: new FeltDbWebhookEndpointStore(runtime.db),
  deliveryStore: new FeltDbWebhookDeliveryStore(runtime.db),
  auditSink: new FeltDbWebhookAuditSink(runtime.db),
  secretStore: new EncryptedWebhookSecretStore(),
});

const invoices = runtime.db.collection<any>('invoices');

// Register invoice processing job handler
jobService.register('invoice.process', async (job: any) => {
  const { invoiceId } = job.payload as { invoiceId: string };

  console.log(`[Job] Processing invoice ${invoiceId}`);

  // Simulate processing
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Mark invoice as completed
  const invoice = await invoices.get(invoiceId);
  if (invoice) {
    await invoices.updateIfVersion(invoiceId, invoice.__version, {
      status: 'completed',
    });
    console.log(`[Job] Invoice ${invoiceId} completed`);
  }
});

const WORKER_ID = `worker-${Math.random().toString(16).slice(2, 8)}`;
const POLL_INTERVAL_MS = 5000;

async function runWorker() {
  console.log(`✓ Worker ${WORKER_ID} started (poll every ${POLL_INTERVAL_MS}ms)`);

  let running = true;

  process.on('SIGINT', () => {
    console.log('\n⏹ Worker shutting down...');
    running = false;
  });

  while (running) {
    try {
      // Process jobs for demo tenant
      const jobs = await jobService.listJobs('demo-tenant');
      const dueJobs = jobs.filter((j: any) => j.status === 'pending' || j.status === 'retrying');

      if (dueJobs.length > 0) {
        console.log(`[Worker] Found ${dueJobs.length} job(s) to process`);
        for (const job of dueJobs) {
          try {
            const result = await jobService.executeJob('demo-tenant', job.id, WORKER_ID);
            if (result) {
              console.log(`[Worker] Job ${job.id} completed`);
            }
          } catch (error: any) {
            console.error(`[Worker] Job ${job.id} failed:`, error.message);
          }
        }
      }

      // Deliver webhooks for demo tenant
      const deliveries = await webhookService.listWebhookDeliveries('demo-tenant');
      const pending = deliveries.filter((d: any) => d.status === 'pending' || d.status === 'retrying');

      if (pending.length > 0) {
        console.log(`[Worker] Found ${pending.length} webhook(s) to deliver`);
        for (const delivery of pending) {
          try {
            const result = await webhookService.deliverWebhook('demo-tenant', delivery.id);
            if (result.success) {
              console.log(`[Webhook] Delivery ${delivery.id} succeeded`);
            }
          } catch (error: any) {
            console.error(`[Webhook] Delivery failed:`, error.message);
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } catch (error) {
      console.error('[Worker] Error:', error);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  console.log('✓ Worker stopped');
  process.exit(0);
}

runWorker().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
