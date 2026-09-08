import rawSchema from '../desktop/src-tauri/src/business_sync_schema.json';
import protocol from '../desktop/src-tauri/src/business_sync_tables.json';
import {
  sqlChecks,
  sqlIdentifiers,
  sqlUniqueIndex,
} from './business-sync-sql-rules';

type Column = {
  name: string;
  type: string;
  not_null: boolean;
  primary_key_position: number;
};
type ForeignKey = {
  id: number;
  sequence: number;
  table: string;
  from: string;
  to: string | null;
};
type Unique = {
  name: string;
  sql: string | null;
  partial: boolean;
  fields: { name: string | null; collation: string; descending: boolean }[];
};
type Table = {
  sql: string;
  columns: Column[];
  foreign_keys: ForeignKey[];
  unique: Unique[];
};
type Schema = {
  version: number;
  schema_version: number;
  protocol_sha256: string;
  tables: Record<string, Table>;
};
export type StructuralRule = {
  id: string;
  table: string;
  kind: 'count' | 'fields' | 'check' | 'unique' | 'foreign_key';
  sql: string;
};
const schema = rawSchema as Schema;
const tables = protocol.tables as Record<
  string,
  { key: string[]; columns: string[]; local_columns: string[] }
>;

export const structuralSchema = schema;

function identifier(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value))
    throw new Error('Invalid checked schema identifier');
  return `"${value}"`;
}
function field(table: string, column: string) {
  identifier(column);
  const type = schema.tables[table].columns.find(
    (c) => c.name === column,
  )?.type;
  if (!type || !['TEXT', 'INTEGER', 'REAL'].includes(type))
    throw new Error('Unsupported checked column affinity');
  // Derived columns retain native comparison affinity through an explicit cast.
  // The separate fields pass rejects invalid storage types before these run.
  return `CAST(json_extract(row_json,'$.${column}') AS ${type})`;
}
function scope(table: string) {
  identifier(table);
  return `transfer_id=?1 AND organization_id=?2 AND table_name='${table}'`;
}
function rows(table: string, columns = tables[table].columns) {
  return `SELECT row_key_json AS __key,${columns.map((column) => `${field(table, column)} AS ${identifier(column)}`).join(',')}
    FROM business_sync_versions WHERE ${scope(table)}`;
}
function requirePortable(table: string, expression: string) {
  const local = tables[table].local_columns;
  if (sqlIdentifiers(expression).some((id) => local.includes(id)))
    throw new Error(`Rule depends on a local-only field: ${table}`);
}

