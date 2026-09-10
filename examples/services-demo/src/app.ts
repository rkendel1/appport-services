import express from 'express';
import {
  createApiKeyService,
  apiKeyAuth,
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

const app = express();
app.use(express.json());

// Initialize FeltDB runtime (shared storage)
const runtime = createFeltDbRuntime({
  mode: 'local',
  namespace: 'demo-services',
  path: './.feltdb/demo',
});

// Initialize AppPort Services
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

// Initialize application-specific services
const invoiceStore = new FeltDbInvoiceStore(runtime.db);
const invoiceService = new InvoiceService(invoiceStore, webhookService, jobService);

// API Key authentication middleware
app.use(apiKeyAuth(apiKeyService));

// POST /invoices - Create invoice with authenticated tenant context
app.post('/invoices', async (req, res) => {
  const principal = req.auth;

  if (!principal) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  const { customer, amount } = req.body;

  if (!customer || typeof amount !== 'number') {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    const invoice = await invoiceService.createInvoice(
      principal,
      customer,
      amount,
    );

    res.status(201).json({
      id: invoice.id,
      customer: invoice.customer,
      amount: invoice.amount,
      status: invoice.status,
      created_at: invoice.created_at,
    });
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /invoices - List invoices for authenticated tenant
app.get('/invoices', async (req, res) => {
  const principal = req.auth;

  if (!principal) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  try {
    const invoices = await invoiceService.listInvoices(principal);

    res.json({
      invoices: invoices.map((inv) => ({
        id: inv.id,
        customer: inv.customer,
        amount: inv.amount,
        status: inv.status,
        created_at: inv.created_at,
      })),
    });
  } catch (error) {
    console.error('Error listing invoices:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✓ Application listening on http://localhost:${PORT}`);
  console.log(`  POST /invoices       Create invoice (requires API key)`);
  console.log(`  GET  /invoices       List invoices (requires API key)`);
  console.log(`  GET  /health        Health check`);
});

export { app, apiKeyService, webhookService, jobService, invoiceService };
