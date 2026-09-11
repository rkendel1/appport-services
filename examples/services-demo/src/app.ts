import { randomUUID } from 'node:crypto';
import { appport } from '@appport/runtime';
import type { Invoice } from './models.js';

const application = await appport({
  routes: {
    'POST /invoices': async ({ body, principal, services, application }) => {
      if (!principal) throw new Error('Authentication is required');
      const input = body as { customer?: string; amount?: number };
      if (!input.customer || typeof input.amount !== 'number') throw new Error('Invalid invoice');
      const invoice: Invoice = {
        id: randomUUID(), tenant_id: principal.tenantId, customer: input.customer,
        amount: input.amount, status: 'pending', created_at: new Date().toISOString(), created_by: principal.principalId,
      };
      await application.state.collection<Invoice>('invoices').insert(invoice, invoice.id);
      await services.publish('invoice.created', { id: invoice.id, customer: invoice.customer, amount: invoice.amount });
      await services.jobs.enqueue({ type: 'invoice.process', payload: { invoiceId: invoice.id } });
      return invoice;
    },
    'GET /invoices': async ({ principal, application }) => {
      if (!principal) throw new Error('Authentication is required');
      return application.state.collection<Invoice>('invoices').find({ tenant_id: principal.tenantId });
    },
  },
  jobHandlers: { 'invoice.process': async (job) => console.log('Processing invoice', job.payload) },
});

console.log(`Application listening at ${application.http?.url}`);
export default application;
