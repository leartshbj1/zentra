import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  MIGRATION_DIAGNOSTIC_OBJECTS,
  MIGRATION_DIAGNOSTIC_QUERIES,
  runMigrationDiagnostic,
} from './migration-diagnostic';
import type { MigrationDiagnosticDependencies } from './migration-diagnostic';

// All tokens and rows below are synthetic; no server bindings or external fetch.
const TOKEN = 'a'.repeat(64);
const BASE_URL =
  'https://zentra.example.test/api/internal/migration-diagnostic';
let sql: DatabaseSync;
let queries: string[];
let database: Mock<MigrationDiagnosticDependencies['database']>;
let token: Mock<MigrationDiagnosticDependencies['token']>;
type DiagnosticFixture = {
  objects: { name: string; present: boolean }[];
  metadataUnavailable: boolean;
  migrationTables: { name: string; sql: string }[];
  migrationTableLimitReached: boolean;
  journals: {
    metadataUnavailable: boolean;
    rows?: {
      hash?: string;
      created_at?: number;
      id?: number;
      name?: string;
      applied_at?: string;
    }[];
  }[];
};
async function body(response: Response): Promise<DiagnosticFixture> {
  return (await response.json()) as DiagnosticFixture;
}
const request = (
  authorization: string | null = `Bearer ${TOKEN}`,
  url = BASE_URL,
  method = 'GET',
) =>
  new Request(url, {
    method,
    headers: authorization ? { Authorization: authorization } : {},
  });

function adapter() {
  return {
    prepare(query: string) {
      expect(Object.values(MIGRATION_DIAGNOSTIC_QUERIES)).toContain(query);
      expect(query.startsWith('SELECT ')).toBe(true);
      queries.push(query);
      return {
        async all() {
          return { success: true, results: sql.prepare(query).all() };
        },
      };
    },
  } as unknown as Pick<D1Database, 'prepare'>;
}

function settings() {
  return { token, database };
}

beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  queries = [];
  sql.exec(
    "CREATE TABLE prepaid_create_recoveries(period_id TEXT); CREATE UNIQUE INDEX prepaid_create_recoveries_scope ON prepaid_create_recoveries(period_id); CREATE TABLE customers(email TEXT); INSERT INTO customers VALUES('private-customer@example.test')",
  );
  database = vi.fn<MigrationDiagnosticDependencies['database']>(() =>
    adapter(),
  );
  token = vi.fn<MigrationDiagnosticDependencies['token']>(() => TOKEN);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No HTTP in diagnostic tests');
    }),
  );
});
afterEach(() => {
  sql.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('temporary private migration diagnostic', () => {
  it('reads only fixed metadata and shows all nine objects including missing ones', async () => {
    const response = await runMigrationDiagnostic(request(), settings());
    expect(response.status).toBe(200);
    const data = await body(response);
    expect(data.objects).toHaveLength(9);
    expect(data.objects.map((item: { name: string }) => item.name)).toEqual(
      MIGRATION_DIAGNOSTIC_OBJECTS.map(([name]) => name),
    );
    expect(
      data.objects.filter((item: { present: boolean }) => item.present),
    ).toHaveLength(2);
    expect(data.metadataUnavailable).toBe(true);
    expect(queries).toEqual([
      MIGRATION_DIAGNOSTIC_QUERIES.objects,
      MIGRATION_DIAGNOSTIC_QUERIES.migrationTables,
    ]);
    expect(JSON.stringify(data)).not.toContain('private-customer');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects missing, malformed, nonhex and wrong tokens before obtaining DB', async () => {
    for (const header of [
      null,
      'Bearer',
      `Basic ${TOKEN}`,
      `Bearer ${'b'.repeat(64)}`,
      `Bearer ${'A'.repeat(64)}`,
      `Bearer ${'g'.repeat(64)}`,
      `Bearer ${'a'.repeat(63)}`,
      `Bearer ${'a'.repeat(65)}`,
      `Bearer ${TOKEN},Bearer ${TOKEN}`,
    ]) {
      expect(
        (await runMigrationDiagnostic(request(header), settings())).status,
      ).toBe(401);
    }
    expect(database).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });

  it('refuses missing or malformed server secret before DB even with a valid-shaped bearer', async () => {
    for (const value of [
      undefined,
      null,
      '',
      123,
      'A'.repeat(64),
      TOKEN + '\n',
      'a'.repeat(63),
    ]) {
      token.mockReturnValue(value);
      expect((await runMigrationDiagnostic(request(), settings())).status).toBe(
        401,
      );
    }
    expect(database).not.toHaveBeenCalled();
  });

  it('GET only: other methods never read the token or the database', async () => {
    for (const method of [
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'HEAD',
      'OPTIONS',
    ]) {
      const response = await runMigrationDiagnostic(
        request(null, BASE_URL, method),
        settings(),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET');
    }
    expect(token).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
  });

  it('refuses every HTTP parameter instead of constructing a query', async () => {
    for (const suffix of [
      '?sql=DELETE+FROM+customers',
      '?table=customers',
      '?journal=customers',
      '?limit=999',
      '?a=',
      '?a=1&a=2',
      '#fragment',
    ]) {
      expect(
        (
          await runMigrationDiagnostic(
            request(`Bearer ${TOKEN}`, BASE_URL + suffix),
            settings(),
          )
        ).status,
      ).toBe(400);
    }
    expect(database).not.toHaveBeenCalled();
  });

  it('rejects a different path without reading the database', async () => {
    expect(
      (
        await runMigrationDiagnostic(
          request(`Bearer ${TOKEN}`, BASE_URL + '/other'),
          settings(),
        )
      ).status,
    ).toBe(400);
    expect(database).not.toHaveBeenCalled();
  });

  it('authorization precedes even URL validation', async () => {
    const response = await runMigrationDiagnostic(
      request(null, BASE_URL + '?sql=SELECT+secret'),
      settings(),
    );
    expect(response.status).toBe(401);
    expect(database).not.toHaveBeenCalled();
  });

  it('all responses are private/no-store, do not enable CORS, and vary on bearer', async () => {
    for (const req of [
      request(),
      request(null),
      request(null, BASE_URL, 'POST'),
    ]) {
      const response = await runMigrationDiagnostic(req, settings());
      expect(response.headers.get('Cache-Control')).toContain('private');
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(response.headers.get('Vary')).toBe('Authorization');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(
        response.headers.get('Access-Control-Allow-Credentials'),
      ).toBeNull();
    }
  });

  it('discovers a private migration table only as schema, never guesses or reads its rows', async () => {
    sql.exec(
      "CREATE TABLE sites_private_migration_state(secret TEXT); INSERT INTO sites_private_migration_state VALUES('never-return-this-private-value')",
    );
    const data = await body(
      await runMigrationDiagnostic(request(), settings()),
    );
    expect(data.migrationTables[0].name).toBe('sites_private_migration_state');
    expect(data.migrationTables[0].sql).toContain('CREATE TABLE');
    expect(data.metadataUnavailable).toBe(true);
    expect(JSON.stringify(data)).not.toContain(
      'never-return-this-private-value',
    );
    expect(queries).toHaveLength(2);
  });

  it('known Drizzle columns permit only five hashes/timestamps in fixed descending order', async () => {
    sql.exec(
      'CREATE TABLE __drizzle_migrations(id SERIAL PRIMARY KEY,hash TEXT NOT NULL,created_at NUMERIC)',
    );
    for (let n = 1; n <= 7; n++)
      sql
        .prepare(
          'INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)',
        )
        .run(n.toString(16).repeat(64), n * 1000);
    const data = await body(
      await runMigrationDiagnostic(request(), settings()),
    );
    expect(data.journals[0].metadataUnavailable).toBe(false);
    expect(data.journals[0].rows).toHaveLength(5);
    expect(data.journals[0].rows?.map((item) => item.created_at)).toEqual([
      7000, 6000, 5000, 4000, 3000,
    ]);
    expect(data.metadataUnavailable).toBe(false);
    expect(queries).toContain(MIGRATION_DIAGNOSTIC_QUERIES.drizzleRows);
  });

  it('known D1 journal uses only recognized ids/filenames/timestamps', async () => {
    sql.exec(
      'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT,applied_at TIMESTAMP)',
    );
    sql
      .prepare('INSERT INTO d1_migrations VALUES(?,?,?)')
      .run(83, '0082_prepaid_renewal_admissions.sql', '2026-10-06 14:00:00');
    const data = await body(
      await runMigrationDiagnostic(request(), settings()),
    );
    expect(data.journals[1].rows).toEqual([
      {
        id: 83,
        name: '0082_prepaid_renewal_admissions.sql',
        applied_at: '2026-10-06 14:00:00',
      },
    ]);
    expect(data.journals[1].metadataUnavailable).toBe(false);
  });

  it('an unexpected column prevents watermark reads rather than falling back to guessed SQL', async () => {
    sql.exec(
      'CREATE TABLE __drizzle_migrations(id INTEGER,hash TEXT,created_at INTEGER,customer_email TEXT)',
    );
    const data = await body(
      await runMigrationDiagnostic(request(), settings()),
    );
    expect(data.journals[0].metadataUnavailable).toBe(true);
    expect(queries).not.toContain(MIGRATION_DIAGNOSTIC_QUERIES.drizzleRows);
  });

  it('unexpected column types prevent watermark reads', async () => {
    sql.exec(
      'CREATE TABLE d1_migrations(id TEXT,name TEXT,applied_at TIMESTAMP)',
    );
    const data = await body(
      await runMigrationDiagnostic(request(), settings()),
    );
    expect(data.journals[1].metadataUnavailable).toBe(true);
    expect(queries).not.toContain(MIGRATION_DIAGNOSTIC_QUERIES.d1Rows);
  });

  it('unsafe free-form watermark values are never returned', async () => {
    sql.exec(
      'CREATE TABLE __drizzle_migrations(id INTEGER,hash TEXT,created_at NUMERIC)',
    );
    sql
      .prepare('INSERT INTO __drizzle_migrations VALUES(?,?,?)')
      .run(1, 'private-email@example.test', 1000);
    const data = await body(
      await runMigrationDiagnostic(request(), settings()),
    );
    expect(data.journals[0].metadataUnavailable).toBe(true);
    expect(JSON.stringify(data)).not.toContain('private-email');
  });

  it('unrecognized D1 filenames and date values never leak through', async () => {
    sql.exec(
      'CREATE TABLE d1_migrations(id INTEGER,name TEXT,applied_at TIMESTAMP)',
    );
    sql
      .prepare('INSERT INTO d1_migrations VALUES(?,?,?)')
      .run(1, 'private@example.test', 'a-password');
    const data = await body(
      await runMigrationDiagnostic(request(), settings()),
    );
    expect(data.journals[1].metadataUnavailable).toBe(true);
    expect(JSON.stringify(data)).not.toContain('a-password');
  });

  it('a migration filename longer than128 is omitted instead of returned', async () => {
    sql.exec(
      'CREATE TABLE d1_migrations(id INTEGER,name TEXT,applied_at TIMESTAMP)',
    );
    const name = '0082_' + 'a'.repeat(124) + '.sql';
    sql
      .prepare('INSERT INTO d1_migrations VALUES(?,?,?)')
      .run(1, name, '2026-10-06 14:00:00');
    const data = await body(
      await runMigrationDiagnostic(request(), settings()),
    );
    expect(data.journals[1].metadataUnavailable).toBe(true);
    expect(data.journals[1].rows).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(name);
  });

  it('metadata discovery is bounded to25, never queries discovered row tables', async () => {
    for (let n = 0; n < 29; n++)
      sql.exec(`CREATE TABLE migration_mock_${n}(secret TEXT)`);
    const data = await body(
      await runMigrationDiagnostic(request(), settings()),
    );
    expect(data.migrationTables).toHaveLength(25);
    expect(data.migrationTableLimitReached).toBe(true);
    expect(queries).toHaveLength(2);
  });

  it('SQL and DB errors are generic without raw details or logs', async () => {
    const log = vi.spyOn(console, 'log'),
      warn = vi.spyOn(console, 'warn'),
      error = vi.spyOn(console, 'error');
    database.mockImplementation(() => {
      throw Error('secret token private customer@example.test');
    });
    const response = await runMigrationDiagnostic(request(), settings());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'diagnostic_unavailable' });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('oversized metadata returned by a failing adapter is refused', async () => {
    database.mockReturnValue({
      prepare: () => ({
        all: async () => ({
          success: true,
          results: [
            {
              name: 'prepaid_create_recoveries',
              type: 'table',
              sql: 'x'.repeat(32769),
            },
          ],
        }),
      }),
    } as unknown as ReturnType<MigrationDiagnosticDependencies['database']>);
    const response = await runMigrationDiagnostic(request(), settings());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'diagnostic_unavailable' });
  });

  it('unexpected object names from a failing adapter are refused', async () => {
    database.mockReturnValue({
      prepare: () => ({
        all: async () => ({
          success: true,
          results: [
            {
              name: 'customers',
              type: 'table',
              sql: 'CREATE TABLE customers(email TEXT)',
            },
          ],
        }),
      }),
    } as unknown as ReturnType<MigrationDiagnosticDependencies['database']>);
    expect((await runMigrationDiagnostic(request(), settings())).status).toBe(
      503,
    );
  });

  it('schema inspection cannot mutate any business or migration data', async () => {
    const before = sql
      .prepare('SELECT name,type,sql FROM sqlite_schema ORDER BY name')
      .all();
    for (let n = 0; n < 3; n++)
      expect((await runMigrationDiagnostic(request(), settings())).status).toBe(
        200,
      );
    expect(
      sql
        .prepare('SELECT name,type,sql FROM sqlite_schema ORDER BY name')
        .all(),
    ).toEqual(before);
    expect(sql.prepare('SELECT email FROM customers').get()?.email).toBe(
      'private-customer@example.test',
    );
    const whitelist: readonly string[] = Object.values(
      MIGRATION_DIAGNOSTIC_QUERIES,
    );
    expect(queries.every((query) => whitelist.includes(query))).toBe(true);
  });

  it('thin route exposes GET only, dedicated bound token, and the existing guarded database getter', () => {
    const source = readFileSync(
      new URL(
        '../app/api/internal/migration-diagnostic/route.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(source).toContain("import { database } from '@/lib/runtime'");
    expect(source).toContain('ZENTRA_MIGRATION_DIAGNOSTIC_TOKEN');
    expect(source.match(/export async function /g)).toHaveLength(1);
    expect(source).toContain('function GET(');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('searchParams');
  });
});
