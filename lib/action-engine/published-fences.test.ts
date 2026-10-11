import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/runtime', () => ({
  database: () => {
    throw new Error('no database in this unit test');
  },
}));
import { planQuoteDraft } from './planner';
import { createPublishedQuoteFences } from './published-fences';
import type { DeviceQuoteAuthority } from './production-admission';
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
