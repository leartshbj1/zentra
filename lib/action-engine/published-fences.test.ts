import { DatabaseSync } from 'node:sqlite';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/runtime', () => ({
  database: () => {
    throw new Error('no database in this unit test');
  },
}));
import { planQuoteDraft } from './planner';
import { createPublishedQuoteFences } from './published-fences';
import type { DeviceQuoteAuthority } from './production-admission';
import type { QuotePreparationClaim } from './intake-types';
import type { QuoteLedgerPredicate } from './ledger-types';
import type { QuotePlanningContext, StoredQuoteProposal } from './types';

const actor = { organizationId: 'qa-company', userId: 'qa-owner' };
const admission = {
  ...actor,
  revision: 'admission-1',
  automationActive: true,
  mayPrepareQuote: true,
};
const installation = '30000000-0000-4000-8000-000000000001';
const context: QuotePlanningContext = {
  organizationId: actor.organizationId,
  revision: 'context-1',
  currency: 'CHF',
  source: {
    id: 'qa-mail',
    revision: 'source-1',
    organizationId: actor.organizationId,
    senderEmail: 'client@example.test',
    senderName: 'Camille Exemple',
    subject: 'Devis',
    body: '3 radiateurs',
  },
  customers: [],
  articles: [],
};
const publication = {
  organizationId: actor.organizationId,
  snapshotId: '10000000-0000-4000-8000-000000000001',
  revision: 1,
  baseRevision: 0,
  archiveSha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  firstChunkSha256: 'c'.repeat(64),
  sidecarSha256: 'd'.repeat(64),
  resourcesHash: 'e'.repeat(64),
};
let authority: DeviceQuoteAuthority,
  sourceActive: boolean,
  admissionActive: boolean;
let loaded: Parameters<typeof createPublishedQuoteFences>[2];
let cas: Parameters<typeof createPublishedQuoteFences>[1],
  stored: StoredQuoteProposal;

beforeEach(async () => {
  sourceActive = true;
  admissionActive = true;
  authority = {
    actor,
    installationId: installation,
    predicate: () => ({ sql: '1', bindings: [] }),
    preflight: async () => admission,
    preflightCas: async () => cas,
    authorizeRead: async () => undefined,
  };
  cas = {
    admission,
    predicate: () => ({ sql: admissionActive ? '1' : '0', bindings: [] }),
  };
  loaded = {
    context,
    publication,
    admission,
    sourceCapability: {
      source: context.source,
      revision: context.source.revision,
      workspaceId: 'qa-support-space',
      predicate: (purpose) => ({
        sql: purpose === 'read' || sourceActive ? '1' : '0',
        bindings: [],
      }),
    },
  };
  // Missing catalogue deliberately yields review without a provider call.
  const provider = {
    decide: vi.fn(async (): Promise<never> => {
      throw new Error('must not call a model');
    }),
  };
  const plan = await planQuoteDraft(context, provider);
  expect(provider.decide).not.toHaveBeenCalled();
  stored = {
    id: 'qa-proposal',
    organizationId: actor.organizationId,
    fingerprint: 'f'.repeat(64),
    plan,
  };
});

it('refuses any mismatch between authenticated identity, source and captured admission', async () => {
  for (const patch of [
    { admission: { ...admission, revision: 'admission-2' } },
    { publication: { ...publication, organizationId: 'other-company' } },
    { sourceCapability: { ...loaded.sourceCapability, revision: 'source-2' } },
  ])
    await expect(
      createPublishedQuoteFences(authority, cas, { ...loaded, ...patch }),
    ).rejects.toMatchObject({ code: 'stale_plan' });
});

it('re-evaluates private source and admission capabilities instead of retaining their first gate', async () => {
  const fences = await createPublishedQuoteFences(authority, cas, loaded);
  const before = fences.progression();
  sourceActive = false;
  admissionActive = false;
  expect(fences.progression().sql).not.toBe(before.sql);
  expect(fences.progression().sql).toContain('(0)');
});

