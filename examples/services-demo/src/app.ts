import express from 'express';
import { randomUUID } from 'node:crypto';
import { createServices, apiKeyAuth } from '@appport/services';
import type { Invoice } from './models.js';

const app = express();
app.use(express.json());

// Initialize unified AppPort Services (API Keys, Webhooks, Jobs share one durable runtime)
const services = createServices({
  mode: 'local',
  namespace: 'demo-services',
  path: './.feltdb/demo',
});

// Middleware: API Key authentication
app.use(apiKeyAuth(services.apiKeys));

// POST /invoices - Create invoice with authenticated tenant context
// Uses atomic transaction to ensure invoice, webhook delivery intent, and job intent
// are all persisted together or all rolled back on failure.
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
    const invoiceId = randomUUID();
    const now = new Date().toISOString();

    const invoice: Invoice = {
      id: invoiceId,
      tenant_id: principal.tenantId,
      customer,
      amount,
      status: 'pending',
      created_at: now,
      created_by: principal.principalId,
    };

    // Atomic composition: all three operations execute in a single FeltDB transaction
    await services.transaction(async (tx) => {
      // 1. Application-owned state: invoice
      await tx.collection<Invoice>('invoices').insert(invoice, invoiceId);

      // 2. Webhook delivery intent: find matching endpoints and queue deliveries
      const endpoints = await services.webhooks.listWebhookEndpoints(principal.tenantId);
      const invoiceCreatedEndpoints = endpoints.filter((ep) =>
        ep.events.includes('invoice.created'),
      );

      if (invoiceCreatedEndpoints.length > 0) {
        tx.queueWebhookDeliveries(
          invoiceCreatedEndpoints.map((ep) => ep.id),
          {
            tenantId: principal.tenantId,
            type: 'invoice.created',
            payload: {
              id: invoiceId,
              customer,
              amount,
            },
          },
        );
      }

      // 3. Job intent: process the invoice
      tx.queueJob({
        tenantId: principal.tenantId,
        type: 'invoice.process',
        payload: { invoiceId },
        maxAttempts: 3,
      });
    });

    res.status(201).json({
      id: invoice.id,
      customer: invoice.customer,
      amount: invoice.amount,
      status: invoice.status,
    });
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /invoices - List invoices for authenticated tenant
// Note: In production, application-owned state would be queried from the application's
// own database service, not from AppPort's internal database. This uses the internal
// database accessor only for demonstration purposes.
app.get('/invoices', async (req, res) => {
  const principal = req.auth;

  if (!principal) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  try {
    const db = (services as any)['_getDb'];
    const tenantInvoices = await db.collection('invoices').find({ tenant_id: principal.tenantId });

    res.json({
      invoices: tenantInvoices.map((inv: any) => ({
        id: inv.id,
        customer: inv.customer,
        amount: inv.amount,
        status: inv.status,
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✓ Application listening on http://localhost:${PORT}`);
  console.log(`  POST /invoices       Create invoice (requires API key)`);
  console.log(`  GET  /invoices       List invoices (requires API key)`);
  console.log(`  GET  /health         Health check`);
});

export { app, services };
