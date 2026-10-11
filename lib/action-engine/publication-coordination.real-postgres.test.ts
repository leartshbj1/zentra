import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { open, readFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { readRealPostgresConfiguration } from '../../scripts/action-real-postgres-evidence.mjs';

// G3 only. Prepared on 2026-10-11 without local PostgreSQL execution.
// Opt-in requires an explicitly selected QA pg package and a fresh, dedicated
// loopback PostgreSQL cluster/database. No ambient PG*, URL, pool, cloud,
// Supabase client, D1, provider, native process or deployment profile is used.
// The unchanged admission migration creates a cluster role: the QA owner needs
// CREATEROLE (never SUPERUSER), and the whole cluster must be disposable.
// This proves SQL scheduling/ACLs only, never hosted parity or D1 admission.
const enabled = process.env.ZENTRA_ACTION_REAL_PG === '1';
if (
  !enabled &&
  Object.keys(process.env).some((name) =>
    name.startsWith('ZENTRA_ACTION_REAL_PG'),
  )
) {
  throw new Error('ZENTRA_ACTION_REAL_PG_CONFIGURATION_REFUSED');
}

export const REAL_POSTGRES_CASE_NAMES = [
  'observes a head-row lock between independent PostgreSQL backends',
  'serializes two same-base commits into one publication and one cancellation',
  'serializes concurrent replay of the same operation exactly once',
  'returns the committed receipt when close waits behind commit',
  'tombstones before a delayed commit, including an absent candidate',
  'lets a waiting close cancel after the unpublished commit rolls back',
  'preserves exact receipts after a newer head, pruning and identity mismatch',
  'enforces anon/authenticated ACLs, service mutation guards and legacy refusal',
] as const;
const migrationNames = [
  '202609140200_company_collaboration',
  '202609200300_company_content',
  '20261007194528_international_workspace_country_config',
  '20261008001726_new_us_workspace_admission',
  '20261011011348_action_engine_publication_coordination',
] as const;
type Row = Record<string, unknown>;
type Json = Record<string, unknown>;
type Role = 'service_role' | 'anon' | 'authenticated';
type Rpc = 'zentra_commit_workspace_v2' | 'zentra_close_action_publication_v1';
type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] } | { rows: Row[] }[]>;
  on(event: 'error', listener: () => void): void;
};
type Session = { client: Client; pid: number; transaction: boolean };
type Identity = {
  organizationId: string;
  snapshotId: string;
  installationId: string;
  userId: string;
  baseRevision: number;
  operationId: string;
};
type LockEvidence = {
  case: string;
  blockedPid: number;
  blockerPid: number;
  state: string;
  waitEventType: string;
  waitEvent: string;
  blockingPids: number[];
};
type Configuration = NonNullable<
  ReturnType<typeof readRealPostgresConfiguration>
>;
let configuration: Configuration;
let control: Session;
let first: Session;
let second: Session;
let observer: Session;
let serverVersion = '';
let setupComplete = false;
let cleanupFailed = false;
let driverFailed = false;
let currentCase = '';
let caseTaskPassed = false;
const sessions: Session[] = [];
const pending = new Set<Promise<unknown>>();
const cases: { name: string; passed: true }[] = [];
const locks: LockEvidence[] = [];
const migrations: { file: string; sha256: string }[] = [];
const hash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const archive = Buffer.from('synthetic-g3-sql-only-archive', 'utf8');
const part = { sha256: hash(archive), size_bytes: archive.length };
const manifest = {
  format: 'zentra-cloud-backup',
  version: 1,
  app_version: '1.90.15',
  sha256: part.sha256,
  size_bytes: part.size_bytes,
  chunks: [part],
};

