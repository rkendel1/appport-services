import { createServices, type Job, type JobExecution } from '@appport/services';
import { DEVELOPMENT_DESTINATIONS, developmentAuthorizer, developmentCredentials } from './authority.js';

/**
 * Invoice processing worker.
 *
 * The worker process is not an authority. Each job runs as the durable
 * principal recorded when it was enqueued, and AuthBoundry authorizes every
 * run (jobs.execute). A revoked delegation stops the next run.
 */

const services = createServices({
  mode: 'local',
  namespace: 'invoice-app',
  path: './.feltdb/invoice-app',
  config: './appport.toml',
  application: 'invoice-app',
  authorizer: developmentAuthorizer,
  credentials: developmentCredentials,
  webhookDestinationPolicy: DEVELOPMENT_DESTINATIONS,
});

async function processInvoice(job: Job, execution: JobExecution): Promise<void> {
  const { invoiceId } = job.payload as { invoiceId: string };
  console.log(`Processing invoice ${invoiceId} for tenant ${job.tenantId} as ${execution.principal.principalId} (run ${execution.runId})`);

  // Application-owned state update.
  const db = (services as any)['_getDb'];
  const [invoice] = await db.collection('invoices').find({ tenant_id: job.tenantId, id: invoiceId });
  if (!invoice) throw new Error(`Invoice not found: ${invoiceId}`);
  await db.collection('invoices').updateIfVersion(invoiceId, invoice.__version, { status: 'completed', updated_at: new Date().toISOString() });
  console.log(`✓ Invoice ${invoiceId} processed`);
}

services.jobs.register('invoice.process', processInvoice);

async function runWorker(workerId: string, tenantId: string): Promise<void> {
  console.log(`Worker ${workerId} started for tenant ${tenantId}`);
  while (true) {
    try {
      const now = new Date().toISOString();
      const due = (await services.jobs.listJobs(tenantId)).filter((job) =>
        (job.status === 'pending' && job.runAt <= now) || (job.status === 'retrying' && (!job.nextAttemptAt || job.nextAttemptAt <= now)));
      for (const job of due) {
        // executeJob claims the lease, asks AuthBoundry, runs the handler, and handles retry/backoff.
        const completed = await services.jobs.executeJob(tenantId, job.id, workerId);
        console.log(`${completed ? '✓' : '✗'} Job ${job.id}`);
      }
      await new Promise((resolve) => setTimeout(resolve, due.length ? 100 : 2000));
    } catch (error) {
      console.error('Worker error:', error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

runWorker(`worker-${Date.now()}`, process.env.TENANT_ID ?? 'test-tenant').catch((error) => {
  console.error('Fatal worker error:', error);
  process.exit(1);
});