it('denies cross-user and cross-source reads and binds proposal-ID reads to the delegated source', async () => {
  const fences = await createPublishedQuoteFences(authority, cas, loaded);
  await expect(
    fences.ledgerFence({
      operation: 'read',
      actor: { ...actor, userId: 'other-user' },
      sourceId: context.source.id,
      proposalId: null,
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    fences.ledgerFence({
      operation: 'read',
      actor,
      sourceId: 'other-source',
      proposalId: null,
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  const gate = await fences.ledgerFence({
    operation: 'read',
    actor,
    sourceId: null,
    proposalId: stored.id,
  });
  expect(gate.bindings).toContain(context.source.id);
  expect(gate.sql).not.toContain('action_engine_publication_attempts');
});

it('refuses reservation from a different installation and stale admission at save', async () => {
  const fences = await createPublishedQuoteFences(authority, cas, loaded);
  await expect(
    fences.ledgerFence({
      operation: 'reserve',
      actor,
      proposal: stored,
      installationId: 'other-pc',
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    fences.ledgerFence({
      operation: 'save',
      actor,
      proposal: stored,
      admission: { ...admission, revision: 'admission-2' },
    }),
  ).rejects.toMatchObject({ code: 'stale_plan' });
  const gate = await fences.ledgerFence({
    operation: 'save',
    actor,
    proposal: stored,
    admission,
  });
  expect(gate.sql).toContain('action_engine_publication_attempts');
});

it('does not mistake resource publication for proof of an existing business quote', async () => {
  const fences = await createPublishedQuoteFences(authority, cas, loaded);
  const request = {
    operation: 'confirm',
    actor,
    proposal: stored,
  } as Parameters<typeof fences.ledgerFence>[0];
  expect(await fences.ledgerFence(request)).toEqual({ sql: '0', bindings: [] });
});

it('rejects changed intake identity/context before allowing another model attempt', async () => {
  const fences = await createPublishedQuoteFences(authority, cas, loaded);
  await expect(
    fences.intakeFence({
      operation: 'claim',
      actor,
      input: { ...fences.input, contextHash: '0'.repeat(64) },
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(
    fences.intakeFence({
      operation: 'claim',
      actor: { ...actor, organizationId: 'other-company' },
      input: fences.input,
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  const read = await fences.intakeFence({
    operation: 'read',
    actor,
    input: fences.input,
  });
  expect(read.sql).not.toContain('action_engine_publication_attempts');
});

it('atomically refuses every captured read/progression gate when a US intent appears after planning', async () => {
  const fences = await createPublishedQuoteFences(authority, cas, loaded);
  const claim: QuotePreparationClaim = {
    id: '40000000-0000-4000-8000-000000000001',
    input: fences.input,
    inputHash: '1'.repeat(64),
    userId: actor.userId,
    ownerToken: '2'.repeat(64),
    leaseUntil: 100,
  };
  const gates: QuoteLedgerPredicate[] = [
    fences.progression(),
    await fences.intakeFence({ operation: 'read', actor, input: fences.input }),
    await fences.intakeFence({
      operation: 'claim',
      actor,
      input: fences.input,
    }),
    await fences.intakeFence({ operation: 'start', actor, claim }),
    await fences.intakeFence({ operation: 'uncertain', actor, claim }),
    await fences.intakeFence({
      operation: 'finish',
      actor,
      claim,
      result: {
        inputHash: claim.inputHash,
        plan: stored.plan,
        fingerprint: stored.fingerprint,
      },
    }),
    await fences.ledgerFence({
      operation: 'read',
      actor,
      sourceId: context.source.id,
      proposalId: null,
    }),
    await fences.ledgerFence({
      operation: 'read',
      actor,
      sourceId: null,
      proposalId: stored.id,
    }),
    await fences.ledgerFence({
      operation: 'save',
      actor,
      proposal: stored,
      admission,
    }),
    await fences.ledgerFence({
      operation: 'reserve',
      actor,
      proposal: stored,
      installationId: installation,
    }),
  ];
  const db = new DatabaseSync(':memory:');
  try {
    // This fixture executes the real composed gates. Identity/delegation are
    // private unit capabilities above, not a substitute for their full tests.
    db.exec(`
      CREATE TABLE international_workspace_creation_intents(organization_id TEXT PRIMARY KEY,country_code TEXT);
      CREATE TABLE action_engine_publication_attempts(organization_id TEXT,snapshot_id TEXT,base_revision INTEGER,archive_sha256 TEXT,manifest_sha256 TEXT,state TEXT,result_json TEXT);
      CREATE TABLE action_engine_quote_proposals(organization_id TEXT,id TEXT,source_id TEXT);
      CREATE TABLE qa_country_guard(allowed INTEGER NOT NULL CHECK(allowed=1));
      CREATE TABLE qa_country_write(label TEXT);
    `);
    db.prepare(
      'INSERT INTO action_engine_publication_attempts VALUES(?,?,?,?,?,?,?)',
    ).run(
      actor.organizationId,
      publication.snapshotId,
      publication.baseRevision,
      publication.archiveSha256,
      publication.manifestSha256,
      'committed',
      JSON.stringify({
        committed: true,
        revision: publication.revision,
        snapshotId: publication.snapshotId,
      }),
    );
    db.prepare('INSERT INTO action_engine_quote_proposals VALUES(?,?,?)').run(
      actor.organizationId,
      stored.id,
      context.source.id,
    );
    const allowed = (gate: QuoteLedgerPredicate) =>
      db
        .prepare(`SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END AS allowed`)
        .get(...gate.bindings)?.allowed;
    const guardedWrite = (gate: QuoteLedgerPredicate) => {
      db.exec('BEGIN');
      try {
        db.exec("INSERT INTO qa_country_write VALUES('must-roll-back')");
        db.prepare(
          `INSERT INTO qa_country_guard SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END`,
        ).run(...gate.bindings);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    };
    expect(gates.map(allowed)).toEqual(Array(gates.length).fill(1));
    // Another tenant must not block this company's preparation or recovery.
    db.prepare(
      'INSERT INTO international_workspace_creation_intents VALUES(?,?)',
    ).run('another-company', 'US');
    expect(gates.map(allowed)).toEqual(Array(gates.length).fill(1));
    // The gates were captured before this change/provider wait. Their SQL,
    // rather than a prior transport preflight, must still refuse the write.
    db.prepare(
      'INSERT INTO international_workspace_creation_intents VALUES(?,?)',
    ).run(actor.organizationId, 'US');
    expect(gates.map(allowed)).toEqual(Array(gates.length).fill(0));
    for (const gate of gates) expect(() => guardedWrite(gate)).toThrow(/CHECK/);
    expect(
      db.prepare('SELECT count(*) AS n FROM qa_country_write').get()?.n,
    ).toBe(0);
    expect(
      db.prepare('SELECT count(*) AS n FROM qa_country_guard').get()?.n,
    ).toBe(0);
  } finally {
    db.close();
  }
});

it('does not admit historical access when the country schema cannot be read', async () => {
  const fences = await createPublishedQuoteFences(authority, cas, loaded);
  const gate = await fences.intakeFence({
    operation: 'read',
    actor,
    input: fences.input,
  });
  const db = new DatabaseSync(':memory:');
  try {
    expect(() =>
      db.prepare(`SELECT (${gate.sql})`).get(...gate.bindings),
    ).toThrow(/no such table/);
  } finally {
    db.close();
  }
});

it('retains the combined 64-binding limit when adding the country fence', async () => {
  let bindingCount = 0;
  const budgetCas = {
    admission,
    predicate: () => ({
      sql: '1',
      bindings: Array<number>(bindingCount).fill(1),
    }),
  };
  const fences = await createPublishedQuoteFences(authority, budgetCas, loaded);
  const base = fences.progression();
  bindingCount = 64 - base.bindings.length;
  expect(fences.progression().bindings).toHaveLength(64);
  bindingCount = 65 - base.bindings.length;
  expect(() => fences.progression()).toThrow('invalid_context');
});
