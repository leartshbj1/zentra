import protocol from '../desktop/src-tauri/src/business_sync_tables.json';
import { structuralSchema } from './business-sync-structure';
import {
  sqlChecks,
  sqlIdentifiers,
  sqlUniqueIndex,
} from './business-sync-sql-rules';

type Unique = { name: string; expressions: string[]; where: string | null };
export type RowContract = {
  columns: { name: string; type: string; required: boolean }[];
  checks: string[];
  unique: Unique[];
};
export const rowStructureContract: Record<string, RowContract> = {};
export const rowUniqueColumns: Record<string, string[]> = {};
for (const [name, table] of Object.entries(structuralSchema.tables)) {
  const policy = protocol.tables[name as keyof typeof protocol.tables];
  const shared = new Set<string>(policy.columns);
  const columns = table.columns
    .filter((c) => shared.has(c.name))
    .map((c) => ({
      name: c.name,
      type: c.type,
      required: c.not_null || policy.key.some((k) => k === c.name),
    }));
  const checks = sqlChecks(table.sql);
  const unique = table.unique.map((index) => {
    const parsed = index.sql
      ? sqlUniqueIndex(index.sql)
      : {
          expressions: index.fields.map((f) => {
            if (!f.name || !['BINARY', 'NOCASE', 'RTRIM'].includes(f.collation))
              throw new Error(`Unmapped native unique key: ${index.name}`);
            return `"${f.name}" COLLATE ${f.collation}`;
          }),
          where: null,
        };
    return { name: index.name, ...parsed };
  });
  const indexed = [
    ...new Set(
      unique
        .flatMap((u) =>
          [...u.expressions, u.where ?? '1'].flatMap(sqlIdentifiers),
        )
        .filter((c) => shared.has(c)),
    ),
  ].sort();
  const used = [
    ...checks,
    ...unique.flatMap((u) => [...u.expressions, u.where ?? '1']),
  ].flatMap(sqlIdentifiers);
  if (used.some((c) => policy.local_columns.some((local) => local === c)))
    throw new Error(`Row constraint uses a local column: ${name}`);
  rowStructureContract[name] = { columns, checks, unique };
  if (unique.length) rowUniqueColumns[name] = indexed;
}
