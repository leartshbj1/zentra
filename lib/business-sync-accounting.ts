// These checks supplement the native schema. They must run only after the
// structural receipt for this immutable bootstrap has been accepted.
export type AccountingRule = { id: string; sql: string };
const scope = (table: string) =>
  `transfer_id=?1 AND organization_id=?2 AND table_name='${table}'`;
const lines = `SELECT row_key_json AS __key,
  CAST(json_extract(row_json,'$.journal_entry_id') AS TEXT) AS entry_id,
  CAST(json_extract(row_json,'$.currency') AS TEXT) AS currency,
  CAST(json_extract(row_json,'$.debit_cents') AS INTEGER) AS debit,
  CAST(json_extract(row_json,'$.credit_cents') AS INTEGER) AS credit
  FROM business_sync_versions WHERE ${scope('journal_lines')}`;

// Split sums stay exact even when the total exceeds both JS's safe integer and
// SQLite's signed 64-bit accumulator. With <=200,000 input rows, every partial
// sum is bounded within int64. Carry propagation then checks the native i64 cap.
const sum = (
  column: string,
) => `SUM(${column}/1000000000)+SUM(${column}%1000000000)/1000000000 AS ${column}_high,
  SUM(${column}%1000000000)%1000000000 AS ${column}_low`;
const overflow = (column: string) =>
  `(${column}_high>9223372036 OR (${column}_high=9223372036 AND ${column}_low>854775807))`;

export const accountingRules: AccountingRule[] = [
  {
    id: 'journal:lines',
    sql: `WITH counts AS MATERIALIZED (
      SELECT CAST(json_extract(row_json,'$.journal_entry_id') AS TEXT) AS entry_id, COUNT(*) AS amount
      FROM business_sync_versions WHERE ${scope('journal_lines')} GROUP BY entry_id)
    SELECT e.row_key_json AS __key FROM business_sync_versions e
    LEFT JOIN counts ON counts.entry_id=CAST(json_extract(e.row_json,'$.id') AS TEXT)
    WHERE e.${scope('journal_entries')} AND COALESCE(counts.amount,0)<2 LIMIT 1`,
  },
  {
    id: 'journal:sides',
    sql: `WITH lines AS (${lines})
    SELECT __key FROM lines WHERE debit<0 OR credit<0 OR (debit=0)=(credit=0) LIMIT 1`,
  },
  {
    id: 'journal:balance',
    sql: `WITH lines AS (${lines}), totals AS (
      SELECT entry_id,currency,MIN(__key) AS __key,${sum('debit')},${sum('credit')}
      FROM lines GROUP BY entry_id,currency)
    SELECT __key FROM totals WHERE debit_high<>credit_high OR debit_low<>credit_low
      OR (debit_high=0 AND debit_low=0) OR ${overflow('debit')} OR ${overflow('credit')} LIMIT 1`,
  },
  {
    id: 'journal:range',
    sql: `WITH lines AS (${lines}), totals AS (
      SELECT entry_id,MIN(__key) AS __key,${sum('debit')},${sum('credit')} FROM lines GROUP BY entry_id)
    SELECT __key FROM totals WHERE ${overflow('debit')} OR ${overflow('credit')} LIMIT 1`,
  },
];