function failure(code: string): never {
  throw new Error('ZENTRA_ACTION_REAL_PG_' + code);
}
async function sql(
  session: Session,
  text: string,
  values?: unknown[],
): Promise<Row[]> {
  try {
    const result = await session.client.query(text, values);
    return Array.isArray(result) ? (result.at(-1)?.rows ?? []) : result.rows;
  } catch (error) {
    // Driver messages may contain connection/authentication material. Retain
    // only SQLSTATE for the assertions, never the raw error or its cause.
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
    throw Object.assign(new Error('ZENTRA_ACTION_REAL_PG_QUERY_FAILED'), {
      code: /^[A-Z0-9]{5}$/.test(code) ? code : 'UNKNOWN',
    });
  }
}
async function begin(session: Session, role?: Role) {
  await sql(session, 'begin');
  session.transaction = true;
  if (role) await sql(session, 'set local role ' + role);
}
async function finish(session: Session, commit: boolean) {
  await sql(session, commit ? 'commit' : 'rollback');
  session.transaction = false;
}
async function asRole(
  session: Session,
  role: Role,
  text: string,
  values?: unknown[],
) {
  await begin(session, role);
  try {
    const rows = await sql(session, text, values);
    await finish(session, true);
    return rows;
  } catch (error) {
    await finish(session, false);
    throw error;
  }
}
function json(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    failure('EXPECTED_JSON_OBJECT');
  return value as Json;
}
function args(identity: Identity) {
  return [
    identity.organizationId,
    identity.snapshotId,
    identity.installationId,
    identity.userId,
    identity.baseRevision,
    identity.operationId,
  ];
}
async function rpcInTransaction(
  session: Session,
  name: Rpc,
  identity: Identity,
) {
  return json(
    (
      await sql(
        session,
        'select public.' + name + '($1,$2,$3,$4,$5,$6) as r',
        args(identity),
      )
    )[0].r,
  );
}
async function rpc(
  session: Session,
  name: Rpc,
  identity: Identity,
  role: Role = 'service_role',
) {
  return json(
    (
      await asRole(
        session,
        role,
        'select public.' + name + '($1,$2,$3,$4,$5,$6) as r',
        args(identity),
      )
    )[0].r,
  );
}
function startRpc(session: Session, name: Rpc, identity: Identity) {
  const promise = rpc(session, name, identity);
  pending.add(promise);
  void promise.then(
    () => pending.delete(promise),
    () => pending.delete(promise),
  );
  return promise;
}
const commit = (session: Session, identity: Identity) =>
  rpc(session, 'zentra_commit_workspace_v2', identity);
const close = (session: Session, identity: Identity) =>
  rpc(session, 'zentra_close_action_publication_v1', identity);
