import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { DeviceSessionContext } from '@/lib/account';
const ports = vi.hoisted(() => ({
  database: vi.fn(),
  authority: vi.fn(),
  access: vi.fn(),
  load: vi.fn(),
  session: vi.fn(),
  enabled: true,
}));
vi.mock('@/lib/runtime', () => ({ database: ports.database }));
vi.mock('@/lib/account', () => ({ requireDeviceSession: ports.session }));
vi.mock('@/lib/supabase-server-runtime', () => ({
  supabaseServerClient: () => {
    throw Error('External PG is forbidden in this reservation fixture');
  },
}));
vi.mock('@/lib/company-collaboration', () => ({
  collaborationSnapshot: () => {
    throw Error('External Storage is forbidden in this reservation fixture');
  },
  downloadCollaborationChunk: () => {
    throw Error('External Storage is forbidden in this reservation fixture');
  },
}));
vi.mock('./production-admission', () => ({
  createDeviceQuoteAuthority: ports.authority,
}));
vi.mock('./published-context', () => ({
  loadDeviceQuotePlanningContext: ports.load,
}));
vi.mock('./support-source', async (original) => ({
  ...(await original<typeof import('./support-source')>()),
  readSupportQuoteAccess: ports.access,
}));
vi.mock('./publication-gateway', async (original) => ({
  ...(await original<typeof import('./publication-gateway')>()),
  publicationCoordinationEnabled: () => ports.enabled,
}));
import {
  reserveDeviceSupportQuote,
  type DeviceQuoteReservationInput,
} from './device-reservation';
import { makeDeviceReservationFixture } from './device-reservation.fixture';

// Real migrations/SQLite batches/ledgers/published and historical fences/A7.
// Authentication and source/catalogue loader are explicitly synthetic ports.
const suite = process.env.ZENTRA_NATIVE_SOURCE_ROOT ? describe : describe.skip;
let f: ReturnType<typeof makeDeviceReservationFixture> | undefined;
let fault: 'lost' | 'rollback' | 'country' | null = null;
let finalGate: (() => Promise<void> | void) | null = null;
const observedFirstReads: string[] = [];
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function request(device = 'first') {
  return new Request('https://zentra.invalid/private-reservation', {
    headers: {
      Authorization: 'Bearer synthetic-private-token',
      Origin: 'https://tauri.localhost',
      'X-QA-Device': device,
    },
  });
}
function identity(req: Request) {
  const fixture = f!;
  const device = req.headers.get('X-QA-Device');
  return {
    actor: device === 'collaborator' ? fixture.actors[1] : fixture.actor,
    installationId:
      device === 'first'
        ? fixture.installationIds[0]
        : fixture.installationIds[1],
  };
}
function setup(seed = true) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T12:01:00Z'));
  for (const value of Object.values(ports))
    if (typeof value === 'function') value.mockReset();
  ports.enabled = true;
  f = makeDeviceReservationFixture();
  const fixture = f;
  if (seed) fixture.seedProposal();
  const db = {
    prepare(sql: string) {
      const statement = fixture.db.prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: (string | number | null)[]) => {
        const bound = bind(...values);
        const first = bound.first.bind(bound);
        bound.first = async <T>() => {
          observedFirstReads.push(sql);
          if (
            finalGate &&
            sql.includes('r.receipt_json IS NULL') &&
            sql.includes('AS allowed')
          ) {
            const hook = finalGate;
            finalGate = null;
            await hook();
          }
          return first<T>();
        };
        return bound;
      };
      return statement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const queries = statements as unknown as { sql: string }[];
      if (
        fault &&
        queries.some((q) =>
          q.sql.startsWith('INSERT INTO action_engine_quote_reservations('),
        )
      ) {
        const action = fault;
        fault = null;
        if (action === 'country') fixture.gates.countryUs();
        else fixture.adapter.failNext(action);
      }
      return fixture.db.batch(statements);
    },
  } as unknown as D1Database;
  ports.database.mockReturnValue(db);
  ports.authority.mockImplementation(async (req: Request) => {
    const value = identity(req);
    return fixture.authority(value.actor, value.installationId);
  });
  ports.access.mockResolvedValue(fixture.access);
  ports.load.mockImplementation(async (req: Request) => {
    const value = identity(req);
    return fixture.loaded(value.actor, value.installationId);
  });
  ports.session.mockImplementation(
    async (req: Request): Promise<DeviceSessionContext> => {
      const value = identity(req);
      return {
        organizationId: value.actor.organizationId,
        userId: value.actor.userId,
        installationId: value.installationId,
        organizationName: 'Synthetic company',
        role: 'owner',
        subscriptionId: 'sub_synthetic',
        sessionId: 'synthetic-session',
        entitlementValidUntil: 2_000_000_000,
      };
    },
  );
  const input = {
    sourceId: fixture.context.source.id,
    proposalId: fixture.proposal.id,
  };
  return {
    fixture,
    db,
    input,
    run: (device = 'first') =>
      reserveDeviceSupportQuote(request(device), input),
  };
}
function count(table: string) {
  return Number(f!.sql.prepare(`SELECT count(*) n FROM ${table}`).get()?.n);
}
afterEach(() => {
  f?.close();
  f = undefined;
  fault = null;
  finalGate = null;
  observedFirstReads.length = 0;
  vi.useRealTimers();
});

