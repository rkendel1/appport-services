export interface Invoice {
  id: string;
  tenant_id: string;
  customer: string;
  amount: number;
  status: 'pending' | 'processing' | 'completed';
  created_at: string;
  created_by: string;
  processed_at?: string;
}

export interface InvoiceStore {
  create(invoice: Invoice): Promise<void>;
  get(tenantId: string, id: string): Promise<Invoice | null>;
  list(tenantId: string): Promise<readonly Invoice[]>;
  updateStatus(
    tenantId: string,
    id: string,
    status: Invoice['status'],
  ): Promise<Invoice | null>;
}
