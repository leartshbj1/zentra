import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/runtime', () => ({
  database: () => {
    throw Error('Unexpected production runtime in SQLite QA');
  },
}));
import {
  captureQuoteConfirmationIdentity,
  readBoundQuoteExecution,
  type QuoteConfirmationIdentity,
  type QuoteConfirmationReadFence,
} from './confirmation-records';
import {
  makeQuoteConfirmationFixture,
  confirmationSqliteAdapter,
} from './confirmation-records.fixture';

const suite = process.env.ZENTRA_NATIVE_SOURCE_ROOT ? describe : describe.skip;
let f: ReturnType<typeof makeQuoteConfirmationFixture> | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  f?.close();
  f = undefined;
});
function setup(withBinding = true) {
  f = makeQuoteConfirmationFixture();
  f.seed(withBinding);
  const value = f;
  const fence: QuoteConfirmationReadFence = (identity) =>
    value.historical().ledgerFence({
      operation: 'read',
      actor: identity.actor,
      sourceId: null,
      proposalId: identity.proposalId,
    });
  return { ...value, fence };
}
function mutateRow(
  results: unknown[],
  change: (row: Record<string, unknown>) => unknown,
) {
  const result = results[1] as { results: Record<string, unknown>[] };
  return results.map((value, index) =>
    index === 1 ? { ...result, results: result.results.map(change) } : value,
  );
}
function assertions(
  sql: ReturnType<typeof makeQuoteConfirmationFixture>['sql'],
) {
  return sql
    .prepare('SELECT count(*) n FROM action_engine_atomic_assertions')
    .get()?.n;
}

