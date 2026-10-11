import { readFileSync } from 'node:fs';
import { randomFillSync } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
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
import type { DeviceSessionContext } from '@/lib/account';

const ports = vi.hoisted(() => ({
  db: null as Pick<D1Database, 'prepare' | 'batch'> | null,
  databaseFailure: false,
  client: vi.fn(),
  country: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => {
    if (ports.databaseFailure || !ports.db)
      throw new Error('Synthetic D1 outage');
    return ports.db;
  },
  runtimeValue: () => {
    throw new Error('A historical read must not use an activation flag');
  },
  fileArchive: () => {
    throw new Error('No backup/R2 fallback');
  },
}));
vi.mock('@/lib/supabase-server-runtime', () => ({
  supabaseServerClient: ports.client,
  supabaseRealtimeConfiguration: () => {
    throw new Error('No announcement');
  },
}));
vi.mock('@/lib/international/legacy-country-guard', () => ({
  requireLegacyCountryTransport: ports.country,
}));

import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { BACKUP_CHUNK_BYTES } from '@/lib/workspace-backup';
import { loadCanonicalQuotePublication } from './confirmation-publication';
import {
  buildConfirmationPublicationTransport,
  makeConfirmationPublicationFixture,
} from './confirmation-publication.fixture';
import { verifyCanonicalQuotePublication } from './canonical-quote';
import { createPublicationLedger } from './publication-ledger';
import type {
  PublicationAttempt,
  PublicationIdentity,
} from './publication-ledger-types';
import { QUOTE_ARCHIVE_MAX_BYTES } from './quote-archive';

// Real versioned D1 schema/transactions, real collaboration download helpers,
// manifest/fact validation, ZIP/DEFLATE/CRC and SQLite/WASM business verifier.
// The only service replacements are authorization, PG fact/metadata and storage.
// No hosted PG/D1, Rust writer execution, provider, activation or real client data.
type Statement = {
  sql: string;
  values: SQLInputValue[];
  bind(...values: SQLInputValue[]): Statement;
};
function sqliteD1(sqlite: DatabaseSync) {
  return {
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
  } as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}
let fixture: ReturnType<typeof makeConfirmationPublicationFixture>;
let sql: DatabaseSync;
let transport: ReturnType<typeof buildConfirmationPublicationTransport>;
let session: DeviceSessionContext;
let fact: Record<string, unknown> | null;
let snapshot: Record<string, unknown>;
let chunks: Uint8Array[];
let allowed: boolean;
let authorize: ReturnType<typeof vi.fn<() => Promise<void>>>;
let rpc: ReturnType<typeof vi.fn>;
let select: ReturnType<typeof vi.fn>;
let companyChunk: ReturnType<typeof vi.fn>;
let order: string[];
const asIdentity = (attempt: PublicationAttempt): PublicationIdentity => ({
  organizationId: attempt.organizationId,
  snapshotId: attempt.snapshotId,
  installationId: attempt.installationId,
  userId: attempt.userId,
  baseRevision: attempt.baseRevision,
  archiveSha256: attempt.archiveSha256,
  manifestSha256: attempt.manifestSha256,
  sizeBytes: attempt.sizeBytes,
});
async function seed(attempt = transport.attempt, pending = false) {
  let now = attempt.createdAt;
  const ledger = createPublicationLedger(ports.db!, {
    nextId: () => attempt.id,
    now: () => now,
  });
  const started = (await ledger.begin(asIdentity(attempt))).attempt;
  if (pending) return started;
  now = attempt.settledAt!;
  return ledger.settle(started, attempt.result!);
}
const run = (attempt = transport.attempt, principal = session) =>
  loadCanonicalQuotePublication(principal, attempt, authorize);
