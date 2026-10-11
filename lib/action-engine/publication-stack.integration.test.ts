import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

// Import the real fact verifier and manifest codec without loading a Worker or
// an external client. These ports MUST NOT be reached by this isolated suite.
vi.mock('@/lib/runtime', () => ({
  runtimeValue: () => '',
  database: () => {
    throw new Error('No runtime database in the publication stack fixture');
  },
  fileArchive: () => {
    throw new Error('No external storage in the publication stack fixture');
  },
}));
vi.mock('@/lib/supabase-server-runtime', () => ({
  supabaseServerClient: () => {
    throw new Error(
      'No external Supabase client in the publication stack fixture',
    );
  },
}));
vi.mock('@/lib/international/legacy-country-guard', () => ({
  requireLegacyCountryTransport: () => {
    throw new Error('Use the real PostgreSQL country guard in this fixture');
  },
}));

import { backupManifest } from '@/lib/workspace-backup';
import {
  capturePublicationRpcResult,
  createPublicationCoordinator,
} from './publication-coordinator';
import { verifyPublicationFact } from './publication-gateway';
import {
  createPublicationLedger,
  publicationPredicate,
} from './publication-ledger';
import type {
  PublicationAttempt,
  PublicationExpectation,
  PublicationIdentity,
  PublicationResult,
} from './publication-ledger-types';

