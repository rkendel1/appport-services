import { createServices } from '@appport/services';

/**
 * Invoice processing worker.
 * Demonstrates job claim, processing, retry, and completion.
 */

const services = createServices({
  mode: 'local',
  namespace: 'invoice-app',
  path: './.feltdb/invoice-app',
  config: './appport.toml',
});

/**
 * Process invoice job.
 * Simulates invoice processing with occasional failures to demonstrate retry.
 */
async function processInvoice(invoiceId: string, tenantId: string): Promise<void> {
  console.log(`Processing invoice ${invoiceId} for tenant ${tenantId}`);

  // Fetch invoice from database
  const db = (services as any)['_getDb'];
  const invoices = await db.collection('invoices').find({
    tenant_id: tenantId,
    id: invoiceId,
  });

  if (invoices.length === 0) {
    throw new Error(`Invoice not found: ${invoiceId}`);
  }

  const invoice = invoices[0];

  // Simulate processing
  console.log(`  Total: $${invoice.total_amount}`);
  console.log(`  Items: ${invoice.items?.length || 0}`);

  // Update invoice status to processing
  await db.collection('invoices').updateIfVersion(
    invoiceId,
    invoice.__version,
    {
      status: 'completed',
      updated_at: new Date().toISOString(),
    },
  );

  console.log(`✓ Invoice ${invoiceId} processed successfully`);
}

/**
 * Run worker: poll for jobs, process, retry on failure.
 */
async function runWorker(workerId: string): Promise<void> {
  console.log(`Worker ${workerId} started`);

  // Process jobs in a loop
  // In a real application, this would be a daemon or triggered by an event
  while (true) {
    try {
      // Get pending jobs for this worker
      // Note: In a real deployment, you'd use JobWorker class
      // For now, we demonstrate manual job handling

      // Simulate finding jobs
      const db = (services as any)['_getDb'];
      const jobs = await db.collection('jobs').find({
        status: 'pending',
        type: 'invoice.process',
      });

      if (jobs.length === 0) {
        // No jobs available
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      const job = jobs[0];

      console.log(`\nProcessing job ${job.id}`);
      try {
        // Process the job
        const payload = job.payload as { invoiceId: string };
        await processInvoice(payload.invoiceId, job.tenantId);

        // Mark job as completed
        await db.collection('jobs').updateIfVersion(job.id, job.__version, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });

        console.log(`✓ Job ${job.id} completed`);
      } catch (error) {
        console.error(`✗ Job ${job.id} failed:`, error);

        // Update job attempt count
        const newAttempts = (job.attemptCount || 0) + 1;
        if (newAttempts >= (job.maxAttempts || 3)) {
          // Mark as failed
          await db.collection('jobs').updateIfVersion(job.id, job.__version, {
            status: 'failed',
            attemptCount: newAttempts,
          });
          console.log(`✗ Job ${job.id} exhausted retries`);
        } else {
          // Schedule retry
          const backoffMs = Math.pow(2, newAttempts) * 1000;
          const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();

          await db.collection('jobs').updateIfVersion(job.id, job.__version, {
            status: 'retrying',
            attemptCount: newAttempts,
            nextAttemptAt,
          });
          console.log(`→ Job ${job.id} will retry in ${backoffMs}ms`);
        }
      }

      // Yield to prevent busy-loop
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      console.error('Worker error:', error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Start worker
const workerId = `worker-${Date.now()}`;
runWorker(workerId).catch((error) => {
  console.error('Fatal worker error:', error);
  process.exit(1);
});