function stored() {
  return sql
    .prepare(
      'SELECT state,result_json,settled_at FROM action_engine_publication_attempts',
    )
    .all();
}
beforeAll(() => {
  fixture = makeConfirmationPublicationFixture();
});
afterAll(() => fixture.close());
beforeEach(async () => {
  vi.resetAllMocks();
  ports.databaseFailure = false;
  sql = new DatabaseSync(':memory:');
  sql.exec(
    readFileSync(
      new URL(
        '../../drizzle/0102_action_engine_publication_ledger.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  ports.db = sqliteD1(sql);
  transport = buildConfirmationPublicationTransport(
    fixture.native.bytes(),
    fixture.native.publication,
  );
  session = structuredClone(fixture.session);
  fact = structuredClone(transport.fact);
  snapshot = structuredClone(transport.snapshot);
  chunks = transport.chunks.map((value) => new Uint8Array(value));
  order = [];
  allowed = true;
  authorize = vi.fn(async () => {
    order.push('authorize');
    if (!allowed)
      throw new AccountPublicError('Synthetic authorization revoked', 403);
  });
  ports.country.mockImplementation(async () => {
    order.push('country');
  });
  rpc = vi.fn(async (name, params) => {
    order.push('fact');
    expect(name).toBe('zentra_action_publication_fact_v1');
    expect(params).toEqual({
      p_organization: session.organizationId,
      p_operation: transport.attempt.id,
    });
    return fact;
  });
  select = vi.fn(async (table, params) => {
    order.push('snapshot');
    expect(table).toBe('zentra_workspace_snapshots');
    expect(params).toEqual({
      organization_id: `eq.${session.organizationId}`,
      id: `eq.${transport.attempt.snapshotId}`,
      limit: 1,
    });
    return [snapshot];
  });
  companyChunk = vi.fn(async (method, path) => {
    order.push('chunk');
    expect(method).toBe('GET');
    const prefix = `${await sha256Hex(session.organizationId)}/${transport.attempt.snapshotId}/`;
    expect(path.startsWith(prefix)).toBe(true);
    return chunks[Number(path.slice(prefix.length))];
  });
  ports.client.mockReturnValue({ rpc, select, companyChunk });
  vi.spyOn(Date, 'now').mockReturnValue(
    (transport.attempt.createdAt + 20) * 1000,
  );
});
afterEach(() => {
  sql.close();
  ports.db = null;
  vi.restoreAllMocks();
});

describe('private first canonical publication loader', () => {
  it('loads a historical committed archive through real helpers and verifies actual SQLite facts', async () => {
    await seed();
    const before = stored();
    const loaded = await run();
    expect(loaded.publication).toEqual(transport.attempt);
    expect(loaded.sqliteBytes).toEqual(fixture.native.bytes());
    expect(loaded.sqliteBytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(loaded.sqliteBytes.buffer).not.toBe(chunks[0].buffer);
    const verified = await verifyCanonicalQuotePublication({
      ...fixture.native.input(),
      ...loaded,
    });
    expect(verified.receipt).toEqual(fixture.native.receipt);
    expect(stored()).toEqual(before);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(companyChunk).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('authorize');
    expect(order.at(-1)).toBe('authorize');
  });
  it('settles a genuine pending D1 attempt only after its exact committed PG fact', async () => {
    const pending = await seed(transport.attempt, true);
    rpc.mockImplementation(async () => {
      expect(stored()[0].state).toBe('pending');
      return fact;
    });
    select.mockImplementation(async () => {
      expect(stored()[0].state).toBe('committed');
      return [snapshot];
    });
    const loaded = await run(pending);
    expect(loaded.publication.state).toBe('committed');
    expect(loaded.publication.result).toEqual(transport.fact.result);
    expect(stored()[0].state).toBe('committed');
  });
  it('accepts the same pending capture when another worker has already settled it exactly', async () => {
    await seed();
    const loaded = await run(transport.pendingAttempt);
    expect(loaded.publication).toEqual(transport.attempt);
  });
  it('never invents absence on a missing D1 attempt', async () => {
    await expect(run()).rejects.toMatchObject({ code: 'invalid_record' });
    expect(rpc).not.toHaveBeenCalled();
    expect(companyChunk).not.toHaveBeenCalled();
  });
  it('requires the captured attempt to match the immutable D1 identity before reading PG', async () => {
    await seed();
    await expect(
      run({ ...transport.attempt, archiveSha256: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['database', 'schema'])(
    'fails closed for a %s failure',
    async (kind) => {
      if (kind === 'database') ports.databaseFailure = true;
      else
        sql.exec(
          'DROP TABLE action_engine_publication_events; DROP TABLE action_engine_publication_attempts',
        );
      await expect(run()).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it.each(['organizationId', 'userId', 'installationId'] as const)(
    'refuses a foreign %s before an external call',
    async (key) => {
      const principal = {
        ...session,
        [key]:
          key === 'installationId'
            ? '10000000-0000-4000-8000-000000000001'
            : 'foreign-identity',
      };
      await expect(run(transport.attempt, principal)).rejects.toMatchObject({
        status: 403,
      });
      expect(ports.country).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it('refuses a read-only session and a missing authorization callback', async () => {
    await expect(
      run(transport.attempt, { ...session, role: 'read_only' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      loadCanonicalQuotePublication(
        session,
        transport.attempt,
        null as unknown as () => Promise<void>,
      ),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(ports.country).not.toHaveBeenCalled();
  });
  it('captures the caller session and attempt synchronously before authorization yields', async () => {
    await seed();
    const principal = structuredClone(session),
      attempt = structuredClone(transport.attempt);
    authorize.mockImplementationOnce(async () => {
      principal.organizationId = 'foreign-company';
      principal.userId = 'foreign-user';
      (attempt as { snapshotId: string }).snapshotId =
        '10000000-0000-4000-8000-000000000001';
      (attempt.result as { revision: number }).revision = 90;
    });
    expect((await run(attempt, principal)).publication).toEqual(
      transport.attempt,
    );
  });
  it('rejects accessor input without calling the getter', async () => {
    const getter = vi.fn(() => session.organizationId);
    const principal = { ...session };
    Object.defineProperty(principal, 'organizationId', {
      enumerable: true,
      get: getter,
    });
    await expect(run(transport.attempt, principal)).rejects.toMatchObject({
      code: 'invalid_record',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects archive sizes above 16 MiB before downloading or authorizing storage', async () => {
    await expect(
      run({ ...transport.attempt, sizeBytes: QUOTE_ARCHIVE_MAX_BYTES + 1 }),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(ports.country).not.toHaveBeenCalled();
    expect(companyChunk).not.toHaveBeenCalled();
  });
  it.each([
    'missing',
    'cancelled',
    'wrong-operation',
    'wrong-manifest',
    'extra-field',
  ])('rejects a %s PG fact without settling pending D1', async (kind) => {
    const pending = await seed(transport.attempt, true);
    if (kind === 'missing') fact = null;
    else if (kind === 'cancelled')
      fact = {
        ...fact,
        state: 'cancelled',
        result: { committed: false, revision: 0, snapshotId: null },
      };
    else if (kind === 'wrong-operation')
      fact = { ...fact, operationId: '10000000-0000-4000-8000-000000000001' };
    else if (kind === 'wrong-manifest')
      fact = {
        ...fact,
        manifest: { ...transport.manifest, sha256: 'a'.repeat(64) },
      };
    else fact = { ...fact, authorized: true };
    await expect(run(pending)).rejects.toBeInstanceOf(Error);
    expect(stored()[0].state).toBe('pending');
    expect(select).not.toHaveBeenCalled();
    expect(companyChunk).not.toHaveBeenCalled();
  });
  it.each([
    'organization_id',
    'installation_id',
    'created_by',
    'base_revision',
    'revision',
    'content_version',
    'size_bytes',
  ] as const)(
    'refuses mismatched snapshot %s without downloading',
    async (key) => {
      await seed();
      snapshot[key] =
        typeof snapshot[key] === 'number'
          ? Number(snapshot[key]) + 1
          : 'foreign-value';
      await expect(run()).rejects.toBeInstanceOf(Error);
      expect(companyChunk).not.toHaveBeenCalled();
    },
  );
  it('refuses a missing/pruned actual snapshot even with a retained committed fact', async () => {
    await seed();
    select.mockResolvedValue([]);
    await expect(run()).rejects.toMatchObject({ status: 404 });
    expect(companyChunk).not.toHaveBeenCalled();
  });
  it.each(['truncated', 'hash-mismatch'])(
    'rejects %s storage bytes without a canonical result',
    async (kind) => {
      await seed();
      if (kind === 'truncated')
        chunks[0] = chunks[0].subarray(0, chunks[0].length - 1);
      else {
        chunks[0] = new Uint8Array(chunks[0]);
        chunks[0][chunks[0].length - 1] ^= 1;
      }
      await expect(run()).rejects.toBeInstanceOf(Error);
    },
  );
  it('rejects a structurally invalid ZIP even when all transport hashes are coherent', async () => {
    const bytes = new Uint8Array(transport.bytes);
    bytes[0] ^= 1;
    const sha256 = await sha256Hex(bytes);
    transport.manifest.sha256 = sha256;
    transport.manifest.chunks[0].sha256 = sha256;
    transport.attempt = {
      ...transport.attempt,
      archiveSha256: sha256,
      manifestSha256: await sha256Hex(JSON.stringify(transport.manifest)),
    };
    fact = { ...transport.fact, manifest: structuredClone(transport.manifest) };
    snapshot = {
      ...transport.snapshot,
      manifest: structuredClone(transport.manifest),
    };
    chunks = [bytes];
    await seed();
    await expect(run()).rejects.toMatchObject({ code: 'invalid_archive' });
  });
  it('validates every chunk of a two-chunk real archive, including the second SHA', async () => {
    transport = buildConfirmationPublicationTransport(
      fixture.native.bytes(),
      fixture.native.publication,
      0,
      [
        {
          name: 'attachments/synthetic.bin',
          bytes: randomFillSync(new Uint8Array(BACKUP_CHUNK_BYTES)),
        },
      ],
    );
    expect(transport.chunks).toHaveLength(2);
    fact = structuredClone(transport.fact);
    snapshot = structuredClone(transport.snapshot);
    chunks = transport.chunks.map((value) => new Uint8Array(value));
    await seed();
    expect((await run()).sqliteBytes).toEqual(fixture.native.bytes());
    expect(companyChunk).toHaveBeenCalledTimes(2);
    chunks[1][0] ^= 1;
    await expect(run()).rejects.toBeInstanceOf(Error);
  });
  it('captures fact and metadata before a post-read authorization await can mutate their aliases', async () => {
    await seed();
    let deliveredFact = false,
      deliveredSnapshot = false;
    rpc.mockImplementation(async () => {
      deliveredFact = true;
      return fact;
    });
    select.mockImplementation(async () => {
      deliveredSnapshot = true;
      return [snapshot];
    });
    authorize.mockImplementation(async () => {
      if (deliveredFact) {
        fact!.userId = 'mutated-after-capture';
        deliveredFact = false;
      }
      if (deliveredSnapshot) {
        snapshot.created_by = 'mutated-after-capture';
        deliveredSnapshot = false;
      }
    });
    // PG facts and the first metadata response were detached before the await;
    // mutating their JavaScript aliases cannot rewrite the accepted proof.
    const loaded = await run();
    expect(loaded.publication.userId).toBe(session.userId);
    expect(loaded.sqliteBytes).toEqual(fixture.native.bytes());
  });
  it('copies storage chunks without evaluating an own constructor getter', async () => {
    await seed();
    const getter = vi.fn(() => {
      throw new Error('Constructor must not be read');
    });
    Object.defineProperty(chunks[0], 'constructor', { get: getter });
    expect((await run()).sqliteBytes).toEqual(fixture.native.bytes());
    expect(getter).not.toHaveBeenCalled();
  });
  it('fails closed and reauthorizes when the existing downloader encounters a hostile iterator', async () => {
    await seed();
    const getter = vi.fn(() => {
      throw new Error('Synthetic hostile iterator');
    });
    Object.defineProperty(chunks[0], Symbol.iterator, { get: getter });
    // The existing downloader hashes with Uint8Array.from before this loader's
    // intrinsic capture. Its rejection must not become bytes or fake absence.
    await expect(run()).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(getter).toHaveBeenCalledOnce();
    expect(order.at(-1)).toBe('authorize');
  });
  it('refuses a detached storage chunk and still rechecks authorization', async () => {
    await seed();
    const detached = chunks[0];
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    await expect(run()).rejects.toBeInstanceOf(Error);
    expect(order.at(-1)).toBe('authorize');
  });
  it.each([
    'fact-success',
    'fact-rejection',
    'storage-success',
    'storage-rejection',
  ] as const)(
    'rechecks authorization after %s and stops before returning bytes',
    async (stage) => {
      await seed();
      if (stage.startsWith('fact'))
        rpc.mockImplementation(async () => {
          allowed = false;
          if (stage.endsWith('rejection'))
            throw new Error('Synthetic PG outage');
          return fact;
        });
      else
        companyChunk.mockImplementation(async () => {
          allowed = false;
          if (stage.endsWith('rejection'))
            throw new Error('Synthetic storage outage');
          return chunks[0];
        });
      await expect(run()).rejects.toMatchObject({ status: 403 });
      expect(order.at(-1)).toBe('authorize');
      if (stage.startsWith('fact')) expect(select).not.toHaveBeenCalled();
    },
  );
  it('checks authorization again after country rejection instead of exposing its original failure', async () => {
    ports.country.mockImplementation(async () => {
      allowed = false;
      throw new Error('Synthetic country outage');
    });
    await expect(run()).rejects.toMatchObject({ status: 403 });
    expect(order.at(-1)).toBe('authorize');
  });
});
