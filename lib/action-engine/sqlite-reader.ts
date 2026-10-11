import initSqlJs from 'sql.js/dist/sql-wasm-browser.js';
import compiledSqlite from 'sql.js/dist/sql-wasm-browser.wasm?module';
import type { Database, SqlJsStatic } from 'sql.js';

export const READONLY_SQLITE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 64;
const MAX_COLUMNS = 64;
const MAX_TEXT = 65536;
const MAX_RESULT_TEXT = 1024 * 1024;
const MAX_QUERIES = 32;
const TABLES = new Set([
  'action_engine_quote_receipts',
  'clients',
  'quotes',
  'quote_items',
  'audit_log',
  'settings',
]);

export type ReadonlySqliteValue = string | number | null;
export type ReadonlySqliteRow = Readonly<Record<string, ReadonlySqliteValue>>;
/** Private server adapter. SQL must be a constant in trusted application code.
 * Neither SQL nor this handle is an HTTP/model input or a durable capability. */
export type ReadonlySqlite = Readonly<{
  query(
    sql: string,
    bindings: readonly ReadonlySqliteValue[],
    maxRows: number,
  ): readonly ReadonlySqliteRow[];
  columns(table: string): readonly string[];
}>;

export class ReadonlySqliteError extends Error {
  constructor(readonly code: 'invalid_sqlite' | 'service_unavailable') {
    super(code);
  }
}
const invalid = (): never => {
  throw new ReadonlySqliteError('invalid_sqlite');
};
let runtime: Promise<SqlJsStatic> | undefined;
function sqliteRuntime(): Promise<SqlJsStatic> {
  runtime ??= initSqlJs({
    instantiateWasm(
      imports: WebAssembly.Imports,
      success: (instance: WebAssembly.Instance) => void,
    ) {
      const instance = new WebAssembly.Instance(compiledSqlite, imports);
      success(instance);
      return instance.exports;
    },
    locateFile() {
      throw new ReadonlySqliteError('service_unavailable');
    },
  }) as Promise<SqlJsStatic>;
  return runtime;
}

/** Capture before the first await; do not invoke an overridable iterator/slice. */
function captureBytes(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  /* oxlint-disable typescript/unbound-method -- Intrinsic getters are deliberately called with raw via Reflect.apply, never without a receiver. */
  try {
    const prototype = Object.getPrototypeOf(Uint8Array.prototype);
    const length = Reflect.apply(
      Object.getOwnPropertyDescriptor(prototype, 'byteLength')!.get!,
      raw,
      [],
    ) as number;
    const buffer = Reflect.apply(
      Object.getOwnPropertyDescriptor(prototype, 'buffer')!.get!,
      raw,
      [],
    );
    const offset = Reflect.apply(
      Object.getOwnPropertyDescriptor(prototype, 'byteOffset')!.get!,
      raw,
      [],
    ) as number;
    const tag = Reflect.apply(
      Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)!.get!,
      raw,
      [],
    );
    if (
      tag !== 'Uint8Array' ||
      !(buffer instanceof ArrayBuffer) ||
      length < 100 ||
      length > READONLY_SQLITE_MAX_BYTES
    )
      return invalid();
    const copy = new Uint8Array(length);
    Uint8Array.prototype.set.call(copy, new Uint8Array(buffer, offset, length));
    const magic = [
      83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116, 32, 51, 0,
    ];
    if (!magic.every((value, index) => copy[index] === value)) return invalid();
    return copy;
  } catch {
    return invalid();
  }
  /* oxlint-enable typescript/unbound-method */
}

function sqlShape(sql: string): {
  sql: string;
  table: string;
  limit: number | null;
} {
  if (typeof sql !== 'string' || sql.length > 4096) return invalid();
  // A deliberately small SELECT grammar, not a general SQL parser. No functions,
  // subqueries, joins, comments, statement separators, collations or identifiers
  // from untrusted data are admitted. BINARY is the only fixed collation.
  const id = '[A-Za-z_][A-Za-z0-9_]*';
  const fields = `(?:\\*|${id}(?:\\s*,\\s*${id})*)`;
  const value = `(?:\\?|'[A-Za-z0-9_-]{1,160}')`;
  const condition = `${id}(?:\\s*=\\s*${value}|\\s+IS\\s+NULL)`;
  const order = `${id}(?:\\s+COLLATE\\s+BINARY)?(?:\\s+(?:ASC|DESC))?`;
  const grammar = new RegExp(
    `^SELECT\\s+${fields}\\s+FROM\\s+(${id})(?:\\s+WHERE\\s+${condition}(?:\\s+AND\\s+${condition})*)?(?:\\s+ORDER\\s+BY\\s+${order}(?:\\s*,\\s*${order})*)?(?:\\s+LIMIT\\s+([0-9]{1,3}))?$`,
    'i',
  );
  const match = grammar.exec(sql.trim());
  if (!match || !TABLES.has(match[1])) return invalid();
  const limit = match[2] === undefined ? null : Number(match[2]);
  if (limit !== null && (limit < 1 || limit > MAX_ROWS + 1)) return invalid();
  // Avoid expression/generated indexes in an untrusted archive. WITHOUT ROWID
  // ordinary tables still use their physical primary-key tree.
  const safe = sql
    .trim()
    .replace(
      new RegExp(`(\\bFROM\\s+${match[1]})(?=\\s|$)`, 'i'),
      '$1 NOT INDEXED',
    );
  return {
    sql: safe.replace(/\s+LIMIT\s+[0-9]+$/i, ''),
    table: match[1],
    limit,
  };
}

