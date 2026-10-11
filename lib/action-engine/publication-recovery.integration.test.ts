import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { DeviceSessionContext } from '@/lib/account';

const ports = vi.hoisted(() => ({
  db: null as Pick<D1Database, 'prepare' | 'batch'> | null,
  databaseFailure: false,
  client: vi.fn(),
  country: vi.fn(async () => undefined),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => {
    if (ports.databaseFailure || ports.db === null)
      throw new Error('Synthetic private D1 outage');
    return ports.db;
  },
  runtimeValue: () => '["qa-recovery-company"]',
  fileArchive: () => {
    throw new Error('Recovery must not read transport bytes');
  },
}));
vi.mock('@/lib/supabase-server-runtime', () => ({
  supabaseServerClient: ports.client,
}));
vi.mock('@/lib/international/legacy-country-guard', () => ({
  requireLegacyCountryTransport: ports.country,
}));

import { backupManifest, type BackupManifest } from '@/lib/workspace-backup';
import { commitCoordinatedCollaboration } from './publication-gateway';
import {
  createPublicationLedger,
  publicationPredicate,
} from './publication-ledger';
import type {
  PublicationAttempt,
  PublicationIdentity,
  PublicationResult,
} from './publication-ledger-types';
import { recoverCoordinatedPublication } from './publication-recovery';

