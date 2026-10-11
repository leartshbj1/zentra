import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// CI-only. Importing this module neither loads pg nor connects to a database.
// The source/branch/opt-in checks precede installation and every connection.
const repository = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const branch = 'codex/action-engine-pg-verification';
// Deliberately public test-only credential for this disposable loopback cluster.
const syntheticAdminPassword = 'zentra-g3-public-synthetic-admin-not-a-secret';
const qaDirectory = join(repository, 'tests/action-engine-postgres-ci');
const sourceFiles = [
  '.circleci/config.yml',
  'scripts/bootstrap-action-real-postgres-ci.mjs',
  'scripts/verify-action-real-postgres.mjs',
  'scripts/action-real-postgres-evidence.mjs',
  'lib/action-engine/publication-coordination.real-postgres.test.ts',
  'tests/action-engine-postgres-ci/package.json',
  'tests/action-engine-postgres-ci/pnpm-lock.yaml',
  'tests/action-engine-postgres-ci/pnpm-workspace.yaml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'desktop/package.json',
  'patches/@wllama__wllama@3.6.1.patch',
  'patches/braces@3.0.3.patch',
  'patches/image-size@2.0.2.patch',
  'vitest.config.ts',
  ...[
    '202609140200_company_collaboration',
    '202609200300_company_content',
    '20261007194528_international_workspace_country_config',
    '20261008001726_new_us_workspace_admission',
    '20261011011348_action_engine_publication_coordination',
  ].map((name) => `supabase/migrations/${name}.sql`),
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let stage = 'source_guard';
let safeClusterComparison = { queryCompleted: false };

function childEnvironment(environment) {
  const allowed = /^(?:PATH|HOME|TMPDIR|TMP|TEMP|CI|CIRCLECI|CIRCLE_SHA1)$/;
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => allowed.test(name)),
  );
}
function checkedProcess(program, arguments_, environment, cwd = repository) {
  const result = spawnSync(program, arguments_, {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  // Never reflect package-manager, Git or child-process error text.
  assert.ok(!result.error && result.status === 0);
  return result.stdout.trim();
}
function ordinary(path, directory) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(sep)) {
    if (!part) continue;
    cursor = join(cursor, part);
    assert.ok(!lstatSync(cursor).isSymbolicLink());
  }
  const stat = lstatSync(absolute);
  assert.ok(directory ? stat.isDirectory() : stat.isFile());
  return realpathSync(absolute);
}
function createOrdinaryDirectory(path) {
  const parent = dirname(path);
  if (!existsSync(parent)) createOrdinaryDirectory(parent);
  ordinary(parent, true);
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  return ordinary(path, true);
}
export function assertG3CiSource(environment = process.env) {
  stage = 'source_guard';
  assert.equal(process.platform, 'linux');
  assert.equal(environment.CIRCLECI, 'true');
  assert.equal(environment.CIRCLE_BRANCH, branch);
  assert.equal(environment.ZENTRA_ACTION_PG_VERIFY_ONLY, 'true');
  assert.equal(environment.ZENTRA_ACTION_PG_VERIFY_REAL_POSTGRES, 'true');
  const source = environment.ZENTRA_ACTION_PG_EXPECTED_SOURCE;
  assert.match(source || '', /^[a-f0-9]{40}$/);
  assert.equal(environment.CIRCLE_SHA1, source);
  assert.ok(
    !Object.keys(environment).some((name) => /^PG[A-Z_]*$/i.test(name)),
  );
  const clean = childEnvironment(environment);
  assert.equal(checkedProcess('git', ['rev-parse', 'HEAD'], clean), source);
  checkedProcess('git', ['ls-files', '--error-unmatch', ...sourceFiles], clean);
  checkedProcess(
    'git',
    ['diff', '--exit-code', source, '--', ...sourceFiles],
    clean,
  );
  return { source, clean };
}
export function installG3CiDependencies(environment = process.env) {
  const { clean } = assertG3CiSource(environment);
  stage = 'dependency_installation';
  const installationDirectory = mkdtempSync(
    join(tmpdir(), 'zentra-g3-dependencies-'),
  );
  const userConfig = join(installationDirectory, 'npm-user.ini');
  const globalConfig = join(installationDirectory, 'npm-global.ini');
  for (const file of [userConfig, globalConfig])
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  const installationEnvironment = {
    ...clean,
    HOME: installationDirectory,
    COREPACK_HOME: join(installationDirectory, 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  };
  checkedProcess(
    'corepack',
    ['prepare', 'pnpm@11.25.0', '--activate'],
    installationEnvironment,
  );
  assert.equal(
    checkedProcess('corepack', ['pnpm', '--version'], installationEnvironment),
    '11.25.0',
  );
  for (const cwd of [repository, ordinary(qaDirectory, true)]) {
    checkedProcess(
      'corepack',
      ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
      installationEnvironment,
      cwd,
    );
  }
  // A frozen installation may not rewrite any tracked verification source.
  assertG3CiSource(environment);
}

async function attestFreshCluster(client) {
  stage = 'cluster_identity';
  safeClusterComparison = { queryCompleted: false };
  const identity = (
    await client.query(
      "select current_database() as database,current_user as owner,inet_server_addr()::text as host,inet_client_addr()::text as client,inet_server_port() as port,current_setting('server_version_num') as version,current_setting('default_transaction_read_only') as read_only",
    )
  ).rows[0];
  safeClusterComparison = {
    queryCompleted: true,
    databaseMatches: identity?.database === 'postgres',
    ownerMatches: identity?.owner === 'postgres',
    hostMatches: identity?.host === '127.0.0.1',
    clientMatches: identity?.client === '127.0.0.1',
    portMatches: identity?.port === 5432,
    versionMatches: identity?.version === '170006',
    versionNumeric: /^[0-9]{6}$/.test(identity?.version || '')
      ? Number(identity.version)
      : null,
    readOnlyMatches: identity?.read_only === 'on',
  };
  assert.deepEqual(identity, {
    database: 'postgres',
    owner: 'postgres',
    host: '127.0.0.1',
    client: '127.0.0.1',
    port: 5432,
    version: '170006',
    read_only: 'on',
  });
  stage = 'cluster_password';
  safeClusterComparison = { queryCompleted: false };
  const passwordEncryption = (
    await client.query(
      "select current_setting('password_encryption') as method",
    )
  ).rows[0].method;
  safeClusterComparison = {
    queryCompleted: true,
    methodMatches: passwordEncryption === 'scram-sha-256',
  };
  assert.equal(passwordEncryption, 'scram-sha-256');
  stage = 'cluster_hba';
  safeClusterComparison = { queryCompleted: false };
  const authenticationRules = (
    await client.query('select type,auth_method,error from pg_hba_file_rules')
  ).rows;
  safeClusterComparison = {
    queryCompleted: true,
    ruleCount: authenticationRules.length,
    errorCount: authenticationRules.filter((rule) => rule.error !== null)
      .length,
    hostRuleCount: authenticationRules.filter((rule) =>
      String(rule.type).startsWith('host'),
    ).length,
    hostMethodMismatchCount: authenticationRules.filter(
      (rule) =>
        String(rule.type).startsWith('host') &&
        rule.auth_method !== 'scram-sha-256',
    ).length,
  };
  assert.ok(authenticationRules.every((rule) => rule.error === null));
  const hostRules = authenticationRules.filter((rule) =>
    String(rule.type).startsWith('host'),
  );
  assert.ok(hostRules.length > 0);
  assert.ok(
    hostRules.every(
      (rule) => rule.auth_method === 'scram-sha-256' && rule.error === null,
    ),
  );
  stage = 'cluster_databases';
  safeClusterComparison = { queryCompleted: false };
  const databases = (
    await client.query(
      'select datname,datistemplate,pg_get_userbyid(datdba) as owner from pg_database order by datname',
    )
  ).rows;
  safeClusterComparison = {
    queryCompleted: true,
    databaseCount: databases.length,
    expectedNames: databases.every((row) =>
      ['postgres', 'template0', 'template1'].includes(row.datname),
    ),
    expectedOwners: databases.every((row) => row.owner === 'postgres'),
    expectedTemplateFlags: databases.every(
      (row) =>
        row.datistemplate ===
        (row.datname === 'template0' || row.datname === 'template1'),
    ),
    expectedOrder: ['postgres', 'template0', 'template1'].every(
      (name, index) => databases[index]?.datname === name,
    ),
  };
  assert.deepEqual(databases, [
    { datname: 'postgres', datistemplate: false, owner: 'postgres' },
    { datname: 'template0', datistemplate: true, owner: 'postgres' },
    { datname: 'template1', datistemplate: true, owner: 'postgres' },
  ]);
  stage = 'cluster_roles';
  safeClusterComparison = { queryCompleted: false };
  const roles = (
    await client.query(
      "select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls from pg_roles where rolname !~ '^pg_' order by rolname",
    )
  ).rows;
  safeClusterComparison = {
    queryCompleted: true,
    roleCount: roles.length,
    expectedName: roles[0]?.rolname === 'postgres',
    ...Object.fromEntries(
      [
        'rolsuper',
        'rolinherit',
        'rolcreaterole',
        'rolcreatedb',
        'rolcanlogin',
        'rolreplication',
        'rolbypassrls',
      ].map((field) => [`${field}Matches`, roles[0]?.[field] === true]),
    ),
  };
  assert.deepEqual(roles, [
    {
      rolname: 'postgres',
      rolsuper: true,
      rolinherit: true,
      rolcreaterole: true,
      rolcreatedb: true,
      rolcanlogin: true,
      rolreplication: true,
      rolbypassrls: true,
    },
  ]);
  stage = 'cluster_clients';
  safeClusterComparison = { queryCompleted: false };
  const otherClientCount = (
    await client.query(
      "select pid from pg_stat_activity where backend_type='client backend' and pid<>pg_backend_pid()",
    )
  ).rows.length;
  safeClusterComparison = {
    queryCompleted: true,
    otherClientCount,
    expectedZero: otherClientCount === 0,
  };
  assert.equal(otherClientCount, 0);
  stage = 'cluster_memberships';
  safeClusterComparison = { queryCompleted: false };
  const membershipCount = (
    await client.query(
      "select 1 from pg_auth_members m join pg_roles member on member.oid=m.member where member.rolname !~ '^pg_'",
    )
  ).rows.length;
  safeClusterComparison = {
    queryCompleted: true,
    membershipCount,
    expectedZero: membershipCount === 0,
  };
  assert.equal(membershipCount, 0);
  stage = 'cluster_objects';
  safeClusterComparison = { queryCompleted: false };
  const objectCount = Number(
    (
      await client.query(
        "select (select count(*) from pg_namespace where nspname !~ '^pg_' and nspname not in ('public','information_schema'))+(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public')+(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')+(select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public')+(select count(*) from pg_extension where extname<>'plpgsql') as count",
      )
    ).rows[0].count,
  );
  safeClusterComparison = {
    queryCompleted: true,
    objectCount:
      Number.isSafeInteger(objectCount) && objectCount >= 0
        ? objectCount
        : null,
    expectedZero: objectCount === 0,
  };
  assert.equal(objectCount, 0);
  return {
    identity,
    databases,
    roles,
    authentication: {
      passwordEncryption,
      hostRuleCount: hostRules.length,
      hostMethods: ['scram-sha-256'],
    },
    otherClientCount: 0,
    userObjectCount: 0,
  };
}
export async function verifyG3Ci(environment = process.env) {
  const { source, clean } = assertG3CiSource(environment);
  stage = 'driver_validation';
  const moduleDirectory = ordinary(
    realpathSync(join(qaDirectory, 'node_modules/pg')),
    true,
  );
  const modulePackage = JSON.parse(
    readFileSync(
      ordinary(join(moduleDirectory, 'package.json'), false),
      'utf8',
    ),
  );
  assert.equal(modulePackage.name, 'pg');
  assert.equal(modulePackage.version, '8.16.3');
  const { Client } = createRequire(import.meta.url)(moduleDirectory);
  assert.equal(typeof Client, 'function');
  const runId = randomBytes(16).toString('hex');
  const owner = `zentra_action_engine_qa_${runId}`;
  const ownerPassword = randomBytes(32).toString('hex');
  const requestedDirectory = join(
    repository,
    '.qa/action-engine-postgres-ci',
    runId,
  );
  assert.ok(!existsSync(requestedDirectory));
  const directory = createOrdinaryDirectory(requestedDirectory);
  const report = join(directory, `action-engine-real-postgres-${runId}.json`);
  assert.ok(!existsSync(report));
  const options = {
    host: '127.0.0.1',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: syntheticAdminPassword,
    ssl: false,
    options:
      '-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=5000',
    connectionTimeoutMillis: 1000,
    query_timeout: 12000,
    application_name: `zentra-g3-bootstrap-${runId}`,
  };
  stage = 'loopback_readiness';
  let admin;
  let driverFailed = false;
  const deadline = Date.now() + 60_000;
  while (!admin && Date.now() < deadline) {
    assertG3CiSource(environment);
    stage = 'loopback_readiness';
    const candidate = new Client(options);
    candidate.on('error', () => {
      if (admin === candidate) driverFailed = true;
    });
    try {
      await candidate.connect();
      admin = candidate;
    } catch {
      await candidate.end().catch(() => {});
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  }
  assert.ok(admin);
  let attestation;
  try {
    attestation = await attestFreshCluster(admin);
    stage = 'qa_role_creation';
    await admin.query('set default_transaction_read_only=off');
    await admin.query('begin');
    await admin.query(
      'create role anon nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
    );
    await admin.query(
      'create role authenticated nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
    );
    await admin.query(
      'create role service_role nologin noinherit nosuperuser nocreatedb nocreaterole noreplication bypassrls',
    );
    await admin.query(
      // The only interpolated password is 64 hex characters generated above.
      `create role "${owner}" login noinherit nosuperuser nocreatedb createrole noreplication nobypassrls password '${ownerPassword}'`,
    );
    await admin.query(
      `grant anon,authenticated,service_role to "${owner}" with admin false, inherit false, set true`,
    );
    await admin.query('commit');
    stage = 'qa_database_creation';
    // CREATE DATABASE cannot share a transaction or a multi-statement query.
    await admin.query(
      `create database "${owner}" owner "${owner}" template template0`,
    );
  } finally {
    await admin.end();
  }
  assert.ok(!driverFailed);
  stage = 'bootstrap_evidence';
  writeFileSync(
    join(directory, 'bootstrap-proof.json'),
    `${JSON.stringify(
      {
        format: 'zentra-action-postgres-ci-bootstrap',
        schemaVersion: 1,
        synthetic: true,
        sourceCommit: source,
        branch,
        runId,
        configuredImages: {
          node: 'cimg/node:22.16',
          postgres: 'postgres:17.6',
        },
        pgModuleVersion: modulePackage.version,
        authentication: {
          configuredHostMethod: 'scram-sha-256',
          adminCredential: 'public_synthetic_test_only',
          qaCredential: 'random_ephemeral_not_recorded',
        },
        target: { host: '127.0.0.1', port: 5432, database: owner, user: owner },
        freshClusterBeforeMutations: attestation,
        bootstrapConnectionClosed: true,
        qaDatabaseCreated: true,
        realPostgresVerificationExecuted: false,
        productionDataUsed: false,
        publishesRelease: false,
        deploysApplication: false,
        sources: sourceFiles.map((file) => ({
          file,
          sha256: digest(readFileSync(join(repository, file))),
        })),
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  // The real runner independently attests the resulting empty QA database,
  // role ACLs/memberships and absence of every other connected client.
  assertG3CiSource(environment);
  stage = 'real_postgres_verification';
  checkedProcess(
    process.execPath,
    [join(repository, 'scripts/verify-action-real-postgres.mjs')],
    {
      ...clean,
      ZENTRA_ACTION_REAL_PG: '1',
      ZENTRA_ACTION_REAL_PG_HOST: '127.0.0.1',
      ZENTRA_ACTION_REAL_PG_PORT: '5432',
      ZENTRA_ACTION_REAL_PG_RUN_ID: runId,
      ZENTRA_ACTION_REAL_PG_DATABASE: owner,
      ZENTRA_ACTION_REAL_PG_USER: owner,
      ZENTRA_ACTION_REAL_PG_PASSWORD: ownerPassword,
      ZENTRA_ACTION_REAL_PG_SOURCE_COMMIT: source,
      ZENTRA_ACTION_REAL_PG_MODULE_DIR: moduleDirectory,
      ZENTRA_ACTION_REAL_PG_REPORT_FILE: report,
    },
  );
  assertG3CiSource(environment);
  return { directory, runId, source };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    assert.equal(process.argv.length, 3);
    if (process.argv[2] === '--install') {
      installG3CiDependencies();
      process.stdout.write(
        'Locked G3 test dependencies installed without scripts.\n',
      );
    } else {
      assert.equal(process.argv[2], '--verify');
      await verifyG3Ci();
      process.stdout.write(
        'Isolated G3 verification passed; evidence artifacts collected.\n',
      );
    }
  } catch {
    // Stage is a fixed local label; no CLI/SQL/driver error or credential leaks.
    process.stderr.write(
      `Isolated G3 CI refused at ${stage}; no successful verification is claimed.\n`,
    );
    if (stage.startsWith('cluster_'))
      process.stderr.write(
        `Safe cluster comparisons: ${JSON.stringify(safeClusterComparison)}\n`,
      );
    process.exitCode = 1;
  }
}
