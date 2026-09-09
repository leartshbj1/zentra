import protocol from '../desktop/src-tauri/src/business_sync_tables.json';
import { nativeGuardField } from './business-sync-native-guard-contract';
import {
  nativeEffects,
  nativeEffectReadColumns,
} from './business-sync-native-effect-contract';
import {
  transitionMissingRows,
  transitionRows,
} from './business-sync-transition-rows';

const shared = protocol.tables as Record<string, { key: string[] }>;
const pending = 'business_sync_transaction_effects';
const own = 'transfer_id=?1 AND validator_sha256=?15';
const equalImage = (expected: string, actual: string) =>
  `(${expected} IS NULL AND ${actual} IS NULL OR ${expected} IS NOT NULL AND ${actual} IS NOT NULL AND (SELECT COUNT(*) FROM json_each(${expected}))=(SELECT COUNT(*) FROM json_each(${actual})) AND NOT EXISTS(SELECT 1 FROM json_each(${expected}) expected LEFT JOIN json_each(${actual}) actual ON actual.key=expected.key WHERE actual.key IS NULL OR actual.type IS NOT expected.type OR actual.value IS NOT expected.value))`;
const matches = `table_name=?20 AND row_key_json=?21 AND ${equalImage('before_json', '?22')} AND ${equalImage('after_json', '?23')}`;

export function nativeEffectQueries(gate: string, args: string) {
  const sources = [...new Set(nativeEffects.map((e) => e.table))];
  const record = Object.fromEntries(
    sources.map((table) => {
      const effects = nativeEffects.filter((e) => e.table === table);
      const dependencies = [...new Set(effects.flatMap((e) => e.dependencies))];
      const ctes = dependencies.map(
        (t) =>
          `"${t}" AS MATERIALIZED (SELECT row_json AS __effect_row,${nativeEffectReadColumns[t].map((c) => `${nativeGuardField(t, c, `json_extract(row_json,'$.${c}')`)} AS "${c}"`).join(',')} FROM (${t === table ? `SELECT row_key_json,row_json FROM (${transitionRows(t)}) WHERE row_key_json<>?21 UNION ALL SELECT ?21,?23 WHERE ?23 IS NOT NULL` : transitionRows(t)}))`,
      );
      const rows = effects.map((e) => {
        const expression = (sql: string) =>
          sql.replace(/\b(OLD|NEW)\.(\w+)\b/g, (_, side, column) =>
            nativeGuardField(
              table,
              column,
              `json_extract(?${side === 'OLD' ? 22 : 23},'$.${column}')`,
            ),
          );
        const values = e.fields.flatMap((c, i) => [
          `'${e.kind === 'insert' ? c : '$.' + c}'`,
          expression(e.expressions[i]),
        ]);
        const image = `${e.kind === 'insert' ? 'json_object(' : 'json_set(__effect_row,'}${values.join(',')})`;
        const when =
          e.operation === 'insert'
            ? '?22 IS NULL AND ?23 IS NOT NULL'
            : `?22 IS NOT NULL AND ?23 IS NOT NULL AND (${e.updateColumns.map((c) => expression(`OLD.${c} IS NOT NEW.${c}`)).join(' OR ')})`;
        const select = `SELECT ${e.kind === 'insert' ? 'NULL' : '__effect_row'} before_image,${image} after_image ${e.kind === 'insert' ? '' : `FROM "${e.target}"`} WHERE (${when}) AND (${expression(e.condition)}) AND (${expression(e.where)})`;
        // Native capture omits UPDATEs whose shared image has not changed.
        return `SELECT ?1,?15,'${e.name}',?19,'${e.target}',json_array(${shared[e.target].key.map((c) => `json_extract(after_image,'$.${c}')`).join(',')}),before_image,after_image FROM (${select}) WHERE ${gate} AND (before_image IS NULL OR before_image<>after_image)`;
      });
      return [
        table,
        `${args},${ctes.join(',')} INSERT INTO ${pending}(transfer_id,validator_sha256,effect_name,cause_position,table_name,row_key_json,before_json,after_json) ${rows.join(' UNION ALL ')}`,
      ];
    }),
  );
  const missing = sources
    .map(
      (table) =>
        `WHEN ?20='${table}' AND ${transitionMissingRows([...new Set(nativeEffects.filter((e) => e.table === table).flatMap((e) => e.dependencies))])} THEN 'native-effect:missing-state:${table}'`,
    )
    .join(' ');
  return {
    check: `${args},failure AS MATERIALIZED (SELECT CASE WHEN EXISTS(SELECT 1 FROM ${pending} WHERE ${own}) AND NOT EXISTS(SELECT 1 FROM ${pending} WHERE ${own} AND ${matches}) THEN 'native-effect:'||(SELECT effect_name FROM ${pending} WHERE ${own} ORDER BY cause_position,table_name,row_key_json LIMIT 1) ${missing} END rule)
      UPDATE business_sync_transaction_validations SET phase='invalid',failed_rule=(SELECT rule FROM failure),failed_change=?19,updated_at=?18 WHERE transfer_id=?1 AND ${gate} AND (SELECT rule FROM failure) IS NOT NULL`,
    consume: `${args} DELETE FROM ${pending} WHERE ${own} AND ${gate} AND ${matches}`,
    targets: [...new Set(nativeEffects.map((e) => e.target))],
    record,
    finish: `${args} UPDATE business_sync_transaction_validations SET phase='invalid',failed_rule='native-effect:'||(SELECT effect_name FROM ${pending} WHERE ${own} ORDER BY cause_position,table_name,row_key_json LIMIT 1),failed_change=?19,updated_at=?18 WHERE transfer_id=?1 AND ${gate} AND EXISTS(SELECT 1 FROM ${pending} WHERE ${own})`,
  };
}
