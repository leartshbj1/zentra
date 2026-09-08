import { boundedPositiveSum, boundedSignedSum } from './business-sync-money';
import { transitionField as f } from './business-sync-transition-state';
import {
  transitionRows as rows,
  transitionMissingRows as missing,
} from './business-sync-transition-rows';
import { transitionJournalProof as journal } from './business-sync-accounting-transitions';

const fields = (table: string, names: readonly string[]) =>
  `SELECT ${names.map((n) => `json_extract(row_json,'$.${n}') ${n}`).join(',')} FROM (${rows(table)})`;
const posting = `?23 IS NOT NULL AND ${f(23, 'status')}='validated' AND (?22 IS NULL OR ${f(22, 'status')}='draft')`;
const sum = (column: string) =>
  `CASE WHEN COUNT(*)=0 THEN 0 ELSE ${boundedPositiveSum(column)} END`;
function validItems(credit: boolean) {
  const table = credit
    ? 'supplier_credit_note_items'
    : 'supplier_invoice_items';
  const parent = credit ? 'supplier_credit_note_id' : 'supplier_invoice_id';
  return `EXISTS(SELECT 1 FROM (${fields(table, [parent, 'line_net_cents', 'line_vat_cents', 'line_total_cents', ...(credit ? [] : ['posted_expense_account_id'])])}) item WHERE item.${parent}=${f(23, 'id')}
    GROUP BY item.${parent} HAVING ${sum('line_net_cents')} IS ${f(23, 'net_cents')} AND ${sum('line_vat_cents')} IS ${f(23, 'vat_cents')} AND ${sum('line_total_cents')} IS ${f(23, 'total_cents')}
    ${credit ? '' : 'AND SUM(CASE WHEN line_net_cents>0 AND posted_expense_account_id IS NULL THEN 1 ELSE 0 END)=0'})`;
}
// Preserve the native matching tolerance and its aggregate check. The posting
// amounts themselves remain exact cent integers; only this native order-line
// proportional tolerance uses SQLite ROUND, as the source trigger does.
const matching = `WITH matches AS MATERIALIZED (${fields('supplier_invoice_matches', ['supplier_invoice_id', 'supplier_order_line_id', 'quantity_milli', 'net_cents', 'vat_cents', 'total_cents'])}),
  orders AS MATERIALIZED (${fields('supplier_order_lines', ['id', 'quantity_milli', 'line_net_cents', 'line_vat_cents', 'line_total_cents'])}),
  differences AS MATERIALIZED (SELECT o.id,o.quantity_milli quantity,
    m.net_cents-CAST(ROUND(CAST(o.line_net_cents AS REAL)*CAST(m.quantity_milli AS REAL)/CAST(o.quantity_milli AS REAL)) AS INTEGER) net,
    m.vat_cents-CAST(ROUND(CAST(o.line_vat_cents AS REAL)*CAST(m.quantity_milli AS REAL)/CAST(o.quantity_milli AS REAL)) AS INTEGER) vat,
    m.total_cents-CAST(ROUND(CAST(o.line_total_cents AS REAL)*CAST(m.quantity_milli AS REAL)/CAST(o.quantity_milli AS REAL)) AS INTEGER) total
    FROM matches m LEFT JOIN orders o ON o.id=m.supplier_order_line_id WHERE m.supplier_invoice_id=${f(23, 'id')})
  SELECT 1 FROM differences WHERE id IS NULL OR quantity<=0 OR typeof(net)<>'integer' OR typeof(vat)<>'integer' OR typeof(total)<>'integer' OR ABS(net)>1 OR ABS(vat)>1 OR ABS(total)>1
  UNION ALL SELECT COUNT(*) FROM differences HAVING COUNT(*)>0 AND (ABS(${boundedSignedSum('net')})>1 OR ABS(${boundedSignedSum('vat')})>1 OR ABS(${boundedSignedSum('total')})>1)`;
const allocated = `(SELECT CASE WHEN COUNT(*)=0 THEN 0 ELSE ${boundedSignedSum('amount')} END FROM
  (SELECT CASE json_extract(row_json,'$.event_type') WHEN 'apply' THEN json_extract(row_json,'$.amount_cents') ELSE -json_extract(row_json,'$.amount_cents') END amount
   FROM (${rows('supplier_credit_allocations')}) WHERE json_extract(row_json,'$.supplier_credit_note_id')=${f(23, 'id')}))`;
const closed = `EXISTS(SELECT 1 FROM (${rows('accounting_periods')}) WHERE json_extract(row_json,'$.status')='closed' AND ${f(23, 'document_date')} BETWEEN json_extract(row_json,'$.date_from') AND json_extract(row_json,'$.date_to'))`;
export const supplierPostingConditions = [
  {
    table: 'supplier_invoices',
    id: 'transition:supplier-invoice-posting',
    invalid: `${posting} AND (
    ${missing(['supplier_invoice_items', 'supplier_invoice_matches', 'supplier_order_lines'])}
    OR ${f(23, 'reference_normalized')} IS NULL OR TRIM(${f(23, 'reference_normalized')})='' OR ${f(23, 'total_cents')}<=0
    OR ${f(23, 'paid_cents')} IS NOT 0 OR ${f(23, 'credited_cents')} IS NOT 0 OR ${f(23, 'due_date')}<${f(23, 'document_date')}
    OR NOT ${validItems(false)} OR EXISTS(${matching})
    OR NOT ${journal(f(23, 'validation_journal_entry_id'), 'supplier_invoice', f(23, 'id'), "'validate'", f(23, 'document_date'))})`,
  },
  {
    table: 'supplier_credit_notes',
    id: 'transition:supplier-credit-posting',
    invalid: `(?22 IS NULL AND ?23 IS NOT NULL AND ${f(23, 'status')}<>'draft') OR (${posting} AND (
    ${missing(['supplier_credit_note_items', 'supplier_credit_allocations', 'accounting_periods'])}
    OR ${f(23, 'number')} IS NULL OR ${f(23, 'validated_at')} IS NULL OR ${f(23, 'snapshot_json')} IS NULL
    OR NOT ${validItems(true)} OR ${allocated} IS NULL OR ${allocated}>${f(23, 'total_cents')} OR ${closed}
    OR NOT ${journal(f(23, 'validation_journal_entry_id'), 'supplier_credit_note', f(23, 'id'), "'validate'", f(23, 'document_date'))}))`,
  },
];