function captureBindings(
  raw: readonly ReadonlySqliteValue[],
): ReadonlySqliteValue[] {
  try {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const length = Object.getOwnPropertyDescriptor(raw, 'length')
      ?.value as unknown;
    if (
      typeof length !== 'number' ||
      length > 16 ||
      Reflect.ownKeys(raw).length !== length + 1
    )
      return invalid();
    const copy: ReadonlySqliteValue[] = [];
    for (let index = 0; index < length; index++) {
      const field = descriptors[String(index)];
      if (!field?.enumerable || !('value' in field)) return invalid();
      const value: unknown = field.value;
      if (
        value === null ||
        (typeof value === 'string' &&
          value.length <= 4096 &&
          value.isWellFormed() &&
          !value.includes('\0')) ||
        (typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          !Object.is(value, -0))
      )
        copy.push(value as ReadonlySqliteValue);
      else return invalid();
    }
    return copy;
  } catch {
    return invalid();
  }
}

/**
 * Upstream sql.js has no exported progress/interrupt hook. The 8MiB input cap,
 * restricted constant SELECTs, NOT INDEXED, row/text/query caps and SQLite's
 * hard_heap_limit bound this private workload; they are not a hard opcode/CPU
 * budget or a cap on all JS/WASM memory. No extensions or writer API are exposed.
 * The callback is synchronous: no handle can survive closing the private copy.
 */
