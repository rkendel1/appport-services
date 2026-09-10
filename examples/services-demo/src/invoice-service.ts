import { randomUUID } from 'node:crypto';
import type { AuthenticatedPrincipal } from '@appport/services';
import type {
  WebhookService,
  JobService,
} from '@appport/services';
import type { Invoice, InvoiceStore } from './models.js';

export class InvoiceService {
  constructor(
    private readonly invoiceStore: InvoiceStore,
    private readonly webhookService: WebhookService,
    private readonly jobService: JobService,
  ) {}

  async createInvoice(
    principal: AuthenticatedPrincipal,
    customer: string,
    amount: number,
  ): Promise<Invoice> {
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

    // Create the invoice in durable storage
    await this.invoiceStore.create(invoice);

    // Establish webhook delivery intent for invoice.created event
    await this.webhookService.emitWebhookEvent({
      tenantId: principal.tenantId,
      type: 'invoice.created',
      payload: {
        id: invoiceId,
        customer,
        amount,
      },
    });

    // Establish durable job to process the invoice
    await this.jobService.enqueue({
      tenantId: principal.tenantId,
      type: 'invoice.process',
      payload: {
        invoiceId,
      },
      maxAttempts: 3,
    });

    return invoice;
  }

  async getInvoice(
    principal: AuthenticatedPrincipal,
    invoiceId: string,
  ): Promise<Invoice | null> {
    return this.invoiceStore.get(principal.tenantId, invoiceId);
  }

  async listInvoices(principal: AuthenticatedPrincipal): Promise<readonly Invoice[]> {
    return this.invoiceStore.list(principal.tenantId);
  }
}
