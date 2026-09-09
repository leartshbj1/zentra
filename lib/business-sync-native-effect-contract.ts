import { nativeAfterGuardContract } from './business-sync-native-guard-contract';
import protocol from '../desktop/src-tauri/src/business_sync_tables.json';

const shared = protocol.tables as Record<
  string,
  { columns: string[]; key: string[] }
>;
// These queues belong to the receiving installation, not to shared history.
export const receiverNativeEffects = [
  'project_document_queue_delete',
  'project_document_queue_insert',
] as const;
const dependencies: Record<string, string[]> = {
  bank_expense_register: ['bank_expense_reconciliation_registry'],
  employees_small_salary_decision_insert_history: [
    'employee_small_salary_decisions',
  ],
  employees_small_salary_decision_update_history: [
    'employee_small_salary_decisions',
    'payslips',
  ],
  stock_movements_apply_balance: ['catalog_items'],
  supplier_credit_allocations_apply_after_insert: [
    'supplier_invoices',
    'supplier_credit_allocations',
    'supplier_credit_notes',
  ],
  supplier_credit_allocations_apply_invoice_total: [
    'supplier_invoices',
    'supplier_credit_allocations',
    'supplier_credit_notes',
  ],
  supplier_payments_update_invoice_total: [
    'supplier_invoices',
    'supplier_payments',
  ],
};

// Parse only the reviewed, trusted trigger catalogue. SQL is never supplied by
// the uploading client. A new trigger shape must be reviewed explicitly.
export function splitNativeEffectSql(sql: string, delimiter = ',') {
  const parts: string[] = [];
  let depth = 0,
    quote = false,
    start = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      if (quote && sql[i + 1] === "'") {
        i++;
        continue;
      }
      quote = !quote;
    } else if (!quote) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (depth === 0 && sql.startsWith(delimiter, i)) {
        parts.push(sql.slice(start, i).trim());
        i += delimiter.length - 1;
        start = i + 1;
      }
    }
    if (depth < 0) throw new Error('Unbalanced native effect SQL');
  }
  if (quote || depth) throw new Error('Unbalanced native effect SQL');
  return [...parts, sql.slice(start).trim()];
}

export const nativeEffects = nativeAfterGuardContract.effects
  .filter((e) => !receiverNativeEffects.some((name) => name === e.name))
  .map((effect) => {
    if (!dependencies[effect.name])
      throw new Error(`Review native effect: ${effect.name}`);
    const header =
      /^CREATE TRIGGER (\w+)\s+AFTER (INSERT|UPDATE(?: OF [\s\S]+?)?) ON (\w+)(?:\s+WHEN ([\s\S]+?))?\s+BEGIN\s+([\s\S]+);\s*END$/.exec(
        effect.sql,
      );
    if (!header || header[1] !== effect.name || header[3] !== effect.table)
      throw new Error(`Review native effect syntax: ${effect.name}`);
    const operation = header[2].startsWith('UPDATE') ? 'update' : 'insert';
    const updateColumns =
      operation === 'update'
        ? header[2]
            .replace(/^UPDATE OF /, '')
            .split(',')
            .map((c) => c.trim())
        : [];
    const insert =
      /^INSERT INTO (\w+)\s*(?:\(([^)]+)\))?\s*VALUES\(([\s\S]+)\)$/.exec(
        header[5],
      );
    const update = /^UPDATE (\w+)\s+SET ([\s\S]+)$/.exec(header[5]);
    if (!insert && !update)
      throw new Error(`Review native effect statement: ${effect.name}`);
    const target = (insert ?? update)![1];
    if (!shared[target] || !dependencies[effect.name].includes(target))
      throw new Error(`Review native effect target: ${target}`);
    const body = update ? splitNativeEffectSql(update[2], ' WHERE ') : [];
    if (update && body.length !== 2)
      throw new Error(`Review native effect WHERE: ${effect.name}`);
    const fields = insert
      ? insert[2]
        ? insert[2].split(',').map((c) => c.trim())
        : shared[target].columns
      : splitNativeEffectSql(body[0]).map((assignment) =>
          assignment.slice(0, assignment.indexOf('=')).trim(),
        );
    const expressions = insert
      ? splitNativeEffectSql(insert[3])
      : splitNativeEffectSql(body[0]).map((assignment) =>
          assignment.slice(assignment.indexOf('=') + 1).trim(),
        );
    if (
      fields.length !== expressions.length ||
      fields.some((c) => !shared[target].columns.includes(c)) ||
      (insert && fields.length !== shared[target].columns.length)
    )
      throw new Error(`Review native effect columns: ${effect.name}`);
    return {
      ...effect,
      operation,
      updateColumns,
      condition: header[4] ?? '1',
      target,
      kind: insert ? 'insert' : 'update',
      fields,
      expressions,
      where: update ? body[1] : '1',
      dependencies: dependencies[effect.name],
    };
  });
if (
  nativeEffects.length !== Object.keys(dependencies).length ||
  nativeAfterGuardContract.effects.length !==
    nativeEffects.length + receiverNativeEffects.length
)
  throw new Error('Review the complete native effect catalogue');
export const nativeEffectReadColumns = Object.fromEntries(
  [...new Set(nativeEffects.flatMap((e) => e.dependencies))].map((table) => [
    table,
    table === 'payslips'
      ? ['employee_id', 'period', 'status']
      : shared[table].columns,
  ]),
);
export const nativeEffectContract = {
  nativeEffects,
  receiverNativeEffects,
  nativeEffectReadColumns,
};
