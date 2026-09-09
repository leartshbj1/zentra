// Sparse projections of changed accounting rows. Unchanged source rows remain
// in the canonical snapshot; a NULL projection is a deletion tombstone.
import { nativeGuardReadColumns } from './business-sync-native-guard-contract';
import { rowUniqueColumns } from './business-sync-row-contract';
const manualColumns: Record<string, readonly string[]> = {
  supplier_invoice_items: [
    'id',
    'supplier_invoice_id',
    'line_net_cents',
    'line_vat_cents',
    'line_total_cents',
    'posted_expense_account_id',
  ],
  supplier_credit_note_items: [
    'id',
    'supplier_credit_note_id',
    'line_net_cents',
    'line_vat_cents',
    'line_total_cents',
  ],
  supplier_invoice_matches: [
    'id',
    'supplier_invoice_id',
    'supplier_order_line_id',
    'quantity_milli',
    'net_cents',
    'vat_cents',
    'total_cents',
  ],
  supplier_order_lines: [
    'id',
    'quantity_milli',
    'line_net_cents',
    'line_vat_cents',
    'line_total_cents',
  ],
  supplier_credit_allocations: [
    'id',
    'supplier_credit_note_id',
    'supplier_invoice_id',
    'event_type',
    'amount_cents',
  ],
  accounting_periods: ['id', 'status', 'date_from', 'date_to'],
  payslips: ['id', 'employee_id', 'period', 'status'],
};
export const transitionRowColumns = Object.fromEntries(
  [
    ...new Set([
      ...Object.keys(manualColumns),
      ...Object.keys(nativeGuardReadColumns),
      ...Object.keys(rowUniqueColumns),
    ]),
  ]
    .sort()
    .map((table) => [
      table,
      [
        ...new Set([
          ...(manualColumns[table] ?? []),
          ...(nativeGuardReadColumns[table] ?? []),
          ...(rowUniqueColumns[table] ?? []),
        ]),
      ].sort(),
    ]),
);
function projectedField(table: string, column: string, row: string) {
  // Stock movements are append-only. Their canonical insertion order is
  // already fixed by review and cannot be taken from another device's counter.
  if (table === 'stock_movements' && column === 'sequence')
    return `CAST((SELECT source_rowid FROM business_sync_row_order WHERE transfer_id=?1 AND table_name='stock_movements' AND row_key_json=json_array(json_extract(${row},'$.id'))) AS INTEGER)`;
  return `json_extract(${row},'$.${column}')`;
}
export function transitionRowProjection(table: string, row: string) {
  const columns = transitionRowColumns[table];
  if (!columns) throw new Error('Unknown accounting transition table');
  let result = `json_object(${columns
    .slice(0, 16)
    .flatMap((c) => [`'${c}'`, projectedField(table, c, row)])
    .join(',')})`;
  for (let i = 16; i < columns.length; i += 15)
    result = `json_set(${result},${columns
      .slice(i, i + 15)
      .flatMap((c) => [`'$.${c}'`, projectedField(table, c, row)])
      .join(',')})`;
  return `CASE WHEN ${row} IS NULL THEN NULL ELSE ${result} END`;
}
export function transitionRows(table: string) {
  if (!transitionRowColumns[table])
    throw new Error('Unknown accounting transition table');
  const state = `state.transfer_id=?1 AND state.validator_sha256=?15 AND state.table_name='${table}'`;
  return `SELECT state.row_key_json,state.row_json FROM business_sync_transaction_accounting_states state WHERE ${state} AND state.row_json IS NOT NULL
  UNION ALL SELECT source.row_key_json,${transitionRowProjection(table, 'source.row_json')} FROM business_sync_versions source WHERE source.transfer_id=?17 AND source.organization_id=?2 AND source.table_name='${table}'
  AND NOT EXISTS(SELECT 1 FROM business_sync_transaction_accounting_states state WHERE ${state} AND state.row_key_json=source.row_key_json)`;
}
export function transitionMissingRows(tables: readonly string[]) {
  for (const table of tables)
    if (!transitionRowColumns[table])
      throw new Error('Unknown accounting transition table');
  return `EXISTS(SELECT 1 FROM business_sync_transaction_changes change WHERE change.transaction_id=?1 AND change.organization_id=?2 AND change.table_name IN (${tables.map((t) => `'${t}'`).join(',')}) AND (change.part_index,change.change_index)<(?24,?25)
    AND NOT EXISTS(SELECT 1 FROM business_sync_transaction_accounting_states state WHERE state.transfer_id=?1 AND state.validator_sha256=?15 AND state.table_name=change.table_name AND state.row_key_json=change.row_key_json))`;
}
export const transitionRowRecordSql = `INSERT INTO business_sync_transaction_accounting_states(transfer_id,validator_sha256,table_name,row_key_json,row_json)
  SELECT ?1,?15,?20,?21,CASE ?20 ${Object.keys(transitionRowColumns)
    .map((t) => `WHEN '${t}' THEN ${transitionRowProjection(t, '?23')}`)
    .join(' ')} END WHERE __ACTIVE__
  ON CONFLICT(transfer_id,validator_sha256,table_name,row_key_json) DO UPDATE SET row_json=excluded.row_json`;