async function head(organizationId: string) {
  const row = (
    await asRole(
      control,
      'service_role',
      'select revision,snapshot_id from public.zentra_workspaces where organization_id=$1',
      [organizationId],
    )
  )[0];
  return { revision: Number(row.revision), snapshotId: row.snapshot_id };
}
async function fact(identity: Identity) {
  return (
    await asRole(
      control,
      'service_role',
      'select public.zentra_action_publication_fact_v1($1,$2) as r',
      [identity.organizationId, identity.operationId],
    )
  )[0].r;
}
async function candidate(
  organizationId: string,
  baseRevision = 0,
): Promise<Identity> {
  const identity = {
    organizationId,
    snapshotId: randomUUID(),
    installationId: 'synthetic-g3-device-' + randomUUID(),
    userId: 'synthetic-g3-owner',
    baseRevision,
    operationId: randomUUID(),
  };
  await asRole(
    control,
    'service_role',
    'insert into public.zentra_workspace_snapshots(organization_id,id,installation_id,created_by,base_revision,manifest,size_bytes) values($1,$2,$3,$4,$5,$6,$7)',
    [...args(identity).slice(0, 5), JSON.stringify(manifest), part.size_bytes],
  );
  await asRole(
    control,
    'service_role',
    'insert into public.zentra_workspace_chunks values($1,$2,0,$3,$4)',
    [organizationId, identity.snapshotId, part.sha256, part.size_bytes],
  );
  return identity;
}
async function fixture() {
  const organizationId = 'synthetic-g3-' + randomUUID();
  await asRole(
    control,
    'service_role',
    'insert into public.zentra_workspaces(organization_id,updated_by) values($1,$2)',
    [organizationId, 'synthetic-g3-owner'],
  );
  const identity = await candidate(organizationId);
  expect(
    (
      await asRole(
        control,
        'service_role',
        'select public.zentra_enable_action_publication_guard_v1($1) as r',
        [organizationId],
      )
    )[0].r,
  ).toEqual({ guarded: true, revision: 0, snapshotId: null });
  return identity;
}
async function observeBlocked(blocked: Session, blocker: Session) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = (
      await sql(
        observer,
        'select state,wait_event_type as "waitEventType",wait_event as "waitEvent",pg_catalog.pg_blocking_pids(pid) as "blockingPids" from pg_catalog.pg_stat_activity where pid=$1 and datname=pg_catalog.current_database()',
        [blocked.pid],
      )
    )[0];
    if (
      row?.state === 'active' &&
      row.waitEventType === 'Lock' &&
      Array.isArray(row.blockingPids) &&
      row.blockingPids.includes(blocker.pid)
    ) {
      expect(blocked.pid).not.toBe(blocker.pid);
      locks.push({
        case: currentCase,
        blockedPid: blocked.pid,
        blockerPid: blocker.pid,
        state: 'active',
        waitEventType: 'Lock',
        waitEvent: String(row.waitEvent),
        blockingPids: row.blockingPids as number[],
      });
      return;
    }
    // Poll actual server state. This delay is not evidence of a lock.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  failure('EXPECTED_BLOCKING_NOT_OBSERVED');
}
async function operationStates(organizationId: string) {
  return asRole(
    control,
    'service_role',
    'select state,count(*)::integer as count from public.zentra_action_publication_operations where organization_id=$1 group by state order by state',
    [organizationId],
  );
}