// Both databases are ephemeral. The actual four PostgreSQL parents + A4 and
// the complete D1 migration chain run here; no production credentials or data.
// PGlite serializes a single connection. This proves cross-store protocol
// composition, NOT concurrent PostgreSQL scheduling, PostgREST, Cloudflare D1
// service behavior, distributed transactions, rollout parity or native writes.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = !!moduleDirectory && isAbsolute(moduleDirectory);
type Row = Record<string, unknown>;
type PgSql = {
  exec(sql: string): Promise<unknown>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
};
type Pg = PgSql & {
  transaction<T>(task: (sql: PgSql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};
type Statement = {
  sql: string;
  values: SQLInputValue[];
  bind(...values: SQLInputValue[]): Statement;
};
type Rpc = 'zentra_commit_workspace_v2' | 'zentra_close_action_publication_v1';
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const bytes = 'fictitious publication bytes';
const manifest = backupManifest({
  format: 'zentra-cloud-backup',
  version: 1,
  app_version: '1.90.15',
  sha256: digest(bytes),
  size_bytes: Buffer.byteLength(bytes),
  chunks: [{ sha256: digest(bytes), size_bytes: Buffer.byteLength(bytes) }],
});
let pg: Pg;
let sqlite: DatabaseSync | undefined;
let fixture: ReturnType<typeof sqliteFixture>;

function sqliteFixture(sql: DatabaseSync) {
  let clock = 2_000_000_000;
  const transport = {
    prepare(query: string) {
      const statement: Statement = {
        sql: query,
        values: [],
        bind(...values) {
          statement.values = [...values];
          return statement;
        },
      };
      return statement;
    },
    async batch(statements: Statement[]) {
      sql.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map((statement) => {
          const native = sql.prepare(statement.sql);
          if (/^\s*SELECT\b/i.test(statement.sql))
            return {
              success: true,
              results: native.all(...statement.values),
              meta: { changes: 0 },
            };
          const changed = native.run(...statement.values);
          return {
            success: true,
            results: [],
            meta: { changes: Number(changed.changes) },
          };
        });
        sql.exec('COMMIT');
        return result;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const ledger = createPublicationLedger(
    transport as unknown as Pick<D1Database, 'prepare' | 'batch'>,
    {
      nextId: randomUUID,
      now: () => clock,
    },
  );
  return {
    sql,
    ledger,
    now: () => clock,
    advance(seconds: number) {
      clock += seconds;
    },
    witness(identity: PublicationIdentity) {
      const expected: PublicationExpectation = {
        organizationId: identity.organizationId,
        snapshotId: identity.snapshotId,
        baseRevision: identity.baseRevision,
        revision: identity.baseRevision + 1,
        archiveSha256: identity.archiveSha256,
        manifestSha256: identity.manifestSha256,
      };
      const predicate = publicationPredicate(expected);
      return sql
        .prepare(`SELECT (${predicate.sql}) AS allowed`)
        .get(...predicate.bindings)?.allowed;
    },
    count(
      table:
        | 'action_engine_publication_attempts'
        | 'action_engine_publication_events',
    ) {
      return Number(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
    },
  };
}

async function service(query: string, values: unknown[] = []) {
  return pg.transaction(async (transaction) => {
    await transaction.exec('SET LOCAL ROLE service_role');
    return (await transaction.query(query, values)).rows;
  });
}
async function company() {
  const organizationId = randomUUID();
  await service(
    'INSERT INTO public.zentra_workspaces(organization_id,updated_by) VALUES($1,$2)',
    [organizationId, 'fictitious-owner'],
  );
  return organizationId;
}
async function candidate(
  organizationId: string,
  baseRevision = 0,
): Promise<PublicationIdentity> {
  const identity: PublicationIdentity = {
    organizationId,
    snapshotId: randomUUID(),
    installationId: randomUUID(),
    userId: 'fictitious-owner',
    baseRevision,
    archiveSha256: manifest.sha256,
    manifestSha256: digest(JSON.stringify(manifest)),
    sizeBytes: manifest.size_bytes,
  };
  await service(
    `INSERT INTO public.zentra_workspace_snapshots
    (organization_id,id,installation_id,created_by,base_revision,manifest,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      organizationId,
      identity.snapshotId,
      identity.installationId,
      identity.userId,
      baseRevision,
      JSON.stringify(manifest),
      manifest.size_bytes,
    ],
  );
  await service(
    'INSERT INTO public.zentra_workspace_chunks VALUES($1,$2,0,$3,$4)',
    [
      organizationId,
      identity.snapshotId,
      manifest.chunks[0].sha256,
      manifest.chunks[0].size_bytes,
    ],
  );
  return identity;
}
async function enableGuard(organizationId: string) {
  return (
    await service(
      'SELECT public.zentra_enable_action_publication_guard_v1($1) AS r',
      [organizationId],
    )
  )[0].r;
}
async function rpc(name: Rpc, attempt: PublicationAttempt) {
  return (
    await service(`SELECT public.${name}($1,$2,$3,$4,$5,$6) AS r`, [
      attempt.organizationId,
      attempt.snapshotId,
      attempt.installationId,
      attempt.userId,
      attempt.baseRevision,
      attempt.id,
    ])
  )[0].r;
}
async function fact(attempt: PublicationAttempt) {
  return (
    await service(
      'SELECT public.zentra_action_publication_fact_v1($1,$2) AS r',
      [attempt.organizationId, attempt.id],
    )
  )[0].r;
}
async function verified(
  name: Rpc,
  attempt: PublicationAttempt,
): Promise<PublicationResult> {
  const result = capturePublicationRpcResult(await rpc(name, attempt), attempt);
  await verifyPublicationFact(await fact(attempt), attempt, result);
  return result;
}
async function head(organizationId: string) {
  const row = (
    await service(
      'SELECT revision,snapshot_id FROM public.zentra_workspaces WHERE organization_id=$1',
      [organizationId],
    )
  )[0];
  return { revision: Number(row.revision), snapshotId: row.snapshot_id };
}
function coordinator(
  ports: {
    commit?: (attempt: PublicationAttempt) => Promise<unknown>;
    close?: (attempt: PublicationAttempt) => Promise<unknown>;
  } = {},
) {
  return createPublicationCoordinator({
    ledger: fixture.ledger,
    enableGuard,
    now: fixture.now,
    commit:
      ports.commit ??
      ((attempt) => verified('zentra_commit_workspace_v2', attempt)),
    close:
      ports.close ??
      ((attempt) => verified('zentra_close_action_publication_v1', attempt)),
  });
}

describe.runIf(enabled)(
  'A4 actual PostgreSQL + SQLite publication stack (requires absolute PGLITE_MODULE_DIR)',
  () => {
    beforeAll(async () => {
      expect(
        JSON.parse(
          await readFile(join(moduleDirectory!, 'package.json'), 'utf8'),
        ).name,
      ).toBe('@electric-sql/pglite');
      const { PGlite } = createRequire(import.meta.url)(
        join(moduleDirectory!, 'dist/index.cjs'),
      ) as { PGlite: new () => Pg };
      pg = new PGlite();
      await pg.exec(
        'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); GRANT USAGE ON SCHEMA public TO service_role;',
      );
      for (const name of [
        '202609140200_company_collaboration',
        '202609200300_company_content',
        '20261007194528_international_workspace_country_config',
        '20261008001726_new_us_workspace_admission',
        '20261011011348_action_engine_publication_coordination',
      ])
        await pg.exec(
          await readFile(
            new URL(`../../supabase/migrations/${name}.sql`, import.meta.url),
            'utf8',
          ),
        );
    }, 20_000);
    beforeEach(async () => {
      sqlite = new DatabaseSync(':memory:');
      sqlite.exec('PRAGMA foreign_keys=ON');
      const directory = new URL('../../drizzle/', import.meta.url);
      const migrations = (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort();
      expect(migrations).toContain('0102_action_engine_publication_ledger.sql');
      for (const name of migrations)
        sqlite.exec(await readFile(new URL(name, directory), 'utf8'));
      fixture = sqliteFixture(sqlite);
    });
    afterEach(() => {
      sqlite?.close();
      sqlite = undefined;
    });
    afterAll(async () => {
      await pg?.close();
    });

    it('keeps the D1 publication predicate closed until PG commit, exact fact verification and D1 settlement', async () => {
      const identity = await candidate(await company());
      const coordinate = coordinator({
        commit: async (attempt) => {
          expect(
            (
              await fixture.ledger.read(
                identity.organizationId,
                identity.snapshotId,
              )
            )?.state,
          ).toBe('pending');
          expect(fixture.witness(identity)).toBe(0);
          expect(await head(identity.organizationId)).toEqual({
            revision: 0,
            snapshotId: null,
          });
          const result = await verified('zentra_commit_workspace_v2', attempt);
          expect(await head(identity.organizationId)).toEqual({
            revision: 1,
            snapshotId: identity.snapshotId,
          });
          // A true PostgreSQL reply, even corroborated, is not yet a D1 witness.
          expect(fixture.witness(identity)).toBe(0);
          return result;
        },
      });
      expect(await coordinate(identity)).toEqual({
        committed: true,
        revision: 1,
        snapshotId: identity.snapshotId,
      });
      expect(fixture.witness(identity)).toBe(1);
      expect(fixture.count('action_engine_publication_attempts')).toBe(1);
      expect(fixture.count('action_engine_publication_events')).toBe(2);
    });

    it('retains pending after a lost PG response and retries the same durable operation without advancing twice', async () => {
      const identity = await candidate(await company());
      const operations: string[] = [];
      let loseResponse = true;
      const coordinate = coordinator({
        commit: async (attempt) => {
          operations.push(attempt.id);
          const raw = await rpc('zentra_commit_workspace_v2', attempt);
          if (loseResponse) {
            loseResponse = false;
            throw new Error('Synthetic lost PG acknowledgement');
          }
          const result = capturePublicationRpcResult(raw, attempt);
          await verifyPublicationFact(await fact(attempt), attempt, result);
          return result;
        },
      });
      await expect(coordinate(identity)).rejects.toThrow(
        'Synthetic lost PG acknowledgement',
      );
      expect(await head(identity.organizationId)).toEqual({
        revision: 1,
        snapshotId: identity.snapshotId,
      });
      expect(
        (
          await fixture.ledger.read(
            identity.organizationId,
            identity.snapshotId,
          )
        )?.state,
      ).toBe('pending');
      expect(fixture.witness(identity)).toBe(0);
      // A removed preparation allowlist sends the gateway through this public
      // legacy RPC first. Even its historical-success branch must return PA103
      // so the gateway can reconcile the original durable D1 operation.
      await expect(
        service('SELECT public.zentra_commit_workspace($1,$2,$3,$4) AS r', [
          identity.organizationId,
          identity.snapshotId,
          identity.installationId,
          identity.userId,
        ]),
      ).rejects.toMatchObject({ code: 'PA103' });
      expect(
        (
          await fixture.ledger.read(
            identity.organizationId,
            identity.snapshotId,
          )
        )?.state,
      ).toBe('pending');
      expect(fixture.count('action_engine_publication_events')).toBe(1);
      expect(await coordinate(identity)).toEqual({
        committed: true,
        revision: 1,
        snapshotId: identity.snapshotId,
      });
      expect(operations).toHaveLength(2);
      expect(operations[1]).toBe(operations[0]);
      expect(
        await service(
          'SELECT operation_id FROM public.zentra_action_publication_operations WHERE organization_id=$1',
          [identity.organizationId],
        ),
      ).toHaveLength(1);
      expect(await head(identity.organizationId)).toEqual({
        revision: 1,
        snapshotId: identity.snapshotId,
      });
      expect(fixture.witness(identity)).toBe(1);
      expect(fixture.count('action_engine_publication_attempts')).toBe(1);
      expect(fixture.count('action_engine_publication_events')).toBe(2);
    });

    it('closes an old held operation before admitting another publication and permanently rejects its late commit', async () => {
      const organizationId = await company(),
        oldIdentity = await candidate(organizationId);
      await enableGuard(organizationId);
      const orphan = (await fixture.ledger.begin(oldIdentity)).attempt;
      const nextIdentity = await candidate(organizationId);
      fixture.advance(120);
      const order: string[] = [];
      const coordinate = coordinator({
        close: async (attempt) => {
          expect(attempt.id).toBe(orphan.id);
          expect(fixture.witness(nextIdentity)).toBe(0);
          const result = await verified(
            'zentra_close_action_publication_v1',
            attempt,
          );
          expect(
            (await fixture.ledger.read(organizationId, oldIdentity.snapshotId))
              ?.state,
          ).toBe('pending');
          expect(result).toEqual({
            committed: false,
            revision: 0,
            snapshotId: null,
          });
          order.push('PG tombstone');
          return result;
        },
        commit: async (attempt) => {
          expect(
            (await fixture.ledger.read(organizationId, oldIdentity.snapshotId))
              ?.state,
          ).toBe('cancelled');
          const late = await verified('zentra_commit_workspace_v2', orphan);
          expect(late).toEqual({
            committed: false,
            revision: 0,
            snapshotId: null,
          });
          expect(await head(organizationId)).toEqual({
            revision: 0,
            snapshotId: null,
          });
          order.push('late commit refused', 'next commit');
          return verified('zentra_commit_workspace_v2', attempt);
        },
      });
      expect(await coordinate(nextIdentity)).toEqual({
        committed: true,
        revision: 1,
        snapshotId: nextIdentity.snapshotId,
      });
      expect(order).toEqual([
        'PG tombstone',
        'late commit refused',
        'next commit',
      ]);
      // Both replay RPCs and the fact keep the ORIGINAL cancellation result even
      // after another snapshot has become the head.
      expect(
        await verified('zentra_close_action_publication_v1', orphan),
      ).toEqual({ committed: false, revision: 0, snapshotId: null });
      expect(await verified('zentra_commit_workspace_v2', orphan)).toEqual({
        committed: false,
        revision: 0,
        snapshotId: null,
      });
      expect(await head(organizationId)).toEqual({
        revision: 1,
        snapshotId: nextIdentity.snapshotId,
      });
      expect(fixture.witness(oldIdentity)).toBe(0);
      expect(fixture.witness(nextIdentity)).toBe(1);
      expect(fixture.count('action_engine_publication_attempts')).toBe(2);
      expect(fixture.count('action_engine_publication_events')).toBe(4);
    });

    it('corroborates exact PG JSON facts after transport pruning and never restores an obsolete catalogue witness', async () => {
      const organizationId = await company(),
        first = await candidate(organizationId);
      const coordinate = coordinator();
      const original = await coordinate(first);
      const firstAttempt = (await fixture.ledger.read(
        organizationId,
        first.snapshotId,
      ))!;
      const next = await candidate(organizationId, 1);
      await coordinate(next);
      await service(
        'DELETE FROM public.zentra_workspace_snapshots WHERE organization_id=$1 AND id=$2',
        [organizationId, first.snapshotId],
      );
      expect(
        await service(
          'SELECT id FROM public.zentra_workspace_snapshots WHERE organization_id=$1 AND id=$2',
          [organizationId, first.snapshotId],
        ),
      ).toEqual([]);
      const durable = await fact(firstAttempt);
      await expect(
        verifyPublicationFact(durable, firstAttempt, original),
      ).resolves.toBeUndefined();
      expect(
        await verified('zentra_commit_workspace_v2', firstAttempt),
      ).toEqual(original);
      expect(
        await verified('zentra_close_action_publication_v1', firstAttempt),
      ).toEqual(original);
      const noReplayWrite = coordinator({
        commit: async () => {
          throw new Error('A settled D1 replay must not issue another commit');
        },
        close: async () => {
          throw new Error(
            'A settled D1 replay must not close another operation',
          );
        },
      });
      expect(await noReplayWrite(first)).toEqual(original);
      expect(await head(organizationId)).toEqual({
        revision: 2,
        snapshotId: next.snapshotId,
      });
      expect(fixture.witness(first)).toBe(0);
      expect(fixture.witness(next)).toBe(1);
      expect(fixture.count('action_engine_publication_attempts')).toBe(2);
      expect(fixture.count('action_engine_publication_events')).toBe(4);
    });

    it('does not settle a real PG commit when its canonical fact disagrees with the captured manifest', async () => {
      const identity = await candidate(await company());
      let tamper = true;
      const coordinate = coordinator({
        commit: async (attempt) => {
          const result = capturePublicationRpcResult(
            await rpc('zentra_commit_workspace_v2', attempt),
            attempt,
          );
          const actual = (await fact(attempt)) as Record<string, unknown>;
          const candidateFact = tamper
            ? { ...actual, manifest: { ...manifest, app_version: '1.90.16' } }
            : actual;
          await verifyPublicationFact(candidateFact, attempt, result);
          return result;
        },
      });
      await expect(coordinate(identity)).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(await head(identity.organizationId)).toEqual({
        revision: 1,
        snapshotId: identity.snapshotId,
      });
      expect(
        (
          await fixture.ledger.read(
            identity.organizationId,
            identity.snapshotId,
          )
        )?.state,
      ).toBe('pending');
      expect(fixture.witness(identity)).toBe(0);
      expect(fixture.count('action_engine_publication_events')).toBe(1);
      tamper = false;
      expect(await coordinate(identity)).toEqual({
        committed: true,
        revision: 1,
        snapshotId: identity.snapshotId,
      });
      expect(fixture.witness(identity)).toBe(1);
      expect(fixture.count('action_engine_publication_attempts')).toBe(1);
      expect(fixture.count('action_engine_publication_events')).toBe(2);
    });
  },
);
