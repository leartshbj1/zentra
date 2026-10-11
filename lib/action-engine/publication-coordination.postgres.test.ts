import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Isolated PostgreSQL WASM on the real collaboration/content/country schemas.
// No production URL, service key, persistent dataDir or network access.
// PGlite serializes one connection: these tests do NOT prove interconnection
// scheduling, PostgREST behavior, D1 coordination or deployed migration parity.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = !!moduleDirectory && isAbsolute(moduleDirectory);
type Row = Record<string, unknown>;
type Json = Record<string, unknown>;
type Sql = {
  exec(sql: string): Promise<unknown>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
};
type Database = Sql & {
  transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};
type Identity = {
  organizationId: string;
  snapshotId: string;
  installationId: string;
  userId: string;
  baseRevision: number;
  operationId: string;
};
let database: Database;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const part = { sha256: hash('fictitious archive'), size_bytes: 3 };
const manifest = {
  format: 'zentra-cloud-backup',
  version: 1,
  app_version: '1.90.15',
  sha256: part.sha256,
  size_bytes: 3,
  chunks: [part],
};
const priorOrganization = randomUUID();
let priorSnapshot: string;
let priorState: Row[];

async function asRole(
  role: 'service_role' | 'anon' | 'authenticated',
  sql: string,
  values?: unknown[],
): Promise<Row[]> {
  return database.transaction(async (transaction) => {
    await transaction.exec(`set local role ${role}`);
    return (await transaction.query(sql, values)).rows;
  });
}
function json(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected local PostgreSQL JSON object');
  return value as Json;
}
async function parent(organizationId = randomUUID()) {
  await asRole(
    'service_role',
    "insert into public.zentra_workspaces(organization_id,updated_by) values($1,'fixture-owner')",
    [organizationId],
  );
  return organizationId;
}
async function candidate(
  organizationId: string,
  baseRevision = 0,
  complete = true,
): Promise<Identity> {
  const identity = {
    organizationId,
    snapshotId: randomUUID(),
    installationId: 'fixture-pc',
    userId: 'fixture-owner',
    baseRevision,
    operationId: randomUUID(),
  };
  await asRole(
    'service_role',
    'insert into public.zentra_workspace_snapshots(organization_id,id,installation_id,created_by,base_revision,manifest,size_bytes) values($1,$2,$3,$4,$5,$6,3)',
    [
      identity.organizationId,
      identity.snapshotId,
      identity.installationId,
      identity.userId,
      identity.baseRevision,
      JSON.stringify(manifest),
    ],
  );
  if (complete)
    await asRole(
      'service_role',
      'insert into public.zentra_workspace_chunks values($1,$2,0,$3,3)',
      [organizationId, identity.snapshotId, part.sha256],
    );
  return identity;
}
async function enable(organizationId: string) {
  return json(
    (
      await asRole(
        'service_role',
        'select public.zentra_enable_action_publication_guard_v1($1) as r',
        [organizationId],
      )
    )[0].r,
  );
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
async function rpc(
  name: 'zentra_commit_workspace_v2' | 'zentra_close_action_publication_v1',
  identity: Identity,
  role: 'service_role' | 'anon' | 'authenticated' = 'service_role',
) {
  return json(
    (
      await asRole(
        role,
        `select public.${name}($1,$2,$3,$4,$5,$6) as r`,
        args(identity),
      )
    )[0].r,
  );
}
const commit = (identity: Identity) =>
  rpc('zentra_commit_workspace_v2', identity);
const close = (identity: Identity) =>
  rpc('zentra_close_action_publication_v1', identity);
async function oldCommit(identity: Identity, privateCore = false) {
  return json(
    (
      await asRole(
        'service_role',
        `select ${privateCore ? 'zentra_admission_private' : 'public'}.zentra_commit_workspace($1,$2,$3,$4) as r`,
        args(identity).slice(0, 4),
      )
    )[0].r,
  );
}
async function fact(identity: Identity) {
  return (
    await asRole(
      'service_role',
      'select public.zentra_action_publication_fact_v1($1,$2) as r',
      [identity.organizationId, identity.operationId],
    )
  )[0].r;
}
async function head(organizationId: string) {
  const row = (
    await asRole(
      'service_role',
      'select revision,snapshot_id from public.zentra_workspaces where organization_id=$1',
      [organizationId],
    )
  )[0];
  return { revision: Number(row.revision), snapshotId: row.snapshot_id };
}

describe.runIf(enabled)(
  'A4 opt-in publication coordination on actual PostgreSQL schemas',
  () => {
    beforeAll(async () => {
      expect(
        JSON.parse(
          await readFile(join(moduleDirectory!, 'package.json'), 'utf8'),
        ).name,
      ).toBe('@electric-sql/pglite');
      const { PGlite } = createRequire(import.meta.url)(
        join(moduleDirectory!, 'dist/index.cjs'),
      ) as { PGlite: new () => Database };
      database = new PGlite();
      await database.exec(
        'create role anon; create role authenticated; create role service_role bypassrls; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); grant usage on schema public to service_role;',
      );
      for (const name of [
        '202609140200_company_collaboration',
        '202609200300_company_content',
        '20261007194528_international_workspace_country_config',
        '20261008001726_new_us_workspace_admission',
      ]) {
        await database.exec(
          await readFile(
            new URL(`../../supabase/migrations/${name}.sql`, import.meta.url),
            'utf8',
          ),
        );
      }
      await parent(priorOrganization);
      const before = await candidate(priorOrganization);
      priorSnapshot = before.snapshotId;
      await oldCommit(before);
      priorState = (
        await database.query(
          'select to_jsonb(w) as row from public.zentra_workspaces w where organization_id=$1',
          [priorOrganization],
        )
      ).rows;
      await database.exec(
        await readFile(
          new URL(
            '../../supabase/migrations/20261011011348_action_engine_publication_coordination.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
    }, 20_000);
    afterAll(async () => {
      await database?.close();
    });

    it('does not opt in or change any existing company and preserves the old public gateway outside opt-in', async () => {
      expect(
        (
          await database.query(
            'select * from public.zentra_action_publication_guards',
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await database.query(
            'select to_jsonb(w) as row from public.zentra_workspaces w where organization_id=$1',
            [priorOrganization],
          )
        ).rows,
      ).toEqual(priorState);
      expect(await head(priorOrganization)).toEqual({
        revision: 1,
        snapshotId: priorSnapshot,
      });
      const next = await candidate(priorOrganization, 1);
      expect(await oldCommit(next)).toEqual({
        committed: true,
        revision: 2,
        snapshotId: next.snapshotId,
      });
      // Both new writes and historical legacy replies remain compatible when
      // the company has never opted into the permanent publication guard.
      expect(await oldCommit(next)).toEqual({
        committed: true,
        revision: 2,
        snapshotId: next.snapshotId,
      });
      const unguarded = await candidate(await parent());
      await expect(commit(unguarded)).rejects.toMatchObject({ code: 'PA106' });
    });

    it('enables permanently under the head lock and blocks old public/private paths and direct head writes', async () => {
      const identity = await candidate(await parent());
      expect(await enable(identity.organizationId)).toEqual({
        guarded: true,
        revision: 0,
        snapshotId: null,
      });
      expect(await enable(identity.organizationId)).toEqual({
        guarded: true,
        revision: 0,
        snapshotId: null,
      });
      await expect(oldCommit(identity)).rejects.toMatchObject({
        code: 'PA103',
      });
      await expect(oldCommit(identity, true)).rejects.toMatchObject({
        code: 'PA103',
      });
      await expect(
        asRole(
          'service_role',
          'update public.zentra_workspaces set revision=1,snapshot_id=$2 where organization_id=$1',
          [identity.organizationId, identity.snapshotId],
        ),
      ).rejects.toMatchObject({ code: 'PA103' });
      expect(await head(identity.organizationId)).toEqual({
        revision: 0,
        snapshotId: null,
      });
      expect(
        (
          await asRole(
            'service_role',
            'select revision from public.zentra_workspace_snapshots where organization_id=$1 and id=$2',
            [identity.organizationId, identity.snapshotId],
          )
        )[0].revision,
      ).toBeNull();
      await expect(
        asRole(
          'service_role',
          'delete from public.zentra_action_publication_guards where organization_id=$1',
          [identity.organizationId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        database.query(
          'delete from public.zentra_action_publication_guards where organization_id=$1',
          [identity.organizationId],
        ),
      ).rejects.toMatchObject({ code: 'PA101' });
      // Number reservation updates the independent floor without advancing a head.
      await asRole(
        'service_role',
        "update public.zentra_workspaces set number_floors='[]' where organization_id=$1",
        [identity.organizationId],
      );
    });

    it('keeps pending snapshot metadata immutable and refuses fabricated committed snapshots', async () => {
      const identity = await candidate(await parent());
      await enable(identity.organizationId);
      for (const expression of [
        "installation_id='other-pc'",
        "created_by='other-owner'",
        'base_revision=1',
        'manifest=manifest||\'{"extra":true}\'::jsonb',
        'size_bytes=4',
        'content_version=1',
        "content_digest='changed'",
        "created_at=created_at+interval '1 second'",
      ]) {
        await expect(
          asRole(
            'service_role',
            `update public.zentra_workspace_snapshots set ${expression} where organization_id=$1 and id=$2`,
            [identity.organizationId, identity.snapshotId],
          ),
        ).rejects.toMatchObject({ code: 'PA102' });
      }
      await expect(
        asRole(
          'service_role',
          'delete from public.zentra_workspace_snapshots where organization_id=$1 and id=$2',
          [identity.organizationId, identity.snapshotId],
        ),
      ).rejects.toMatchObject({ code: 'PA102' });
      await expect(
        asRole(
          'service_role',
          'update public.zentra_workspace_snapshots set revision=1 where organization_id=$1 and id=$2',
          [identity.organizationId, identity.snapshotId],
        ),
      ).rejects.toMatchObject({ code: 'PA103' });
      await expect(
        asRole(
          'service_role',
          'insert into public.zentra_workspace_snapshots(organization_id,id,installation_id,created_by,base_revision,revision,manifest,size_bytes) values($1,$2,$3,$4,0,1,$5,3)',
          [
            identity.organizationId,
            randomUUID(),
            identity.installationId,
            identity.userId,
            JSON.stringify(manifest),
          ],
        ),
      ).rejects.toMatchObject({ code: 'PA102' });
    });

    it('commits once, clears its private transaction marker and returns an exact historical receipt on replay/close', async () => {
      const identity = await candidate(await parent());
      await enable(identity.organizationId);
      const result = {
        committed: true,
        revision: 1,
        snapshotId: identity.snapshotId,
      };
      expect(await commit(identity)).toEqual(result);
      // The private core's historical early return must not bypass the public
      // wrapper and leave a lost-ACK D1 attempt pending after flag rollback.
      await expect(oldCommit(identity)).rejects.toMatchObject({
        code: 'PA103',
      });
      expect(await commit(identity)).toEqual(result);
      expect(await close(identity)).toEqual(result);
      expect(
        (
          await database.query(
            'select * from zentra_admission_private.action_publication_context',
          )
        ).rows,
      ).toEqual([]);
      expect(await fact(identity)).toEqual({
        operationId: identity.operationId,
        organizationId: identity.organizationId,
        snapshotId: identity.snapshotId,
        installationId: identity.installationId,
        userId: identity.userId,
        baseRevision: 0,
        state: 'committed',
        manifest,
        sizeBytes: 3,
        contentVersion: 0,
        result,
      });
      expect(
        await fact({ ...identity, organizationId: await parent() }),
      ).toBeNull();
      await expect(
        asRole(
          'service_role',
          'delete from public.zentra_workspace_snapshots where organization_id=$1 and id=$2',
          [identity.organizationId, identity.snapshotId],
        ),
      ).rejects.toMatchObject({ code: 'PA102' });
    });

    it('cancels before a delayed RPC permanently, including an absent candidate, without publishing anything', async () => {
      const identity = await candidate(await parent());
      await enable(identity.organizationId);
      expect(await close(identity)).toEqual({
        committed: false,
        revision: 0,
        snapshotId: null,
      });
      expect(await commit(identity)).toEqual({
        committed: false,
        revision: 0,
        snapshotId: null,
        cancelled: true,
        conflict: true,
      });
      expect(await close(identity)).toEqual({
        committed: false,
        revision: 0,
        snapshotId: null,
      });
      expect(await head(identity.organizationId)).toEqual({
        revision: 0,
        snapshotId: null,
      });
      expect(json(await fact(identity))).toMatchObject({
        state: 'cancelled',
        manifest,
        result: { committed: false, revision: 0, snapshotId: null },
      });
      const absent = {
        ...identity,
        operationId: randomUUID(),
        snapshotId: randomUUID(),
      };
      expect(await close(absent)).toEqual({
        committed: false,
        revision: 0,
        snapshotId: null,
      });
      expect(await commit(absent)).toMatchObject({
        committed: false,
        cancelled: true,
      });
      expect(json(await fact(absent))).toMatchObject({
        state: 'cancelled',
        manifest: null,
        sizeBytes: null,
        contentVersion: null,
      });
      // A later publication must not change a cancelled operation's durable
      // result: recovery corroborates the replay against this original fact.
      const next = await candidate(identity.organizationId);
      expect(await commit(next)).toEqual({
        committed: true,
        revision: 1,
        snapshotId: next.snapshotId,
      });
      for (const cancelled of [identity, absent]) {
        const result = { committed: false, revision: 0, snapshotId: null };
        expect(await close(cancelled)).toEqual(result);
        expect(await commit(cancelled)).toEqual({
          ...result,
          cancelled: true,
          conflict: true,
        });
        expect(json(await fact(cancelled))).toMatchObject({
          state: 'cancelled',
          result,
        });
      }
      expect(await head(identity.organizationId)).toEqual({
        revision: 1,
        snapshotId: next.snapshotId,
      });
    });

    it('retains the real content-defined transport and its complete-only commit behind v2', async () => {
      const organizationId = await parent();
      await enable(organizationId);
      const identity = {
        organizationId,
        snapshotId: randomUUID(),
        installationId: 'fixture-pc',
        userId: 'fixture-owner',
        baseRevision: 0,
        operationId: randomUUID(),
      };
      const entries = [part];
      const prepared = json(
        (
          await asRole(
            'service_role',
            'select public.zentra_prepare_content($1,$2,$3,$4,0,$5,$6,$7,false,$8) as r',
            [
              organizationId,
              identity.snapshotId,
              identity.installationId,
              identity.userId,
              JSON.stringify(manifest),
              JSON.stringify(entries),
              hash(JSON.stringify(entries)),
              '[]',
            ],
          )
        )[0].r,
      );
      expect(prepared.missing).toEqual([part.sha256]);
      await expect(commit(identity)).rejects.toMatchObject({
        message: 'workspace_incomplete',
      });
      await asRole(
        'service_role',
        'select public.zentra_reserve_content_blob($1,$2,$3,$4,$5,3)',
        [
          organizationId,
          identity.snapshotId,
          identity.installationId,
          identity.userId,
          part.sha256,
        ],
      );
      await asRole(
        'service_role',
        "update public.zentra_workspace_content_blobs set state='ready' where organization_id=$1 and sha256=$2",
        [organizationId, part.sha256],
      );
      expect(await commit(identity)).toEqual({
        committed: true,
        revision: 1,
        snapshotId: identity.snapshotId,
      });
      expect(json(await fact(identity))).toMatchObject({
        state: 'committed',
        contentVersion: 1,
        manifest,
      });
    });

    it('can recover an already committed pre-opt-in snapshot without advancing the current head', async () => {
      const identity = await candidate(await parent());
      await oldCommit(identity);
      const next = await candidate(identity.organizationId, 1);
      await oldCommit(next);
      await enable(identity.organizationId);
      expect(await close(identity)).toEqual({
        committed: true,
        revision: 1,
        snapshotId: identity.snapshotId,
      });
      expect(await commit(identity)).toEqual({
        committed: true,
        revision: 1,
        snapshotId: identity.snapshotId,
      });
      expect(await head(identity.organizationId)).toEqual({
        revision: 2,
        snapshotId: next.snapshotId,
      });
    });

    it('records stale CAS as a permanent cancellation and survives newer publications and pruning', async () => {
      const organizationId = await parent();
      const winner = await candidate(organizationId);
      const loser = await candidate(organizationId);
      await enable(organizationId);
      await commit(winner);
      expect(await commit(loser)).toEqual({
        committed: false,
        revision: 1,
        snapshotId: winner.snapshotId,
        cancelled: true,
        conflict: true,
      });
      expect(await close(loser)).toEqual({
        committed: false,
        revision: 1,
        snapshotId: winner.snapshotId,
      });
      const next = await candidate(organizationId, 1);
      await commit(next);
      await asRole(
        'service_role',
        'delete from public.zentra_workspace_snapshots where organization_id=$1 and id=$2',
        [organizationId, winner.snapshotId],
      );
      await expect(
        asRole(
          'service_role',
          'insert into public.zentra_workspace_snapshots(organization_id,id,installation_id,created_by,base_revision,manifest,size_bytes) values($1,$2,$3,$4,2,$5,3)',
          [
            organizationId,
            winner.snapshotId,
            winner.installationId,
            winner.userId,
            JSON.stringify(manifest),
          ],
        ),
      ).rejects.toMatchObject({ code: 'PA102' });
      expect(await commit(winner)).toEqual({
        committed: true,
        revision: 1,
        snapshotId: winner.snapshotId,
      });
      expect(await close(winner)).toEqual({
        committed: true,
        revision: 1,
        snapshotId: winner.snapshotId,
      });
      expect(json(await fact(winner))).toMatchObject({
        manifest,
        state: 'committed',
        result: { committed: true, revision: 1, snapshotId: winner.snapshotId },
      });
      expect(await head(organizationId)).toEqual({
        revision: 2,
        snapshotId: next.snapshotId,
      });
    });

    it('rolls back incomplete commits and can tombstone them before upload completion/retry', async () => {
      const identity = await candidate(await parent(), 0, false);
      await enable(identity.organizationId);
      await expect(commit(identity)).rejects.toMatchObject({
        message: 'workspace_incomplete',
      });
      expect(await fact(identity)).toBeNull();
      expect(
        (
          await database.query(
            'select * from zentra_admission_private.action_publication_context',
          )
        ).rows,
      ).toEqual([]);
      await close(identity);
      await asRole(
        'service_role',
        'insert into public.zentra_workspace_chunks values($1,$2,0,$3,3)',
        [identity.organizationId, identity.snapshotId, part.sha256],
      );
      expect(await commit(identity)).toMatchObject({
        committed: false,
        cancelled: true,
      });
      expect(await head(identity.organizationId)).toEqual({
        revision: 0,
        snapshotId: null,
      });
    });

    it('rejects operation replay with changed tenant, candidate, actor, device or base', async () => {
      const identity = await candidate(await parent());
      await enable(identity.organizationId);
      await commit(identity);
      const other = await candidate(await parent());
      await enable(other.organizationId);
      for (const patch of [
        { snapshotId: randomUUID() },
        { installationId: 'other-pc' },
        { userId: 'other-owner' },
        { baseRevision: 1 },
        { organizationId: other.organizationId },
      ]) {
        await expect(commit({ ...identity, ...patch })).rejects.toMatchObject({
          code: 'PA107',
        });
        await expect(close({ ...identity, ...patch })).rejects.toMatchObject({
          code: 'PA107',
        });
      }
      await expect(
        commit({ ...other, installationId: 'wrong' }),
      ).rejects.toMatchObject({ code: 'PA107' });
      expect(await head(other.organizationId)).toEqual({
        revision: 0,
        snapshotId: null,
      });
    });

    it('prevents marker forgery and direct operation mutations even from the service role', async () => {
      const identity = await candidate(await parent());
      await enable(identity.organizationId);
      await commit(identity);
      await expect(
        asRole(
          'service_role',
          'insert into zentra_admission_private.action_publication_context values(txid_current(),$1,$2)',
          [identity.organizationId, identity.operationId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asRole(
          'service_role',
          "update public.zentra_action_publication_operations set state='cancelled',publication_revision=NULL where operation_id=$1",
          [identity.operationId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        database.query(
          'delete from public.zentra_action_publication_operations where operation_id=$1',
          [identity.operationId],
        ),
      ).rejects.toMatchObject({ code: 'PA101' });
      await expect(
        database.query(
          "update public.zentra_action_publication_operations set installation_id='other' where operation_id=$1",
          [identity.operationId],
        ),
      ).rejects.toMatchObject({ code: 'PA101' });
      await expect(
        database.transaction(async (transaction) => {
          await transaction.exec('set local role service_role');
          await transaction.query(
            "select set_config('zentra.action_operation',$1,true)",
            [identity.operationId],
          );
          await transaction.query(
            'update public.zentra_workspaces set revision=2 where organization_id=$1',
            [identity.organizationId],
          );
        }),
      ).rejects.toMatchObject({ code: 'PA103' });
    });

    it.each(['anon', 'authenticated'] as const)(
      'denies all new RPCs and records to %s',
      async (role) => {
        const identity = await candidate(await parent());
        await enable(identity.organizationId);
        await expect(
          asRole(
            role,
            'select public.zentra_commit_workspace($1,$2,$3,$4)',
            args(identity).slice(0, 4),
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          asRole(
            role,
            'select public.zentra_enable_action_publication_guard_v1($1)',
            [identity.organizationId],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        for (const name of [
          'zentra_commit_workspace_v2',
          'zentra_close_action_publication_v1',
        ] as const) {
          await expect(rpc(name, identity, role)).rejects.toMatchObject({
            code: '42501',
          });
        }
        await expect(
          asRole(
            role,
            'select public.zentra_action_publication_fact_v1($1,$2)',
            [identity.organizationId, identity.operationId],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        for (const table of [
          'zentra_action_publication_guards',
          'zentra_action_publication_operations',
        ]) {
          await expect(
            asRole(role, `select * from public.${table}`),
          ).rejects.toMatchObject({ code: '42501' });
        }
      },
    );

    it('retains the genuine US country guard for enable, v2, close and fact', async () => {
      const organizationId = randomUUID();
      const actor = randomUUID();
      const config = {
        schemaVersion: 1,
        organizationId,
        country: 'US',
        currency: 'USD',
        language: 'en',
        timeZone: 'America/New_York',
        address: {
          country: 'US',
          line1: '10 Fictitious Avenue',
          postalCode: '10001',
          city: 'New York',
          subdivision: 'NY',
        },
        accountingBasis: 'accrual',
        invoiceNumberPrefix: 'INV',
        taxConfiguration: { status: 'unconfigured' },
      };
      await asRole(
        'service_role',
        'select public.zentra_admit_new_us_workspace_v1($1,$2,$3,$4,$5,$6)',
        [
          organizationId,
          randomUUID(),
          actor,
          randomUUID(),
          JSON.stringify(config),
          hash('fictitious US admission'),
        ],
      );
      const identity = {
        organizationId,
        snapshotId: randomUUID(),
        installationId: 'fixture-pc',
        userId: actor,
        baseRevision: 0,
        operationId: randomUUID(),
      };
      await expect(enable(organizationId)).rejects.toMatchObject({
        code: 'PA004',
      });
      await expect(oldCommit(identity)).rejects.toMatchObject({
        code: 'PA004',
      });
      await expect(commit(identity)).rejects.toMatchObject({ code: 'PA004' });
      await expect(close(identity)).rejects.toMatchObject({ code: 'PA004' });
      await expect(fact(identity)).rejects.toMatchObject({ code: 'PA004' });
    });
  },
);
