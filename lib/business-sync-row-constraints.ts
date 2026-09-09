import {
  rowStructureContract,
  rowUniqueColumns,
} from './business-sync-row-contract';
import { nativeGuardField } from './business-sync-native-guard-contract';
import {
  transitionRows,
  transitionMissingRows,
} from './business-sync-transition-rows';
import { balanceSqlPredicates } from './business-sync-sql-balance';

// NOT NULL, storage types, CHECK and UNIQUE apply to each row before AFTER
// triggers. Foreign keys are also checked on the resulting snapshot: the wire
// contains row events, not the statement boundaries of native cascades.
export function rowConstraintQueries(gate: string, args: string) {
  return Object.fromEntries(
    Object.entries(rowStructureContract).map(([table, contract]) => {
      const ctes = [
        `row_gate AS MATERIALIZED (SELECT 1 WHERE ${gate})`,
        `incoming AS MATERIALIZED (SELECT ${contract.columns.map((c) => `${nativeGuardField(table, c.name, `json_extract(?23,'$.${c.name}')`)} AS "${c.name}"`).join(',')})`,
      ];
      if (contract.unique.length)
        ctes.push(
          `current_rows AS MATERIALIZED (SELECT row_key_json AS __key,${rowUniqueColumns[table].map((c) => `${nativeGuardField(table, c, `json_extract(row_json,'$.${c}')`)} AS "${c}"`).join(',') || '1 AS __exists'} FROM (${transitionRows(table)}) WHERE row_key_json<>?21)`,
        );
      const fields = contract.columns.map((c) => {
        const type = `json_type(?23,'$.${c.name}')`,
          value = `json_extract(?23,'$.${c.name}')`;
        const allowed =
          c.type === 'TEXT'
            ? "'text'"
            : c.type === 'INTEGER'
              ? "'integer'"
              : c.type === 'REAL'
                ? "'integer','real'"
                : null;
        if (!allowed)
          throw new Error(`Unsupported row type: ${table}.${c.name}`);
        return `${type} IS NULL OR ${type} NOT IN (${allowed}${c.required ? '' : ",'null'"})${c.type === 'INTEGER' ? ` OR (${type}='integer' AND typeof(${value})<>'integer')` : ''}`;
      });
      const cases = [
        `WHEN ${balanceSqlPredicates(fields.join(' OR '))} THEN 'row:fields:${table}'`,
      ];
      if (contract.checks.length)
        cases.push(
          // WHERE preserves native CHECK short-circuiting (notably json_valid
          // before json_type); a scalar SELECT can eagerly throw malformed JSON.
          `WHEN EXISTS(SELECT 1 FROM incoming WHERE ${balanceSqlPredicates(contract.checks.map((c) => `NOT (${c})`).join(' OR '))}) THEN 'row:check:${table}'`,
        );
      if (contract.unique.length)
        cases.push(
          `WHEN ${transitionMissingRows([table])} THEN 'row:missing-state:${table}'`,
        );
      for (const [i, unique] of contract.unique.entries()) {
        const projected = unique.expressions
          .map((e, j) => `(${e}) AS u${j}`)
          .join(',');
        ctes.push(
          `existing_${i} AS (SELECT __key,${projected} FROM current_rows WHERE ${unique.where ?? '1'})`,
        );
        ctes.push(
          `new_${i} AS (SELECT ${projected} FROM incoming WHERE ${unique.where ?? '1'})`,
        );
        cases.push(
          `WHEN EXISTS(SELECT 1 FROM existing_${i} existing CROSS JOIN new_${i} candidate WHERE ${unique.expressions.map((_, j) => `existing.u${j}=candidate.u${j}`).join(' AND ')}) THEN 'row:unique:${unique.name}'`,
        );
      }
      ctes.push(
        `row_failure AS MATERIALIZED (SELECT CASE WHEN ?23 IS NULL THEN NULL ${cases.join(' ')} END rule)`,
      );
      return [
        table,
        `${args},${ctes.join(',')} UPDATE business_sync_transaction_validations SET phase='invalid',failed_rule=(SELECT rule FROM row_failure),failed_change=?19,updated_at=?18 WHERE transfer_id=?1 AND EXISTS(SELECT 1 FROM row_gate) AND (SELECT rule FROM row_failure) IS NOT NULL`,
      ];
    }),
  );
}
