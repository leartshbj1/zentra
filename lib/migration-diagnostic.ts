import { createHash, timingSafeEqual } from 'node:crypto';

/** Temporary, server-token-only schema inspection. Never accepts SQL or IDs from HTTP. */
export const MIGRATION_DIAGNOSTIC_OBJECTS = Object.freeze([
  ['prepaid_create_recoveries', 'table'],
  ['prepaid_create_recoveries_scope', 'index'],
  ['prepaid_create_recovery_closed', 'trigger'],
  ['prepaid_create_recovery_no_update', 'trigger'],
  ['prepaid_create_recovery_no_delete', 'trigger'],
  ['prepaid_renewal_admissions', 'table'],
  ['prepaid_renewal_admissions_due', 'index'],
  ['prepaid_renewal_admissions_immutable', 'trigger'],
  ['prepaid_renewal_admissions_no_delete', 'trigger'],
] as const);

export const MIGRATION_DIAGNOSTIC_QUERIES = Object.freeze({
  objects:
    "SELECT name,type,sql FROM sqlite_schema WHERE name IN ('prepaid_create_recoveries','prepaid_create_recoveries_scope','prepaid_create_recovery_closed','prepaid_create_recovery_no_update','prepaid_create_recovery_no_delete','prepaid_renewal_admissions','prepaid_renewal_admissions_due','prepaid_renewal_admissions_immutable','prepaid_renewal_admissions_no_delete') ORDER BY name LIMIT 9",
  migrationTables:
    "SELECT name,type,sql FROM sqlite_schema WHERE type='table' AND LOWER(name) LIKE '%migration%' ORDER BY name LIMIT 25",
  drizzleColumns:
    "SELECT name,type FROM pragma_table_info('__drizzle_migrations') ORDER BY cid LIMIT 16",
  d1Columns:
    "SELECT name,type FROM pragma_table_info('d1_migrations') ORDER BY cid LIMIT 16",
  drizzleRows:
    'SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at DESC,hash DESC LIMIT 5',
  d1Rows:
    'SELECT id,name,applied_at FROM d1_migrations ORDER BY id DESC LIMIT 5',
});

type ReadDatabase = Pick<D1Database, 'prepare'>;
type Row = Record<string, unknown>;
export type MigrationDiagnosticDependencies = {
  token: () => unknown;
  database: () => ReadDatabase;
};

function authorized(request: Request, expected: unknown) {
  const match = /^Bearer ([0-9a-f]{64})$/.exec(
    request.headers.get('Authorization') ?? '',
  );
  if (
    typeof expected !== 'string' ||
    !/^[0-9a-f]{64}$/.test(expected) ||
    !match
  )
    return false;
  // Fixed-size digests; secret equality never exits on a first different byte.
  return timingSafeEqual(
    createHash('sha256').update(expected).digest(),
    createHash('sha256').update(match[1]).digest(),
  );
}

async function rows(
  db: ReadDatabase,
  query: string,
  max: number,
): Promise<Row[]> {
  const result = await db.prepare(query).all<Row>();
  if (
    !result.success ||
    !Array.isArray(result.results) ||
    result.results.length > max ||
    result.results.some(
      (row) => !row || typeof row !== 'object' || Array.isArray(row),
    )
  )
    throw Error('diagnostic_unavailable');
  return result.results;
}

function schemaRows(items: Row[], objects: boolean) {
  const seen = new Set<string>();
  let bytes = 0;
  return items.map((item) => {
    if (
      typeof item.name !== 'string' ||
      !/^[A-Za-z0-9_]{1,128}$/.test(item.name) ||
      seen.has(item.name) ||
      typeof item.sql !== 'string' ||
      item.sql.length > 32768 ||
      !['table', 'index', 'trigger'].includes(String(item.type))
    )
      throw Error('diagnostic_unavailable');
    if (
      objects &&
      !MIGRATION_DIAGNOSTIC_OBJECTS.some(
        ([name, type]) => name === item.name && type === item.type,
      )
    )
      throw Error('diagnostic_unavailable');
    if (
      !objects &&
      (item.type !== 'table' || !item.name.toLowerCase().includes('migration'))
    )
      throw Error('diagnostic_unavailable');
    seen.add(item.name);
    bytes += Buffer.byteLength(item.sql, 'utf8');
    if (bytes > 262144) throw Error('diagnostic_unavailable');
    return { name: item.name, type: item.type, sql: item.sql };
  });
}

