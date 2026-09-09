import {
  nativeGuardContract,
  nativeGuardReadColumns,
  nativeGuardField,
  serverNativeGuards,
  type NativeGuard,
} from './business-sync-native-guard-contract';
import {
  transitionMissingRows,
  transitionRows,
} from './business-sync-transition-rows';
import { balanceSqlPredicates } from './business-sync-sql-balance';

const field = (side: string, column: string) => `${side}."${column}"`;
const applicable = (guard: NativeGuard) => {
  if (guard.operation === 'insert') return '?22 IS NULL AND ?23 IS NOT NULL';
  if (guard.operation === 'delete') return '?22 IS NOT NULL AND ?23 IS NULL';
  return `?22 IS NOT NULL AND ?23 IS NOT NULL${
    guard.update_columns.length
      ? ` AND (${guard.update_columns.map((c) => `${field('OLD', c)} IS NOT ${field('NEW', c)}`).join(' OR ')})`
      : ''
  }`;
};
function condition(guard: NativeGuard) {
  let sql = guard.condition;
  // These two native guards hash exactly one assessment payload. Its digest
  // is computed from the exact current payload by the Worker, never supplied
  // by the uploading client. Additional native hash uses require review.
  if (guard.name === 'payslip_small_salary_assessments_integrity_insert_guard')
    sql = sql.replace('zentra_sha256(NEW.assessment_json)', '?26');
  if (guard.name === 'payslips_small_salary_posted_trace_update_guard')
    sql = sql.replace('zentra_sha256(t.assessment_json)', '?26');
  if (/zentra_\w+\(/i.test(sql))
    throw new Error(`Unmapped native function: ${guard.name}`);
  return balanceSqlPredicates(sql);
}
export function nativeGuardViewSql(name: string, sql: string) {
  if (name !== 'vat_source_fiscal_dates') return sql;
  const parts =
    /^(SELECT source_type,source_id,MIN\(fiscal_date\) AS fiscal_date\s+FROM \()([\s\S]*)(\)\s+WHERE fiscal_date[\s\S]*)$/.exec(
      sql,
    );
  if (!parts) throw new Error('Review the native fiscal date view');
  const arms = parts[2].split(/\bUNION ALL\b/);
  if (arms.length !== 7) throw new Error('Review native fiscal date sources');
  return `${parts[1]}WITH fiscal_a AS MATERIALIZED (${arms.slice(0, 4).join(' UNION ALL ')}),fiscal_b AS MATERIALIZED (${arms.slice(4).join(' UNION ALL ')}) SELECT * FROM fiscal_a UNION ALL SELECT * FROM fiscal_b ${parts[3]}`;
}
export function nativeGuardQueries(gate: string, args: string) {
  return Object.fromEntries(
    [...new Set(serverNativeGuards.map((g) => g.table))].sort().map((table) => {
      const guards = serverNativeGuards.filter((g) => g.table === table);
      const dependencies = [
        ...new Set(guards.flatMap((g) => Object.keys(g.reads))),
      ].sort();
      const shared = dependencies.filter((t) =>
        Object.hasOwn(nativeGuardReadColumns, t),
      );
      const ctes = shared.map(
        (t) =>
          `"${t}" AS MATERIALIZED (SELECT ${
            nativeGuardReadColumns[t].length
              ? nativeGuardReadColumns[t]
                  .map(
                    (c) =>
                      `${nativeGuardField(t, c, `json_extract(row_json,'$.${c}')`)} AS "${c}"`,
                  )
                  .join(',')
              : '1 AS __exists'
          } FROM (${transitionRows(t)}))`,
      );
      for (const view of dependencies.filter((t) =>
        Object.hasOwn(nativeGuardContract.views, t),
      ))
        ctes.push(
          `"${view}" AS MATERIALIZED (${nativeGuardViewSql(view, nativeGuardContract.views[view])})`,
        );
      const fields = [
        ...new Set(
          guards.flatMap((g) => [
            ...[...g.condition.matchAll(/\b(?:OLD|NEW)\.(\w+)\b/gi)].map(
              (m) => m[1],
            ),
            ...g.update_columns,
          ]),
        ),
      ].sort();
      for (const [name, parameter] of [
        ['native_before', 22],
        ['native_after', 23],
      ] as const)
        ctes.push(
          `${name} AS MATERIALIZED (SELECT ${fields.length ? fields.map((c) => `${nativeGuardField(table, c, `json_extract(?${parameter},'$.${c}')`)} AS "${c}"`).join(',') : '1 AS __unused'})`,
        );
      ctes.push(
        `native_failure AS MATERIALIZED (SELECT CASE ${
          shared.includes('stock_movements')
            ? "WHEN EXISTS(SELECT 1 FROM stock_movements WHERE sequence IS NULL OR sequence<1) THEN 'native:missing-stock-order'"
            : ''
        } ${
          shared.length
            ? `WHEN ${transitionMissingRows(shared)} THEN 'native:missing-state:${table}'`
            : ''
        } ${guards
          .map(
            (g) =>
              `WHEN (${applicable(g)}) AND (${condition(g)}) THEN 'native:${g.name}'`,
          )
          .join(
            ' ',
          )} END rule FROM native_before AS OLD CROSS JOIN native_after AS NEW)`,
      );
      ctes.unshift(`native_gate AS MATERIALIZED (SELECT 1 WHERE ${gate})`);
      return [
        table,
        `${args},native_parameters AS (SELECT ?26 assessment_sha),${ctes.join(',')}
      UPDATE business_sync_transaction_validations SET phase='invalid',failed_rule=(SELECT rule FROM native_failure),failed_change=?19,updated_at=?18
      WHERE transfer_id=?1 AND EXISTS(SELECT 1 FROM native_gate) AND (SELECT rule FROM native_failure) IS NOT NULL`,
      ];
    }),
  );
}
