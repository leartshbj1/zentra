// The source revision supplies the cumulative closed-through boundary. Using
// the final candidate's boundary would reject legitimate work performed before
// closing a new period in the same transaction. Intermediate transitions still
// require their own checks before full business validation can be enabled.
const scope = (alias: string, transfer: number, table: string) =>
  `${alias}.transfer_id=?${transfer} AND ${alias}.organization_id=?2 AND ${alias}.table_name='${table}'`;
const field = (alias: string, name: string) =>
  `json_extract(${alias}.row_json,'$.${name}')`;
const cutoff = `cutoff AS MATERIALIZED (SELECT COALESCE(MAX(json_extract(row_json,'$.date_to')),'0000-00-00') date FROM business_sync_versions WHERE transfer_id=?3 AND organization_id=?2 AND table_name='accounting_periods' AND json_extract(row_json,'$.status')='closed')`;
const through = '(SELECT date FROM cutoff)';
const changed = 'a.row_sha256 IS NOT b.row_sha256';
const pair = (table: string) =>
  `business_sync_versions a LEFT JOIN business_sync_versions b ON ${scope('b', 3, table)} AND b.row_key_json=a.row_key_json WHERE ${scope('a', 1, table)}`;
const badDate = (value: string) =>
  `(${value} IS NULL OR LENGTH(${value})<>10 OR ${value} NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' OR DATE(${value}) IS NULL OR DATE(${value}) IS NOT ${value})`;
const newDated = (table: string, date: string) =>
  `SELECT 1 invalid FROM ${pair(table)} AND b.row_json IS NULL AND (${badDate(field('a', date))} OR ${field('a', date)}<=${through})`;
const expenseFields = [
  'date',
  'supplier',
  'category',
  'reference',
  'currency',
  'net_cents',
  'vat_cents',
  'total_cents',
];
const expensePaidDate = (alias: string) =>
  `COALESCE(NULLIF(TRIM(${field(alias, 'paid_at')}),''),${field(alias, 'date')})`;
export const transactionClosureRules = [
  {
    id: 'closed:period-history',
    sql: `WITH ${cutoff} SELECT 1 invalid FROM business_sync_versions b LEFT JOIN business_sync_versions a
      ON ${scope('a', 1, 'accounting_periods')} AND a.row_key_json=b.row_key_json
      WHERE ${scope('b', 3, 'accounting_periods')} AND ${field('b', 'status')}='closed' AND ${changed}
      UNION ALL SELECT 1 invalid FROM ${pair('accounting_periods')} AND ${changed} AND ${field('a', 'date_from')}<=${through} LIMIT 1`,
    source: true,
  },
  {
    id: 'closed:period-dates',
    sql: `WITH periods AS (SELECT ${field('a', 'date_from')} date_from,
      MAX(${field('a', 'date_to')}) OVER (ORDER BY ${field('a', 'date_from')},${field('a', 'date_to')},a.row_key_json ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) previous_end
      FROM business_sync_versions a WHERE ${scope('a', 1, 'accounting_periods')})
      SELECT 1 invalid FROM business_sync_versions a WHERE ${scope('a', 1, 'accounting_periods')}
      AND (${badDate(field('a', 'date_from'))} OR ${badDate(field('a', 'date_to'))} OR ${field('a', 'date_from')}>${field('a', 'date_to')})
      UNION ALL SELECT 1 invalid FROM periods WHERE date_from<=previous_end LIMIT 1`,
    source: false,
  },
  {
    id: 'closed:journal-dates',
    sql: `WITH ${cutoff} ${newDated('journal_entries', 'entry_date')} LIMIT 1`,
    source: true,
  },
  {
    id: 'closed:journal-lines',
    sql: `WITH ${cutoff} SELECT 1 invalid FROM business_sync_versions a JOIN business_sync_versions entry
      ON ${scope('entry', 1, 'journal_entries')} AND entry.row_key_json=json_array(${field('a', 'journal_entry_id')})
      WHERE ${scope('a', 1, 'journal_lines')} AND ${field('entry', 'entry_date')}<=${through}
      AND NOT EXISTS(SELECT 1 FROM business_sync_versions b WHERE ${scope('b', 3, 'journal_lines')} AND b.row_key_json=a.row_key_json) LIMIT 1`,
    source: true,
  },
  {
    id: 'closed:invoice-issuance',
    sql: `WITH ${cutoff} SELECT 1 invalid FROM ${pair('invoices')}
      AND ${field('a', 'number')} IS NOT NULL AND TRIM(${field('a', 'number')})<>'' AND ${field('b', 'number')} IS NULL
      AND (${badDate(field('a', 'issue_date'))} OR ${field('a', 'issue_date')}<=${through}) LIMIT 1`,
    source: true,
  },
  {
    id: 'closed:supplier-validation',
    sql: `WITH ${cutoff} SELECT 1 invalid FROM ${pair('supplier_invoices')}
      AND ${field('a', 'status')}='validated' AND (b.row_json IS NULL OR ${field('b', 'status')}='draft')
      AND (${badDate(field('a', 'document_date'))} OR ${field('a', 'document_date')}<=${through}) LIMIT 1`,
    source: true,
  },
  {
    id: 'closed:payment-dates',
    sql: `WITH ${cutoff} ${newDated('payments', 'date')} UNION ALL ${newDated('supplier_payments', 'date')} LIMIT 1`,
    source: true,
  },
  {
    id: 'closed:expense-history',
    sql: `WITH ${cutoff} SELECT 1 invalid FROM ${pair('expenses')} AND ${changed} AND (
        ${badDate(field('a', 'date'))} OR (${field('a', 'paid_at')} IS NOT NULL AND TRIM(${field('a', 'paid_at')})<>'' AND ${badDate(field('a', 'paid_at'))})
        OR (b.row_json IS NULL AND (${field('a', 'date')}<=${through} OR (${field('a', 'paid_at')} IS NOT NULL AND TRIM(${field('a', 'paid_at')})<>'' AND ${field('a', 'paid_at')}<=${through})))
        OR (b.row_json IS NOT NULL AND (${expenseFields.map((f) => `${field('a', f)} IS NOT ${field('b', f)}`).join(' OR ')}) AND (${field('a', 'date')}<=${through} OR ${field('b', 'date')}<=${through}))
        OR (b.row_json IS NOT NULL AND (${field('a', 'payment_status')} IS NOT ${field('b', 'payment_status')} OR ${field('a', 'paid_at')} IS NOT ${field('b', 'paid_at')})
          AND ((${field('b', 'payment_status')}='paid' AND ${expensePaidDate('b')}<=${through}) OR (${field('a', 'payment_status')}='paid' AND ${expensePaidDate('a')}<=${through}))))
      UNION ALL SELECT 1 invalid FROM business_sync_versions b WHERE ${scope('b', 3, 'expenses')}
        AND (${field('b', 'date')}<=${through} OR (${field('b', 'paid_at')} IS NOT NULL AND TRIM(${field('b', 'paid_at')})<>'' AND ${field('b', 'paid_at')}<=${through}))
        AND NOT EXISTS(SELECT 1 FROM business_sync_versions a WHERE ${scope('a', 1, 'expenses')} AND a.row_key_json=b.row_key_json) LIMIT 1`,
    source: true,
  },
  {
    id: 'closed:vat-adjustment-dates',
    sql: `WITH ${cutoff} ${newDated('vat_adjustments', 'adjustment_date')} LIMIT 1`,
    source: true,
  },
];
