/** Synthetic, deterministic workload. Never opens an actual company or calls a server. */
export function runtimeVolumeFixture(count: number) {
  const raw: Record<string, any> = { settings: {}, schema_version: 60 };
  for (const [table, items, foreign] of [
    ['quotes', 'quote_items', 'quote_id'], ['invoices', 'invoice_items', 'invoice_id'],
    ['payslips', 'payslip_items', 'payslip_id'], ['supplier_invoices', 'supplier_invoice_items', 'supplier_invoice_id'],
    ['sales_orders', 'sales_order_lines', 'sales_order_id'], ['delivery_notes', 'delivery_note_lines', 'delivery_note_id'],
    ['supplier_orders', 'supplier_order_lines', 'supplier_order_id'], ['supplier_receipts', 'supplier_receipt_lines', 'supplier_receipt_id'],
    ['supplier_credit_notes', 'supplier_credit_note_items', 'supplier_credit_note_id'],
  ]) {
    raw[table] = Array.from({ length: count }, (_, i) => ({ id: `${table}-${i}`, number: `${table}-${i}`, client_id: `client-${i % 50}`, status: table === 'invoices' ? 'emise' : 'validated', type: 'standard', issue_date: '2026-09-01', due_date: '2026-09-30', currency: i % 3 ? 'CHF' : 'EUR', created_at: '2026-09-01T12:00:00Z', total_cents: 86480, net_cents: 80000, vat_cents: 6480 }));
    raw[items] = raw[table].flatMap((row: any) => Array.from({ length: 8 }, (_, position) => ({ id: `${row.id}-line-${position}`, [foreign]: row.id, position: 7-position, description: `Ligne ${position}`, quantity: 1, quantity_milli: 1000, unit_price_cents: 10000, vat_rate_bp: 810, amount_cents: 10000, kind: 'earning', total_cents: 10810, net_cents: 10000, vat_cents: 810 })));
  }
  raw.clients = Array.from({ length: 50 }, (_, i) => ({ id: `client-${i}`, name: `Client ${i}` }));
  raw.payments = raw.invoices.map((row: any, i: number) => ({ id: `payment-${i}`, invoice_id: row.id, amount_cents: i % 2 ? 86480 : 43240, date: '2026-09-02' }));
  return raw;
}
