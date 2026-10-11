import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  createD1QuoteIntake,
  quotePreparationInput,
  quotePreparationInputFingerprint,
  captureQuotePreparationClaim,
  captureQuotePreparationResult,
  QUOTE_PREPARATION_LEASE_SECONDS,
} from './intake';
import { quotePlanFingerprint } from './fingerprint';
import {
  QuotePreparationError,
  type QuotePreparationClaim,
  type QuotePreparationFence,
  type QuotePreparationFenceRequest,
  type QuotePreparationIntake,
} from './intake-types';
import type { ActionActor, QuotePlan, QuotePlanningContext } from './types';

// SQLite policy fixtures prove only the supplied predicate's atomic evaluation.
// They do not implement production subscriptions, sessions or Support intake.
const actor: ActionActor = { organizationId: 'company-a', userId: 'owner-a' };
function context(): QuotePlanningContext {
  return {
    organizationId: actor.organizationId,
    revision: 'context-v1',
    currency: 'CHF',
    source: {
      id: 'ticket-a',
      revision: 'source-v1',
      organizationId: actor.organizationId,
      senderEmail: 'client@example.ch',
      senderName: 'Camille Exemple',
      subject: 'Devis',
      body: '3 radiateurs',
    },
    customers: [
      {
        id: 'customer-a',
        revision: 'customer-v1',
        organizationId: actor.organizationId,
        name: 'Camille Exemple',
        email: 'client@example.ch',
        archived: false,
      },
    ],
    articles: [
      {
        id: 'article-a',
        revision: 'article-v1',
        organizationId: actor.organizationId,
        name: 'Radiateur',
        description: 'radiateurs',
        sku: 'RAD-A',
        unit: 'pièce',
        currency: 'CHF',
        unitPriceCents: 19900,
        taxRateBp: 810,
        archived: false,
      },
    ],
  };
}
function plan(): QuotePlan {
  return {
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId: actor.organizationId,
    sourceId: 'ticket-a',
    sourceRevision: 'source-v1',
    contextRevision: 'context-v1',
    status: 'ready',
    reasons: [],
    customer: {
      kind: 'existing',
      id: 'customer-a',
      revision: 'customer-v1',
      name: 'Camille Exemple',
    },
    title: 'Devis',
    currency: 'CHF',
    lines: [
      {
        articleId: 'article-a',
        articleRevision: 'article-v1',
        description: 'Radiateur',
        unit: 'pièce',
        quantityMilli: 3000,
        unitPriceCents: 19900,
        taxRateBp: 810,
        netCents: 59700,
        evidence: '3 radiateurs',
      },
    ],
    netCents: 59700,
    confidence: 0.99,
    requiresHumanValidation: true,
  };
}