suite('private authenticated draft execution reservation', () => {
  it('reserves server-owned IDs and the exact plan/source/binding in one actual batch', async () => {
    const x = setup(),
      result = await x.run();
    expect(result.state).toBe('reserved');
    if (result.state !== 'reserved') throw Error('Expected reserved');
    expect(result.actor).toEqual(x.fixture.actor);
    expect(result.installationId).toBe(x.fixture.installationIds[0]);
    expect(hash(result.canonicalPlanJson)).toBe(result.proposal.fingerprint);
    expect(JSON.parse(result.canonicalPlanJson)).toEqual(result.proposal.plan);
    expect(hash(JSON.stringify(result.source))).toBe(
      result.binding.sourceCanonicalSha256,
    );
    expect(result.binding.resourcesSha256).toBe(
      x.fixture.publication.resourcesHash,
    );
    expect(result.binding.planningPublication.snapshotId).toBe(
      x.fixture.publication.snapshotId,
    );
    expect(result.reservation.customerId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.reservation.quoteId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.reservation.receipt).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(count('action_engine_quote_reservations')).toBe(1);
    expect(count('action_engine_quote_reservation_bindings')).toBe(1);
    expect(count('action_engine_quote_publication_evidence')).toBe(0);
    const mutation = x.fixture.adapter.batches.find((batch) =>
      batch.some((q) =>
        q.startsWith('INSERT INTO action_engine_quote_reservations('),
      ),
    );
    expect(
      mutation?.some((q) =>
        q.startsWith('INSERT INTO action_engine_quote_reservation_bindings('),
      ),
    ).toBe(true);
    expect(count('action_engine_atomic_assertions')).toBe(0);
    // No historical/read-only await may follow the final full admission read.
    expect(observedFirstReads.at(-1)).toContain('r.receipt_json IS NULL');
    expect(observedFirstReads.at(-1)).toContain('write_enabled=1');
    expect(observedFirstReads.at(-1)).toContain('source_revision=?');
  });
  it('replays an unconfirmed reservation with the same IDs only under fresh progression permission', async () => {
    const x = setup(),
      first = await x.run(),
      second = await x.run();
    expect(second).toEqual(first);
    expect(count('action_engine_quote_reservations')).toBe(1);
    expect(count('action_engine_quote_events')).toBe(2);
  });
  for (const device of ['second', 'collaborator'])
    it(`returns only held to another ${device}, without disclosing execution IDs or legacy receipts`, async () => {
      const x = setup(false);
      x.fixture.base.seed();
      x.fixture.sql
        .prepare(
          'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=?',
        )
        .run(
          JSON.stringify(x.fixture.native.receipt),
          x.fixture.native.reservation.createdAt + 30,
        );
      expect(await x.run(device)).toEqual({
        state: 'held',
        proposalId: x.input.proposalId,
      });
      expect(ports.load).not.toHaveBeenCalled();
      expect(ports.session).not.toHaveBeenCalled();
    });
  it('serializes concurrent devices on two real SQLite connections into one permanent owner', async () => {
    const x = setup();
    const connection = x.fixture.connect();
    const second = x.fixture.databaseFor(connection);
    ports.database.mockReturnValueOnce(x.db).mockReturnValueOnce(second.db);
    const results = await Promise.all([x.run(), x.run('second')]);
    expect(results.map((r) => r.state).sort()).toEqual(['held', 'reserved']);
    expect(count('action_engine_quote_reservations')).toBe(1);
    expect(count('action_engine_quote_reservation_bindings')).toBe(1);
    expect(count('action_engine_quote_events')).toBe(2);
  });
  for (const action of ['lost', 'rollback'] as const)
    it(`recovers a ${action} reservation response conservatively`, async () => {
      const x = setup();
      fault = action;
      await expect(x.run()).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      expect(count('action_engine_quote_reservations')).toBe(
        action === 'lost' ? 1 : 0,
      );
      const prior = x.fixture.sql
        .prepare(
          'SELECT id,customer_id,quote_id FROM action_engine_quote_reservations',
        )
        .get();
      const result = await x.run();
      expect(result.state).toBe('reserved');
      if (result.state !== 'reserved') throw Error('Expected reserved');
      if (prior)
        expect(result.reservation).toMatchObject({
          id: prior.id,
          customerId: prior.customer_id,
          quoteId: prior.quote_id,
        });
      expect(count('action_engine_quote_reservations')).toBe(1);
      expect(count('action_engine_quote_events')).toBe(2);
    });
  for (const confirm of [true, false])
    it(`recovers canonical proof with receipt already confirmed=${confirm} without loading a current context`, async () => {
      const x = setup(false),
        seeded = await x.fixture.seedConfirmedEvidence(confirm);
      ports.enabled = false;
      x.fixture.gates.writeEnabled(false);
      x.fixture.gates.sourceRevision('edited-source');
      x.fixture.gates.catalogueRevision('edited-catalogue');
      ports.load.mockRejectedValue(Error('Old context must not be loaded'));
      expect(await x.run()).toEqual({
        state: 'confirmed',
        receipt: seeded.receipt,
      });
      expect(ports.load).not.toHaveBeenCalled();
      expect(count('action_engine_quote_publication_evidence')).toBe(1);
    });
  it('refuses an owned legacy receipt before loading current resources', async () => {
    const x = setup(false);
    x.fixture.base.seed();
    x.fixture.sql
      .prepare(
        'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=?',
      )
      .run(
        JSON.stringify(x.fixture.native.receipt),
        x.fixture.native.reservation.createdAt + 30,
      );
    await expect(x.run()).rejects.toMatchObject({ code: 'review_required' });
    expect(ports.load).not.toHaveBeenCalled();
  });
  it('refuses a legacy reservation without its original binding', async () => {
    const x = setup(false);
    x.fixture.base.seed(false);
    await expect(x.run()).rejects.toMatchObject({ code: 'review_required' });
    expect(ports.load).not.toHaveBeenCalled();
  });
  for (const gate of ['source', 'catalogue', 'consent', 'pilot'] as const)
    it(`returns a bounded recovery-only selector after an owned reservation and changed ${gate}`, async () => {
      const x = setup(),
        first = await x.run();
      if (first.state !== 'reserved') throw Error('Expected reserved');
      if (gate === 'source') x.fixture.gates.sourceRevision('changed');
      if (gate === 'catalogue') x.fixture.gates.catalogueRevision('changed');
      if (gate === 'consent') x.fixture.gates.writeEnabled(false);
      if (gate === 'pilot') ports.enabled = false;
      expect(await x.run()).toEqual({
        state: 'recovery_required',
        proposalId: x.input.proposalId,
        reservationId: first.reservation.id,
        fingerprint: first.proposal.fingerprint,
      });
      expect(count('action_engine_quote_reservations')).toBe(1);
      expect(count('action_engine_quote_events')).toBe(2);
    });
  for (const gate of ['source', 'catalogue', 'consent', 'admission'] as const)
    it(`never returns a write input when ${gate} changes during its last admission await`, async () => {
      const x = setup();
      finalGate = () => {
        if (gate === 'source')
          x.fixture.gates.sourceRevision('changed-at-final-gate');
        if (gate === 'catalogue')
          x.fixture.gates.catalogueRevision('changed-at-final-gate');
        if (gate === 'consent') x.fixture.gates.writeEnabled(false);
        if (gate === 'admission') x.fixture.gates.authorityRevision(2);
      };
      const result = await x.run();
      const stored = x.fixture.sql
        .prepare('SELECT id,fingerprint FROM action_engine_quote_reservations')
        .get();
      expect(result).toEqual({
        state: 'recovery_required',
        proposalId: x.input.proposalId,
        reservationId: stored?.id,
        fingerprint: stored?.fingerprint,
      });
      expect(count('action_engine_quote_reservations')).toBe(1);
      expect(count('action_engine_quote_events')).toBe(2);
    });
  it('rejects a competing legacy receipt at the final gate rather than supplying a second write input', async () => {
    const x = setup();
    finalGate = () => {
      const row = x.fixture.sql
        .prepare(
          'SELECT customer_id,quote_id,created_at FROM action_engine_quote_reservations',
        )
        .get()!;
      const receipt = {
        ...x.fixture.native.receipt,
        customerId: row.customer_id,
        quoteId: row.quote_id,
      };
      x.fixture.sql
        .prepare(
          'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=?',
        )
        .run(JSON.stringify(receipt), Number(row.created_at) + 30);
    };
    await expect(x.run()).rejects.toMatchObject({ code: 'review_required' });
    expect(count('action_engine_quote_reservations')).toBe(1);
    expect(count('action_engine_quote_publication_evidence')).toBe(0);
  });
  for (const gate of ['authority', 'source', 'country'] as const)
    it(`does not disclose recovery selectors when ${gate} read access is revoked at the final gate`, async () => {
      const x = setup();
      finalGate = () => {
        if (gate === 'authority') x.fixture.gates.authorityAllowed(false);
        if (gate === 'source') x.fixture.gates.sourceAllowed(false);
        if (gate === 'country') x.fixture.gates.countryUs();
      };
      await expect(x.run()).rejects.toMatchObject({ code: 'forbidden' });
      expect(count('action_engine_quote_reservations')).toBe(1);
    });
  it('keeps failure of the final SQL admission read distinct from recovery or success', async () => {
    const x = setup();
    finalGate = () => {
      throw Error('PRIVATE_FINAL_SQL_FAILURE');
    };
    await expect(x.run()).rejects.toMatchObject({
      code: 'service_unavailable',
      message: 'service_unavailable',
    });
    expect(count('action_engine_quote_reservations')).toBe(1);
  });
  it('does not treat a missing proposal as an unreserved opportunity', async () => {
    const x = setup(false);
    await expect(x.run()).rejects.toMatchObject({ code: 'invalid_record' });
    expect(ports.load).not.toHaveBeenCalled();
    expect(count('action_engine_quote_reservations')).toBe(0);
  });
  for (const at of ['success', 'failure'] as const)
    it(`rejects a permission revoked during context ${at}`, async () => {
      const x = setup();
      ports.load.mockImplementation(async () => {
        const value = await x.fixture.loaded();
        x.fixture.gates.authorityAllowed(false);
        if (at === 'failure') throw Error('Private upstream message');
        return value;
      });
      await expect(x.run()).rejects.toMatchObject({ code: 'forbidden' });
      expect(count('action_engine_quote_reservations')).toBe(0);
    });
  for (const gate of ['source', 'catalogue', 'admission'] as const)
    it(`rejects changed ${gate} facts after context capture and before reservation`, async () => {
      const x = setup();
      ports.load.mockImplementation(async () => {
        const value = await x.fixture.loaded();
        if (gate === 'source') x.fixture.gates.sourceRevision('changed');
        if (gate === 'catalogue') x.fixture.gates.catalogueRevision('changed');
        if (gate === 'admission') x.fixture.gates.authorityRevision(2);
        return value;
      });
      await expect(x.run()).rejects.toThrow();
      expect(count('action_engine_quote_reservations')).toBe(0);
    });
  it('keeps a network/service failure distinct from an absent or stale reservation', async () => {
    const x = setup();
    await x.run();
    ports.load.mockRejectedValue(Error('PRIVATE_STORAGE_DETAIL'));
    await expect(x.run()).rejects.toMatchObject({
      code: 'service_unavailable',
      message: 'service_unavailable',
    });
    expect(count('action_engine_quote_reservations')).toBe(1);
  });
  for (const at of ['initial', 'reserve-batch'] as const)
    it(`rejects a US intention at ${at} through the real country guards`, async () => {
      const x = setup();
      if (at === 'initial') x.fixture.gates.countryUs();
      else fault = 'country';
      await expect(x.run()).rejects.toMatchObject({ code: 'forbidden' });
      expect(count('action_engine_quote_reservations')).toBe(0);
      expect(count('action_engine_quote_reservation_bindings')).toBe(0);
    });
  it('rejects a corrupt stored fingerprint without reserving', async () => {
    const x = setup(false);
    (x.fixture.proposal as { fingerprint: string }).fingerprint = 'f'.repeat(
      64,
    );
    x.fixture.seedProposal();
    await expect(x.run()).rejects.toMatchObject({ code: 'invalid_record' });
    expect(count('action_engine_quote_reservations')).toBe(0);
  });
  for (const point of ['\ud800', '\udfff'])
    it(`refuses a lone surrogate ${point.charCodeAt(0).toString(16)} before supplying a Serde input`, async () => {
      const x = setup();
      ports.load.mockImplementation(async () => {
        const value = await x.fixture.loaded();
        return {
          ...value,
          context: {
            ...value.context,
            source: {
              ...value.context.source,
              body: value.context.source.body + '\n' + point,
            },
          },
        };
      });
      await expect(x.run()).rejects.toMatchObject({ code: 'review_required' });
      expect(count('action_engine_quote_reservations')).toBe(0);
    });
  it('captures request headers and selectors before authentication awaits', async () => {
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
    const pending = reserveDeviceSupportQuote(req, x.input);
    x.input.proposalId = 'changed';
    req.headers.set('X-QA-Device', 'second');
    release!();
    const result = await pending;
    expect(result.state).toBe('reserved');
    if (result.state === 'reserved')
      expect(result.installationId).toBe(x.fixture.installationIds[0]);
  });
  it('rejects extra fields and accessors without evaluating them or authenticating', async () => {
    const x = setup();
    await expect(
      reserveDeviceSupportQuote(request(), {
        ...x.input,
        actor: x.fixture.actor,
      } as DeviceQuoteReservationInput),
    ).rejects.toThrow();
    let calls = 0;
    await expect(
      reserveDeviceSupportQuote(request(), {
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
  it('refuses a mismatched planning authentication instead of returning another workspace input', async () => {
    const x = setup();
    ports.load.mockImplementation(async () => {
      const value = await x.fixture.loaded();
      return {
        ...value,
        admission: { ...value.admission, userId: 'another-user' },
      };
    });
    await expect(x.run()).rejects.toThrow();
    expect(count('action_engine_quote_reservations')).toBe(0);
  });
  it('does not let a revoked delegation recover a proven receipt', async () => {
    const x = setup(false);
    await x.fixture.seedConfirmedEvidence();
    x.fixture.gates.sourceAllowed(false);
    await expect(x.run()).rejects.toMatchObject({ code: 'forbidden' });
    expect(ports.load).not.toHaveBeenCalled();
  });
});
