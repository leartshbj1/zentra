export const transitionField = (image: number, name: string) =>
  `json_extract(?${image},'$.${name}')`;
export const transitionDifferent = (fields: readonly string[]) =>
  fields
    .map(
      (name) =>
        `${transitionField(22, name)} IS NOT ${transitionField(23, name)}`,
    )
    .join(' OR ');
export const transitionParentPredicates: Record<
  string,
  (row: string) => string
> = {
  invoices: (row) => `json_extract(${row},'$.number') IS NOT NULL`,
  quotes: (row) => `json_extract(${row},'$.number') IS NOT NULL`,
  payslips: (row) =>
    `json_extract(${row},'$.status') IN ('comptabilise','paye')`,
  supplier_invoices: (row) => `json_extract(${row},'$.status')<>'draft'`,
  supplier_credit_notes: (row) => `json_extract(${row},'$.status')='validated'`,
};
// A source value cannot replace missing evidence of an earlier parent change.
export function transitionParentLocked(
  table: string,
  key: string,
  missing = 0,
) {
  const predicate = transitionParentPredicates[table];
  if (!predicate) throw new Error('Unknown transition parent');
  return `COALESCE((SELECT issued FROM business_sync_transaction_document_states WHERE transfer_id=?1 AND validator_sha256=?15 AND table_name='${table}' AND row_key_json=${key}),
 CASE WHEN EXISTS(SELECT 1 FROM business_sync_transaction_changes WHERE transaction_id=?1 AND organization_id=?2 AND table_name='${table}' AND row_key_json=${key} AND (part_index,change_index)<(?24,?25)) THEN -1
 ELSE COALESCE((SELECT CASE WHEN ${predicate('row_json')} THEN 1 ELSE 0 END FROM business_sync_versions WHERE transfer_id=?17 AND organization_id=?2 AND table_name='${table}' AND row_key_json=${key}),${missing}) END)`;
}
export function transitionDraftParents(table: string, foreignKey: string) {
  return [22, 23]
    .map(
      (image) =>
        `(?${image} IS NOT NULL AND ${transitionParentLocked(table, `json_array(${transitionField(image, foreignKey)})`, -2)}<>0)`,
    )
    .join(' OR ');
}
// Only use this lookup for append-only rows, or rows whose later deletion is
// separately forbidden once their parent is validated. It preserves the source
// and inserts that actually precede this change; future inserts stay invisible.
export function transitionRowVisible(table: string, alias: string) {
  // Draft credit allocations may be deleted and recreated under the same key.
  // Only the original image or an earlier insertion of this exact image can be
  // visible, and a later deletion ends that lifetime. A future replacement must
  // not inherit the old allocation's date of appearance.
  const conditional = table === 'supplier_credit_allocations';
  const undeleted = (after?: string) =>
    `NOT EXISTS(SELECT 1 FROM business_sync_transaction_changes removed WHERE removed.transaction_id=?1 AND removed.organization_id=?2 AND removed.table_name='${table}' AND removed.row_key_json=${alias}.row_key_json AND removed.operation='delete' AND (removed.part_index,removed.change_index)<(?24,?25) ${after ? `AND (removed.part_index,removed.change_index)>(${after}.part_index,${after}.change_index)` : ''})`;
  return `${alias}.transfer_id=?1 AND ${alias}.organization_id=?2 AND ${alias}.table_name='${table}' AND (
 EXISTS(SELECT 1 FROM business_sync_versions original WHERE original.transfer_id=?17 AND original.organization_id=?2 AND original.table_name='${table}' AND original.row_key_json=${alias}.row_key_json ${conditional ? `AND original.row_sha256=${alias}.row_sha256 AND ${undeleted()}` : ''})
 OR EXISTS(SELECT 1 FROM business_sync_transaction_changes change WHERE change.transaction_id=?1 AND change.organization_id=?2 AND change.table_name='${table}' AND change.row_key_json=${alias}.row_key_json AND change.operation='insert' AND (change.part_index,change.change_index)<(?24,?25) ${conditional ? `AND change.after_sha256=${alias}.row_sha256 AND ${undeleted('change')}` : ''}))`;
}
