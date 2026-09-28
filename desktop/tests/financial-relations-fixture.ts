/** Generated financial history only. No local profile, account or network access. */
export function financialRelationsFixture(count: number) {
  const raw: Record<string, Record<string, unknown>[] | number | object> = {
    settings: {}, schema_version: 60,
  };
  const rows = (make: (index: number) => Record<string, unknown>) => Array.from({ length: count }, (_, index) => make(index));
  raw.invoices = rows(i => ({ id: `invoice-${i}`, type: i % 2 ? 'avoir' : 'standard', status: 'emise', total_cents: 10810, currency: 'CHF' }));
  raw.quote_invoice_pairs = rows(i => ({ deposit_invoice_id: `invoice-${i}`, balance_invoice_id: `invoice-${i + 1}` }));
  raw.customer_credit_balances = rows(i => ({ credit_note_id: `invoice-${i}`, allocated_cents: 1000, refunded_cents: 500, remaining_cents: 9310 }));
  raw.customer_credit_settlements = rows(i => ({ id: `settlement-${i}`, credit_note_id: `invoice-${i}`, invoice_id: `invoice-${Math.max(0, i - 1)}`, event_type: i % 3 ? 'allocate' : 'reverse', amount_cents: 1000, journal_valid: i % 2 === 0 }));
  raw.expenses = rows(i => ({ id: `expense-${i}`, net_cents: 10000, vat_cents: 810, total_cents: 10810, cost_cents: 10000 }));
  raw.expense_refunds = rows(i => ({ id: `expense-refund-${i}`, expense_id: `expense-${i}`, event_type: 'refund', total_cents: 10810, cost_cents: 10000 }));
  raw.supplier_invoices = rows(i => ({ id: `supplier-invoice-${i}`, status: 'validated', total_cents: 10810, paid_cents: 3000, credited_cents: 1000 }));
  raw.attachments = rows(i => ({ id: `attachment-${i}`, entity_type: 'supplier_invoice', entity_id: `supplier-invoice-${i}`, original_name: `Facture ${i}.pdf`, created_at: '2026-09-01T10:00:00Z', size_bytes: 1000 }));
  raw.supplier_credit_notes = rows(i => ({ id: `supplier-credit-${i}`, total_cents: 10810, status: 'validated' }));
  raw.supplier_credit_allocations = rows(i => ({ id: `allocation-${i}`, supplier_credit_note_id: `supplier-credit-${i}`, supplier_invoice_id: `supplier-invoice-${i}`, event_type: i % 3 ? 'allocate' : 'reverse', amount_cents: 1000 }));
  raw.supplier_credit_refunds = rows(i => ({ id: `supplier-refund-${i}`, supplier_credit_note_id: `supplier-credit-${i}`, event_type: i % 3 ? 'refund' : 'reverse', amount_cents: 500 }));
  raw.supplier_expense_reclassifications = rows(i => ({ id: `reclassification-${i}`, supplier_invoice_id: `supplier-invoice-${i}` }));
  raw.supplier_expense_reclassification_lines = rows(i => ({ id: `reclassification-line-${i}`, reclassification_id: `reclassification-${i}`, amount_cents: 10000 }));
  raw.catalog_items = rows(i => ({ id: `product-${i}`, kind: 'product', track_stock: 1, stock_quantity_milli: 5000 }));
  raw.stock_reservation_events = rows(i => ({ id: `reservation-${i}`, catalog_item_id: `product-${i}`, quantity_delta_milli: i % 2 ? -500 : 1000 }));
  return raw as Record<string, any>;
}
