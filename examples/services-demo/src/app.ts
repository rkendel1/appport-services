import { randomUUID } from 'node:crypto';
import { appport } from '@appport/runtime';
import type { Invoice } from './models.js';
import { developmentAuthorizer } from './authority.js';

const application = await appport({
  // AuthBoundry decides every service effect. Replace the development stand-in with your AuthBoundry client.
  authorizer: developmentAuthorizer,
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
      // Webhook fan-out and job enqueue are authorized effects performed as the verified caller.
      await services.publish('invoice.created', { id: invoice.id, customer: invoice.customer, amount: invoice.amount }, principal);
      await services.jobs.enqueue({ type: 'invoice.process', payload: { invoiceId: invoice.id } }, principal);
      return invoice;
    },
    'GET /invoices': async ({ principal, application }) => {
      if (!principal) throw new Error('Authentication is required');
      return application.state.collection<Invoice>('invoices').find({ tenant_id: principal.tenantId });
    },
  },
  jobs: { 'invoice.process': async (job) => console.log('Processing invoice', job.payload) },
});

console.log(`Application listening at ${application.http?.url}`);
export default application;