async function preflight(session: Session) {
  const row = (
    await sql(
      session,
      "select pg_catalog.current_database() as database,current_user as owner,pg_catalog.host(pg_catalog.inet_server_addr()) as host,pg_catalog.inet_server_port() as port,pg_catalog.host(pg_catalog.inet_client_addr()) as client_host,pg_catalog.current_setting('server_version') as version,pg_catalog.current_setting('server_version_num') as version_number,pg_catalog.current_setting('default_transaction_read_only') as read_only",
    )
  )[0];
  if (
    row.database !== configuration.database ||
    row.owner !== configuration.user ||
    row.host !== '127.0.0.1' ||
    row.client_host !== '127.0.0.1' ||
    Number(row.port) !== configuration.port ||
    row.read_only !== 'on'
  )
    failure('SERVER_IDENTITY_REFUSED');
  serverVersion = String(row.version);
  const databases = await sql(
    session,
    'select datname,datistemplate,pg_catalog.pg_get_userbyid(datdba) as owner from pg_catalog.pg_database',
  );
  if (
    databases.some(
      (database) =>
        ![
          'postgres',
          'template0',
          'template1',
          configuration.database,
        ].includes(String(database.datname)) ||
        (database.datname === configuration.database
          ? database.owner !== configuration.user || database.datistemplate
          : database.owner !== 'postgres' ||
            database.datistemplate !==
              (database.datname === 'template0' ||
                database.datname === 'template1')),
    ) ||
    !databases.some((database) => database.datname === configuration.database)
  )
    failure('DEDICATED_CLUSTER_REFUSED');
  const roles = await sql(
    session,
    "select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls from pg_catalog.pg_roles where rolname !~ '^pg_'",
  );
  const allowedRoles = [
    'postgres',
    'anon',
    'authenticated',
    'service_role',
    configuration.user,
  ];
  if (
    roles.some((role) => !allowedRoles.includes(String(role.rolname))) ||
    allowedRoles.some((name) => !roles.some((role) => role.rolname === name))
  )
    failure('CLUSTER_ROLES_REFUSED');
  for (const role of roles.filter((role) => role.rolname !== 'postgres')) {
    const owner = role.rolname === configuration.user;
    if (
      role.rolsuper ||
      role.rolcreatedb ||
      role.rolreplication ||
      role.rolcreaterole !== owner ||
      role.rolcanlogin !== owner ||
      role.rolbypassrls !== (role.rolname === 'service_role') ||
      (owner && role.rolinherit)
    )
      failure('ROLE_PRIVILEGES_REFUSED');
  }
  const membershipOptions = Number(row.version_number) >= 160_000;
  const memberships = await sql(
    session,
    'select parent.rolname as parent,member.rolname as member,m.admin_option' +
      (membershipOptions ? ',m.inherit_option,m.set_option' : '') +
      " from pg_catalog.pg_auth_members m join pg_catalog.pg_roles parent on parent.oid=m.roleid join pg_catalog.pg_roles member on member.oid=m.member where member.rolname !~ '^pg_'",
  );
  if (
    memberships.some(
      (membership) =>
        membership.member !== configuration.user ||
        membership.admin_option !== false ||
        (membershipOptions &&
          (membership.inherit_option !== false ||
            membership.set_option !== true)) ||
        !['anon', 'authenticated', 'service_role'].includes(
          String(membership.parent),
        ),
    ) ||
    ['anon', 'authenticated', 'service_role'].some(
      (role) =>
        !memberships.some(
          (membership) =>
            membership.member === configuration.user &&
            membership.parent === role,
        ),
    )
  )
    failure('ROLE_MEMBERSHIPS_REFUSED');
  if (
    (
      await sql(
        session,
        'select pid from pg_catalog.pg_stat_activity where datname is not null and pid<>pg_catalog.pg_backend_pid()',
      )
    ).length
  )
    failure('OTHER_CLIENTS_REFUSED');
  const objects = (
    await sql(
      session,
      "select (select count(*) from pg_catalog.pg_namespace where nspname !~ '^pg_' and nspname not in ('public','information_schema'))+(select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public')+(select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public')+(select count(*) from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid=t.typnamespace where n.nspname='public')+(select count(*) from pg_catalog.pg_extension where extname<>'plpgsql') as count",
    )
  )[0];
  if (Number(objects.count) !== 0) failure('NONEMPTY_DATABASE_REFUSED');
  // Verify SET ROLE itself before any schema or fixture mutation.
  for (const role of ['anon', 'authenticated', 'service_role'] as const) {
    expect(
      (await asRole(session, role, 'select current_user as role'))[0].role,
    ).toBe(role);
  }
}

