import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { DecisionInput, ProviderResult } from '@/lib/automation/types';
import type { DeviceSessionContext } from '@/lib/account';
import type { DeviceQuoteAuthority } from './production-admission';
import type {
  ActionActor,
  ActionAdmission,
  QuotePlanningContext,
} from './types';

// Actual local D1/workerd runs the unmodified A1/A2/publication SQL and the real
// preparation/intake/ledger/source/historical/published-fence composition.
// QA account session/rate limiter, authority rows, the published-context loader
// and provider are explicit synthetic boundaries: no real authentication,
// commercial admission, PG/archive or JEV claim.
const state = vi.hoisted(() => ({
  db: null as Pick<D1Database, 'prepare' | 'batch'> | null,
  enabled: true,
  authority: vi.fn(),
  load: vi.fn(),
  key: vi.fn(),
  providerFactory: vi.fn(),
  decide: vi.fn(),
  preflight: vi.fn(),
  preflightCas: vi.fn(),
  session: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock('@/lib/account', () => ({
  requireDeviceSession: state.session,
  enforceSyncRateLimit: state.rateLimit,
  accountNoStoreHeaders: () => ({
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => {
    if (!state.db) throw Error('Local D1 not initialized');
    return state.db;
  },
}));
vi.mock('@/lib/automation/config', () => ({ decisionApiKey: state.key }));
vi.mock('./production-admission', () => ({
  createDeviceQuoteAuthority: state.authority,
}));
vi.mock('./published-context', () => ({
  loadDeviceQuotePlanningContext: state.load,
}));
vi.mock('./publication-gateway', () => ({
  publicationCoordinationEnabled: () => state.enabled,
}));
vi.mock('./provider', () => ({
  createQuoteDecisionProvider: state.providerFactory,
}));

import { prepareDeviceSupportQuote } from './device-preparation';
import { readPreparedDeviceQuote } from './device-proposal-recovery';
import { readSupportQuoteSource } from './support-source';
import { createPublicationLedger } from './publication-ledger';
import { ActionEngineError } from './types';
import { handleDeviceQuoteWork } from './device-work-handler';

type Runtime = {
  getD1Database(name: string): Promise<D1Database>;
  dispose(): Promise<void>;
};
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler'))(
  'miniflare',
) as {
  Miniflare: new (options: Record<string, unknown>) => Runtime;
};
let runtime: Runtime;
let db: D1Database;
let sequence = 0;
let fixture: Awaited<ReturnType<typeof seed>>;
const installationId = '00000000-0000-4000-8000-000000001201';

function request() {
  return new Request('http://localhost/private-quote-preparation', {
    headers: {
      Authorization: 'Bearer synthetic-device-session-not-a-real-token',
      Origin: 'tauri://localhost',
    },
  });
}

function workRequest(body: unknown) {
  return new Request('http://localhost/private-quote-work', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer synthetic-device-session-not-a-real-token',
      Origin: 'tauri://localhost',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function decision(input: DecisionInput): ProviderResult {
  return {
    provider: 'fixture',
    model: 'fixture',
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    answers: Object.fromEntries(
      Object.entries(input.questions).map(([id, question]) => {
        const choice =
          id === 'intent'
            ? 'quote'
            : Object.keys(question.options).find((key) => key !== 'none')!;
        return [
          id,
          {
            choice,
            confidence: 0.99,
            probabilities: Object.fromEntries(
              Object.keys(question.options).map((key) => [
                key,
                key === choice ? 1 : 0,
              ]),
            ),
          },
        ];
      }),
    ),
  };
}

async function applyMigration(name: string) {
  const sql = readFileSync(
    new URL('../../drizzle/' + name, import.meta.url),
    'utf8',
  );
  if (sql.includes('--> statement-breakpoint')) {
    for (const statement of sql.split('--> statement-breakpoint'))
      if (statement.trim()) await db.prepare(statement).run();
    return;
  }
  // 0102's complete trigger bodies end with an unindented END;. Interior CASE
  // expressions must not be split into separate statements by their semicolons.
  let statement = '',
    trigger = false;
  for (const line of sql.split(/\r?\n/)) {
    statement += line + '\n';
    if (/^\s*--/.test(line)) continue;
    if (/^CREATE TRIGGER\b/.test(line)) trigger = true;
    if (trigger ? line === 'END;' : /;\s*$/.test(line)) {
      await db.prepare(statement).run();
      statement = '';
      trigger = false;
    }
  }
  if (statement.trim()) throw Error('Unconsumed local migration statement');
}

async function seed() {
  const suffix = String(++sequence),
    actor: ActionActor = Object.freeze({
      organizationId: 'qa-preparation-company-' + suffix,
      userId: 'qa-preparation-owner-' + suffix,
    }),
    workspaceId = 'qa-preparation-workspace-' + suffix,
    connectionId = 'qa-preparation-connection-' + suffix,
    sourceId = 'qa-preparation-source-' + suffix,
    admission: ActionAdmission = Object.freeze({
      ...actor,
      revision: 'qa-admission-one',
      automationActive: true,
      mayPrepareQuote: true,
    }),
    envelope = {
      externalId: 'mail-' + suffix,
      senderEmail: 'camille@example.test',
      senderName: 'Camille Exemple',
      subject: 'Devis radiateurs',
      body: 'Installer 3 radiateurs',
      version: 'mail-version-one',
      groupId: null,
      agentId: null,
      closed: false,
    };
  await db.batch([
    db
      .prepare('INSERT INTO qa_preparation_authority VALUES(?,?,1,1,?)')
      .bind(actor.organizationId, actor.userId, admission.revision),
    db
      .prepare("INSERT INTO support_workspaces VALUES(?,?,'review')")
      .bind(workspaceId, actor.userId),
    db
      .prepare('INSERT INTO organization_members VALUES(?,?,?,?,NULL)')
      .bind(
        actor.organizationId,
        actor.userId,
        'owner',
        'owner-' + suffix + '@example.test',
      ),
    db
      .prepare('INSERT INTO support_gestion_links VALUES(?,?,1,?,100)')
      .bind(workspaceId, actor.organizationId, actor.userId),
    db
      .prepare("INSERT INTO support_connections VALUES(?,?,1,100,'infomaniak')")
      .bind(connectionId, workspaceId),
    db
      .prepare(`INSERT INTO support_tickets
        (id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,revision,created_at,state,decision_json)
        VALUES(?,?,?,?,?,?,?,?,1,100,'ready','{"category":"quote"}')`)
      .bind(
        sourceId,
        workspaceId,
        connectionId,
        envelope.externalId,
        envelope.subject,
        envelope.body,
        JSON.stringify(envelope),
        'a'.repeat(64),
      ),
  ]);
  const predicate = (purpose: 'read' | 'progression') => ({
    sql: `EXISTS(SELECT 1 FROM qa_preparation_authority WHERE organization_id=? AND user_id=? AND allowed=1${purpose === 'progression' ? ' AND progression=1' : ''})`,
    bindings: [actor.organizationId, actor.userId],
  });
  const authorizeRead = async () => {
    const gate = predicate('read');
    const row = await db
      .prepare(`SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END AS allowed`)
      .bind(...gate.bindings)
      .first<{ allowed: number }>();
    if (row?.allowed !== 1) throw new ActionEngineError('forbidden');
  };
  const preflight = async () => {
    const gate = predicate('progression');
    const row = await db
      .prepare(`SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END AS allowed`)
      .bind(...gate.bindings)
      .first<{ allowed: number }>();
    if (row?.allowed !== 1) throw new ActionEngineError('forbidden');
    return admission;
  };
  const authority: DeviceQuoteAuthority = Object.freeze({
    actor,
    installationId,
    predicate,
    authorizeRead,
    preflight: state.preflight,
    preflightCas: state.preflightCas,
  });
  state.preflight.mockImplementation(preflight);
  state.preflightCas.mockImplementation(async () => {
    await preflight();
    return {
      admission,
      predicate: () => ({
        sql: 'EXISTS(SELECT 1 FROM qa_preparation_authority WHERE organization_id=? AND user_id=? AND allowed=1 AND progression=1 AND revision=?)',
        bindings: [actor.organizationId, actor.userId, admission.revision],
      }),
    };
  });
  state.authority.mockResolvedValue(authority);
  const sourceCapability = await readSupportQuoteSource(actor, sourceId);
  const publication = await createPublicationLedger(db).begin({
    organizationId: actor.organizationId,
    snapshotId: crypto.randomUUID(),
    installationId,
    userId: actor.userId,
    baseRevision: 0,
    archiveSha256: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64),
    sizeBytes: 1000,
  });
  await createPublicationLedger(db).settle(publication.attempt, {
    committed: true,
    revision: 1,
    snapshotId: publication.attempt.snapshotId,
  });
  // This is a synthetic trusted loader output, not bytes from a PG/native ZIP.
  const context: QuotePlanningContext = {
    organizationId: actor.organizationId,
    revision: 'qa-current-context-' + suffix,
    currency: 'CHF',
    source: sourceCapability.source,
    customers: [],
    articles: [
      {
        id: 'radiator',
        revision: 'qa-article-one',
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
  state.load.mockResolvedValue({
    context,
    admission,
    sourceCapability,
    publication: {
      organizationId: actor.organizationId,
      snapshotId: publication.attempt.snapshotId,
      revision: 1,
      baseRevision: 0,
      archiveSha256: publication.attempt.archiveSha256,
      manifestSha256: publication.attempt.manifestSha256,
      resourcesHash: 'd'.repeat(64),
      firstChunkSha256: 'e'.repeat(64),
      sidecarSha256: 'f'.repeat(64),
    },
  });
  return { actor, authority, sourceId, workspaceId, connectionId, context };
}

type TracedStatement = D1PreparedStatement & {
  inner: D1PreparedStatement;
  query: string;
};
function instrumentBatches(
  matches: RegExp,
  afterCommit: () => void | Promise<void>,
): Pick<D1Database, 'prepare' | 'batch'> {
  let pending = true;
  function wrap(inner: D1PreparedStatement, query: string): TracedStatement {
    return {
      inner,
      query,
      bind(...values: unknown[]) {
        return wrap(inner.bind(...values), query);
      },
      first: inner.first.bind(inner),
      all: inner.all.bind(inner),
      run: inner.run.bind(inner),
      raw: inner.raw.bind(inner),
    } as TracedStatement;
  }
  return {
    prepare: (query: string) => wrap(db.prepare(query), query),
    async batch<T>(statements: D1PreparedStatement[]) {
      const traced = statements as TracedStatement[];
      const outcome = await db.batch<T>(traced.map((s) => s.inner));
      if (pending && traced.some((s) => matches.test(s.query))) {
        pending = false;
        await afterCommit();
      }
      return outcome;
    },
  };
}
function loseAcknowledgement(matches: RegExp) {
  state.db = instrumentBatches(matches, () => {
    throw Error('Synthetic lost acknowledgement after the real D1 commit');
  });
}
function clearWorkCalls() {
  state.preflight.mockClear();
  state.preflightCas.mockClear();
  state.load.mockClear();
  state.key.mockClear();
  state.providerFactory.mockClear();
  state.decide.mockClear();
}
function expectNoNewPreparation() {
  expect(state.preflight).not.toHaveBeenCalled();
  expect(state.preflightCas).not.toHaveBeenCalled();
  expect(state.load).not.toHaveBeenCalled();
  expect(state.key).not.toHaveBeenCalled();
  expect(state.providerFactory).not.toHaveBeenCalled();
  expect(state.decide).not.toHaveBeenCalled();
}
async function counts() {
  return db
    .prepare(`SELECT
    (SELECT count(*) FROM action_engine_quote_proposals WHERE organization_id=?) AS proposals,
    (SELECT count(*) FROM action_engine_quote_intake WHERE organization_id=?) AS intakes,
    (SELECT count(*) FROM action_engine_quote_events WHERE organization_id=? AND event_type='proposal_saved') AS saved,
    (SELECT count(*) FROM action_engine_quote_intake_events WHERE organization_id=? AND event_type='finished') AS finished,
    (SELECT count(*) FROM action_engine_quote_reservations WHERE organization_id=?) AS reservations,
    (SELECT count(*) FROM action_engine_atomic_assertions) AS assertions`)
    .bind(...Array<string>(5).fill(fixture.actor.organizationId))
    .first();
}
async function advanceHead() {
  const p = await createPublicationLedger(db).begin({
    organizationId: fixture.actor.organizationId,
    snapshotId: crypto.randomUUID(),
    installationId,
    userId: fixture.actor.userId,
    baseRevision: 1,
    archiveSha256: '1'.repeat(64),
    manifestSha256: '2'.repeat(64),
    sizeBytes: 1200,
  });
  await createPublicationLedger(db).settle(p.attempt, {
    committed: true,
    revision: 2,
    snapshotId: p.attempt.snapshotId,
  });
}

beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script:
      'export default { fetch() { return new Response("Local preparation QA"); } }',
    d1Databases: ['DB'],
    compatibilityDate: '2026-05-15',
  });
  db = await runtime.getD1Database('DB');
  state.db = db;
  for (const name of [
    '0099_action_engine_quote_ledger.sql',
    '0100_action_engine_quote_intake.sql',
    '0102_action_engine_publication_ledger.sql',
  ])
    await applyMigration(name);
  // Narrow QA fixtures let the REAL delegated-source reader run against D1.
  // They deliberately do not stand in for the production account/payment schema.
  for (const sql of [
    'CREATE TABLE qa_preparation_authority(organization_id TEXT PRIMARY KEY,user_id TEXT,allowed INTEGER,progression INTEGER,revision TEXT)',
    'CREATE TABLE support_workspaces(id TEXT PRIMARY KEY,owner_id TEXT,mode TEXT)',
    'CREATE TABLE support_members(workspace_id TEXT,email TEXT,role TEXT)',
    'CREATE TABLE organization_members(organization_id TEXT,user_id TEXT,role TEXT,email TEXT,revoked_at INTEGER)',
    'CREATE TABLE support_gestion_links(workspace_id TEXT PRIMARY KEY,organization_id TEXT,enabled INTEGER,connected_by TEXT,created_at INTEGER)',
    'CREATE TABLE support_connections(id TEXT PRIMARY KEY,workspace_id TEXT,active INTEGER,created_at INTEGER,provider TEXT)',
    'CREATE TABLE support_tickets(id TEXT PRIMARY KEY,workspace_id TEXT,connection_id TEXT,external_id TEXT,subject TEXT,body TEXT,source_json TEXT,fingerprint TEXT,revision INTEGER,created_at INTEGER,state TEXT,decision_json TEXT)',
    'CREATE TABLE international_workspace_creation_intents(organization_id TEXT,country_code TEXT)',
  ])
    await db.prepare(sql).run();
  for (const name of [
    '0103_action_engine_quote_publication_evidence.sql',
    '0104_action_engine_quote_evidence_preconfirmation.sql',
    '0105_action_engine_support_work_index.sql',
  ])
    await applyMigration(name);
}, 20000);
beforeEach(async () => {
  vi.resetAllMocks();
  state.db = db;
  state.enabled = true;
  state.key.mockResolvedValue('synthetic-platform-key');
  state.decide.mockImplementation(async (input: DecisionInput) =>
    decision(input),
  );
  state.providerFactory.mockImplementation(
    (key: string, authorize: () => Promise<void>) => {
      if (key !== 'synthetic-platform-key') throw Error('Unexpected QA key');
      return {
        decide: async (input: DecisionInput) => {
          await authorize();
          return state.decide(input);
        },
      };
    },
  );
  fixture = await seed();
  // The handler sees this exact synthetic account; durable permission checks
  // still use the real D1 predicates constructed by the QA authority above.
  const session: DeviceSessionContext = {
    ...fixture.actor,
    organizationName: 'QA preparation company',
    subscriptionId: 'qa-subscription',
    role: 'owner',
    sessionId: 'qa-session',
    installationId,
    entitlementValidUntil: 4102444800,
  };
  state.session.mockResolvedValue(session);
  state.rateLimit.mockResolvedValue(undefined);
});
afterAll(async () => {
  if (runtime) await runtime.dispose();
});

it('replays the same real proposal before current head, source, QA progression or key lookup', async () => {
  const original = await prepareDeviceSupportQuote(request(), fixture.sourceId);
  expect(original.plan).toMatchObject({ status: 'ready', netCents: 59700 });
  expect(state.decide).toHaveBeenCalledTimes(1);
  const originalCounts = await counts();
  await advanceHead();
  await db.batch([
    db
      .prepare("UPDATE support_workspaces SET mode='paused' WHERE id=?")
      .bind(fixture.workspaceId),
    db
      .prepare(
        'UPDATE qa_preparation_authority SET progression=0,revision=? WHERE organization_id=?',
      )
      .bind('qa-new-admission', fixture.actor.organizationId),
    db
      .prepare('UPDATE support_connections SET active=0 WHERE id=?')
      .bind(fixture.connectionId),
    db
      .prepare(
        'UPDATE support_tickets SET body=?,source_json=?,revision=revision+1 WHERE id=?',
      )
      .bind(
        'Edited source after preparation',
        '{"closed":true}',
        fixture.sourceId,
      ),
  ]);
  state.load.mockRejectedValue(new ActionEngineError('stale_plan'));
  state.key.mockRejectedValue(
    Error('No platform key after the first preparation'),
  );
  clearWorkCalls();
  await expect(
    prepareDeviceSupportQuote(request(), fixture.sourceId),
  ).resolves.toEqual(original);
  expectNoNewPreparation();
  expect(await counts()).toEqual(originalCounts);
  expect(originalCounts).toEqual({
    proposals: 1,
    intakes: 1,
    saved: 1,
    finished: 1,
    reservations: 0,
    assertions: 0,
  });
});

it('recovers the committed proposal after its actual D1 save ACK is lost and the head advances', async () => {
  loseAcknowledgement(/INSERT\s+INTO\s+action_engine_quote_proposals\b/i);
  await expect(
    prepareDeviceSupportQuote(request(), fixture.sourceId),
  ).rejects.toMatchObject({ code: 'service_unavailable' });
  expect(state.decide).toHaveBeenCalledTimes(1);
  const saved = await db
    .prepare(
      'SELECT id,fingerprint,plan_json FROM action_engine_quote_proposals WHERE organization_id=? AND source_id=?',
    )
    .bind(fixture.actor.organizationId, fixture.sourceId)
    .first<{ id: string; fingerprint: string; plan_json: string }>();
  expect(saved).not.toBeNull();
  await advanceHead();
  state.db = db;
  state.load.mockRejectedValue(new ActionEngineError('stale_plan'));
  state.key.mockRejectedValue(Error('Key removed after the commit'));
  clearWorkCalls();
  const recovered = await prepareDeviceSupportQuote(
    request(),
    fixture.sourceId,
  );
  expect(recovered).toEqual({
    id: saved!.id,
    organizationId: fixture.actor.organizationId,
    fingerprint: saved!.fingerprint,
    plan: JSON.parse(saved!.plan_json),
  });
  expectNoNewPreparation();
  expect(await counts()).toEqual({
    proposals: 1,
    intakes: 1,
    saved: 1,
    finished: 1,
    reservations: 0,
    assertions: 0,
  });
});

it('saves a finished D1 intake after a lost finish ACK without resolving the now missing provider key', async () => {
  loseAcknowledgement(
    /UPDATE\s+action_engine_quote_intake[\s\S]*state\s*=\s*'finished'/i,
  );
  await expect(
    prepareDeviceSupportQuote(request(), fixture.sourceId),
  ).rejects.toMatchObject({ code: 'service_unavailable' });
  expect(state.decide).toHaveBeenCalledTimes(1);
  expect(await counts()).toEqual({
    proposals: 0,
    intakes: 1,
    saved: 0,
    finished: 1,
    reservations: 0,
    assertions: 0,
  });
  const finished = await db
    .prepare(
      'SELECT result_json FROM action_engine_quote_intake WHERE organization_id=? AND source_id=?',
    )
    .bind(fixture.actor.organizationId, fixture.sourceId)
    .first<{ result_json: string }>();
  state.db = db;
  state.key.mockRejectedValue(Error('Key removed before result recovery'));
  clearWorkCalls();
  const recovered = await prepareDeviceSupportQuote(
    request(),
    fixture.sourceId,
  );
  expect(recovered.plan).toEqual(JSON.parse(finished!.result_json));
  expect(state.load).toHaveBeenCalledTimes(1);
  expect(state.key).not.toHaveBeenCalled();
  expect(state.providerFactory).not.toHaveBeenCalled();
  expect(state.decide).not.toHaveBeenCalled();
  const firstCounts = await counts();
  clearWorkCalls();
  await expect(
    prepareDeviceSupportQuote(request(), fixture.sourceId),
  ).resolves.toEqual(recovered);
  expectNoNewPreparation();
  expect(await counts()).toEqual(firstCounts);
  expect(firstCounts).toEqual({
    proposals: 1,
    intakes: 1,
    saved: 1,
    finished: 1,
    reservations: 0,
    assertions: 0,
  });
});

it.each(['authority', 'delegation', 'country'] as const)(
  'does not disclose a durable proposal after the current %s fence closes',
  async (closed) => {
    await prepareDeviceSupportQuote(request(), fixture.sourceId);
    const original = await counts();
    if (closed === 'authority')
      await db
        .prepare(
          'UPDATE qa_preparation_authority SET allowed=0 WHERE organization_id=?',
        )
        .bind(fixture.actor.organizationId)
        .run();
    else if (closed === 'delegation')
      await db
        .prepare(
          'UPDATE support_gestion_links SET enabled=0 WHERE workspace_id=?',
        )
        .bind(fixture.workspaceId)
        .run();
    else
      await db
        .prepare(
          "INSERT INTO international_workspace_creation_intents VALUES(?,'US')",
        )
        .bind(fixture.actor.organizationId)
        .run();
    clearWorkCalls();
    await expect(
      prepareDeviceSupportQuote(request(), fixture.sourceId),
    ).rejects.toMatchObject({
      code: closed === 'delegation' ? 'invalid_context' : 'forbidden',
    });
    expectNoNewPreparation();
    expect(await counts()).toEqual(original);
  },
);

it('refuses finishing or saving when Support pauses during the provider await without changing source bytes', async () => {
  const before = await db
    .prepare(
      'SELECT body,source_json,fingerprint,revision FROM support_tickets WHERE id=?',
    )
    .bind(fixture.sourceId)
    .first();
  state.decide.mockImplementation(async (input: DecisionInput) => {
    await db
      .prepare("UPDATE support_workspaces SET mode='paused' WHERE id=?")
      .bind(fixture.workspaceId)
      .run();
    return decision(input);
  });
  await expect(
    prepareDeviceSupportQuote(request(), fixture.sourceId),
  ).rejects.toMatchObject({ code: 'forbidden' });
  expect(state.decide).toHaveBeenCalledTimes(1);
  expect(
    await db
      .prepare(
        'SELECT body,source_json,fingerprint,revision FROM support_tickets WHERE id=?',
      )
      .bind(fixture.sourceId)
      .first(),
  ).toEqual(before);
  const stopped = await counts();
  expect(stopped).toEqual({
    proposals: 0,
    intakes: 1,
    saved: 0,
    finished: 0,
    reservations: 0,
    assertions: 0,
  });
  expect(
    await db
      .prepare(
        'SELECT state FROM action_engine_quote_intake WHERE organization_id=? AND source_id=?',
      )
      .bind(fixture.actor.organizationId, fixture.sourceId)
      .first(),
  ).toEqual({ state: 'started' });
  // Read access is historical, while another attempt must not call the model
  // or silently release a durable started attempt after the pause.
  await expect(
    readPreparedDeviceQuote(fixture.authority, fixture.sourceId),
  ).resolves.toBeNull();
  clearWorkCalls();
  await expect(
    prepareDeviceSupportQuote(request(), fixture.sourceId),
  ).rejects.toMatchObject({ code: 'forbidden' });
  expect(state.decide).not.toHaveBeenCalled();
  expect(state.key).not.toHaveBeenCalled();
  expect(await counts()).toEqual(stopped);
});

it('rechecks delegated source access after the real historical ledger batch returns', async () => {
  await prepareDeviceSupportQuote(request(), fixture.sourceId);
  const original = await counts();
  state.db = instrumentBatches(
    /SELECT[\s\S]+FROM\s+action_engine_quote_proposals\b/i,
    async () => {
      await db
        .prepare(
          'UPDATE support_gestion_links SET enabled=0 WHERE workspace_id=?',
        )
        .bind(fixture.workspaceId)
        .run();
    },
  );
  clearWorkCalls();
  await expect(
    readPreparedDeviceQuote(fixture.authority, fixture.sourceId),
  ).rejects.toMatchObject({ code: 'forbidden' });
  expectNoNewPreparation();
  expect(await counts()).toEqual(original);
});

it('discovers then prepares through the real work handler with a closed summary and no reservation', async () => {
  const discovered = await handleDeviceQuoteWork(
    workRequest({
      schemaVersion: 1,
      operation: 'discover',
      limit: 20,
      cursor: null,
    }),
  );
  expect(discovered.status).toBe(200);
  expect(discovered.headers.get('Cache-Control')).toBe('no-store, max-age=0');
  expect(await discovered.json()).toEqual({
    schemaVersion: 1,
    state: 'discovered',
    sourceIds: [fixture.sourceId],
    nextCursor: null,
  });
  expectNoNewPreparation();

  const prepared = await handleDeviceQuoteWork(
    workRequest({
      schemaVersion: 1,
      operation: 'prepare',
      sourceId: fixture.sourceId,
    }),
  );
  expect(prepared.status).toBe(200);
  const stored = await db
    .prepare(`SELECT id,fingerprint
    FROM action_engine_quote_proposals WHERE organization_id=? AND source_id=?`)
    .bind(fixture.actor.organizationId, fixture.sourceId)
    .first<{ id: string; fingerprint: string }>();
  expect(stored).not.toBeNull();
  // Exact equality excludes the source body, plan, customer and price fields.
  expect(await prepared.json()).toEqual({
    schemaVersion: 1,
    state: 'prepared',
    sourceId: fixture.sourceId,
    proposalId: stored!.id,
    fingerprint: stored!.fingerprint,
    disposition: 'ready',
    reasons: [],
    requiresHumanValidation: true,
  });
  expect(state.decide).toHaveBeenCalledTimes(1);
  expect(state.session).toHaveBeenCalledTimes(2);
  expect(state.rateLimit).toHaveBeenCalledTimes(2);
  expect(state.rateLimit.mock.calls[0].slice(1)).toEqual([
    'action-engine-device-work',
    fixture.actor.organizationId + ':' + installationId,
    500,
  ]);
  expect(await counts()).toEqual({
    proposals: 1,
    intakes: 1,
    saved: 1,
    finished: 1,
    reservations: 0,
    assertions: 0,
  });
});

it('replays the handler summary after the real proposal commit loses its ACK without another decision', async () => {
  loseAcknowledgement(/INSERT\s+INTO\s+action_engine_quote_proposals\b/i);
  const lost = await handleDeviceQuoteWork(
    workRequest({
      schemaVersion: 1,
      operation: 'prepare',
      sourceId: fixture.sourceId,
    }),
  );
  expect(lost.status).toBe(503);
  expect(await lost.json()).toEqual({
    schemaVersion: 1,
    state: 'error',
    code: 'service_unavailable',
    message:
      'Automation est momentanément indisponible. Vos données sont conservées.',
  });
  expect(state.decide).toHaveBeenCalledTimes(1);
  const saved = await db
    .prepare(`SELECT id,fingerprint
    FROM action_engine_quote_proposals WHERE organization_id=? AND source_id=?`)
    .bind(fixture.actor.organizationId, fixture.sourceId)
    .first<{ id: string; fingerprint: string }>();
  expect(saved).not.toBeNull();
  const original = await counts();
  await advanceHead();
  state.db = db;
  state.load.mockRejectedValue(new ActionEngineError('stale_plan'));
  state.key.mockRejectedValue(Error('Synthetic key removed after commit'));
  clearWorkCalls();
  const recovered = await handleDeviceQuoteWork(
    workRequest({
      schemaVersion: 1,
      operation: 'prepare',
      sourceId: fixture.sourceId,
    }),
  );
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual({
    schemaVersion: 1,
    state: 'prepared',
    sourceId: fixture.sourceId,
    proposalId: saved!.id,
    fingerprint: saved!.fingerprint,
    disposition: 'ready',
    reasons: [],
    requiresHumanValidation: true,
  });
  expectNoNewPreparation();
  expect(await counts()).toEqual(original);
  expect(original).toEqual({
    proposals: 1,
    intakes: 1,
    saved: 1,
    finished: 1,
    reservations: 0,
    assertions: 0,
  });
});

it('does not disclose discovery selectors or a saved handler summary after delegated access is revoked', async () => {
  const prepared = await handleDeviceQuoteWork(
    workRequest({
      schemaVersion: 1,
      operation: 'prepare',
      sourceId: fixture.sourceId,
    }),
  );
  expect(prepared.status).toBe(200);
  const original = await counts();
  await db
    .prepare('UPDATE support_gestion_links SET enabled=0 WHERE workspace_id=?')
    .bind(fixture.workspaceId)
    .run();
  clearWorkCalls();
  const discovery = await handleDeviceQuoteWork(
    workRequest({
      schemaVersion: 1,
      operation: 'discover',
    }),
  );
  expect(discovery.status).toBe(403);
  expect(await discovery.json()).toEqual({
    schemaVersion: 1,
    state: 'error',
    code: 'forbidden',
    message:
      'Reconnectez votre compte ou vérifiez vos accès à cette entreprise.',
  });
  const replay = await handleDeviceQuoteWork(
    workRequest({
      schemaVersion: 1,
      operation: 'prepare',
      sourceId: fixture.sourceId,
    }),
  );
  expect(replay.status).toBe(409);
  expect(await replay.json()).toEqual({
    schemaVersion: 1,
    state: 'error',
    code: 'review_required',
    message: 'Cette demande doit être vérifiée. Vos données sont conservées.',
  });
  expectNoNewPreparation();
  expect(await counts()).toEqual(original);
});

it('hides unprepared work while Support is paused and refuses preparation before an intake or decision', async () => {
  await db
    .prepare("UPDATE support_workspaces SET mode='paused' WHERE id=?")
    .bind(fixture.workspaceId)
    .run();
  const discovery = await handleDeviceQuoteWork(
    workRequest({
      schemaVersion: 1,
      operation: 'discover',
    }),
  );
  expect(discovery.status).toBe(200);
  expect(await discovery.json()).toEqual({
    schemaVersion: 1,
    state: 'discovered',
    sourceIds: [],
    nextCursor: null,
  });
  expectNoNewPreparation();
  const prepared = await handleDeviceQuoteWork(
    workRequest({
      schemaVersion: 1,
      operation: 'prepare',
      sourceId: fixture.sourceId,
    }),
  );
  expect(prepared.status).toBe(403);
  expect(await prepared.json()).toEqual({
    schemaVersion: 1,
    state: 'error',
    code: 'forbidden',
    message:
      'Reconnectez votre compte ou vérifiez vos accès à cette entreprise.',
  });
  expect(state.decide).not.toHaveBeenCalled();
  expect(state.key).not.toHaveBeenCalled();
  expect(await counts()).toEqual({
    proposals: 0,
    intakes: 0,
    saved: 0,
    finished: 0,
    reservations: 0,
    assertions: 0,
  });
});

it('holds a concurrent handler preparation on the real D1 intake and later replays one proposal', async () => {
  let entered!: () => void, release!: () => void;
  const providerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const providerRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.decide.mockImplementation(async (input: DecisionInput) => {
    entered();
    await providerRelease;
    return decision(input);
  });
  const first = handleDeviceQuoteWork(
    workRequest({
      schemaVersion: 1,
      operation: 'prepare',
      sourceId: fixture.sourceId,
    }),
  );
  try {
    await Promise.race([
      providerEntered,
      first.then(() => {
        throw Error(
          'First preparation returned before reaching the synthetic provider',
        );
      }),
    ]);
    const concurrent = await handleDeviceQuoteWork(
      workRequest({
        schemaVersion: 1,
        operation: 'prepare',
        sourceId: fixture.sourceId,
      }),
    );
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toEqual({
      schemaVersion: 1,
      state: 'error',
      code: 'busy',
      message: 'Cette demande est déjà en cours de préparation.',
    });
    expect(state.decide).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual({
      proposals: 0,
      intakes: 1,
      saved: 0,
      finished: 0,
      reservations: 0,
      assertions: 0,
    });
  } finally {
    release();
  }
  const completed = await first;
  expect(completed.status).toBe(200);
  const summary: unknown = await completed.json();
  const original = await counts();
  clearWorkCalls();
  const replay = await handleDeviceQuoteWork(
    workRequest({
      schemaVersion: 1,
      operation: 'prepare',
      sourceId: fixture.sourceId,
    }),
  );
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(summary);
  expectNoNewPreparation();
  expect(await counts()).toEqual(original);
  expect(original).toEqual({
    proposals: 1,
    intakes: 1,
    saved: 1,
    finished: 1,
    reservations: 0,
    assertions: 0,
  });
}, 10000);
