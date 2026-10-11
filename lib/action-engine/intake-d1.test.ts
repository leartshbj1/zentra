import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createD1QuoteIntake } from './intake';
import { createD1QuoteLedger } from './ledger';
import { prepareQuoteProposal } from './engine';
import type { QuotePreparationFence } from './intake-types';
import type { QuoteLedgerFence } from './ledger-types';
import type {
  ActionActor,
  ActionAdmission,
  QuotePlanningContext,
  QuotePreparationPorts,
} from './types';
import type { DecisionInput } from '@/lib/automation/types';

const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler'))('miniflare');
let runtime: {
  getD1Database(name: string): Promise<D1Database>;
  dispose(): Promise<void>;
};
let db: D1Database;
const actor: ActionActor = {
  organizationId: 'qa-intake-company',
  userId: 'qa-intake-owner',
};
const admission: ActionAdmission = {
  ...actor,
  revision: 'qa-rights-v1',
  automationActive: true,
  mayPrepareQuote: true,
};
// Fictitious authority/context records test atomicity, not commercial access.
const intakeFence: QuotePreparationFence = async (request) => ({
  sql: 'EXISTS(SELECT 1 FROM qa_intake_rights WHERE organization_id=? AND user_id=? AND active=1)',
  bindings: [request.actor.organizationId, request.actor.userId],
});
const ledgerFence: QuoteLedgerFence = async (request) => ({
  sql: 'EXISTS(SELECT 1 FROM qa_intake_rights WHERE organization_id=? AND user_id=? AND active=1)',
  bindings: [request.actor.organizationId, request.actor.userId],
});
function context(sourceId: string): QuotePlanningContext {
  return {
    organizationId: actor.organizationId,
    revision: 'qa-catalogue-v1',
    currency: 'CHF',
    source: {
      id: sourceId,
      revision: 'qa-mail-v1',
      organizationId: actor.organizationId,
      senderEmail: 'camille@example.test',
      senderName: 'Camille Exemple',
      subject: 'Devis radiateurs',
      body: 'Installer 3 radiateurs',
    },
    customers: [],
    articles: [
      {
        id: 'radiator',
        revision: 'qa-article-v1',
        organizationId: actor.organizationId,
        name: 'Radiateur',
        description: 'radiateurs',
        sku: 'RAD-600',
        unit: 'pièce',
        currency: 'CHF',
        unitPriceCents: 19900,
        taxRateBp: 810,
        archived: false,
      },
    ],
  };
}
function decision(input: DecisionInput) {
  return {
    provider: 'fixture',
    model: 'fixture',
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    answers: Object.fromEntries(
      Object.entries(input.questions).map(([key, question]) => {
        const choice =
          key === 'intent'
            ? 'quote'
            : Object.keys(question.options).find((k) => k !== 'none')!;
        return [
          key,
          {
            choice,
            confidence: 0.99,
            probabilities: Object.fromEntries(
              Object.keys(question.options).map((k) => [
                k,
                k === choice ? 1 : 0,
              ]),
            ),
          },
        ];
      }),
    ),
  };
}
function ports(
  sourceId: string,
  intakeDb: Pick<D1Database, 'prepare' | 'batch'> = db,
): QuotePreparationPorts {
  const ledger = createD1QuoteLedger(db, ledgerFence);
  return {
    intake: createD1QuoteIntake(intakeDb, intakeFence),
    authorize: async () => admission,
    loadContext: async () => context(sourceId),
    findProposal: ledger.findProposal,
    saveProposal: ledger.saveProposal,
    provider: { decide: vi.fn(async (input) => decision(input)) },
  };
}

/** Lose an acknowledgement AFTER the actual D1 commit; never undo the write. */
function lostAcknowledgement(
  pattern: RegExp,
): Pick<D1Database, 'prepare' | 'batch'> {
  type Traced = D1PreparedStatement & {
    inner: D1PreparedStatement;
    sql: string;
  };
  let lose = true;
  function wrap(inner: D1PreparedStatement, sql: string): Traced {
    return {
      inner,
      sql,
      bind(...values: unknown[]) {
        return wrap(inner.bind(...values), sql);
      },
      first: inner.first.bind(inner),
      all: inner.all.bind(inner),
      run: inner.run.bind(inner),
      raw: inner.raw.bind(inner),
    } as Traced;
  }
  return {
    prepare(sql: string) {
      return wrap(db.prepare(sql), sql);
    },
    async batch(statements: D1PreparedStatement[]) {
      const traced = statements as Traced[];
      const result = await db.batch(traced.map((statement) => statement.inner));
      if (lose && traced.some((statement) => pattern.test(statement.sql))) {
        lose = false;
        throw Error('Private simulated lost D1 acknowledgement');
      }
      return result;
    },
  } as Pick<D1Database, 'prepare' | 'batch'>;
}

beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script:
      'export default { fetch() { return new Response("Local intake QA"); } }',
    d1Databases: ['DB'],
    compatibilityDate: '2026-05-15',
  });
  db = await runtime.getD1Database('DB');
  for (const file of [
    '0099_action_engine_quote_ledger.sql',
    '0100_action_engine_quote_intake.sql',
  ]) {
    const sql = readFileSync(
      new URL('../../drizzle/' + file, import.meta.url),
      'utf8',
    );
    for (const statement of sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  }
  await db
    .prepare(
      'CREATE TABLE qa_intake_rights(organization_id TEXT,user_id TEXT,active INTEGER)',
    )
    .run();
  await db
    .prepare('INSERT INTO qa_intake_rights VALUES(?,?,1)')
    .bind(actor.organizationId, actor.userId)
    .run();
}, 20000);
afterAll(async () => {
  if (runtime) await runtime.dispose();
});

it('serializes two complete preparations in actual D1 with one provider call and one proposal', async () => {
  const sourceId = 'qa-concurrent-mail',
    first = ports(sourceId),
    second = ports(sourceId);
  const outcomes = await Promise.allSettled([
    prepareQuoteProposal(actor, sourceId, first),
    prepareQuoteProposal(actor, sourceId, second),
  ]);
  expect(
    outcomes.filter((outcome) => outcome.status === 'fulfilled'),
  ).toHaveLength(1);
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  expect(
    rejected &&
      rejected.status === 'rejected' &&
      ['held', 'uncertain'].includes(rejected.reason.code),
  ).toBe(true);
  expect(
    vi.mocked(first.provider.decide).mock.calls.length +
      vi.mocked(second.provider.decide).mock.calls.length,
  ).toBe(1);
  const recovered = await prepareQuoteProposal(
    actor,
    sourceId,
    ports(sourceId),
  );
  expect(recovered.plan.status).toBe('ready');
  expect(
    await db
      .prepare(
        'SELECT count(*) n FROM action_engine_quote_proposals WHERE source_id=?',
      )
      .bind(sourceId)
      .first(),
  ).toEqual({ n: 1 });
  expect(
    await db
      .prepare(
        'SELECT count(*) n FROM action_engine_quote_intake WHERE source_id=?',
      )
      .bind(sourceId)
      .first(),
  ).toEqual({ n: 1 });
});

it('does not send HTTP when the started commit succeeded but its acknowledgement was lost', async () => {
  const sourceId = 'qa-lost-start',
    execution = ports(
      sourceId,
      lostAcknowledgement(
        /UPDATE\s+action_engine_quote_intake[\s\S]*state\s*=\s*'started'/i,
      ),
    );
  await expect(
    prepareQuoteProposal(actor, sourceId, execution),
  ).rejects.toMatchObject({ code: 'service_unavailable' });
  expect(execution.provider.decide).not.toHaveBeenCalled();
  const replay = ports(sourceId);
  const outcome = await prepareQuoteProposal(actor, sourceId, replay).catch(
    (error) => error,
  );
  expect(['held', 'uncertain']).toContain(outcome.code);
  expect(replay.provider.decide).not.toHaveBeenCalled();
  expect(
    await db
      .prepare('SELECT state FROM action_engine_quote_intake WHERE source_id=?')
      .bind(sourceId)
      .first(),
  ).toEqual({ state: 'started' });
});

it('recovers the finished plan after a lost result acknowledgement without another analysis', async () => {
  const sourceId = 'qa-lost-finish',
    execution = ports(
      sourceId,
      lostAcknowledgement(
        /UPDATE\s+action_engine_quote_intake[\s\S]*state\s*=\s*'finished'/i,
      ),
    );
  await expect(
    prepareQuoteProposal(actor, sourceId, execution),
  ).rejects.toMatchObject({ code: 'service_unavailable' });
  expect(execution.provider.decide).toHaveBeenCalledTimes(1);
  expect(
    await db
      .prepare(
        'SELECT count(*) n FROM action_engine_quote_proposals WHERE source_id=?',
      )
      .bind(sourceId)
      .first(),
  ).toEqual({ n: 0 });
  const replay = ports(sourceId);
  await expect(
    prepareQuoteProposal(actor, sourceId, replay),
  ).resolves.toMatchObject({ plan: { status: 'ready', netCents: 59700 } });
  expect(replay.provider.decide).not.toHaveBeenCalled();
  expect(
    await db
      .prepare(
        "SELECT count(*) n FROM action_engine_quote_intake_events WHERE event_type='finished' AND intake_id=(SELECT id FROM action_engine_quote_intake WHERE source_id=?)",
      )
      .bind(sourceId)
      .first(),
  ).toEqual({ n: 1 });
});

it('leaves no partial intake or events when the atomic authority predicate is false or NULL', async () => {
  for (const sql of ['0', 'NULL']) {
    const sourceId = 'qa-denied-' + sql,
      execution = ports(sourceId);
    execution.intake = createD1QuoteIntake(db, async () => ({
      sql,
      bindings: [],
    }));
    await expect(
      prepareQuoteProposal(actor, sourceId, execution),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(execution.provider.decide).not.toHaveBeenCalled();
    expect(
      await db
        .prepare(
          'SELECT count(*) n FROM action_engine_quote_intake WHERE source_id=?',
        )
        .bind(sourceId)
        .first(),
    ).toEqual({ n: 0 });
  }
  expect(
    await db
      .prepare('SELECT count(*) n FROM action_engine_atomic_assertions')
      .first(),
  ).toEqual({ n: 0 });
});
