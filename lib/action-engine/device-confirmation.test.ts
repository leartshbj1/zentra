import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQLInputValue } from 'node:sqlite';
const ports = vi.hoisted(() => ({
  database: vi.fn(),
  authority: vi.fn(),
  session: vi.fn(),
  access: vi.fn(),
  rpc: vi.fn(),
  snapshot: vi.fn(),
  chunk: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({ database: ports.database }));
vi.mock('@/lib/account', () => ({ requireDeviceSession: ports.session }));
vi.mock('./production-admission', () => ({
  createDeviceQuoteAuthority: ports.authority,
}));
vi.mock('./support-source', async (original) => ({
  ...(await original<typeof import('./support-source')>()),
  readSupportQuoteAccess: ports.access,
}));
vi.mock('@/lib/supabase-server-runtime', () => ({
  supabaseServerClient: () => ({ rpc: ports.rpc }),
}));
vi.mock('@/lib/company-collaboration', () => ({
  collaborationSnapshot: ports.snapshot,
  downloadCollaborationChunk: ports.chunk,
}));
import {
  confirmDeviceSupportQuote,
  type QuoteConfirmationInput,
} from './device-confirmation';
import { makeQuoteConfirmationFixture } from './confirmation-records.fixture';
import { buildConfirmationPublicationTransport } from './confirmation-publication.fixture';
import type { DeviceSessionContext } from '@/lib/account';
import { ActionEngineError } from './types';

// Actual cumulative D1 migrations, transactions, historical fences, ledger,
// evidence, ZIP parser, SQLite WASM and canonical verifier. Authentication and
// external PG/storage ports are explicitly synthetic; this is not hosted E2E.
const suite = process.env.ZENTRA_NATIVE_SOURCE_ROOT ? describe : describe.skip;
let f: ReturnType<typeof makeQuoteConfirmationFixture> | undefined;
let dropAck: 'evidence' | 'confirm' | null = null;
const request = () =>
  new Request('https://zentra.invalid/private-confirmation', {
    headers: {
      Authorization: 'Bearer synthetic-private-token',
      Origin: 'https://tauri.localhost',
    },
  });
function setup(
  options: {
    binding?: boolean;
    pending?: boolean;
    mutate?: (value: ReturnType<typeof makeQuoteConfirmationFixture>) => void;
  } = {},
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T12:01:00Z'));
  for (const port of Object.values(ports)) port.mockReset();
  f = makeQuoteConfirmationFixture();
  const fixture = f;
  options.mutate?.(fixture);
  const transport = buildConfirmationPublicationTransport(
    fixture.native.bytes(),
    fixture.native.publication,
  );
  fixture.seed(options.binding !== false);
  fixture.seedPublication(
    options.pending ? transport.pendingAttempt : transport.attempt,
  );
  type Statement = {
    sql: string;
    values: SQLInputValue[];
    first: <T>() => Promise<T | null>;
  };
  const db = {
    prepare(sql: string) {
      const statement = fixture.db.prepare(sql) as unknown as Statement;
      statement.first = async <T>() =>
        (fixture.sql.prepare(statement.sql).get(...statement.values) ??
          null) as T | null;
      return statement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const queries = (statements as unknown as Statement[]).map((s) => s.sql);
      const mutation =
        dropAck === 'evidence'
          ? queries.some((s) =>
              s.startsWith(
                'INSERT INTO action_engine_quote_publication_evidence(',
              ),
            )
          : dropAck === 'confirm' &&
            queries.some((s) =>
              s.startsWith(
                'UPDATE action_engine_quote_reservations SET receipt_json=',
              ),
            );
      if (mutation) {
        dropAck = null;
        fixture.adapter.failNext('lost');
      }
      return fixture.db.batch(statements);
    },
  } as unknown as D1Database;
  ports.database.mockReturnValue(db);
  const predicate = () => ({
    sql: 'EXISTS(SELECT 1 FROM qa_confirmation_authority WHERE organization_id=? AND allowed=1)',
    bindings: [fixture.actor.organizationId],
  });
  const authorizeRead = async () => {
    if (
      fixture.sql
        .prepare(
          'SELECT allowed FROM qa_confirmation_authority WHERE organization_id=?',
        )
        .get(fixture.actor.organizationId)?.allowed !== 1
    )
      throw new ActionEngineError('forbidden');
  };
  ports.authority.mockResolvedValue({
    actor: fixture.actor,
    installationId: fixture.identity.installationId,
    predicate,
    authorizeRead,
    preflight: vi.fn(() => {
      throw Error('No new preparation');
    }),
    preflightCas: vi.fn(() => {
      throw Error('No new preparation');
    }),
  });
  const session: DeviceSessionContext = {
    organizationId: fixture.actor.organizationId,
    userId: fixture.actor.userId,
    organizationName: 'Synthetic company',
    role: 'owner',
    subscriptionId: 'sub_synthetic',
    sessionId: 'synthetic-session',
    installationId: fixture.identity.installationId,
    entitlementValidUntil: 2_000_000_000,
  };
  ports.session.mockResolvedValue(session);
  ports.access.mockImplementation(async (_actor, sourceId: string) => ({
    sourceId,
    workspaceId: 'qa-workspace',
    predicate: () => ({
      sql: 'EXISTS(SELECT 1 FROM qa_confirmation_support WHERE source_id=? AND allowed=1)',
      bindings: [sourceId],
    }),
  }));
  ports.rpc.mockResolvedValue(transport.fact);
  ports.snapshot.mockResolvedValue(transport.snapshot);
  ports.chunk.mockImplementation(async (_session, _snapshot, index: string) =>
    transport.chunks[Number(index)].slice(),
  );
  const input: QuoteConfirmationInput = {
    sourceId: fixture.identity.sourceId,
    proposalId: fixture.identity.proposalId,
    reservationId: fixture.identity.reservationId,
    publicationSnapshotId: transport.attempt.snapshotId,
  };
  return {
    fixture,
    transport,
    input,
    session,
    run: () => confirmDeviceSupportQuote(request(), input),
  };
}
function count(table: string) {
  return Number(f!.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
}
afterEach(() => {
  f?.close();
  f = undefined;
  dropAck = null;
  vi.useRealTimers();
});

suite(
  'private A7 authenticated confirmation composition with actual SQLite/ZIP/ledger',
  () => {
    it('verifies the entire first publication and confirms one real draft receipt', async () => {
      const x = setup();
      expect(await x.run()).toEqual(x.fixture.native.receipt);
      expect(count('action_engine_quote_publication_evidence')).toBe(1);
      expect(count('action_engine_quote_events')).toBe(2);
      expect(ports.rpc).toHaveBeenCalledWith(
        'zentra_action_publication_fact_v1',
        {
          p_organization: x.fixture.actor.organizationId,
          p_operation: x.transport.attempt.id,
        },
      );
      expect(ports.chunk).toHaveBeenCalledTimes(x.transport.chunks.length);
      expect(
        x.fixture.native.sql.prepare('SELECT status,number FROM quotes').get(),
      ).toEqual({ status: 'brouillon', number: null });
    });
    it('settles a pending D1 publication only after the matching committed PG fact', async () => {
      const x = setup({ pending: true });
      await x.run();
      expect(
        x.fixture.sql
          .prepare(
            'SELECT state FROM action_engine_publication_attempts WHERE id=?',
          )
          .get(x.transport.attempt.id)?.state,
      ).toBe('committed');
      expect(count('action_engine_quote_publication_evidence')).toBe(1);
    });
    for (const fault of ['evidence', 'confirm'] as const)
      it(`recovers a lost ${fault} ACK without any PG/archive read or duplicate`, async () => {
        const x = setup();
        dropAck = fault;
        await expect(x.run()).rejects.toMatchObject({
          code: 'service_unavailable',
        });
        expect(count('action_engine_quote_publication_evidence')).toBe(1);
        ports.rpc
          .mockReset()
          .mockRejectedValue(Error('Purged PG transport must not be read'));
        ports.snapshot
          .mockReset()
          .mockRejectedValue(Error('Purged snapshot must not be read'));
        ports.chunk
          .mockReset()
          .mockRejectedValue(Error('Purged archive must not be read'));
        expect(await x.run()).toEqual(x.fixture.native.receipt);
        expect(ports.rpc).not.toHaveBeenCalled();
        expect(ports.snapshot).not.toHaveBeenCalled();
        expect(ports.chunk).not.toHaveBeenCalled();
        expect(count('action_engine_quote_publication_evidence')).toBe(1);
        expect(count('action_engine_quote_events')).toBe(2);
      });
    it('recovers historical proof after quote deletion and a newer independent pending publication', async () => {
      const x = setup();
      await x.run();
      x.fixture.native.sql.exec('DELETE FROM quotes');
      x.fixture.seedPublication({
        ...x.transport.pendingAttempt,
        id: x.fixture.nextId(),
        snapshotId: x.fixture.nextId(),
        baseRevision: 5,
        createdAt: x.transport.attempt.createdAt + 20,
      });
      ports.rpc.mockReset();
      ports.snapshot.mockReset();
      ports.chunk.mockReset();
      expect(await x.run()).toEqual(x.fixture.native.receipt);
      expect(ports.rpc).not.toHaveBeenCalled();
      expect(ports.chunk).not.toHaveBeenCalled();
    });
    it('does not retrofit a legacy receipt without canonical evidence', async () => {
      const x = setup();
      x.fixture.sql
        .prepare(
          'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=?',
        )
        .run(
          JSON.stringify(x.fixture.native.receipt),
          x.fixture.native.reservation.createdAt + 30,
        );
      await expect(x.run()).rejects.toMatchObject({ code: 'review_required' });
      expect(count('action_engine_quote_publication_evidence')).toBe(0);
      expect(ports.rpc).not.toHaveBeenCalled();
    });
    for (const at of ['fact', 'chunk'] as const)
      it(`does not retrofit a receipt confirmed concurrently during ${at} loading`, async () => {
        const x = setup();
        const confirmLegacy = () =>
          x.fixture.sql
            .prepare(
              'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=?',
            )
            .run(
              JSON.stringify(x.fixture.native.receipt),
              x.fixture.native.reservation.createdAt + 30,
            );
        if (at === 'fact')
          ports.rpc.mockImplementation(async () => {
            confirmLegacy();
            return x.transport.fact;
          });
        else
          ports.chunk.mockImplementation(
            async (_session, _snapshot, index: string) => {
              confirmLegacy();
              return x.transport.chunks[Number(index)].slice();
            },
          );
        await expect(x.run()).rejects.toMatchObject({ code: 'invalid_record' });
        expect(count('action_engine_quote_publication_evidence')).toBe(0);
        expect(count('action_engine_quote_events')).toBe(1);
        await expect(x.run()).rejects.toMatchObject({
          code: 'review_required',
        });
        expect(count('action_engine_quote_publication_evidence')).toBe(0);
      });
    it('does not retrofit a reservation without its original binding', async () => {
      const x = setup({ binding: false });
      await expect(x.run()).rejects.toMatchObject({ code: 'review_required' });
      expect(ports.rpc).not.toHaveBeenCalled();
      expect(count('action_engine_quote_publication_evidence')).toBe(0);
    });
    for (const mutation of [
      "UPDATE quotes SET title='Edited'",
      "UPDATE quotes SET status='emis',number='DV-1'",
      'DELETE FROM quotes',
      'DELETE FROM quote_items WHERE position=1',
    ])
      it(`refuses first evidence for a hash-valid archive after ${mutation}`, async () => {
        const x = setup({ mutate: (value) => value.native.sql.exec(mutation) });
        await expect(x.run()).rejects.toMatchObject({
          code: 'review_required',
        });
        expect(count('action_engine_quote_publication_evidence')).toBe(0);
        expect(
          x.fixture.sql
            .prepare(
              'SELECT receipt_json FROM action_engine_quote_reservations',
            )
            .get()?.receipt_json,
        ).toBeNull();
      });
    it('refuses a pruned archive before first proof, without confirming a receipt', async () => {
      const x = setup();
      ports.snapshot.mockRejectedValue(Error('synthetic404'));
      await expect(x.run()).rejects.toThrow();
      expect(count('action_engine_quote_publication_evidence')).toBe(0);
      expect(count('action_engine_quote_events')).toBe(1);
    });
    for (const column of [
      'userId',
      'installationId',
      'organizationId',
    ] as const)
      it(`refuses a second authentication with a different ${column}`, async () => {
        const x = setup();
        ports.session.mockResolvedValue({ ...x.session, [column]: 'other' });
        await expect(x.run()).rejects.toMatchObject({ code: 'forbidden' });
        expect(ports.rpc).not.toHaveBeenCalled();
      });
    for (const at of [
      'fact-success',
      'fact-rejection',
      'chunk-success',
      'after-confirmed-replay',
    ] as const)
      it(`rechecks a revoked grant at ${at}`, async () => {
        const x = setup();
        const revoke = () =>
          x.fixture.sql.exec('UPDATE qa_confirmation_authority SET allowed=0');
        if (at === 'fact-success')
          ports.rpc.mockImplementation(async () => {
            revoke();
            return x.transport.fact;
          });
        if (at === 'fact-rejection')
          ports.rpc.mockImplementation(async () => {
            revoke();
            throw Error('Private upstream error');
          });
        if (at === 'chunk-success')
          ports.chunk.mockImplementation(async () => {
            revoke();
            return x.transport.chunks[0];
          });
        if (at === 'after-confirmed-replay') {
          await x.run();
          revoke();
        }
        await expect(x.run()).rejects.toMatchObject({ code: 'forbidden' });
        if (at !== 'after-confirmed-replay')
          expect(count('action_engine_quote_publication_evidence')).toBe(0);
      });
    it('refuses delegation revoked after a confirmed receipt without contacting transport', async () => {
      const x = setup();
      await x.run();
      ports.rpc.mockClear();
      x.fixture.sql.exec('UPDATE qa_confirmation_support SET allowed=0');
      await expect(x.run()).rejects.toMatchObject({ code: 'forbidden' });
      expect(ports.rpc).not.toHaveBeenCalled();
    });
    it('rejects extra fields and accessors before authenticating, without reading their values', async () => {
      const x = setup();
      ports.authority.mockClear();
      await expect(
        confirmDeviceSupportQuote(request(), {
          ...x.input,
          actor: x.fixture.actor,
        } as QuoteConfirmationInput),
      ).rejects.toThrow();
      let calls = 0;
      await expect(
        confirmDeviceSupportQuote(request(), {
          ...x.input,
          get sourceId() {
            calls++;
            return x.input.sourceId;
          },
        }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect(ports.authority).not.toHaveBeenCalled();
    });
    it('captures input and request headers before authentication awaits', async () => {
      const x = setup(),
        req = request();
      const original = ports.authority.getMockImplementation()!;
      let release: (() => void) | undefined;
      ports.authority.mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return original(...args);
      });
      const pending = confirmDeviceSupportQuote(req, x.input);
      (x.input as { sourceId: string }).sourceId = 'changed';
      req.headers.set('Authorization', 'Bearer switched');
      release!();
      await pending;
      expect(
        (ports.session.mock.calls[0][0] as Request).headers.get(
          'Authorization',
        ),
      ).toBe('Bearer synthetic-private-token');
    });
    it('refuses a different publication selector on historical replay', async () => {
      const x = setup();
      await x.run();
      ports.rpc.mockClear();
      await expect(
        confirmDeviceSupportQuote(request(), {
          ...x.input,
          publicationSnapshotId: x.fixture.nextId(),
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(ports.rpc).not.toHaveBeenCalled();
    });
    for (const at of ['initial', 'after-proof'] as const)
      it(`atomically refuses a US intention at ${at}`, async () => {
        const x = setup();
        if (at === 'after-proof') await x.run();
        ports.rpc.mockClear();
        x.fixture.seedUsIntent();
        await expect(x.run()).rejects.toMatchObject({ code: 'forbidden' });
        expect(ports.rpc).not.toHaveBeenCalled();
      });
  },
);