export function compileStructuralRules(): StructuralRule[] {
  if (
    schema.version !== 1 ||
    schema.schema_version !== 60 ||
    Object.keys(schema.tables).sort().join() !==
      Object.keys(tables).sort().join()
  )
    throw new Error('Structural schema drift');
  const rules: StructuralRule[] = [];
  for (const [name, table] of Object.entries(schema.tables)) {
    const rule = tables[name];
    if (
      table.columns
        .map((c) => c.name)
        .sort()
        .join() !== [...rule.columns, ...rule.local_columns].sort().join()
    )
      throw new Error(`Column contract drift: ${name}`);
    // There are no column collations in the checked schema. New ones require
    // explicit handling of SQLite's parent-column FK comparison semantics.
    if (sqlIdentifiers(table.sql).includes('collate'))
      throw new Error(`Unsupported column collation: ${name}`);
    const add = (kind: StructuralRule['kind'], suffix: string, sql: string) =>
      rules.push({ id: `${name}:${kind}${suffix}`, table: name, kind, sql });
    add(
      'count',
      '',
      `SELECT 1 AS invalid WHERE (SELECT COUNT(*) FROM business_sync_versions WHERE ${scope(name)})<>?3`,
    );
    const fieldErrors: string[] = [
      'row_json IS NULL',
      'NOT json_valid(row_json)',
    ];
    for (const column of table.columns.filter((c) =>
      rule.columns.includes(c.name),
    )) {
      const type = `json_type(row_json,'$.${column.name}')`;
      const allowed =
        column.type === 'TEXT'
          ? "'text'"
          : column.type === 'INTEGER'
            ? "'integer'"
            : column.type === 'REAL'
              ? "'integer','real'"
              : null;
      if (!allowed)
        throw new Error(`Unsupported scalar type: ${name}.${column.name}`);
      fieldErrors.push(
        `${type} IS NULL`,
        `${type} NOT IN (${allowed}${column.not_null || rule.key.includes(column.name) ? '' : ",'null'"})`,
      );
    }
    add(
      'fields',
      '',
      `SELECT row_key_json AS __key FROM business_sync_versions WHERE ${scope(name)}
      AND CASE WHEN row_json IS NULL OR NOT json_valid(row_json) THEN 1 ELSE (${fieldErrors.slice(2).join(' OR ')}) END LIMIT 1`,
    );
    const checks = sqlChecks(table.sql);
    for (const check of checks) requirePortable(name, check);
    if (checks.length)
      add(
        'check',
        '',
        `WITH rows AS (${rows(name)}) SELECT __key FROM rows WHERE ${checks.map((check) => `NOT (${check})`).join(' OR ')} LIMIT 1`,
      );
    for (const unique of table.unique) {
      let expressions: string[];
      let where: string | null;
      if (unique.sql) ({ expressions, where } = sqlUniqueIndex(unique.sql));
      else {
        expressions = unique.fields.map((f) => {
          if (!f.name || !['BINARY', 'NOCASE', 'RTRIM'].includes(f.collation))
            throw new Error(`Unsupported unique key: ${unique.name}`);
          return `${identifier(f.name)} COLLATE ${f.collation}`;
        });
        where = null;
      }
      if (
        Boolean(where) !== unique.partial ||
        expressions.length !== unique.fields.length
      )
        throw new Error(`Unique index contract drift: ${unique.name}`);
      for (const expression of [...expressions, where ?? '1'])
        requirePortable(name, expression);
      add(
        'unique',
        `:${unique.name}`,
        `WITH rows AS (${rows(name)}) SELECT MIN(__key) AS __key FROM rows
        WHERE (${where ?? '1'}) AND ${expressions.map((e) => `(${e}) IS NOT NULL`).join(' AND ')}
        GROUP BY ${expressions.map((e) => `(${e})`).join(',')} HAVING COUNT(*)>1 LIMIT 1`,
      );
    }
    const groups = new Map<number, ForeignKey[]>();
    for (const fk of table.foreign_keys)
      groups.set(fk.id, [...(groups.get(fk.id) ?? []), fk]);
    for (const [id, columns] of groups) {
      columns.sort((a, b) => a.sequence - b.sequence);
      const parentName = columns[0].table;
      const parent = schema.tables[parentName];
      if (
        !parent ||
        columns.some((c, i) => c.table !== parentName || c.sequence !== i)
      )
        throw new Error(`Invalid foreign key: ${name}:${id}`);
      const parentPrimary = parent.columns
        .filter((c) => c.primary_key_position > 0)
        .sort((a, b) => a.primary_key_position - b.primary_key_position);
      const referenced = columns.map((c) => {
        const target = c.to ?? parentPrimary[c.sequence]?.name;
        if (!target) throw new Error(`Missing parent key: ${name}:${id}`);
        return target;
      });
      if (
        columns.some((c) => !rule.columns.includes(c.from)) ||
        referenced.some((c) => !c || !tables[parentName].columns.includes(c))
      )
        throw new Error(`Foreign key references a local field: ${name}:${id}`);
      if (
        columns.some(
          (c, i) =>
            table.columns.find((column) => column.name === c.from)?.type !==
            parent.columns.find((column) => column.name === referenced[i])
              ?.type,
        )
      )
        throw new Error(
          `Cross-affinity foreign key requires explicit support: ${name}:${id}`,
        );
      // Materialize each parent set once. SQLite can build an automatic covering
      // index for the join instead of rescanning the parent table for every child.
      add(
        'foreign_key',
        `:${id}`,
        `WITH children AS (${rows(name, [...new Set(columns.map((c) => c.from))])}),
        parents AS MATERIALIZED (SELECT 1 AS __present,${referenced.map((c) => `${field(parentName, c)} AS ${identifier(c)}`).join(',')}
          FROM business_sync_versions WHERE ${scope(parentName)})
        SELECT children.__key FROM children LEFT JOIN parents ON ${columns.map((c, i) => `parents.${identifier(referenced[i])}=children.${identifier(c.from)}`).join(' AND ')}
        WHERE ${columns.map((c) => `children.${identifier(c.from)} IS NOT NULL`).join(' AND ')} AND parents.__present IS NULL LIMIT 1`,
      );
    }
  }
  if (
    new Set(rules.map((r) => r.id)).size !== rules.length ||
    rules.some((r) => new TextEncoder().encode(r.sql).length > 100_000)
  )
    throw new Error('Structural rules exceed the query contract');
  // Validate every row shape before any query can traverse another table.
  const order = { count: 0, fields: 1, check: 2, unique: 3, foreign_key: 4 };
  return rules.sort((a, b) => order[a.kind] - order[b.kind]);
}

export const structuralRules = compileStructuralRules();