// Boundary of this integration fixture: the real production SQLite migration,
// ledger, recovery, coordinator and fact verifier run here. PostgreSQL RPCs are
// deterministic service-fact fixtures with the exact A4 schema, not a real PG
// server. A4 publication-stack.integration.test.ts separately exercises the
// actual PostgreSQL migration. This suite proves no PostgREST, hosted D1,
// distributed transaction, native quote, archive parser or native transport.
type Statement = {
  sql: string;
  values: SQLInputValue[];
  bind(...values: SQLInputValue[]): Statement;
};
function createSqliteD1(sqlite: DatabaseSync) {
  const adapter = {
    prepare(sql: string) {
      const statement: Statement = {
        sql,
        values: [],
        bind(...values) {
          statement.values = [...values];
          return statement;
        },
      };
      return statement;
    },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => {
          const native = sqlite.prepare(statement.sql);
          if (/^\s*SELECT\b/i.test(statement.sql))
            return {
              success: true,
              results: native.all(...statement.values),
              meta: { changes: 0 },
            };
          const result = native.run(...statement.values);
          return {
            success: true,
            results: [],
            meta: { changes: Number(result.changes) },
          };
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return adapter as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const archive = 'Synthetic company archive: no real client data';
const manifest = backupManifest({
  format: 'zentra-cloud-backup',
  version: 1,
  app_version: '1.90.15',
  sha256: hash(archive),
  size_bytes: Buffer.byteLength(archive),
  chunks: [{ sha256: hash(archive), size_bytes: Buffer.byteLength(archive) }],
});
const actor: DeviceSessionContext = {
  organizationId: 'qa-recovery-company',
  organizationName: 'Synthetic company',
  subscriptionId: 'synthetic-subscription',
  role: 'owner',
  sessionId: 'synthetic-session',
  userId: 'qa-recovery-owner',
  installationId: '30000000-0000-4000-8000-000000000001',
  entitlementValidUntil: 2_000_000_000,
};
let migration: string;
let sqlite: DatabaseSync;
let db: Pick<D1Database, 'prepare' | 'batch'>;
let ledger: ReturnType<typeof createPublicationLedger>;
let pgFact: unknown;
let pgHead: { revision: number; snapshotId: string | null };
let client: {
  rpc: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
};

function identity(baseRevision = 0): PublicationIdentity {
  return {
    organizationId: actor.organizationId,
    snapshotId: randomUUID(),
    installationId: actor.installationId,
    userId: actor.userId,
    baseRevision,
    archiveSha256: manifest.sha256,
    manifestSha256: hash(JSON.stringify(manifest)),
    sizeBytes: manifest.size_bytes,
  };
}
function input(
  value: PublicationIdentity,
  candidate: BackupManifest = manifest,
) {
  return {
    action: 'recover-publication' as const,
    id: value.snapshotId,
    baseRevision: value.baseRevision,
    manifest: candidate,
  };
}
async function pending(value: PublicationIdentity = identity()) {
  const result = await ledger.begin(value);
  expect(result.state).toBe('owned');
  return result.attempt;
}
function result(attempt: PublicationAttempt): PublicationResult {
  return {
    committed: true,
    revision: attempt.baseRevision + 1,
    snapshotId: attempt.snapshotId,
  };
}
function fact(attempt: PublicationAttempt, committed = true) {
  return {
    operationId: attempt.id,
    organizationId: attempt.organizationId,
    snapshotId: attempt.snapshotId,
    installationId: attempt.installationId,
    userId: attempt.userId,
    baseRevision: attempt.baseRevision,
    state: committed ? 'committed' : 'cancelled',
    manifest: committed ? manifest : null,
    sizeBytes: committed ? manifest.size_bytes : null,
    contentVersion: committed ? 0 : null,
    result: committed
      ? result(attempt)
      : { committed: false, revision: 0, snapshotId: null },
  };
}
function ack(attempt: PublicationAttempt) {
  return { known: true, ...result(attempt) };
}
function rows() {
  return {
    attempts: sqlite
      .prepare('SELECT * FROM action_engine_publication_attempts ORDER BY id')
      .all(),
    events: sqlite
      .prepare(
        'SELECT * FROM action_engine_publication_events ORDER BY attempt_id,event_type',
      )
      .all(),
  };
}
function witness(value: PublicationIdentity) {
  const predicate = publicationPredicate({
    organizationId: value.organizationId,
    snapshotId: value.snapshotId,
    baseRevision: value.baseRevision,
    revision: value.baseRevision + 1,
    archiveSha256: value.archiveSha256,
    manifestSha256: value.manifestSha256,
  });
  return sqlite
    .prepare(`SELECT (${predicate.sql}) AS allowed`)
    .get(...predicate.bindings)?.allowed;
}
function onlyFactReads() {
  expect(client.select).not.toHaveBeenCalled();
  expect(
    client.rpc.mock.calls.every(
      ([name]) => name === 'zentra_action_publication_fact_v1',
    ),
  ).toBe(true);
}

beforeAll(async () => {
  migration = await readFile(
    new URL(
      '../../drizzle/0102_action_engine_publication_ledger.sql',
      import.meta.url,
    ),
    'utf8',
  );
});
beforeEach(() => {
  vi.clearAllMocks();
  ports.databaseFailure = false;
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(migration);
  db = createSqliteD1(sqlite);
  ports.db = db;
  // Creation time is historical; the real recovery clock must not be rewound.
  ledger = createPublicationLedger(db, { now: () => 1_700_000_000 });
  pgFact = null;
  pgHead = { revision: 0, snapshotId: null };
  client = {
    select: vi.fn(async () => {
      throw new Error('Synthetic pruned transport metadata');
    }),
    rpc: vi.fn(async (name: string, parameters: Record<string, unknown>) => {
      if (name === 'zentra_action_publication_fact_v1') {
        expect(Object.keys(parameters).sort()).toEqual([
          'p_operation',
          'p_organization',
        ]);
        expect(parameters.p_organization).toBe(actor.organizationId);
        return pgFact;
      }
      if (name === 'zentra_enable_action_publication_guard_v1')
        return { guarded: true, ...pgHead };
      if (name === 'zentra_commit_workspace_v2') {
        const value = pgFact as ReturnType<typeof fact>;
        expect(parameters.p_operation).toBe(value.operationId);
        return value.result;
      }
      throw new Error(`Unexpected synthetic RPC ${name}`);
    }),
  };
  ports.client.mockReturnValue(client);
});
afterEach(() => {
  ports.db = null;
  sqlite?.close();
});

describe('A5 recovery: real SQLite ledger + deterministic verified PG fact boundary', () => {
  it('returns unknown only for an absent D1 attempt without creating a barrier or touching PG', async () => {
    const value = identity();
    expect(await recoverCoordinatedPublication(actor, input(value))).toEqual({
      known: false,
    });
    expect(rows()).toEqual({ attempts: [], events: [] });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.select).not.toHaveBeenCalled();
  });

  it('preserves the exact pending barrier after a crash between D1 begin and the first PG operation', async () => {
    const attempt = await pending();
    const before = rows();
    expect(await recoverCoordinatedPublication(actor, input(attempt))).toEqual({
      known: true,
      pending: true,
    });
    expect(rows()).toEqual(before);
    expect(witness(attempt)).toBe(0);
    expect(client.rpc).toHaveBeenCalledWith(
      'zentra_action_publication_fact_v1',
      {
        p_organization: actor.organizationId,
        p_operation: attempt.id,
      },
    );
    onlyFactReads();
  });

  it('settles a lost PG acknowledgement from its exact durable fact and records only one terminal event', async () => {
    const attempt = await pending();
    pgFact = fact(attempt);
    pgHead = { revision: 1, snapshotId: attempt.snapshotId };
    expect(await recoverCoordinatedPublication(actor, input(attempt))).toEqual(
      ack(attempt),
    );
    expect(
      (await ledger.read(actor.organizationId, attempt.snapshotId))?.state,
    ).toBe('committed');
    expect(witness(attempt)).toBe(1);
    const after = rows();
    expect(after.attempts).toHaveLength(1);
    expect(after.events).toHaveLength(2);
    expect(await recoverCoordinatedPublication(actor, input(attempt))).toEqual(
      ack(attempt),
    );
    expect(rows()).toEqual(after);
    onlyFactReads();
  });

  it('recovers the original ACK after metadata pruning and a newer head without restoring its obsolete witness', async () => {
    const first = await pending();
    pgFact = fact(first);
    expect(await recoverCoordinatedPublication(actor, input(first))).toEqual(
      ack(first),
    );
    const second = await pending(identity(1));
    await ledger.settle(second, result(second));
    pgHead = { revision: 2, snapshotId: second.snapshotId };
    const before = rows();
    expect(witness(first)).toBe(0);
    expect(witness(second)).toBe(1);
    expect(await recoverCoordinatedPublication(actor, input(first))).toEqual(
      ack(first),
    );
    expect(rows()).toEqual(before);
    expect(witness(first)).toBe(0);
    expect(witness(second)).toBe(1);
    onlyFactReads();
  });

  it('leaves a PG cancellation pending in recovery until the ordinary commit caller reconciles its tombstone', async () => {
    const attempt = await pending();
    pgFact = fact(attempt, false);
    const before = rows();
    expect(await recoverCoordinatedPublication(actor, input(attempt))).toEqual({
      known: true,
      pending: true,
    });
    expect(rows()).toEqual(before);
    expect(witness(attempt)).toBe(0);
    onlyFactReads();
    expect(
      await commitCoordinatedCollaboration(actor, attempt.snapshotId),
    ).toEqual({
      committed: false,
      revision: 0,
      snapshotId: null,
      conflict: true,
    });
    expect(
      (await ledger.read(actor.organizationId, attempt.snapshotId))?.state,
    ).toBe('cancelled');
    expect(rows().events).toHaveLength(2);
    expect(witness(attempt)).toBe(0);
    expect(
      client.rpc.mock.calls.some(
        ([name]) => name === 'zentra_close_action_publication_v1',
      ),
    ).toBe(false);
    const cancelled = rows();
    expect(await recoverCoordinatedPublication(actor, input(attempt))).toEqual({
      known: true,
      committed: false,
      revision: 0,
      snapshotId: null,
    });
    expect(rows()).toEqual(cancelled);
  });

  it.each(['user', 'installation', 'role'] as const)(
    'never acknowledges a pending attempt for a different %s',
    async (field) => {
      const attempt = await pending();
      pgFact = fact(attempt);
      const before = rows();
      const foreign = {
        ...actor,
        ...(field === 'user' ? { userId: 'another-owner' } : {}),
        ...(field === 'installation' ? { installationId: randomUUID() } : {}),
        ...(field === 'role' ? { role: 'read_only' as const } : {}),
      };
      await expect(
        recoverCoordinatedPublication(foreign, input(attempt)),
      ).rejects.toMatchObject({ status: field === 'role' ? 403 : 409 });
      expect(rows()).toEqual(before);
      expect(client.rpc).not.toHaveBeenCalled();
      expect(client.select).not.toHaveBeenCalled();
    },
  );

  it('cannot disclose another company receipt through the same snapshot identifier', async () => {
    const attempt = await pending();
    pgFact = fact(attempt);
    const before = rows();
    expect(
      await recoverCoordinatedPublication(
        { ...actor, organizationId: 'another-company' },
        input(attempt),
      ),
    ).toEqual({ known: false });
    expect(rows()).toEqual(before);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each(['base', 'archive', 'manifest', 'size'] as const)(
    'does not ACK a request whose %s differs from the immutable attempt',
    async (field) => {
      const attempt = await pending();
      pgFact = fact(attempt);
      const before = rows();
      const request = input(attempt);
      if (field === 'base') request.baseRevision++;
      if (field === 'archive')
        request.manifest = { ...manifest, sha256: 'b'.repeat(64) };
      if (field === 'manifest')
        request.manifest = { ...manifest, app_version: '1.90.16' };
      if (field === 'size')
        request.manifest = {
          ...manifest,
          size_bytes: manifest.size_bytes + 1,
          chunks: [
            { ...manifest.chunks[0], size_bytes: manifest.size_bytes + 1 },
          ],
        };
      await expect(
        recoverCoordinatedPublication(actor, request),
      ).rejects.toMatchObject({ status: 409 });
      expect(rows()).toEqual(before);
      expect(client.rpc).not.toHaveBeenCalled();
    },
  );

  it.each(['identity', 'manifest', 'result'] as const)(
    'does not settle an uncorroborated permanent PG %s fact',
    async (field) => {
      const attempt = await pending();
      const value = fact(attempt);
      pgFact =
        field === 'identity'
          ? { ...value, userId: 'another-owner' }
          : field === 'manifest'
            ? { ...value, manifest: { ...manifest, app_version: '1.90.16' } }
            : { ...value, result: { ...result(attempt), revision: 2 } };
      const before = rows();
      await expect(
        recoverCoordinatedPublication(actor, input(attempt)),
      ).rejects.toThrow();
      expect(rows()).toEqual(before);
      expect(witness(attempt)).toBe(0);
      onlyFactReads();
    },
  );

  it('never turns an unavailable PG fact into unknown or releases pending', async () => {
    const attempt = await pending();
    const before = rows();
    client.rpc.mockRejectedValueOnce(new Error('Synthetic private PG outage'));
    await expect(
      recoverCoordinatedPublication(actor, input(attempt)),
    ).rejects.toMatchObject({ status: 503 });
    expect(rows()).toEqual(before);
    expect(witness(attempt)).toBe(0);
    onlyFactReads();
  });

  it('does not ACK if the real SQLite settlement transaction rolls back, and can retry the same fact', async () => {
    const attempt = await pending();
    pgFact = fact(attempt);
    sqlite.exec(
      "CREATE TRIGGER qa_recovery_failure BEFORE UPDATE ON action_engine_publication_attempts BEGIN SELECT RAISE(ABORT,'synthetic-settlement-outage'); END",
    );
    const before = rows();
    await expect(
      recoverCoordinatedPublication(actor, input(attempt)),
    ).rejects.toMatchObject({ status: 503 });
    expect(rows()).toEqual(before);
    expect(witness(attempt)).toBe(0);
    sqlite.exec('DROP TRIGGER qa_recovery_failure');
    expect(await recoverCoordinatedPublication(actor, input(attempt))).toEqual(
      ack(attempt),
    );
    expect(rows().attempts).toHaveLength(1);
    expect(rows().events).toHaveLength(2);
    onlyFactReads();
  });

  it.each(['runtime', 'schema'] as const)(
    'never answers unknown when the actual D1 %s is unavailable',
    async (failure) => {
      if (failure === 'runtime') ports.databaseFailure = true;
      else {
        sqlite.close();
        sqlite = new DatabaseSync(':memory:');
        ports.db = createSqliteD1(sqlite);
      }
      await expect(
        recoverCoordinatedPublication(actor, input(identity())),
      ).rejects.toMatchObject({ status: 503 });
      expect(client.rpc).not.toHaveBeenCalled();
      expect(client.select).not.toHaveBeenCalled();
    },
  );
});