export async function withReadonlySqlite<T>(
  bytes: Uint8Array,
  callback: (reader: ReadonlySqlite) => T,
): Promise<T> {
  const captured = captureBytes(bytes);
  if (typeof callback !== 'function') return invalid();
  let SQL: SqlJsStatic;
  try {
    SQL = await sqliteRuntime();
  } catch {
    throw new ReadonlySqliteError('service_unavailable');
  }
  let database: Database;
  try {
    database = new SQL.Database(captured);
  } catch {
    return invalid();
  }
  let active = true,
    queries = 0,
    resultText = 0;
  const physical = new Map<string, readonly string[]>();
  const declaredIntegers = new Map<string, ReadonlySet<string>>();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  function assertActive() {
    if (!active || ++queries > MAX_QUERIES) return invalid();
  }
  function read(
    sql: string,
    bindings: readonly ReadonlySqliteValue[],
    maxRows: number,
    facts?: { columns: readonly string[]; integerColumns: ReadonlySet<string> },
  ): readonly ReadonlySqliteRow[] {
    if (facts) {
      const fields = facts.columns.map(
        (column, index) =>
          `${column},typeof(${column}) AS __ae_type_${index},CAST(${column} AS BLOB) AS __ae_blob_${index}`,
      );
      sql = sql.replace(
        /^SELECT\s+.+?\s+FROM\s/i,
        `SELECT ${fields.join(',')} FROM `,
      );
    }
    let statement;
    try {
      statement = database.prepare(sql);
    } catch {
      return invalid();
    }
    try {
      statement.bind(bindings as ReadonlySqliteValue[]);
      const names = statement.getColumnNames();
      if (
        names.length > MAX_COLUMNS * (facts ? 3 : 1) ||
        new Set(names).size !== names.length ||
        names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      )
        return invalid();
      const outputNames = facts?.columns ?? names;
      const rows: ReadonlySqliteRow[] = [];
      while (statement.step()) {
        if (rows.length >= maxRows) return invalid();
        // @types/sql.js predates upstream's exact INTEGER option, verified with
        // the pinned actual engine in Node and workerd, never db.exec rounding.
        // oxlint-disable-next-line typescript/unbound-method -- The call below explicitly binds statement; this only widens the outdated option type.
        const getExact = statement.get as (
          params: null,
          config: { useBigInt: true },
        ) => unknown[];
        const values = getExact.call(statement, null, { useBigInt: true });
        const row: Record<string, ReadonlySqliteValue> = Object.create(null);
        for (let index = 0; index < outputNames.length; index++) {
          const name = outputNames[index],
            value = values[index * (facts ? 3 : 1)];
          if (facts) {
            const storage = values[index * 3 + 1],
              raw = values[index * 3 + 2];
            if (facts.integerColumns.has(name) && storage !== 'integer')
              return invalid();
            if (storage === 'text') {
              if (
                !(raw instanceof Uint8Array) ||
                typeof value !== 'string' ||
                raw.length > MAX_TEXT * 4 ||
                decoder.decode(raw) !== value
              )
                return invalid();
            } else if (storage === 'integer') {
              if (typeof value !== 'bigint') return invalid();
            } else if (storage === 'real') {
              if (typeof value !== 'number') return invalid();
            } else if (storage !== 'null' || value !== null || raw !== null)
              return invalid();
          }
          if (typeof value === 'bigint') {
            if (
              value < BigInt(Number.MIN_SAFE_INTEGER) ||
              value > BigInt(Number.MAX_SAFE_INTEGER)
            )
              return invalid();
            row[name] = Number(value);
          } else if (typeof value === 'number') {
            if (
              !Number.isFinite(value) ||
              (Number.isInteger(value) && !Number.isSafeInteger(value))
            )
              return invalid();
            row[name] = value;
          } else if (typeof value === 'string') {
            resultText += value.length;
            if (
              value.length > MAX_TEXT ||
              resultText > MAX_RESULT_TEXT ||
              !value.isWellFormed() ||
              value.includes('\0')
            )
              return invalid();
            row[name] = value;
          } else if (value === null) row[name] = null;
          else return invalid(); // BLOBs and unsupported types are never evidence.
        }
        rows.push(Object.freeze(row));
      }
      return Object.freeze(rows);
    } catch (error) {
      if (error instanceof ReadonlySqliteError) throw error;
      return invalid();
    } finally {
      statement.free();
    }
  }
  function columns(table: string): readonly string[] {
    assertActive();
    if (!TABLES.has(table)) return invalid();
    const previous = physical.get(table);
    if (previous) return previous;
    const meta = read(
      'SELECT type,sql FROM sqlite_schema WHERE name=?',
      [table],
      2,
    );
    if (
      meta.length !== 1 ||
      meta[0].type !== 'table' ||
      typeof meta[0].sql !== 'string' ||
      !/^CREATE\s+TABLE\s/i.test(meta[0].sql)
    )
      return invalid();
    const info = read(`PRAGMA main.table_xinfo('${table}')`, [], MAX_COLUMNS);
    if (
      !info.length ||
      info.some(
        (column) =>
          typeof column.name !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column.name) ||
          typeof column.type !== 'string' ||
          column.hidden !== 0,
      )
    )
      return invalid();
    const names = Object.freeze(info.map((column) => column.name as string));
    declaredIntegers.set(
      table,
      new Set(
        info
          .filter(
            (column) =>
              /^INTEGER$/i.test(column.type as string) ||
              /(?:_cents|_bp)$/.test(column.name as string) ||
              column.name === 'position',
          )
          .map((column) => column.name as string),
      ),
    );
    physical.set(table, names);
    return names;
  }
  const reader: ReadonlySqlite = Object.freeze({
    columns,
    query(sql, bindings, maxRows) {
      assertActive();
      if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS)
        return invalid();
      const shape = sqlShape(sql),
        values = captureBindings(bindings);
      if ((shape.sql.match(/\?/g) ?? []).length !== values.length)
        return invalid();
      const tableColumns = columns(shape.table);
      const select = /^SELECT\s+(.+?)\s+FROM\s/i.exec(shape.sql)?.[1];
      if (!select) return invalid();
      const selected =
        select === '*'
          ? tableColumns
          : select.split(',').map((column) => column.trim());
      if (
        selected.length > MAX_COLUMNS ||
        new Set(selected).size !== selected.length ||
        selected.some((column) => !tableColumns.includes(column))
      )
        return invalid();
      const limit = Math.min(shape.limit ?? maxRows + 1, maxRows + 1);
      return read(`${shape.sql} LIMIT ${limit}`, values, maxRows, {
        columns: selected,
        integerColumns: declaredIntegers.get(shape.table)!,
      });
    },
  });
  try {
    try {
      database.run(
        'PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA hard_heap_limit=33554432; PRAGMA cache_size=-2048; PRAGMA temp_store=MEMORY;',
      );
    } catch {
      return invalid();
    }
    if (
      read('PRAGMA user_version', [], 1)[0]?.user_version !== 62 ||
      read('PRAGMA query_only', [], 1)[0]?.query_only !== 1 ||
      read('PRAGMA trusted_schema', [], 1)[0]?.trusted_schema !== 0 ||
      read('PRAGMA hard_heap_limit', [], 1)[0]?.hard_heap_limit !== 33554432
    )
      return invalid();
    const result = callback(reader);
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result
    )
      return invalid();
    return result;
  } finally {
    active = false;
    try {
      database.close();
    } catch {
      /* the isolated failed database is discarded */
    }
  }
}
