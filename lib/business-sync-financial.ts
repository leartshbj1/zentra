import type { AccountingRule } from './business-sync-accounting';
import { structuralRows as rows } from './business-sync-structure';

// These queries run after the schema checks and before canonical publication.
// Every projected table is scoped to the same immutable transfer and company.
// Split signed sums keep cancellation exact, including sums beyond int64.
const high = (c: string) =>
  `(SUM(${c}/1000000000)+SUM(${c}%1000000000)/1000000000)`;
const low = (c: string) => `(SUM(${c}%1000000000)%1000000000)`;
const nonzero = (c: string) => `(${high(c)}<>0 OR ${low(c)}<>0)`;
const negative = (c: string) =>
  `(${high(c)}<0 OR (${high(c)}=0 AND ${low(c)}<0))`;
const positive = (c: string) =>
  `(${high(c)}>0 OR (${high(c)}=0 AND ${low(c)}>0))`;
// Native i128 round_basis_points, decomposed to avoid a value*rate overflow.
const rate = (value: string, bp: string) =>
  `(CASE WHEN ${value}<0 THEN -1 ELSE 1 END*(ABS(${value})/10000*${bp}+(ABS(${value})%10000*${bp}+5000)/10000))`;
const amounts = [
  'subtotal_cents',
  'discount_cents',
  'vat_cents',
  'total_cents',
];
function salesRules(table: 'invoices' | 'quotes'): AccountingRule[] {
  const itemTable = table === 'invoices' ? 'invoice_items' : 'quote_items';
  const parent = table === 'invoices' ? 'invoice_id' : 'quote_id';
  const items = rows(itemTable, [
    parent,
    'quantity',
    'unit_price_cents',
    'discount_bp',
    'vat_bp',
    'line_net_cents',
    'line_vat_cents',
    'line_total_cents',
  ]);
  const prefix = `WITH items AS (${items}), bases AS (SELECT *,CAST(ROUND(quantity*unit_price_cents) AS INTEGER) AS base FROM items)`;
  return [
    {
      id: `${itemTable}:amounts`,
      sql: `${prefix} SELECT __key FROM bases WHERE
        ABS(quantity*unit_price_cents)>=9223372036854775808.0
        OR line_net_cents<>base-${rate('base', 'discount_bp')}
        OR line_vat_cents<>${rate('line_net_cents', 'vat_bp')}
        OR line_total_cents<>line_net_cents+line_vat_cents LIMIT 1`,
    },
    {
      id: `${table}:totals`,
      sql: `${prefix}, documents AS (${rows(table, ['id', ...amounts])}), movements AS (
        SELECT ${parent} AS id,base AS subtotal_cents,base-line_net_cents AS discount_cents,line_vat_cents AS vat_cents,line_total_cents AS total_cents FROM bases
        UNION ALL SELECT id,${amounts.map((c) => `-${c}`).join(',')} FROM documents)
        SELECT id AS __key FROM movements GROUP BY id HAVING ${amounts.map(nonzero).join(' OR ')} LIMIT 1`,
    },
  ];
}
function paidRule(table: 'invoices' | 'supplier_invoices'): AccountingRule {
  const paymentTable = table === 'invoices' ? 'payments' : 'supplier_payments';
  const parent = table === 'invoices' ? 'invoice_id' : 'supplier_invoice_id';
  return {
    id: `${table}:paid`,
    sql: `WITH invoices AS (${rows(table, ['id', 'paid_cents'])}), payments AS (${rows(paymentTable, [parent, 'amount_cents'])}), movements AS (
      SELECT ${parent} AS id,amount_cents AS amount FROM payments UNION ALL SELECT id,-paid_cents FROM invoices)
      SELECT id AS __key FROM movements GROUP BY id HAVING ${nonzero('amount')} LIMIT 1`,
  };
}
const invoices = rows('invoices', [
  'id',
  'type',
  'number',
  'status',
  'issue_date',
  'currency',
  'total_cents',
  'paid_cents',
  'original_invoice_id',
]);
const settlements = rows('customer_credit_settlements', [
  'id',
  'credit_note_id',
  'invoice_id',
  'event_type',
  'amount_cents',
]);
// Same dated/legacy distinction as customer_invoice_credit_movements. A dated
// credit note contributes only its applications, not its entire face value.
const creditCtes = `invoices AS MATERIALIZED (${invoices}), documents AS MATERIALIZED (${rows('customer_credit_documents', ['credit_note_id'])}), settlements AS (${settlements}), credits AS (
  SELECT i.original_invoice_id AS invoice_id,-i.total_cents AS amount FROM invoices i LEFT JOIN documents d ON d.credit_note_id=i.id
  WHERE i.type='avoir' AND i.number IS NOT NULL AND i.status<>'annulee' AND d.credit_note_id IS NULL
  UNION ALL SELECT invoice_id,CASE event_type WHEN 'apply' THEN amount_cents ELSE -amount_cents END FROM settlements WHERE event_type IN ('apply','reverse_apply'))`;

