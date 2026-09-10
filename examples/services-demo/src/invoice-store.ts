import type { StateFirstDB } from '@feltdb/core';
import type { Invoice, InvoiceStore } from './models.js';

const INVOICES_COLLECTION = 'invoices';

export class FeltDbInvoiceStore implements InvoiceStore {
  private readonly invoices;

  constructor(private readonly db: StateFirstDB) {
    this.invoices = db.collection<Invoice>(INVOICES_COLLECTION);
  }

  async create(invoice: Invoice): Promise<void> {
    await this.db.transaction({
      operations: [
        {
          collection: INVOICES_COLLECTION,
          id: invoice.id,
          requireAbsent: true,
          value: invoice,
        },
      ],
    });
  }

  async get(tenantId: string, id: string): Promise<Invoice | null> {
    const invoice = await this.invoices.get(id);
    if (!invoice || invoice.tenant_id !== tenantId) {
      return null;
    }
    return invoice;
  }

  async list(tenantId: string): Promise<readonly Invoice[]> {
    return this.invoices.find({ tenant_id: tenantId });
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: Invoice['status'],
  ): Promise<Invoice | null> {
    const invoice = await this.get(tenantId, id);
    if (!invoice) {
      return null;
    }

    const updated = await this.invoices.updateIfVersion(id, invoice.__version, {
      status,
      processed_at: new Date().toISOString(),
    });

    if (!updated.updated || !updated.item) {
      return null;
    }

    return updated.item;
  }
}