function knownColumns(items: Row[], kind: 'drizzle' | 'd1') {
  const fields =
    kind === 'drizzle'
      ? {
          id: ['SERIAL', 'INTEGER'],
          hash: ['TEXT'],
          created_at: ['NUMERIC', 'INTEGER', 'BIGINT'],
        }
      : {
          id: ['INTEGER'],
          name: ['TEXT'],
          applied_at: ['TIMESTAMP', 'TEXT', 'DATETIME'],
        };
  if (items.length !== 3) return false;
  const seen = new Set<string>();
  return items.every((item) => {
    if (
      typeof item.name !== 'string' ||
      typeof item.type !== 'string' ||
      seen.has(item.name)
    )
      return false;
    seen.add(item.name);
    const accepted = fields[item.name as keyof typeof fields] as
      | string[]
      | undefined;
    return accepted?.includes(item.type.toUpperCase()) === true;
  });
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

async function journal(
  db: ReadDatabase,
  present: boolean,
  name: '__drizzle_migrations' | 'd1_migrations',
) {
  const kind = name === '__drizzle_migrations' ? 'drizzle' : 'd1';
  if (!present) return { name, present: false, metadataUnavailable: true };
  const columns = await rows(
    db,
    kind === 'drizzle'
      ? MIGRATION_DIAGNOSTIC_QUERIES.drizzleColumns
      : MIGRATION_DIAGNOSTIC_QUERIES.d1Columns,
    16,
  );
  if (!knownColumns(columns, kind))
    return { name, present: true, metadataUnavailable: true };
  const watermark = await rows(
    db,
    kind === 'drizzle'
      ? MIGRATION_DIAGNOSTIC_QUERIES.drizzleRows
      : MIGRATION_DIAGNOSTIC_QUERIES.d1Rows,
    5,
  );
  const valid = watermark.every((item) =>
    kind === 'drizzle'
      ? typeof item.hash === 'string' &&
        /^[0-9a-f]{64}$/.test(item.hash) &&
        safeInteger(item.created_at)
      : safeInteger(item.id) &&
        typeof item.name === 'string' &&
        item.name.length <= 128 &&
        /^[0-9]{4}_[a-z0-9_]+(?:\.sql)?$/.test(item.name) &&
        typeof item.applied_at === 'string' &&
        /^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})?$/.test(
          item.applied_at,
        ),
  );
  // Never return unexpected free-form values or newly discovered journal rows.
  if (!valid) return { name, present: true, metadataUnavailable: true };
  return {
    name,
    present: true,
    metadataUnavailable: false,
    rows: watermark.map((item) =>
      kind === 'drizzle'
        ? { hash: item.hash, created_at: item.created_at }
        : { id: item.id, name: item.name, applied_at: item.applied_at },
    ),
  };
}

export async function runMigrationDiagnostic(
  request: Request,
  dependencies: MigrationDiagnosticDependencies,
) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    Pragma: 'no-cache',
    Vary: 'Authorization',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  const answer = (code: string, status: number) =>
    Response.json({ code }, { status, headers });
  if (request.method !== 'GET') {
    headers.set('Allow', 'GET');
    return answer('method_not_allowed', 405);
  }
  try {
    if (!authorized(request, dependencies.token()))
      return answer('unauthorized', 401);
    const url = new URL(request.url);
    if (
      url.pathname !== '/api/internal/migration-diagnostic' ||
      url.search ||
      url.hash
    )
      return answer('invalid_request', 400);
    const db = dependencies.database();
    const found = schemaRows(
      await rows(db, MIGRATION_DIAGNOSTIC_QUERIES.objects, 9),
      true,
    );
    const discovered = schemaRows(
      await rows(db, MIGRATION_DIAGNOSTIC_QUERIES.migrationTables, 25),
      false,
    );
    const journals = await Promise.all([
      journal(
        db,
        discovered.some((item) => item.name === '__drizzle_migrations'),
        '__drizzle_migrations',
      ),
      journal(
        db,
        discovered.some((item) => item.name === 'd1_migrations'),
        'd1_migrations',
      ),
    ]);
    return Response.json(
      {
        readOnly: true,
        objects: MIGRATION_DIAGNOSTIC_OBJECTS.map(([name, type]) => ({
          name,
          type,
          present: found.some((item) => item.name === name),
          sql: found.find((item) => item.name === name)?.sql ?? null,
        })),
        migrationTables: discovered,
        migrationTableLimitReached: discovered.length === 25,
        journals,
        metadataUnavailable: journals.every((item) => item.metadataUnavailable),
      },
      { headers },
    );
  } catch {
    return answer('diagnostic_unavailable', 503);
  }
}