const isolatedSuite = enabled ? describe.sequential : describe.skip;
isolatedSuite('G3 isolated real PostgreSQL publication coordination', () => {
  beforeAll(async () => {
    const selected = readRealPostgresConfiguration();
    if (!selected) failure('CONFIGURATION_REFUSED');
    configuration = selected;
    const pgModule = createRequire(import.meta.url)(
      configuration.moduleDirectory,
    ) as { Client: new (options: Record<string, unknown>) => Client };
    if (typeof pgModule.Client !== 'function') failure('PG_MODULE_REFUSED');
    async function connect(label: string) {
      const client = new pgModule.Client({
        host: configuration.host,
        port: configuration.port,
        database: configuration.database,
        user: configuration.user,
        password: configuration.password || 'synthetic-g3-explicit-no-password',
        ssl: false,
        application_name: 'zentra-g3-' + configuration.runId + '-' + label,
        options:
          '-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=20000',
        connectionTimeoutMillis: 3_000,
        query_timeout: 17_000,
      });
      const session = { client, pid: 0, transaction: false };
      sessions.push(session);
      client.on('error', () => {
        driverFailed = true;
      });
      try {
        await client.connect();
      } catch {
        failure('CONNECTION_REFUSED');
      }
      session.pid = Number(
        (await sql(session, 'select pg_catalog.pg_backend_pid() as pid'))[0]
          .pid,
      );
      return session;
    }
    control = await connect('control');
    await preflight(control);
    await sql(control, 'set default_transaction_read_only=off');
    await sql(
      control,
      'create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); grant usage on schema public to anon,authenticated,service_role;',
    );
    for (const name of migrationNames) {
      const file = 'supabase/migrations/' + name + '.sql';
      const bytes = await readFile(new URL('../../' + file, import.meta.url));
      await sql(control, bytes.toString('utf8'));
      migrations.push({ file, sha256: hash(bytes) });
    }
    expect(
      (
        await sql(
          control,
          "select rolcanlogin,rolinherit,rolsuper,rolbypassrls from pg_catalog.pg_roles where rolname='zentra_us_admission_owner'",
        )
      )[0],
    ).toEqual({
      rolcanlogin: false,
      rolinherit: false,
      rolsuper: false,
      rolbypassrls: false,
    });
    first = await connect('first');
    second = await connect('second');
    observer = await connect('observer');
    for (const session of [first, second])
      await sql(session, 'set default_transaction_read_only=off');
    expect(new Set(sessions.map((session) => session.pid)).size).toBe(4);
    expect(sessions.every((session) => session.pid > 0)).toBe(true);
    setupComplete = true;
  }, 30_000);

  afterEach(async () => {
    const startedAt = Date.now();
    try {
      // Release the deliberately held first transaction before draining any
      // waiting second connection. Each expected SQL error has its own rollback.
      if (first?.transaction) await finish(first, false);
      await Promise.allSettled(pending);
      for (const session of sessions) {
        await sql(session, 'rollback');
        session.transaction = false;
      }
      if (Date.now() - startedAt > 20_000)
        failure('TRANSACTION_CLEANUP_DEADLINE');
      if (caseTaskPassed) cases.push({ name: currentCase, passed: true });
    } catch {
      cleanupFailed = true;
      failure('TRANSACTION_CLEANUP_FAILED');
    }
  }, 25_000);

  afterAll(async () => {
    const startedAt = Date.now();
    // Close every connection even when setup or a case failed. No database or
    // cluster role is dropped: the disposable fixture is retained for inspection
    // and a second run must fail the fresh/empty preflight.
    const results = await Promise.allSettled(
      sessions.map(async (session) => {
        try {
          await sql(session, 'rollback');
          session.transaction = false;
        } finally {
          await session.client.end();
        }
      }),
    );
    if (
      results.some((result) => result.status === 'rejected') ||
      Date.now() - startedAt > 20_000
    ) {
      cleanupFailed = true;
      failure('CONNECTION_CLEANUP_FAILED');
    }
    if (
      !setupComplete ||
      cleanupFailed ||
      driverFailed ||
      cases.length !== REAL_POSTGRES_CASE_NAMES.length
    )
      return;
    expect(cases.map((item) => item.name)).toEqual([
      ...REAL_POSTGRES_CASE_NAMES,
    ]);
    expect(locks.map((item) => item.case)).toEqual(
      REAL_POSTGRES_CASE_NAMES.slice(0, 6),
    );
    const testFile =
      'lib/action-engine/publication-coordination.real-postgres.test.ts';
    const proof = {
      format: 'zentra-action-real-postgres-proof',
      schemaVersion: 1,
      synthetic: true,
      gate: 'G3',
      status: 'passed',
      runId: configuration.runId,
      sourceCommit: configuration.sourceCommit,
      testFile,
      testSha256: hash(await readFile(new URL(import.meta.url))),
      pgModule: { name: 'pg', version: configuration.moduleVersion },
      target: {
        host: configuration.host,
        port: configuration.port,
        database: configuration.database,
      },
      server: {
        version: serverVersion,
        backendPids: {
          control: control.pid,
          first: first.pid,
          second: second.pid,
          observer: observer.pid,
        },
      },
      preflight: {
        databaseInitiallyEmpty: true,
        dedicatedClusterChecked: true,
        noOtherClientsInitially: true,
        qaOwnerCreateRoleRequired: true,
        qaOwnerSuperuser: false,
        roleCreatedByUnchangedMigration: 'zentra_us_admission_owner',
        fixtureRetained: true,
      },
      migrations,
      cases,
      locks,
      cleanup: { transactionsClosed: true, connectionsClosed: true },
      limitations: {
        hostedParity: false,
        d1Coordination: false,
        nativeExecution: false,
        archiveInterop: false,
      },
    };
    // Exclusive creation only after successful assertions and all closures.
    // SOURCE_COMMIT is declared input; the separate runner must corroborate HEAD,
    // clean tracked sources, file hashes, Vitest results and this report.
    const file = await open(configuration.reportFile, 'wx');
    try {
      await file.writeFile(JSON.stringify(proof, null, 2) + '\n', 'utf8');
      await file.sync();
      await file.close();
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(configuration.reportFile).catch(() => {});
      throw error;
    }
  }, 25_000);

  function scenario(index: number, task: () => Promise<void>) {
    it(
      REAL_POSTGRES_CASE_NAMES[index],
      async () => {
        const startedAt = Date.now();
        currentCase = REAL_POSTGRES_CASE_NAMES[index];
        caseTaskPassed = false;
        await task();
        if (Date.now() - startedAt > 15_000) failure('CASE_DEADLINE');
        caseTaskPassed = true;
      },
      20_000,
    );
  }

  scenario(0, async () => {
    const identity = await fixture();
    await begin(first, 'service_role');
    await sql(
      first,
      'select organization_id from public.zentra_workspaces where organization_id=$1 for update',
      [identity.organizationId],
    );
    const waiting = startRpc(second, 'zentra_commit_workspace_v2', identity);
    await observeBlocked(second, first);
    expect(await head(identity.organizationId)).toEqual({
      revision: 0,
      snapshotId: null,
    });
    await finish(first, true);
    expect(await waiting).toEqual({
      committed: true,
      revision: 1,
      snapshotId: identity.snapshotId,
    });
  });

  scenario(1, async () => {
    const winner = await fixture();
    const loser = await candidate(winner.organizationId);
    expect(loser.installationId).not.toBe(winner.installationId);
    await begin(first, 'service_role');
    const result = await rpcInTransaction(
      first,
      'zentra_commit_workspace_v2',
      winner,
    );
    const waiting = startRpc(second, 'zentra_commit_workspace_v2', loser);
    await observeBlocked(second, first);
    expect(await head(winner.organizationId)).toEqual({
      revision: 0,
      snapshotId: null,
    });
    await finish(first, true);
    expect(result).toEqual({
      committed: true,
      revision: 1,
      snapshotId: winner.snapshotId,
    });
    expect(await waiting).toEqual({
      committed: false,
      revision: 1,
      snapshotId: winner.snapshotId,
      cancelled: true,
      conflict: true,
    });
    expect(await operationStates(winner.organizationId)).toEqual([
      { state: 'cancelled', count: 1 },
      { state: 'committed', count: 1 },
    ]);
    expect(await head(winner.organizationId)).toEqual({
      revision: 1,
      snapshotId: winner.snapshotId,
    });
    expect(await close(second, loser)).toEqual({
      committed: false,
      revision: 1,
      snapshotId: winner.snapshotId,
    });
  });

  scenario(2, async () => {
    const identity = await fixture();
    await begin(first, 'service_role');
    const result = await rpcInTransaction(
      first,
      'zentra_commit_workspace_v2',
      identity,
    );
    const waiting = startRpc(second, 'zentra_commit_workspace_v2', identity);
    await observeBlocked(second, first);
    await finish(first, true);
    expect(await waiting).toEqual(result);
    expect(result).toEqual({
      committed: true,
      revision: 1,
      snapshotId: identity.snapshotId,
    });
    expect(await operationStates(identity.organizationId)).toEqual([
      { state: 'committed', count: 1 },
    ]);
    expect(await head(identity.organizationId)).toEqual({
      revision: 1,
      snapshotId: identity.snapshotId,
    });
  });

  scenario(3, async () => {
    const identity = await fixture();
    await begin(first, 'service_role');
    const result = await rpcInTransaction(
      first,
      'zentra_commit_workspace_v2',
      identity,
    );
    const waiting = startRpc(
      second,
      'zentra_close_action_publication_v1',
      identity,
    );
    await observeBlocked(second, first);
    await finish(first, true);
    expect(await waiting).toEqual(result);
    expect(result).toEqual({
      committed: true,
      revision: 1,
      snapshotId: identity.snapshotId,
    });
    expect(await fact(identity)).toMatchObject({
      state: 'committed',
      result,
    });
  });

  scenario(4, async () => {
    const identity = await fixture();
    const result = { committed: false, revision: 0, snapshotId: null };
    await begin(first, 'service_role');
    expect(
      await rpcInTransaction(
        first,
        'zentra_close_action_publication_v1',
        identity,
      ),
    ).toEqual(result);
    const waiting = startRpc(second, 'zentra_commit_workspace_v2', identity);
    await observeBlocked(second, first);
    await finish(first, true);
    expect(await waiting).toEqual({
      ...result,
      cancelled: true,
      conflict: true,
    });
    const absent = {
      ...identity,
      snapshotId: randomUUID(),
      operationId: randomUUID(),
    };
    expect(await close(first, absent)).toEqual(result);
    expect(await fact(absent)).toMatchObject({
      state: 'cancelled',
      manifest: null,
      sizeBytes: null,
      contentVersion: null,
      result,
    });
    const next = await candidate(identity.organizationId);
    expect(await commit(first, next)).toEqual({
      committed: true,
      revision: 1,
      snapshotId: next.snapshotId,
    });
    for (const cancelled of [identity, absent]) {
      expect(await close(second, cancelled)).toEqual(result);
      expect(await commit(second, cancelled)).toEqual({
        ...result,
        cancelled: true,
        conflict: true,
      });
      expect(await fact(cancelled)).toMatchObject({
        state: 'cancelled',
        result,
      });
    }
    expect(await head(identity.organizationId)).toEqual({
      revision: 1,
      snapshotId: next.snapshotId,
    });
  });

  scenario(5, async () => {
    const identity = await fixture();
    await begin(first, 'service_role');
    expect(
      await rpcInTransaction(first, 'zentra_commit_workspace_v2', identity),
    ).toMatchObject({ committed: true });
    const waiting = startRpc(
      second,
      'zentra_close_action_publication_v1',
      identity,
    );
    await observeBlocked(second, first);
    await finish(first, false);
    expect(await waiting).toEqual({
      committed: false,
      revision: 0,
      snapshotId: null,
    });
    expect(await commit(first, identity)).toEqual({
      committed: false,
      revision: 0,
      snapshotId: null,
      cancelled: true,
      conflict: true,
    });
    expect(await operationStates(identity.organizationId)).toEqual([
      { state: 'cancelled', count: 1 },
    ]);
    expect(await head(identity.organizationId)).toEqual({
      revision: 0,
      snapshotId: null,
    });
    expect(
      await sql(
        control,
        'select * from zentra_admission_private.action_publication_context',
      ),
    ).toEqual([]);
  });

  scenario(6, async () => {
    const identity = await fixture();
    const result = {
      committed: true,
      revision: 1,
      snapshotId: identity.snapshotId,
    };
    expect(await commit(first, identity)).toEqual(result);
    const next = await candidate(identity.organizationId, 1);
    expect(await commit(second, next)).toEqual({
      committed: true,
      revision: 2,
      snapshotId: next.snapshotId,
    });
    await asRole(
      control,
      'service_role',
      'delete from public.zentra_workspace_snapshots where organization_id=$1 and id=$2',
      [identity.organizationId, identity.snapshotId],
    );
    expect(await commit(first, identity)).toEqual(result);
    expect(await close(second, identity)).toEqual(result);
    expect(await fact(identity)).toMatchObject({
      state: 'committed',
      manifest,
      sizeBytes: part.size_bytes,
      result,
    });
    expect(await head(identity.organizationId)).toEqual({
      revision: 2,
      snapshotId: next.snapshotId,
    });
    const foreign = await fixture();
    for (const patch of [
      { organizationId: foreign.organizationId },
      { snapshotId: randomUUID() },
      { installationId: 'synthetic-other-device' },
      { userId: 'synthetic-other-owner' },
      { baseRevision: 1 },
    ]) {
      await expect(
        commit(first, { ...identity, ...patch }),
      ).rejects.toMatchObject({ code: 'PA107' });
      await expect(
        close(second, { ...identity, ...patch }),
      ).rejects.toMatchObject({ code: 'PA107' });
    }
  });

  scenario(7, async () => {
    const identity = await fixture();
    for (const schema of ['public', 'zentra_admission_private']) {
      await expect(
        asRole(
          first,
          'service_role',
          'select ' + schema + '.zentra_commit_workspace($1,$2,$3,$4)',
          args(identity).slice(0, 4),
        ),
      ).rejects.toMatchObject({ code: 'PA103' });
    }
    for (const role of ['anon', 'authenticated'] as const) {
      expect(
        (
          await asRole(
            second,
            role,
            "select pg_catalog.has_schema_privilege(current_user,'public','USAGE') as allowed",
          )
        )[0].allowed,
      ).toBe(true);
      await expect(
        asRole(
          second,
          role,
          'select public.zentra_enable_action_publication_guard_v1($1)',
          [identity.organizationId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        rpc(second, 'zentra_commit_workspace_v2', identity, role),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        rpc(second, 'zentra_close_action_publication_v1', identity, role),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asRole(
          second,
          role,
          'select public.zentra_action_publication_fact_v1($1,$2)',
          [identity.organizationId, identity.operationId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asRole(
          second,
          role,
          'select public.zentra_commit_workspace($1,$2,$3,$4)',
          args(identity).slice(0, 4),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      for (const table of [
        'zentra_action_publication_guards',
        'zentra_action_publication_operations',
      ]) {
        await expect(
          asRole(second, role, 'select * from public.' + table),
        ).rejects.toMatchObject({ code: '42501' });
      }
    }
    expect(await commit(first, identity)).toMatchObject({ committed: true });
    await expect(
      asRole(
        second,
        'service_role',
        "update public.zentra_action_publication_operations set state='cancelled' where operation_id=$1",
        [identity.operationId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asRole(
        second,
        'service_role',
        'delete from public.zentra_action_publication_guards where organization_id=$1',
        [identity.organizationId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asRole(
        second,
        'service_role',
        'insert into zentra_admission_private.action_publication_context values(pg_catalog.txid_current(),$1,$2)',
        [identity.organizationId, identity.operationId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asRole(
        second,
        'service_role',
        'update public.zentra_workspaces set revision=2 where organization_id=$1',
        [identity.organizationId],
      ),
    ).rejects.toMatchObject({ code: 'PA103' });
    await expect(
      sql(
        control,
        'delete from public.zentra_action_publication_guards where organization_id=$1',
        [identity.organizationId],
      ),
    ).rejects.toMatchObject({ code: 'PA101' });
    expect(await head(identity.organizationId)).toEqual({
      revision: 1,
      snapshotId: identity.snapshotId,
    });
    expect(
      await sql(
        control,
        'select * from zentra_admission_private.action_publication_context',
      ),
    ).toEqual([]);
  });
});