suite('private bound quote loader, real cumulative D1 SQL', () => {
  it('loads exact frozen historical facts with atomic selection and leaves no assertion rows', async () => {
    const q = setup();
    const result = await readBoundQuoteExecution(q.db, q.fence, q.identity);
    expect(result).toEqual({
      proposal: q.native.proposal,
      reservation: q.native.reservation,
      binding: q.native.binding,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.proposal.plan.lines[0])).toBe(true);
    expect(Object.isFrozen(result.binding.planningPublication)).toBe(true);
    expect(q.adapter.batches).toHaveLength(2);
    for (const batch of q.adapter.batches) {
      expect(batch[0]).toContain('INSERT INTO action_engine_atomic_assertions');
      expect(batch[1]).toContain('JOIN action_engine_quote_reservations');
      expect(batch[2]).toContain('DELETE FROM action_engine_atomic_assertions');
    }
    expect(assertions(q.sql)).toBe(0);
    expect(q.migrations).toContain(
      '0104_action_engine_quote_evidence_preconfirmation.sql',
    );
  });
  it('clean reopen uses a second actual SQLite connection and preserves exact IDs', async () => {
    const q = setup();
    const before = await readBoundQuoteExecution(q.db, q.fence, q.identity);
    const reopened = confirmationSqliteAdapter(q.connect());
    expect(
      await readBoundQuoteExecution(reopened.db, q.fence, q.identity),
    ).toEqual(before);
    expect(
      q.sql
        .prepare('SELECT count(*) n FROM action_engine_quote_reservations')
        .get()?.n,
    ).toBe(1);
  });
  it('never backfills an old unbound reservation, even when it already contains a receipt', async () => {
    const q = setup(false);
    q.sql
      .prepare(
        'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=? WHERE id=?',
      )
      .run(
        JSON.stringify(q.native.receipt),
        q.native.reservation.createdAt + 1,
        q.identity.reservationId,
      );
    await expect(
      readBoundQuoteExecution(q.db, q.fence, q.identity),
    ).rejects.toMatchObject({ code: 'review_required' });
    expect(
      q.sql
        .prepare(
          'SELECT count(*) n FROM action_engine_quote_reservation_bindings',
        )
        .get()?.n,
    ).toBe(0);
    expect(assertions(q.sql)).toBe(0);
  });
  it('returns a stored receipt only with a valid immutable binding; this loader grants no A6 proof', async () => {
    const q = setup();
    q.sql
      .prepare(
        'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=? WHERE id=?',
      )
      .run(
        JSON.stringify(q.native.receipt),
        q.native.reservation.createdAt + 1,
        q.identity.reservationId,
      );
    const result = await readBoundQuoteExecution(q.db, q.fence, q.identity);
    expect(result.reservation.receipt).toEqual(q.native.receipt);
    expect(
      q.sql
        .prepare(
          'SELECT count(*) n FROM action_engine_quote_publication_evidence',
        )
        .get()?.n,
    ).toBe(0);
  });
  it.each([
    'sourceId',
    'proposalId',
    'reservationId',
    'installationId',
    'userId',
    'organizationId',
  ] as const)(
    'rejects a different %s without returning another tenant/device/source record',
    async (field) => {
      const q = setup();
      const identity = {
        ...q.identity,
        actor: { ...q.actor },
        ...(field === 'reservationId'
          ? { reservationId: q.nextId() }
          : field === 'userId' || field === 'organizationId'
            ? {}
            : { [field]: 'other' }),
      };
      if (field === 'userId') identity.actor.userId = 'other-user';
      if (field === 'organizationId')
        identity.actor.organizationId = 'other-company';
      await expect(
        readBoundQuoteExecution(q.db, q.fence, identity),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^(forbidden|invalid_record)$/),
      });
      expect(assertions(q.sql)).toBe(0);
    },
  );
  it('denies authority revoked by a second connection immediately before the selection batch', async () => {
    const q = setup(),
      other = q.connect();
    q.adapter.beforeNext(() =>
      other.exec('UPDATE qa_confirmation_authority SET allowed=0'),
    );
    await expect(
      readBoundQuoteExecution(q.db, q.fence, q.identity),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(assertions(q.sql)).toBe(0);
  });
  it('renews authority after the asynchronous digest', async () => {
    const q = setup(),
      digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(
      async (...args) => {
        q.sql.exec('UPDATE qa_confirmation_authority SET allowed=0');
        return digest(...args);
      },
    );
    await expect(
      readBoundQuoteExecution(q.db, q.fence, q.identity),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('captures identity before an await and ignores caller retargeting while permission waits', async () => {
    const q = setup();
    const identity = { ...q.identity, actor: { ...q.actor } };
    const fence: QuoteConfirmationReadFence = async (captured) => {
      identity.actor.organizationId = 'other-company';
      identity.sourceId = 'other-source';
      identity.reservationId = q.nextId();
      return q.fence(captured);
    };
    expect(
      (await readBoundQuoteExecution(q.db, fence, identity)).proposal,
    ).toEqual(q.native.proposal);
  });
  it('adopts a coherently confirmed receipt on the final admitted read after hashing', async () => {
    const q = setup(),
      digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(
      async (...args) => {
        q.sql
          .prepare(
            'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=? WHERE id=?',
          )
          .run(
            JSON.stringify(q.native.receipt),
            q.native.reservation.createdAt + 1,
            q.identity.reservationId,
          );
        return digest(...args);
      },
    );
    expect(
      (await readBoundQuoteExecution(q.db, q.fence, q.identity)).reservation
        .receipt,
    ).toEqual(q.native.receipt);
  });
  it('requires a fresh successful fence before publishing a crypto failure', async () => {
    const q = setup();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async () => {
      q.sql.exec('UPDATE qa_confirmation_support SET allowed=0');
      throw Error('Private digest detail');
    });
    await expect(
      readBoundQuoteExecution(q.db, q.fence, q.identity),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('masks a rejected digest and a rejected admission without exposing private diagnostics', async () => {
    const q = setup();
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(
      Error('PRIVATE DIGEST'),
    );
    let calls = 0;
    const fence: QuoteConfirmationReadFence = async (identity) => {
      if (++calls > 1) throw Error('PRIVATE AUTHORITY');
      return q.fence(identity);
    };
    await expect(
      readBoundQuoteExecution(q.db, fence, q.identity),
    ).rejects.toMatchObject({
      code: 'service_unavailable',
      message: 'service_unavailable',
    });
  });
  it.each(['rollback', 'lost'] as const)(
    'a %s read acknowledgement leaves no durable control mutation and retry is explicit',
    async (fault) => {
      const q = setup();
      q.adapter.failNext(fault);
      await expect(
        readBoundQuoteExecution(q.db, q.fence, q.identity),
      ).rejects.toMatchObject({ code: 'service_unavailable' });
      expect(assertions(q.sql)).toBe(0);
      expect(
        (await readBoundQuoteExecution(q.db, q.fence, q.identity)).reservation
          .id,
      ).toBe(q.identity.reservationId);
    },
  );
  it('rechecks the canonical plan fingerprint instead of trusting coherent row metadata', async () => {
    const q = setup();
    q.adapter.transformNext((results) =>
      mutateRow(results, (row) => {
        const plan = JSON.parse(row.plan_json as string);
        plan.title = 'Forged title';
        return { ...row, plan_json: JSON.stringify(plan) };
      }),
    );
    await expect(
      readBoundQuoteExecution(q.db, q.fence, q.identity),
    ).rejects.toMatchObject({ code: 'invalid_record' });
  });
  it.each([
    'planning_witness',
    'binding_json',
    'quote_id',
    'confirmed_at',
    'source_revision',
  ] as const)('rejects malformed private returned %s facts', async (field) => {
    const q = setup();
    q.adapter.transformNext((results) =>
      mutateRow(results, (row) => ({
        ...row,
        [field]:
          field === 'planning_witness'
            ? 0
            : field === 'confirmed_at'
              ? q.native.reservation.createdAt
              : 'forged',
      })),
    );
    await expect(
      readBoundQuoteExecution(q.db, q.fence, q.identity),
    ).rejects.toMatchObject({ code: 'invalid_record' });
  });
  it('rejects hidden/accessor fields in the input and database rows without invoking getters', async () => {
    const q = setup();
    let calls = 0;
    const identity = { ...q.identity };
    Object.defineProperty(identity, 'sourceId', {
      enumerable: true,
      get() {
        calls++;
        return q.identity.sourceId;
      },
    });
    await expect(
      readBoundQuoteExecution(q.db, q.fence, identity),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    q.adapter.transformNext((results) =>
      mutateRow(results, (row) => {
        const copy = { ...row };
        Object.defineProperty(copy, 'plan_json', {
          enumerable: true,
          get() {
            calls++;
            throw Error('private');
          },
        });
        return copy;
      }),
    );
    await expect(
      readBoundQuoteExecution(q.db, q.fence, q.identity),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(calls).toBe(0);
  });
  it.each(['symbol', 'nonenumerable', 'extra'] as const)(
    'closed identity refuses %s properties before SQL',
    async (kind) => {
      const q = setup(),
        identity = { ...q.identity };
      Object.defineProperty(
        identity,
        kind === 'symbol' ? Symbol('private') : 'extra',
        { value: true, enumerable: kind !== 'nonenumerable' },
      );
      await expect(
        readBoundQuoteExecution(q.db, q.fence, identity),
      ).rejects.toMatchObject({ code: 'invalid_record' });
      expect(q.adapter.batches).toHaveLength(0);
    },
  );
  it('captures closed predicates and rejects getters in their arrays without invoking them', async () => {
    const q = setup();
    let calls = 0;
    const bindings: string[] = [];
    Object.defineProperty(bindings, '0', {
      enumerable: true,
      get() {
        calls++;
        return 'secret';
      },
    });
    await expect(
      readBoundQuoteExecution(
        q.db,
        async () => ({ sql: '?', bindings }),
        q.identity,
      ),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(calls).toBe(0);
    expect(q.adapter.batches).toHaveLength(0);
  });
  it('captures the identity helper deeply and refuses accidental request extras', () => {
    const q = setup(),
      captured = captureQuoteConfirmationIdentity(q.identity);
    expect(Object.isFrozen(captured.actor)).toBe(true);
    expect(() =>
      captureQuoteConfirmationIdentity({
        ...q.identity,
        receipt: q.native.receipt,
      } as QuoteConfirmationIdentity),
    ).toThrow();
  });
});
