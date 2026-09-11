import express from 'express';
import { randomUUID } from 'node:crypto';
import { createServices, apiKeyAuth } from '@appport/services';
import { createFeltDB } from '@feltdb/core';
import type { Invoice } from './models.js';

const app = express();
app.use(express.json());

// Initialize unified AppPort Services (API Keys, Webhooks, Jobs share one durable runtime)
const services = createServices({
  mode: 'local',
  namespace: 'demo-services',
  path: './.feltdb/demo',
});

// Application-owned state: invoices use separate FeltDB instance
// Note: for atomic composition across app state and AppPort services,
// the application would use FeltDB's transaction API directly.
// Here we keep them separate for clarity of responsibilities.
const appDb = createFeltDB({
  mode: 'local',
  namespace: 'demo-services',
  path: './.feltdb/demo',
});
const invoices = appDb.collection<Invoice>('invoices');

// Middleware: API Key authentication
app.use(apiKeyAuth(services.apiKeys));

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

    // Create invoice
    await invoices.insert(invoice, invoiceId);

    // Establish webhook delivery intent
    await services.webhooks.emitWebhookEvent({
      tenantId: principal.tenantId,
      type: 'invoice.created',
      payload: {
        id: invoiceId,
        customer,
        amount,
      },
    });

    // Establish job intent
    await services.jobs.enqueue({
      tenantId: principal.tenantId,
      type: 'invoice.process',
      payload: { invoiceId },
      maxAttempts: 3,
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
app.get('/invoices', async (req, res) => {
  const principal = req.auth;

  if (!principal) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  try {
    const tenantInvoices = await invoices.find({ tenant_id: principal.tenantId });

    res.json({
      invoices: tenantInvoices.map((inv) => ({
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
