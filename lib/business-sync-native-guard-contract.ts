import catalog from '../desktop/src-tauri/src/business_sync_guards.json';
import tables from '../desktop/src-tauri/src/business_sync_tables.json';
import schema from '../desktop/src-tauri/src/business_sync_schema.json';

export type NativeGuard = {
  name: string;
  table: string;
  operation: 'insert' | 'update' | 'delete';
  update_columns: string[];
  condition: string;
  reads: Record<string, string[]>;
  local_reads: string[];
  functions: string[];
};
export const nativeGuardContract = catalog as unknown as {
  version: number;
  native_schema_version: number;
  data_schema_version: number;
  guards: NativeGuard[];
  views: Record<string, string>;
};
const shared = tables.tables as Record<string, { columns: string[] }>;
const columnTypes = Object.fromEntries(
  Object.entries(schema.tables).map(([table, definition]) => [
    table,
    Object.fromEntries(definition.columns.map((c) => [c.name, c.type])),
  ]),
);
export function nativeGuardField(
  table: string,
  column: string,
  expression: string,
) {
  const type = columnTypes[table]?.[column];
  if (!type || !['TEXT', 'INTEGER', 'REAL'].includes(type))
    throw new Error(`Unmapped native affinity: ${table}.${column}`);
  // JSON extraction alone has no column affinity. CAST preserves native SQL
  // comparisons (including a typed column compared with a JSON scalar).
  return `CAST(${expression} AS ${type})`;
}
// A running timer belongs to the receiving installation. This guard must be
// applied by that installation; the server has no authoritative timer state.
export const receiverNativeGuards = [
  'project_tasks_active_timer_close_guard',
] as const;
const localGuards = nativeGuardContract.guards.filter(
  (g) => g.local_reads.length,
);
if (
  localGuards.length !== receiverNativeGuards.length ||
  localGuards.some((g) => !receiverNativeGuards.some((name) => name === g.name))
) {
  throw new Error(
    'Review native protections that depend on local device state',
  );
}
export const serverNativeGuards = nativeGuardContract.guards.filter(
  (g) => !g.local_reads.length,
);
export const nativeGuardReadColumns: Record<string, string[]> = {};
for (const guard of serverNativeGuards) {
  const imageColumns = [
    ...guard.update_columns,
    ...[...guard.condition.matchAll(/\b(?:OLD|NEW)\.(\w+)\b/gi)].map(
      (m) => m[1],
    ),
  ];
  if (
    !Object.hasOwn(shared, guard.table) ||
    imageColumns.some((c) => !shared[guard.table].columns.includes(c))
  )
    throw new Error(`Unmapped native image: ${guard.name}/${guard.table}`);
  for (const [table, columns] of Object.entries(guard.reads)) {
    if (Object.hasOwn(nativeGuardContract.views, table)) continue;
    if (
      !Object.hasOwn(shared, table) ||
      columns.some(
        (c) =>
          !shared[table].columns.includes(c) &&
          !(table === 'stock_movements' && c === 'sequence'),
      )
    )
      throw new Error(`Unmapped native dependency: ${guard.name}/${table}`);
    nativeGuardReadColumns[table] = [
      ...new Set([...(nativeGuardReadColumns[table] ?? []), ...columns]),
    ].sort();
  }
}
