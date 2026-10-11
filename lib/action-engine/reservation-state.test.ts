import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/runtime', () => ({
  database: () => {
    throw Error('Unexpected production runtime in reservation-state QA');
  },
}));
import {
  readQuoteReservationState,
  type QuoteReservationStateFence,
  type QuoteReservationStateSelection,
} from './reservation-state';
import {
  confirmationSqliteAdapter,
  makeQuoteConfirmationFixture,
} from './confirmation-records.fixture';
import { createHistoricalQuoteFences } from './historical-quote-fences';
import { createD1QuotePublicationEvidence } from './quote-publication-evidence';

// Real cumulative D1 migrations/SQLite and A6 proof; device/Support grants are
// explicit QA capabilities. No hosted auth, PG/storage or native writer runs.
const suite = process.env.ZENTRA_NATIVE_SOURCE_ROOT ? describe : describe.skip;
let f: ReturnType<typeof makeQuoteConfirmationFixture> | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  f?.close();
  f = undefined;
});
function setup(options: { reserved?: boolean; binding?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T12:01:00Z'));
  f = makeQuoteConfirmationFixture();
  const q = f;
  if (options.reserved !== false) q.seed(options.binding !== false);
  else {
    const p = q.native.proposal;
    q.sql
      .prepare(
        'INSERT INTO action_engine_quote_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        p.id,
        p.organizationId,
        p.plan.sourceId,
        p.plan.kind,
        p.fingerprint,
        p.plan.sourceRevision,
        p.plan.contextRevision,
        JSON.stringify(p.plan),
        q.actor.userId,
        q.native.reservation.createdAt - 1,
      );
  }
  const selection: QuoteReservationStateSelection = {
    actor: q.actor,
    installationId: q.identity.installationId,
    sourceId: q.identity.sourceId,
    proposalId: q.identity.proposalId,
  };
  function fenceFor(expected: QuoteReservationStateSelection) {
    const actor = Object.freeze({ ...expected.actor }),
      installationId = expected.installationId,
      sourceId = expected.sourceId;
    const historical = createHistoricalQuoteFences(
      {
        actor,
        installationId,
        predicate: () => ({
          sql: 'EXISTS(SELECT 1 FROM qa_confirmation_authority WHERE organization_id=? AND allowed=1)',
          bindings: [actor.organizationId],
        }),
        preflight: async () => {
          throw Error('Unexpected progression in read-only classification');
        },
        preflightCas: async () => {
          throw Error('Unexpected progression in read-only classification');
        },
        authorizeRead: async () => {},
      },
      {
        sourceId,
        workspaceId: 'qa-workspace',
        predicate: () => ({
          sql: 'EXISTS(SELECT 1 FROM qa_confirmation_support WHERE source_id=? AND allowed=1)',
          bindings: [sourceId],
        }),
      },
    );
    const fence: QuoteReservationStateFence = (captured) => {
      if (captured.installationId !== installationId)
        throw Error('Synthetic identity mismatch');
      // Source-only historical access intentionally permits a missing proposal
      // to reach the scoped SELECT and be invalid_record, never unreserved.
      return historical.ledgerFence({
        operation: 'read',
        actor: captured.actor,
        sourceId: captured.sourceId,
        proposalId: null,
      });
    };
    return fence;
  }
  const fence = fenceFor(selection);
  return {
    ...q,
    selection,
    fence,
    fenceFor,
    run: () => readQuoteReservationState(q.db, fence, selection),
  };
}
function assertionCount(q: ReturnType<typeof setup>) {
  return q.sql
    .prepare('SELECT count(*) n FROM action_engine_atomic_assertions')
    .get()?.n;
}
function legacyReceipt(q: ReturnType<typeof setup>) {
  q.sql
    .prepare(
      'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=? WHERE id=?',
    )
    .run(
      JSON.stringify(q.native.receipt),
      q.native.reservation.createdAt + 1,
      q.identity.reservationId,
    );
}
function mutateRow(
  results: unknown[],
  change: (row: Record<string, unknown>) => unknown,
) {
  const selected = results[1] as { results: Record<string, unknown>[] };
  return results.map((result, index) =>
    index === 1
      ? { ...selected, results: selected.results.map(change) }
      : result,
  );
}

suite('private reservation classifier, real cumulative D1 SQLite', () => {
  it('returns frozen owned recovery selectors without any business or actor data', async () => {
    const q = setup(),
      state = await q.run();
    expect(state).toEqual({
      state: 'owned',
      reservationId: q.identity.reservationId,
      hasReceipt: false,
      evidenceSnapshotId: null,
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(assertionCount(q)).toBe(0);
    expect(
      q.sql.prepare('SELECT count(*) n FROM action_engine_quote_events').get()
        ?.n,
    ).toBe(1);
    expect(q.migrations.at(-1)).toContain('0104');
  });
  it('returns unreserved only for an existing scoped proposal without a reservation', async () => {
    const q = setup({ reserved: false }),
      state = await q.run();
    expect(state).toEqual({ state: 'unreserved' });
    expect(Object.isFrozen(state)).toBe(true);
    expect(
      q.sql
        .prepare('SELECT count(*) n FROM action_engine_quote_reservations')
        .get()?.n,
    ).toBe(0);
    expect(assertionCount(q)).toBe(0);
  });
  it('a missing proposal is invalid_record, never an opportunity to reserve', async () => {
    const q = setup({ reserved: false });
    await expect(
      readQuoteReservationState(q.db, q.fence, {
        ...q.selection,
        proposalId: 'missing-proposal',
      }),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(assertionCount(q)).toBe(0);
  });
  it.each(['source', 'organization'] as const)(
    'does not select the proposal through a different %s',
    async (kind) => {
      const q = setup(),
        selection = {
          ...q.selection,
          actor: { ...q.actor },
        };
      if (kind === 'source') selection.sourceId = 'other-source';
      else selection.actor.organizationId = 'other-company';
      await expect(
        readQuoteReservationState(q.db, q.fenceFor(selection), selection),
      ).rejects.toMatchObject({
        code: kind === 'source' ? 'forbidden' : 'invalid_record',
      });
      expect(assertionCount(q)).toBe(0);
    },
  );
  for (const receipt of [false, true])
    it.each(['actor', 'installation'] as const)(
      `another %s receives only held, even with receipt=${receipt}`,
      async (kind) => {
        const q = setup();
        if (receipt) legacyReceipt(q);
        const selection = {
          ...q.selection,
          actor: { ...q.actor },
        };
        if (kind === 'actor') selection.actor.userId = 'other-user';
        else selection.installationId = q.nextId();
        const state = await readQuoteReservationState(
          q.db,
          q.fenceFor(selection),
          selection,
        );
        expect(state).toEqual({ state: 'held' });
        expect(Object.isFrozen(state)).toBe(true);
        expect(Reflect.ownKeys(state)).toEqual(['state']);
        expect(assertionCount(q)).toBe(0);
      },
    );
  it('reports a legacy receipt as a hint only, without converting it to evidence', async () => {
    const q = setup();
    legacyReceipt(q);
    expect(await q.run()).toEqual({
      state: 'owned',
      reservationId: q.identity.reservationId,
      hasReceipt: true,
      evidenceSnapshotId: null,
    });
    expect(
      q.sql
        .prepare(
          'SELECT count(*) n FROM action_engine_quote_publication_evidence',
        )
        .get()?.n,
    ).toBe(0);
  });
  it('does not create a binding for an old owned reservation', async () => {
    const q = setup({ binding: false });
    expect((await q.run()).state).toBe('owned');
    expect(
      q.sql
        .prepare(
          'SELECT count(*) n FROM action_engine_quote_reservation_bindings',
        )
        .get()?.n,
    ).toBe(0);
  });
  it('selects an owned canonical evidence snapshot, without returning its receipt or treating it as authority', async () => {
    const q = setup();
    q.seedPublication(q.native.publication);
    const verified = await q.native.verify();
    await createD1QuotePublicationEvidence(
      q.db,
      q.historical().evidenceFence,
    ).append(q.actor, verified);
    legacyReceipt(q);
    q.native.sql.exec('DELETE FROM quotes');
    expect(await q.run()).toEqual({
      state: 'owned',
      reservationId: q.identity.reservationId,
      hasReceipt: true,
      evidenceSnapshotId: q.native.publication.snapshotId,
    });
    const selection = { ...q.selection, installationId: q.nextId() };
    expect(
      await readQuoteReservationState(q.db, q.fenceFor(selection), selection),
    ).toEqual({ state: 'held' });
  });
  it('reopens on a second actual SQLite connection with the same owned identity', async () => {
    const q = setup(),
      reopened = confirmationSqliteAdapter(q.connect());
    expect(
      await readQuoteReservationState(reopened.db, q.fence, q.selection),
    ).toEqual(await q.run());
  });
  it.each(['rollback', 'lost'] as const)(
    'a %s acknowledgement fails closed and leaves no assertions or new reservation',
    async (failure) => {
      const q = setup();
      q.adapter.failNext(failure);
      await expect(q.run()).rejects.toMatchObject({
        code: 'service_unavailable',
        message: 'service_unavailable',
      });
      expect(assertionCount(q)).toBe(0);
      expect((await q.run()).state).toBe('owned');
      expect(
        q.sql
          .prepare('SELECT count(*) n FROM action_engine_quote_reservations')
          .get()?.n,
      ).toBe(1);
    },
  );
  it.each(['authority', 'delegation'] as const)(
    'a second connection can revoke %s before the atomic selection',
    async (kind) => {
      const q = setup(),
        other = q.connect();
      q.adapter.beforeNext(() =>
        other.exec(
          kind === 'authority'
            ? 'UPDATE qa_confirmation_authority SET allowed=0'
            : 'UPDATE qa_confirmation_support SET allowed=0',
        ),
      );
      await expect(q.run()).rejects.toMatchObject({ code: 'forbidden' });
      expect(assertionCount(q)).toBe(0);
    },
  );
  it('renews authority after capturing a successful read, so no stale owned selector escapes', async () => {
    const q = setup();
    q.adapter.transformNext((results) => {
      q.sql.exec('UPDATE qa_confirmation_authority SET allowed=0');
      return results;
    });
    await expect(q.run()).rejects.toMatchObject({ code: 'forbidden' });
    expect(assertionCount(q)).toBe(0);
  });
  it('renews access after rejection and masks private diagnostics with the fresh denial', async () => {
    const q = setup();
    q.adapter.beforeNext(() => {
      q.sql.exec('UPDATE qa_confirmation_support SET allowed=0');
      throw Error('PRIVATE READ DIAGNOSTIC');
    });
    await expect(q.run()).rejects.toMatchObject({
      code: 'forbidden',
      message: 'forbidden',
    });
    expect(assertionCount(q)).toBe(0);
  });
  it('does not expose a rejected fresh admission or proxy diagnostic after a successful read', async () => {
    const q = setup();
    let calls = 0;
    const privateFailure = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw Error('PRIVATE PROXY DIAGNOSTIC');
        },
      },
    );
    const fence: QuoteReservationStateFence = async (selection) => {
      if (++calls > 1) throw privateFailure;
      return q.fence(selection);
    };
    await expect(
      readQuoteReservationState(q.db, fence, q.selection),
    ).rejects.toMatchObject({
      code: 'service_unavailable',
      message: 'service_unavailable',
    });
    expect(assertionCount(q)).toBe(0);
  });
  it('a US intention is denied by the real historical fence', async () => {
    const q = setup();
    q.seedUsIntent();
    await expect(q.run()).rejects.toMatchObject({ code: 'forbidden' });
    expect(assertionCount(q)).toBe(0);
  });
  it('a missing evidence table is service_unavailable rather than unreserved', async () => {
    const q = setup({ reserved: false });
    q.sql.exec('DROP TABLE action_engine_quote_publication_evidence');
    await expect(q.run()).rejects.toMatchObject({
      code: 'service_unavailable',
      message: 'service_unavailable',
    });
    expect(assertionCount(q)).toBe(0);
  });
  it('captures every selector before awaiting the fence, including the nested actor', async () => {
    const q = setup(),
      selection = { ...q.selection, actor: { ...q.actor } };
    const fence: QuoteReservationStateFence = async (captured) => {
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.isFrozen(captured.actor)).toBe(true);
      selection.actor.organizationId = 'other-company';
      selection.actor.userId = 'other-user';
      selection.installationId = q.nextId();
      selection.sourceId = 'other-source';
      selection.proposalId = 'other-proposal';
      return q.fence(captured);
    };
    expect(await readQuoteReservationState(q.db, fence, selection)).toEqual({
      state: 'owned',
      reservationId: q.identity.reservationId,
      hasReceipt: false,
      evidenceSnapshotId: null,
    });
  });
  it.each(['accessor', 'symbol', 'nonenumerable', 'extra'] as const)(
    'rejects a closed-input %s before invoking any fence or SQL',
    async (kind) => {
      const q = setup(),
        selection = { ...q.selection };
      let reads = 0;
      Object.defineProperty(
        selection,
        kind === 'accessor'
          ? 'sourceId'
          : kind === 'symbol'
            ? Symbol('private')
            : 'extra',
        kind === 'accessor'
          ? {
              enumerable: true,
              get() {
                reads++;
                return q.selection.sourceId;
              },
            }
          : { enumerable: kind !== 'nonenumerable', value: true },
      );
      const fence = vi.fn(q.fence);
      await expect(
        readQuoteReservationState(q.db, fence, selection),
      ).rejects.toMatchObject({ code: 'invalid_record' });
      expect(reads).toBe(0);
      expect(fence).not.toHaveBeenCalled();
      expect(q.adapter.batches).toHaveLength(0);
    },
  );
  it('rejects an accessor inside the actor without invoking it', async () => {
    const q = setup(),
      actor = { ...q.actor };
    let reads = 0;
    Object.defineProperty(actor, 'userId', {
      enumerable: true,
      get() {
        reads++;
        throw Error('PRIVATE ACTOR');
      },
    });
    await expect(
      readQuoteReservationState(q.db, q.fence, { ...q.selection, actor }),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(reads).toBe(0);
    expect(q.adapter.batches).toHaveLength(0);
  });
  it('does not invoke predicate or binding getters, even while renewing a rejection', async () => {
    const q = setup();
    let reads = 0;
    const bindings: string[] = [];
    Object.defineProperty(bindings, '0', {
      enumerable: true,
      get() {
        reads++;
        throw Error('PRIVATE BINDING');
      },
    });
    await expect(
      readQuoteReservationState(
        q.db,
        async () => ({ sql: '?', bindings }),
        q.selection,
      ),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(reads).toBe(0);
    expect(q.adapter.batches).toHaveLength(0);
  });
  it.each([
    ['unknown state', { state: 'confirmed' }],
    ['reservation ID', { reservation_id: 'not-a-uuid' }],
    ['receipt coercion', { has_receipt: '1' }],
    ['publication ID', { evidence_snapshot_id: 'not-a-uuid' }],
    ['private held selector', { state: 'held' }],
    ['private unreserved selector', { state: 'unreserved' }],
    ['unexpected field', { receipt_json: 'PRIVATE RECEIPT' }],
  ])('refuses malformed returned %s facts', async (_name, patch) => {
    const q = setup();
    q.adapter.transformNext((results) =>
      mutateRow(results, (row) => ({ ...row, ...(patch as object) })),
    );
    await expect(q.run()).rejects.toMatchObject({ code: 'invalid_record' });
    expect(assertionCount(q)).toBe(0);
  });
  it('never invokes a database row getter while capturing the result', async () => {
    const q = setup();
    let reads = 0;
    q.adapter.transformNext((results) =>
      mutateRow(results, (row) => {
        const copy = { ...row };
        Object.defineProperty(copy, 'reservation_id', {
          enumerable: true,
          get() {
            reads++;
            throw Error('PRIVATE DATABASE ROW');
          },
        });
        return copy;
      }),
    );
    await expect(q.run()).rejects.toMatchObject({ code: 'invalid_record' });
    expect(reads).toBe(0);
    expect(assertionCount(q)).toBe(0);
  });
  it.each(['missing-result', 'failed-result', 'sparse-rows'] as const)(
    'a malformed batch %s cannot produce an unreserved response',
    async (kind) => {
      const q = setup({ reserved: false });
      q.adapter.transformNext((results) => {
        if (kind === 'missing-result') return results.slice(0, 2);
        if (kind === 'failed-result')
          return results.map((result, at) =>
            at === 1 ? { ...(result as object), success: false } : result,
          );
        const selected = results[1] as { results: unknown[] },
          sparse: unknown[] = Array(1);
        return results.map((result, at) =>
          at === 1 ? { ...selected, results: sparse } : result,
        );
      });
      await expect(q.run()).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      expect(assertionCount(q)).toBe(0);
    },
  );
});
