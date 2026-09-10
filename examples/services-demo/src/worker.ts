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
import { FeltDbInvoiceStore } from './invoice-store.js';

const runtime = createFeltDbRuntime({
  mode: 'local',
  namespace: 'demo-services',
  path: './.feltdb/demo',
});

const invoiceStore = new FeltDbInvoiceStore(runtime.db);

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

// Register invoice processing job handler
jobService.register('invoice.process', async (job) => {
  const { invoiceId } = job.payload as { invoiceId: string };

  console.log(`[Job] Processing invoice ${invoiceId} for tenant ${job.tenantId}`);

  // Simulate processing
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Mark invoice as processed
  const updated = await invoiceStore.updateStatus(
    job.tenantId,
    invoiceId,
    'completed',
  );

  if (updated) {
    console.log(`[Job] Invoice ${invoiceId} marked as completed`);
  } else {
    throw new Error(`Invoice ${invoiceId} not found`);
  }
});

// Worker configuration
const WORKER_ID = `worker-${Math.random().toString(16).slice(2, 8)}`;
const CONCURRENT_JOBS = 2;
const POLL_INTERVAL_MS = 5000;

async function runWorker() {
  console.log(`✓ Worker ${WORKER_ID} started`);
  console.log(`  Concurrent jobs: ${CONCURRENT_JOBS}`);
  console.log(`  Poll interval: ${POLL_INTERVAL_MS}ms`);

  let running = true;

  process.on('SIGINT', () => {
    console.log('\n⏹ Worker shutting down gracefully...');
    running = false;
  });

  while (running) {
    try {
      // Get all tenants (simplified: scan all jobs)
      const allJobs = await jobService.listJobs('demo-tenant');

      // Process due jobs
      const dueJobs = allJobs.filter((j) => j.status === 'pending' || j.status === 'retrying');

      if (dueJobs.length > 0) {
        console.log(`[Worker] Found ${dueJobs.length} due job(s)`);

        // Process concurrently up to limit
        const batch = dueJobs.slice(0, CONCURRENT_JOBS);

        await Promise.all(
          batch.map((job) => jobService.executeJob('demo-tenant', job.id, WORKER_ID).catch((e) => {
            console.error(`[Job] Error executing job ${job.id}:`, e.message);
          })),
        );
      }

      // Deliver webhooks
      const deliveries = await webhookService.listDeliveries('demo-tenant');
      const pendingDeliveries = deliveries.filter((d) => d.status === 'pending' || d.status === 'retrying');

      if (pendingDeliveries.length > 0) {
        console.log(`[Webhook] Found ${pendingDeliveries.length} pending delivery(ies)`);

        const batch = pendingDeliveries.slice(0, CONCURRENT_JOBS);

        await Promise.all(
          batch.map((delivery) => webhookService.deliverWebhook('demo-tenant', delivery.id).catch((e) => {
            console.error(`[Webhook] Error delivering webhook:`, e.message);
          })),
        );
      }

      // Poll again after interval
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } catch (error) {
      console.error('[Worker] Unexpected error:', error);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  console.log('✓ Worker shut down');
  process.exit(0);
}

runWorker().catch((error) => {
  console.error('Fatal worker error:', error);
  process.exit(1);
});