export const financialRules: AccountingRule[] = [
  ...salesRules('quotes'),
  ...salesRules('invoices'),
  {
    id: 'expenses:amounts',
    sql: `WITH expenses AS (${rows('expenses', ['net_cents', 'vat_cents', 'total_cents'])}) SELECT __key FROM expenses
      WHERE net_cents<0 OR vat_cents<0 OR total_cents<>net_cents+vat_cents LIMIT 1`,
  },
  paidRule('invoices'),
  paidRule('supplier_invoices'),
  {
    id: 'payments:invoice',
    sql: `WITH invoices AS MATERIALIZED (${invoices}), payments AS (${rows('payments', ['invoice_id', 'date'])})
      SELECT p.__key FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.type='avoir' OR i.number IS NULL
      OR i.status NOT IN ('emise','en_retard','partiellement_payee','payee') OR i.total_cents<=0
      OR i.issue_date IS NULL OR p.date<i.issue_date LIMIT 1`,
  },
  {
    id: 'supplier_payments:invoice',
    sql: `WITH invoices AS MATERIALIZED (${rows('supplier_invoices', ['id', 'status', 'document_date'])}), payments AS (${rows('supplier_payments', ['supplier_invoice_id', 'date'])})
      SELECT p.__key FROM payments p JOIN invoices i ON i.id=p.supplier_invoice_id
      WHERE i.status<>'validated' OR p.date<i.document_date LIMIT 1`,
  },
  {
    id: 'invoices:settled',
    sql: `WITH ${creditCtes}, movements AS (
      SELECT invoice_id AS id,amount FROM credits UNION ALL SELECT id,paid_cents-total_cents FROM invoices WHERE type<>'avoir')
      SELECT m.id AS __key FROM movements m JOIN invoices i ON i.id=m.id AND i.type<>'avoir' GROUP BY m.id
      HAVING ${positive('amount')} LIMIT 1`,
  },
  {
    id: 'invoices:credit_balance',
    sql: `WITH ${creditCtes} SELECT invoice_id AS __key FROM credits GROUP BY invoice_id HAVING ${negative('amount')} LIMIT 1`,
  },
  {
    id: 'credits:available',
    sql: `WITH ${creditCtes}, movements AS (
      SELECT credit_note_id AS id,CASE WHEN event_type IN ('apply','refund') THEN amount_cents ELSE -amount_cents END AS amount FROM settlements
      UNION ALL SELECT i.id,i.total_cents FROM invoices i JOIN documents d ON d.credit_note_id=i.id)
      SELECT id AS __key FROM movements GROUP BY id HAVING ${positive('amount')} LIMIT 1`,
  },
  {
    id: 'credits:reversals',
    sql: `WITH settlements AS (${settlements}), movements AS (SELECT credit_note_id,
      CASE WHEN event_type IN ('apply','reverse_apply') THEN 'application' ELSE 'refund' END AS kind,
      CASE WHEN event_type IN ('apply','refund') THEN amount_cents ELSE -amount_cents END AS amount FROM settlements)
      SELECT credit_note_id AS __key FROM movements GROUP BY credit_note_id,kind HAVING ${negative('amount')} LIMIT 1`,
  },
  {
    id: 'quote_invoice_pairs:documents',
    sql: `WITH pairs AS (${rows('quote_invoice_pairs', ['quote_id', 'deposit_invoice_id', 'balance_invoice_id'])}),
      invoices AS MATERIALIZED (${rows('invoices', ['id', 'client_id', 'project_id', 'quote_id', 'type', 'currency', ...amounts])}),
      quotes AS MATERIALIZED (${rows('quotes', ['id', 'client_id', 'project_id', 'currency', ...amounts])})
      SELECT p.__key FROM pairs p JOIN invoices d ON d.id=p.deposit_invoice_id JOIN invoices b ON b.id=p.balance_invoice_id JOIN quotes q ON q.id=p.quote_id
      WHERE d.type<>'acompte' OR b.type<>'finale' OR d.quote_id IS NOT q.id OR b.quote_id IS NOT q.id
      OR d.client_id IS NOT q.client_id OR b.client_id IS NOT q.client_id OR d.project_id IS NOT q.project_id OR b.project_id IS NOT q.project_id
      OR d.currency<>q.currency OR b.currency<>q.currency
      OR ${amounts.map((c) => `d.${c}+b.${c}<>q.${c}`).join(' OR ')} LIMIT 1`,
  },
];
