export interface Invoice extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  customer: string;
  amount: number;
  status: 'pending' | 'completed';
  created_at: string;
  created_by: string;
  __version?: number;
}
