/**
 * Domain models for the invoice application.
 * These are application-owned state, not AppPort service state.
 */

export interface Customer {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  created_at: string;
  created_by: string;
  __version?: number;
}

export interface InvoiceItem {
  id: string;
  invoice_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

export interface Invoice {
  id: string;
  tenant_id: string;
  customer_id: string;
  items: InvoiceItem[];
  total_amount: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: string;
  created_by: string;
  updated_at: string;
  __version?: number;
}

export interface InvoiceRequest {
  customer_id: string;
  items: Array<{
    description: string;
    quantity: number;
    unit_price: number;
  }>;
}
