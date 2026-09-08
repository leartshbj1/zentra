// These source-state protections complement final-state accounting checks.
// They mirror schema.rs's immutable journals/payments/stock and invoice guards
// (including MIGRATION_V41's deposit fields). Other native transition guards
// still need coverage before a transaction can be committed canonically.
export const issuedInvoiceFields = [
  'number',
  'client_id',
  'project_id',
  'quote_id',
  'original_invoice_id',
  'title',
  'type',
  'deposit_percentage_bp',
  'deposit_basis_json',
  'issue_date',
  'due_date',
  'service_date_from',
  'service_date_to',
  'currency',
  'subtotal_cents',
  'discount_cents',
  'vat_cents',
  'total_cents',
  'notes',
  'terms',
  'snapshot_json',
] as const;
const scope = (alias: string, transfer: number, table: string) =>
  `${alias}.transfer_id=?${transfer} AND ${alias}.organization_id=?2 AND ${alias}.table_name='${table}'`;
const changed = 'incoming.row_sha256 IS NOT original.row_sha256';
export const transactionImmutabilityRules = [
  {
    id: 'immutable:append-only',
    sql: `SELECT 1 invalid FROM business_sync_transaction_changes WHERE transaction_id=?1 AND organization_id=?2
      AND table_name IN ('audit_log','journal_entries','journal_lines','payments','supplier_payments','stock_movements')
      AND operation IN ('update','delete') LIMIT 1`,
    source: false,
  },
  {
    id: 'immutable:issued-invoices',
    sql: `SELECT 1 invalid FROM business_sync_versions original LEFT JOIN business_sync_versions incoming
      ON ${scope('incoming', 1, 'invoices')} AND incoming.row_key_json=original.row_key_json
      WHERE ${scope('original', 3, 'invoices')} AND json_extract(original.row_json,'$.number') IS NOT NULL
      AND (incoming.row_json IS NULL OR ${issuedInvoiceFields.map((f) => `json_extract(incoming.row_json,'$.${f}') IS NOT json_extract(original.row_json,'$.${f}')`).join(' OR ')}) LIMIT 1`,
    source: true,
  },
  {
    id: 'immutable:issued-invoice-items',
    sql: `SELECT 1 invalid FROM business_sync_versions original JOIN business_sync_versions invoice
      ON ${scope('invoice', 3, 'invoices')} AND invoice.row_key_json=json_array(json_extract(original.row_json,'$.invoice_id'))
      LEFT JOIN business_sync_versions incoming ON ${scope('incoming', 1, 'invoice_items')} AND incoming.row_key_json=original.row_key_json
      WHERE ${scope('original', 3, 'invoice_items')} AND json_extract(invoice.row_json,'$.number') IS NOT NULL AND ${changed}
      UNION ALL
      SELECT 1 invalid FROM business_sync_versions incoming JOIN business_sync_versions invoice
      ON ${scope('invoice', 3, 'invoices')} AND invoice.row_key_json=json_array(json_extract(incoming.row_json,'$.invoice_id'))
      WHERE ${scope('incoming', 1, 'invoice_items')} AND json_extract(invoice.row_json,'$.number') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM business_sync_versions original WHERE ${scope('original', 3, 'invoice_items')} AND original.row_key_json=incoming.row_key_json) LIMIT 1`,
    source: true,
  },
  {
    id: 'immutable:frozen-qr-bills',
    sql: `SELECT 1 invalid FROM business_sync_versions original LEFT JOIN business_sync_versions incoming
      ON ${scope('incoming', 1, 'invoice_qr_bills')} AND incoming.row_key_json=original.row_key_json
      WHERE ${scope('original', 3, 'invoice_qr_bills')} AND ${changed}
      AND (json_extract(original.row_json,'$.frozen_at') IS NOT NULL OR EXISTS(SELECT 1 FROM business_sync_versions invoice
        WHERE ${scope('invoice', 3, 'invoices')} AND invoice.row_key_json=json_array(json_extract(original.row_json,'$.invoice_id'))
        AND json_extract(invoice.row_json,'$.number') IS NOT NULL)) LIMIT 1`,
    source: true,
  },
];
