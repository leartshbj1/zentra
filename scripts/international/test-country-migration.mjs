import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';

// This runner has no production URL, API key, CLI login or persistent dataDir.
// Install PGlite separately and explicitly supply its package directory.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
if (!moduleDirectory || !isAbsolute(moduleDirectory)) {
  throw new Error('PGLITE_MODULE_DIR must be the absolute directory of the separately installed @electric-sql/pglite package.');
}
const manifest = JSON.parse(await readFile(join(moduleDirectory, 'package.json'), 'utf8'));
if (manifest.name !== '@electric-sql/pglite') throw new Error('PGLITE_MODULE_DIR is not the @electric-sql/pglite package.');
const { PGlite } = createRequire(import.meta.url)(join(moduleDirectory, 'dist', 'index.cjs'));
const migrationName = '20261007194528_international_workspace_country_config.sql';
const migration = await readFile(new URL('../../supabase/migrations/' + migrationName, import.meta.url), 'utf8');
const assertionsSql = await readFile(new URL('../../supabase/tests/database/international_country.test.sql', import.meta.url), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const database = new PGlite();
try {
  await database.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.zentra_workspaces(organization_id text primary key);
    grant usage on schema public to service_role;
    grant select,update on public.zentra_workspaces to service_role;
  `);
  const engine = (await database.query('select version()')).rows[0].version;
  await database.exec(migration);
  const results = await database.exec(assertionsSql);
  const assertions = results.flatMap(result => result.rows ?? []).filter(row => row.name && row.passed === true);
  if (assertions.length !== 17) throw new Error('Expected 17 country SQL assertions; got ' + assertions.length);
  console.log(JSON.stringify({
    executedAt: new Date().toISOString(), engine, pgliteVersion: manifest.version,
    migration: migrationName, migrationSha256: sha256(migration), assertionsSha256: sha256(assertionsSql),
    passed: assertions.length, assertions,
    scope: 'Isolated PostgreSQL WASM; synthetic workspace parent and roles only. No live Supabase, deployed-schema alignment, PostgREST or concurrent-connection certification.',
  }, null, 2));
} catch (error) {
  // SQL contains synthetic fixtures only. Print diagnostic identifiers rather
  // than a complete query, stack, environment or database connection context.
  console.error(JSON.stringify({ error: 'country_sql_tests_failed', message: error.message, code: error.code, position: error.position }));
  process.exitCode = 1;
} finally {
  await database.close();
}