type Fault = 'rollback' | 'lost';
function adapter(sql: DatabaseSync) {
  let fault: Fault | null = null;
  type Statement = {
    sql: string;
    values: SQLInputValue[];
    bind: (...values: SQLInputValue[]) => Statement;
  };
  const statements: string[][] = [];
  const execute = (statement: Statement) => {
    const native = sql.prepare(statement.sql);
    if (/^\s*SELECT\b|\bRETURNING\s+\*/i.test(statement.sql))
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
  };
  const database = {
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
    async batch(batch: Statement[]) {
      const failure = fault;
      fault = null;
      statements.push(batch.map((statement) => statement.sql));
      sql.exec('BEGIN');
      let committed = false;
      try {
        const results = batch.map(execute);
        if (failure === 'rollback') throw Error('Synthetic rollback');
        sql.exec('COMMIT');
        committed = true;
        if (failure === 'lost')
          throw Error('Synthetic lost response after commit');
        return results;
      } catch (error) {
        if (!committed) sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return {
    database: database as unknown as Pick<D1Database, 'prepare' | 'batch'>,
    statements,
    failNext(value: Fault) {
      fault = value;
    },
  };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'zentra-quote-intake-'));
  const file = join(directory, 'intake.sqlite'),
    connections: DatabaseSync[] = [];
  const connect = () => {
    const sql = new DatabaseSync(file);
    sql.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
    connections.push(sql);
    return sql;
  };
  const sql = connect();
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + name, import.meta.url), 'utf8'),
    );
  sql.exec(`CREATE TABLE qa_intake_rights(organization_id TEXT,user_id TEXT,active INTEGER,PRIMARY KEY(organization_id,user_id));
    CREATE TABLE qa_intake_context(organization_id TEXT PRIMARY KEY,source_revision TEXT,context_revision TEXT,context_hash TEXT);
    INSERT INTO qa_intake_rights VALUES('company-a','owner-a',1),('company-b','owner-b',1);`);
  const input = await quotePreparationInput(context());
  sql
    .prepare('INSERT INTO qa_intake_context VALUES(?,?,?,?)')
    .run(
      input.organizationId,
      input.sourceRevision,
      input.contextRevision,
      input.contextHash,
    );
  let clock = 2_000_000_000,
    sequence = 0;
  let hook: ((request: QuotePreparationFenceRequest) => Promise<void>) | null =
    null;
  const fence: QuotePreparationFence = async (request) => {
    let predicate =
      'EXISTS(SELECT 1 FROM qa_intake_rights WHERE organization_id=? AND user_id=? AND active=1)';
    const bindings: (string | number | null)[] = [
      request.actor.organizationId,
      request.actor.userId,
    ];
    if (request.operation !== 'read' && request.operation !== 'uncertain') {
      const expected = 'input' in request ? request.input : request.claim.input;
      predicate +=
        ' AND EXISTS(SELECT 1 FROM qa_intake_context WHERE organization_id=? AND source_revision=? AND context_revision=? AND context_hash=?)';
      bindings.push(
        expected.organizationId,
        expected.sourceRevision,
        expected.contextRevision,
        expected.contextHash,
      );
    }
    if (hook) await hook(request);
    return { sql: predicate, bindings };
  };
  const create = (connection = sql, selectedFence = fence) => {
    const transport = adapter(connection);
    return {
      ...transport,
      intake: createD1QuoteIntake(transport.database, selectedFence, {
        nowSeconds: () => clock,
        newUuid: () =>
          `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
      }),
    };
  };
  return {
    sql,
    input,
    create,
    fence,
    connect,
    setTime(value: number) {
      clock = value;
    },
    setHook(value: typeof hook) {
      hook = value;
    },
    counts() {
      const reader = connect(),
        count = (table: string) =>
          Number(reader.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
      return {
        intake: count('action_engine_quote_intake'),
        events: count('action_engine_quote_intake_events'),
        assertions: count('action_engine_atomic_assertions'),
        proposals: count('action_engine_quote_proposals'),
      };
    },
    close(connection: DatabaseSync) {
      connection.close();
      connections.splice(connections.indexOf(connection), 1);
    },
    cleanup() {
      for (const connection of connections) connection.close();
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep))
        throw Error('Unexpected fixture path');
      rmSync(target, { force: true, recursive: true });
    },
  };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(() => {
  try {
    expect(f.counts().assertions).toBe(0);
  } finally {
    f.cleanup();
  }
});
async function claim(intake: QuotePreparationIntake, input = f.input) {
  const result = await intake.claim(actor, input);
  expect(result.state).toBe('owned');
  if (result.state !== 'owned') throw Error('Expected fixture claim');
  return result.claim;
}
async function finish(
  intake: QuotePreparationIntake,
  owned: QuotePreparationClaim,
  p = plan(),
) {
  return intake.finish(actor, owned, p, await quotePlanFingerprint(p));
}
async function error(attempt: Promise<unknown>, code: string) {
  await expect(attempt).rejects.toBeInstanceOf(QuotePreparationError);
  await expect(attempt).rejects.toMatchObject({ code, message: code });
}
function barrier(count: number) {
  let arrived = 0;
  let release!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return async () => {
    if (++arrived === count) release();
    await promise;
  };
}

describe('closed input and preparation identity', () => {
  it('canonicalizes catalogue order and captures the complete context before hashing', async () => {
    const original = context();
    const c = {
      ...original,
      articles: [
        ...original.articles,
        { ...original.articles[0], id: 'article-z', name: 'Autre' },
      ],
    };
    const first = await quotePreparationInput(c);
    expect(
      await quotePreparationInput({
        ...c,
        articles: [...c.articles].reverse(),
      }),
    ).toEqual(first);
    const pending = quotePreparationInput(c);
    Object.assign(c.articles[0], { unitPriceCents: 1 });
    Object.assign(c.source, { body: 'Changed after capture' });
    expect(await pending).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
  });
  it.each(['mail', 'price', 'archive', 'customer'])(
    'includes changed %s facts even without changed revision labels',
    async (kind) => {
      const c = structuredClone(context());
      if (kind === 'mail')
        Object.assign(c.source, { body: '3 radiateurs différents' });
      if (kind === 'price') Object.assign(c.articles[0], { unitPriceCents: 1 });
      if (kind === 'archive') Object.assign(c.articles[0], { archived: true });
      if (kind === 'customer')
        Object.assign(c.customers[0], { email: 'another@example.ch' });
      expect((await quotePreparationInput(c)).contextHash).not.toBe(
        f.input.contextHash,
      );
    },
  );
  it('creates one stable source identity and holds concurrent owners', async () => {
    const a = f.create(),
      b = f.create(f.connect()),
      meet = barrier(2);
    f.setHook(async (request) => {
      if (request.operation === 'claim') await meet();
    });
    const results = await Promise.all([
      a.intake.claim(actor, f.input),
      b.intake.claim(actor, f.input),
    ]);
    expect(results.map((result) => result.state).sort()).toEqual([
      'held',
      'owned',
    ]);
    expect(f.counts()).toEqual({
      intake: 1,
      events: 1,
      assertions: 0,
      proposals: 0,
    });
  });
  it('reclaims only an expired preparing lease and preserves the source identity', async () => {
    const { intake } = f.create(),
      first = await claim(intake);
    expect(await intake.claim(actor, f.input)).toEqual({
      state: 'held',
      sourceId: f.input.sourceId,
    });
    f.setTime(first.leaseUntil);
    const second = await claim(intake);
    expect(second.id).toBe(first.id);
    expect(second.inputHash).toBe(first.inputHash);
    expect(second.ownerToken).not.toBe(first.ownerToken);
    expect(second.leaseUntil).toBe(
      first.leaseUntil + QUOTE_PREPARATION_LEASE_SECONDS,
    );
    await error(intake.start(actor, first), 'held');
    expect(f.counts().events).toBe(2);
  });
  it('starts a new lease after an awaited claim fence rather than before it', async () => {
    const { intake } = f.create();
    f.setHook(async (request) => {
      if (request.operation === 'claim') f.setTime(2_000_000_500);
    });
    expect((await claim(intake)).leaseUntil).toBe(
      2_000_000_500 + QUOTE_PREPARATION_LEASE_SECONDS,
    );
  });
  it.each(['source', 'context', 'facts'])(
    'refuses a changed %s input instead of silently making another proposal',
    async (kind) => {
      const { intake } = f.create();
      await claim(intake);
      const c = context();
      if (kind === 'source') Object.assign(c.source, { revision: 'source-v2' });
      if (kind === 'context') Object.assign(c, { revision: 'context-v2' });
      if (kind === 'facts') Object.assign(c.articles[0], { unitPriceCents: 1 });
      await error(
        intake.claim(actor, await quotePreparationInput(c)),
        'conflict',
      );
      expect(f.counts().intake).toBe(1);
    },
  );
  it('does not reveal records or create a claim under a foreign tenant', async () => {
    const { intake } = f.create();
    await claim(intake);
    const foreign = { organizationId: 'company-b', userId: 'owner-b' };
    await error(intake.read(foreign, f.input), 'forbidden');
    await error(intake.claim(foreign, f.input), 'forbidden');
  });
});

describe('one-shot start and durable closed result', () => {
  it('two starts on the same private claim authorize exactly one caller', async () => {
    const a = f.create(),
      b = f.create(f.connect()),
      owned = await claim(a.intake),
      meet = barrier(2);
    f.setHook(async (request) => {
      if (request.operation === 'start') await meet();
    });
    const results = await Promise.allSettled([
      a.intake.start(actor, owned),
      b.intake.start(actor, owned),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    if (!rejected || rejected.status !== 'rejected')
      throw Error('Missing rejected start');
    expect(rejected.reason).toMatchObject({ code: 'uncertain' });
    expect(f.counts().events).toBe(2);
  });
  it('never transfers or restarts a started or uncertain request after arbitrary time', async () => {
    const { intake } = f.create(),
      owned = await claim(intake);
    await intake.start(actor, owned);
    await error(intake.start(actor, owned), 'uncertain');
    f.setTime(2_100_000_000);
    expect(await intake.claim(actor, f.input)).toEqual({
      state: 'uncertain',
      sourceId: f.input.sourceId,
    });
    await intake.uncertain(actor, owned);
    await intake.uncertain(actor, owned);
    expect(await intake.claim(actor, f.input)).toEqual({
      state: 'uncertain',
      sourceId: f.input.sourceId,
    });
    await error(finish(intake, owned), 'uncertain');
    expect(f.counts()).toEqual({
      intake: 1,
      events: 3,
      assertions: 0,
      proposals: 0,
    });
  });
  it('finishes and replays a structured plan without changing immutable result or audit', async () => {
    const { intake } = f.create(),
      owned = await claim(intake);
    await intake.start(actor, owned);
    const result = await finish(intake, owned);
    expect(await finish(intake, owned)).toEqual(result);
    expect(await intake.claim(actor, f.input)).toEqual({
      state: 'finished',
      result,
    });
    expect(result.inputHash).toBe(
      await quotePreparationInputFingerprint(f.input),
    );
    expect(Object.isFrozen(result.plan.lines[0])).toBe(true);
    await error(
      finish(intake, owned, { ...plan(), title: 'Another valid title' }),
      'conflict',
    );
    expect(f.counts()).toEqual({
      intake: 1,
      events: 3,
      assertions: 0,
      proposals: 0,
    });
  });
  it('retains a legitimate deterministic needs_review result without starting a provider', async () => {
    const { intake } = f.create(),
      owned = await claim(intake);
    const p: QuotePlan = {
      ...plan(),
      status: 'needs_review',
      reasons: ['missing_quantity'],
      lines: [],
      netCents: 0,
      confidence: null,
    };
    const result = await finish(intake, owned, p);
    expect(result.plan.status).toBe('needs_review');
    expect(f.counts().events).toBe(2);
  });
  it('never makes a provider_unavailable infrastructure failure an immutable result', async () => {
    const { intake } = f.create(),
      owned = await claim(intake);
    await intake.start(actor, owned);
    const p: QuotePlan = {
      ...plan(),
      status: 'needs_review',
      reasons: ['provider_unavailable'],
      lines: [],
      netCents: 0,
      confidence: null,
    };
    await error(finish(intake, owned, p), 'invalid_record');
    expect((await intake.read(actor, f.input))?.state).toBe('started');
    await intake.uncertain(actor, owned);
    expect(f.counts().proposals).toBe(0);
  });
  it('allows the original started owner to finish late while a preparing owner must retain its lease', async () => {
    const { intake } = f.create(),
      owned = await claim(intake);
    f.setTime(owned.leaseUntil);
    await error(finish(intake, owned), 'held');
    const replacement = await claim(intake);
    await intake.start(actor, replacement);
    f.setTime(replacement.leaseUntil + 100);
    expect((await finish(intake, replacement)).plan).toEqual(plan());
  });
  it.each(['start', 'finish'] as const)(
    'refuses %s when the preparing lease expires during the awaited fence',
    async (operation) => {
      const { intake } = f.create(),
        owned = await claim(intake),
        before = f.counts();
      f.setHook(async (request) => {
        if (request.operation === operation) f.setTime(owned.leaseUntil);
      });
      await error(
        operation === 'start'
          ? intake.start(actor, owned)
          : finish(intake, owned),
        'held',
      );
      expect((await intake.read(actor, f.input))?.state).toBe('preparing');
      expect(f.counts()).toEqual(before);
    },
  );
  it('returns the exact finished result after close/reopen and never resumes uncertain HTTP', async () => {
    const { intake } = f.create(),
      owned = await claim(intake);
    await intake.start(actor, owned);
    await intake.uncertain(actor, owned);
    f.close(f.sql);
    const reopened = f.create(f.connect()).intake;
    expect((await reopened.read(actor, f.input))?.state).toBe('uncertain');
    expect(await reopened.claim(actor, f.input)).toEqual({
      state: 'uncertain',
      sourceId: f.input.sourceId,
    });
    await error(reopened.start(actor, owned), 'uncertain');
  });
  it('persists finished JSON byte-for-byte through a new factory and connection', async () => {
    const { intake } = f.create(),
      owned = await claim(intake),
      result = await finish(intake, owned);
    const raw = f.sql
      .prepare('SELECT result_json FROM action_engine_quote_intake')
      .get()?.result_json;
    f.close(f.sql);
    const connection = f.connect(),
      reopened = f.create(connection).intake;
    expect(await reopened.claim(actor, f.input)).toEqual({
      state: 'finished',
      result,
    });
    expect(
      connection
        .prepare('SELECT result_json FROM action_engine_quote_intake')
        .get()?.result_json,
    ).toBe(raw);
  });
});

describe('transactional fences, lost responses and hostile captures', () => {
  it.each(['claim', 'start', 'finish', 'uncertain'] as const)(
    'revocation during the %s fence prevents the complete mutation and event',
    async (operation) => {
      const { intake } = f.create();
      let owned: QuotePreparationClaim | null = null;
      if (operation !== 'claim') owned = await claim(intake);
      if (operation === 'uncertain') await intake.start(actor, owned!);
      const before = f.counts();
      f.setHook(async (request) => {
        if (request.operation === operation)
          f.sql.exec('UPDATE qa_intake_rights SET active=0');
      });
      const attempt =
        operation === 'claim'
          ? intake.claim(actor, f.input)
          : operation === 'start'
            ? intake.start(actor, owned!)
            : operation === 'finish'
              ? finish(intake, owned!)
              : intake.uncertain(actor, owned!);
      await error(attempt, 'forbidden');
      expect(f.counts()).toEqual(before);
    },
  );
  it('denied historical reads are forbidden rather than absence', async () => {
    const { intake } = f.create();
    const owned = await claim(intake);
    await finish(intake, owned);
    f.sql.exec('UPDATE qa_intake_rights SET active=0');
    await error(intake.read(actor, f.input), 'forbidden');
    await error(intake.claim(actor, f.input), 'forbidden');
  });
  it.each(['claim', 'start', 'finish'] as const)(
    'distinguishes a lost %s COMMIT response from a safe fresh retry',
    async (operation) => {
      const transport = f.create();
      let owned: QuotePreparationClaim | null = null;
      if (operation !== 'claim') owned = await claim(transport.intake);
      if (operation === 'finish') await transport.intake.start(actor, owned!);
      f.setHook(async (request) => {
        if (request.operation === operation) {
          f.setHook(null);
          transport.failNext('lost');
        }
      });
      const attempt =
        operation === 'claim'
          ? transport.intake.claim(actor, f.input)
          : operation === 'start'
            ? transport.intake.start(actor, owned!)
            : finish(transport.intake, owned!);
      await error(attempt, 'service_unavailable');
      if (operation === 'claim')
        expect(await transport.intake.claim(actor, f.input)).toEqual({
          state: 'held',
          sourceId: f.input.sourceId,
        });
      if (operation === 'start')
        await error(transport.intake.start(actor, owned!), 'uncertain');
      if (operation === 'finish')
        expect((await transport.intake.claim(actor, f.input)).state).toBe(
          'finished',
        );
      expect(f.counts().intake).toBe(1);
    },
  );
  it.each(['claim', 'start', 'finish'] as const)(
    'rolls back the %s identity/state and its audit together',
    async (operation) => {
      const transport = f.create();
      let owned: QuotePreparationClaim | null = null;
      if (operation !== 'claim') owned = await claim(transport.intake);
      const before = f.counts();
      f.setHook(async (request) => {
        if (request.operation === operation) {
          f.setHook(null);
          transport.failNext('rollback');
        }
      });
      const attempt =
        operation === 'claim'
          ? transport.intake.claim(actor, f.input)
          : operation === 'start'
            ? transport.intake.start(actor, owned!)
            : finish(transport.intake, owned!);
      await error(attempt, 'service_unavailable');
      expect(f.counts()).toEqual(before);
      if (operation === 'claim')
        expect((await transport.intake.claim(actor, f.input)).state).toBe(
          'owned',
        );
      if (operation === 'start') await transport.intake.start(actor, owned!);
      if (operation === 'finish')
        expect((await finish(transport.intake, owned!)).plan).toEqual(plan());
    },
  );
  it('fails closed without a fence and masks a rejecting private fence', async () => {
    expect(() =>
      createD1QuoteIntake(
        adapter(f.sql).database,
        undefined as unknown as QuotePreparationFence,
      ),
    ).toThrow('forbidden');
    const { intake } = f.create(f.sql, async () => {
      throw Error('Private source and SQL details');
    });
    await error(intake.claim(actor, f.input), 'service_unavailable');
  });
  it('captures a claim and result without executing getters', async () => {
    const { intake } = f.create(),
      owned = await claim(intake);
    let getters = 0;
    const hostile = Object.defineProperty({ ...owned }, 'ownerToken', {
      enumerable: true,
      get() {
        getters++;
        return owned.ownerToken;
      },
    });
    expect(() => captureQuotePreparationClaim(hostile, actor, f.input)).toThrow(
      'invalid_record',
    );
    const hostileResult = Object.defineProperty(
      { inputHash: owned.inputHash, plan: plan() },
      'fingerprint',
      {
        enumerable: true,
        get() {
          getters++;
          return '0'.repeat(64);
        },
      },
    );
    expect(() => captureQuotePreparationResult(hostileResult, f.input)).toThrow(
      'invalid_record',
    );
    expect(getters).toBe(0);
  });
  it('captures caller-owned nested values before an awaited finish fence', async () => {
    const { intake } = f.create(),
      owned = await claim(intake),
      p = structuredClone(plan()),
      expected = structuredClone(p);
    const fingerprint = await quotePlanFingerprint(p);
    f.setHook(async (request) => {
      if (request.operation === 'finish') {
        Object.assign(p.lines[0], { unitPriceCents: 1 });
        Object.assign(p, { title: 'Changed' });
      }
    });
    expect((await intake.finish(actor, owned, p, fingerprint)).plan).toEqual(
      expected,
    );
  });
  it('refuses fake claim and result hashes and does not mutate state', async () => {
    const { intake } = f.create(),
      owned = await claim(intake);
    await error(
      intake.start(actor, { ...owned, inputHash: '0'.repeat(64) }),
      'invalid_record',
    );
    await error(
      intake.finish(actor, owned, plan(), '0'.repeat(64)),
      'invalid_record',
    );
    expect((await intake.read(actor, f.input))?.state).toBe('preparing');
  });
});

describe('independent SQL state and immutable audit guards', () => {
  it('blocks transfer/restart of started rows and immutable replacement even with recursive triggers off', async () => {
    const { intake } = f.create(),
      owned = await claim(intake);
    await intake.start(actor, owned);
    f.sql.exec('PRAGMA recursive_triggers=OFF');
    const before = f.sql
      .prepare('SELECT * FROM action_engine_quote_intake')
      .all();
    for (const statement of [
      "UPDATE action_engine_quote_intake SET state='preparing',started_at=NULL",
      "UPDATE action_engine_quote_intake SET owner_token='ffffffff-ffff-4fff-8fff-ffffffffffff'",
      "UPDATE action_engine_quote_intake SET context_hash='0000000000000000000000000000000000000000000000000000000000000000'",
      'DELETE FROM action_engine_quote_intake',
      'INSERT OR REPLACE INTO action_engine_quote_intake SELECT * FROM action_engine_quote_intake',
    ]) {
      expect(() => f.sql.exec(statement)).toThrow(/action_engine_intake_/);
      expect(
        f.sql.prepare('SELECT * FROM action_engine_quote_intake').all(),
      ).toEqual(before);
    }
  });
  it('keeps finished results and append-only event rows immutable without mail text or monetary values', async () => {
    const { intake } = f.create(),
      owned = await claim(intake);
    await intake.start(actor, owned);
    await finish(intake, owned);
    const rows = () =>
      f.sql
        .prepare(
          'SELECT * FROM action_engine_quote_intake_events ORDER BY event_type',
        )
        .all();
    const before = rows();
    expect(before.map((row) => row.event_type)).toEqual([
      'claimed',
      'finished',
      'started',
    ]);
    expect(JSON.stringify(before)).not.toContain('radiateur');
    expect(JSON.stringify(before)).not.toContain('19900');
    for (const statement of [
      'UPDATE action_engine_quote_intake SET result_json=result_json',
      "UPDATE action_engine_quote_intake SET state='started',finished_at=NULL,result_json=NULL,result_fingerprint=NULL",
      'DELETE FROM action_engine_quote_intake_events',
      "UPDATE action_engine_quote_intake_events SET actor_user_id='other'",
      'INSERT OR REPLACE INTO action_engine_quote_intake_events SELECT * FROM action_engine_quote_intake_events',
    ])
      expect(() => f.sql.exec(statement)).toThrow(/action_engine_intake_/);
    expect(rows()).toEqual(before);
    expect((await intake.read(actor, f.input))?.state).toBe('finished');
    expect(f.counts().proposals).toBe(0);
  });
});
