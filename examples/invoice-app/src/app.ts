import express from 'express';
import { randomUUID } from 'node:crypto';
import { createServices, apiKeyAuth } from '@appport/services';
import type { Invoice, Customer, InvoiceRequest } from './models.js';

const app = express();
app.use(express.json());

// Initialize AppPort Services with DSL configuration
const services = createServices({
  mode: 'local',
  namespace: 'invoice-app',
  path: './.feltdb/invoice-app',
  config: './appport.toml',
});

// Middleware: API Key authentication
app.use(apiKeyAuth(services.apiKeys));

// ============================================================================
// Customer Management
// ============================================================================

// POST /customers - Create a customer
app.post('/customers', async (req, res) => {
  const principal = req.auth;

  if (!principal) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email required' });
  }

  try {
    const customerId = randomUUID();
    const now = new Date().toISOString();

    const customer: Customer = {
      id: customerId,
      tenant_id: principal.tenantId,
      name,
      email,
      created_at: now,
      created_by: principal.principalId,
    };

    // Store customer in application database
    const db = (services as any)['_getDb'];
    await db.collection('customers').insert(customer, customerId);

    res.status(201).json({
      id: customer.id,
      name: customer.name,
      email: customer.email,
    });
  } catch (error) {
    console.error('Error creating customer:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /customers - List customers for tenant
app.get('/customers', async (req, res) => {
  const principal = req.auth;

  if (!principal) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  try {
    const db = (services as any)['_getDb'];
    const customers = await db.collection('customers').find({ tenant_id: principal.tenantId });

    res.json({
      customers: customers.map((c: any) => ({
        id: c.id,
        name: c.name,
        email: c.email,
      })),
    });
  } catch (error) {
    console.error('Error listing customers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// Invoice Management - Atomic Composition
// ============================================================================

// POST /invoices - Create invoice atomically with webhook + job
// This is the critical flow: application state + webhook + job in ONE transaction
app.post('/invoices', async (req, res) => {
  const principal = req.auth;

  if (!principal) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  const invoiceRequest = req.body as InvoiceRequest;

  if (!invoiceRequest.customer_id || !Array.isArray(invoiceRequest.items) || invoiceRequest.items.length === 0) {
    return res.status(400).json({ error: 'Customer ID and items required' });
  }

  try {
    const invoiceId = randomUUID();
    const now = new Date().toISOString();

    // Prepare invoice data
    const items = invoiceRequest.items.map((item) => ({
      id: randomUUID(),
      invoice_id: invoiceId,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total: item.quantity * item.unit_price,
    }));

    const totalAmount = items.reduce((sum, item) => sum + item.total, 0);

    const invoice: Invoice = {
      id: invoiceId,
      tenant_id: principal.tenantId,
      customer_id: invoiceRequest.customer_id,
      items,
      total_amount: totalAmount,
      status: 'pending',
      created_at: now,
      created_by: principal.principalId,
      updated_at: now,
    };

    // ATOMIC COMPOSITION: invoice + webhook + job in ONE transaction
    await services.transaction(async (tx) => {
      // 1. Create invoice (application-owned state)
      await tx.collection<Invoice>('invoices').insert(invoice, invoiceId);

      // 2. Create invoice items
      for (const item of items) {
        await tx.collection('invoice_items').insert(item, item.id);
      }

      // 3. Queue webhook delivery for invoice.created
      const endpoints = await services.webhooks.listWebhookEndpoints(principal.tenantId);
      const createdEndpoints = endpoints.filter((ep) => ep.events.includes('invoice.created'));

      if (createdEndpoints.length > 0) {
        tx.queueWebhookDeliveries(
          createdEndpoints.map((ep) => ep.id),
          {
            tenantId: principal.tenantId,
            type: 'invoice.created',
            payload: {
              id: invoiceId,
              customer_id: invoiceRequest.customer_id,
              total_amount: totalAmount,
              items_count: items.length,
            },
          },
        );
      }

      // 4. Enqueue job for invoice processing
      tx.queueJob({
        tenantId: principal.tenantId,
        type: 'invoice.process',
        payload: { invoiceId },
        maxAttempts: 3,
      });
    });

    // All three persisted atomically; respond with invoice
    res.status(201).json({
      id: invoice.id,
      customer_id: invoice.customer_id,
      total_amount: invoice.total_amount,
      items_count: items.length,
      status: invoice.status,
    });
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /invoices - List invoices for tenant
app.get('/invoices', async (req, res) => {
  const principal = req.auth;

  if (!principal) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  try {
    const db = (services as any)['_getDb'];
    const invoices = await db.collection('invoices').find({ tenant_id: principal.tenantId });

    res.json({
      invoices: invoices.map((inv: any) => ({
        id: inv.id,
        customer_id: inv.customer_id,
        total_amount: inv.total_amount,
        status: inv.status,
      })),
    });
  } catch (error) {
    console.error('Error listing invoices:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /invoices/:id - Get single invoice
app.get('/invoices/:id', async (req, res) => {
  const principal = req.auth;

  if (!principal) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  try {
    const db = (services as any)['_getDb'];
    const invoices = await db.collection('invoices').find({
      tenant_id: principal.tenantId,
      id: req.params.id,
    });

    if (invoices.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoices[0];
    const items = await db.collection('invoice_items').find({ invoice_id: invoice.id });

    res.json({
      id: invoice.id,
      customer_id: invoice.customer_id,
      total_amount: invoice.total_amount,
      status: invoice.status,
      items_count: items.length,
      created_at: invoice.created_at,
    });
  } catch (error) {
    console.error('Error fetching invoice:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

export { app, services };
