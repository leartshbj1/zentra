import { describe, expect, it, vi } from 'vitest';
import type { DecisionInput } from '@/lib/automation/types';
import {
  executeQuoteProposal,
  prepareQuoteProposal,
  quotePlanFingerprint,
} from './engine';
import {
  validatePlanningContext,
  captureQuotePlan,
  captureActor,
} from './validation';
import type {
  ActionActor,
  ActionAdmission,
  QuotePlanningContext,
  QuotePlan,
  StoredQuoteProposal,
  DraftQuoteReceipt,
  QuoteExecutionPorts,
  QuotePreparationPorts,
} from './types';

const actor: ActionActor = { organizationId: 'org-a', userId: 'user-a' };
const admission = (): ActionAdmission => ({
  ...actor,
  revision: 'membership-v1',
  automationActive: true,
  mayPrepareQuote: true,
});
function context(): QuotePlanningContext {
  return {
    organizationId: 'org-a',
    revision: 'company-v1',
    currency: 'CHF',
    source: {
      id: 'ticket-a',
      revision: 'email-v1',
      organizationId: 'org-a',
      senderEmail: 'client@example.ch',
      senderName: 'Camille Exemple',
      subject: 'Devis radiateurs',
      body: 'Installer 3 radiateurs',
    },
    customers: [
      {
        id: 'client-a',
        revision: 'client-v1',
        organizationId: 'org-a',
        name: 'Camille Exemple',
        email: 'client@example.ch',
        archived: false,
      },
    ],
    articles: [
      {
        id: 'radiator',
        revision: 'price-v1',
        organizationId: 'org-a',
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
function plan(): QuotePlan {
  return {
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId: 'org-a',
    contextRevision: 'company-v1',
    sourceId: 'ticket-a',
    sourceRevision: 'email-v1',
    status: 'ready',
    reasons: [],
    customer: {
      kind: 'existing',
      id: 'client-a',
      revision: 'client-v1',
      name: 'Camille Exemple',
    },
    title: 'Devis radiateurs',
    currency: 'CHF',
    lines: [
      {
        articleId: 'radiator',
        articleRevision: 'price-v1',
        description: 'Radiateur',
        unit: 'pièce',
        quantityMilli: 3000,
        unitPriceCents: 19900,
        taxRateBp: 810,
        netCents: 59700,
        evidence: 'Installer 3 radiateurs',
      },
    ],
    netCents: 59700,
    confidence: 0.99,
    requiresHumanValidation: true,
  };
}
async function proposal(p = plan()): Promise<StoredQuoteProposal> {
  return {
    id: 'proposal-a',
    organizationId: 'org-a',
    fingerprint: await quotePlanFingerprint(p),
    plan: p,
  };
}
function receipt(p: StoredQuoteProposal): DraftQuoteReceipt {
  return {
    organizationId: 'org-a',
    proposalId: p.id,
    fingerprint: p.fingerprint,
    customerId: 'client-a',
    quoteId: 'quote-a',
    quoteNumber: 'DV-2026-0001',
    status: 'draft',
    requiresHumanValidation: true,
  };
}
async function execution(supplied?: StoredQuoteProposal) {
  const p = supplied ?? (await proposal());
  const ports: QuoteExecutionPorts = {
    authorize: vi.fn(async () => admission()),
    loadProposal: vi.fn(async () => p),
    findReceipt: vi.fn(async () => null),
    loadContext: vi.fn(async () => context()),
    commitDraft: vi.fn(async () => receipt(p)),
  };
  return ports;
}
function preparation(
  prior: StoredQuoteProposal | null = null,
): QuotePreparationPorts {
  return {
    authorize: vi.fn(async () => admission()),
    loadContext: vi.fn(async () => context()),
    findProposal: vi.fn(async () => prior),
    saveProposal: vi.fn(async (_a, p, fingerprint) => ({
      id: 'proposal-a',
      organizationId: 'org-a',
      plan: p,
      fingerprint,
    })),
    provider: {
      decide: vi.fn(async (input: DecisionInput) => ({
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
      })),
    },
  };
}

describe('Action Engine authorization and durable port contract', () => {
  it('prepares a real typed proposal, without issue/send/payment capabilities', async () => {
    const ports = preparation();
    const result = await prepareQuoteProposal(actor, 'ticket-a', ports);
    expect(result.plan.status).toBe('ready');
    expect(result.plan.requiresHumanValidation).toBe(true);
    expect(result.plan.lines[0].unitPriceCents).toBe(19900);
    expect(ports.provider.decide).toHaveBeenCalledTimes(1);
    expect(ports.authorize).toHaveBeenCalledTimes(4);
    expect(ports.saveProposal).toHaveBeenCalledWith(
      actor,
      result.plan,
      result.fingerprint,
      admission(),
    );
  });
  it('reuses the saved proposal without another AI call', async () => {
    const prior = await proposal(),
      ports = preparation(prior);
    expect(await prepareQuoteProposal(actor, 'ticket-a', ports)).toEqual(prior);
    expect(ports.provider.decide).not.toHaveBeenCalled();
    expect(ports.saveProposal).not.toHaveBeenCalled();
  });
  it('refuses revoked access before reading source or calling a provider', async () => {
    const ports = preparation();
    ports.authorize = vi.fn(async () => ({
      ...admission(),
      mayPrepareQuote: false,
    }));
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow('forbidden');
    expect(ports.loadContext).not.toHaveBeenCalled();
    expect(ports.provider.decide).not.toHaveBeenCalled();
  });
  it('rechecks authorization after provider returns and before saving', async () => {
    const ports = preparation();
    ports.authorize = vi
      .fn()
      .mockResolvedValueOnce(admission())
      .mockResolvedValueOnce(admission())
      .mockResolvedValue({ ...admission(), automationActive: false });
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow('forbidden');
    expect(ports.provider.decide).toHaveBeenCalledTimes(1);
    expect(ports.saveProposal).not.toHaveBeenCalled();
  });
  it('does not return private proposal data after revocation during persistence', async () => {
    const ports = preparation();
    ports.authorize = vi
      .fn()
      .mockResolvedValueOnce(admission())
      .mockResolvedValueOnce(admission())
      .mockResolvedValueOnce(admission())
      .mockResolvedValue({ ...admission(), automationActive: false });
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow('forbidden');
    expect(ports.saveProposal).toHaveBeenCalledTimes(1);
  });
  it('refuses another tenant or another source from a repository', async () => {
    const ports = preparation();
    ports.loadContext = vi.fn(async () => ({
      ...context(),
      source: { ...context().source, id: 'ticket-b' },
    }));
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow('forbidden');
    expect(ports.findProposal).not.toHaveBeenCalled();
  });
  it('does not silently overwrite a stale saved proposal', async () => {
    const ports = preparation(await proposal());
    ports.loadContext = vi.fn(async () => ({
      ...context(),
      revision: 'company-v2',
    }));
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow('stale_plan');
    expect(ports.saveProposal).not.toHaveBeenCalled();
    expect(ports.provider.decide).not.toHaveBeenCalled();
  });
  it('does not trust a repository acknowledgement with a changed fingerprint', async () => {
    const ports = preparation();
    ports.saveProposal = vi.fn(async (_a, p) => ({
      id: 'proposal-a',
      organizationId: 'org-a',
      plan: p,
      fingerprint: '0'.repeat(64),
    }));
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow('invalid_proposal');
  });
  it('captures actor and method references before asynchronous work', async () => {
    const mutable = { ...actor },
      ports = preparation();
    const oldAuthorize = ports.authorize;
    ports.authorize = vi.fn(async (a) => {
      mutable.organizationId = 'org-b';
      ports.loadContext = vi.fn(async () => {
        throw Error('replaced');
      });
      return oldAuthorize(a);
    });
    const result = await prepareQuoteProposal(mutable, 'ticket-a', ports);
    expect(result.organizationId).toBe('org-a');
  });
  it('commits only a valid server-stored plan and captures the draft receipt', async () => {
    const ports = await execution();
    expect(
      (await executeQuoteProposal(actor, 'proposal-a', ports)).quoteId,
    ).toBe('quote-a');
    expect(ports.commitDraft).toHaveBeenCalledTimes(1);
    expect(ports.authorize).toHaveBeenCalledTimes(3);
  });
  it('recovers historical receipt before changed prices/source; never writes again', async () => {
    const p = await proposal(),
      ports = await execution(p);
    ports.findReceipt = vi.fn(async () => receipt(p));
    ports.loadContext = vi.fn(async () => {
      throw Error('catalogue no longer exists');
    });
    expect(await executeQuoteProposal(actor, p.id, ports)).toEqual(receipt(p));
    expect(ports.loadContext).not.toHaveBeenCalled();
    expect(ports.commitDraft).not.toHaveBeenCalled();
  });
  it('cannot replay a receipt without fresh access', async () => {
    const p = await proposal(),
      ports = await execution(p);
    ports.findReceipt = vi.fn(async () => receipt(p));
    ports.authorize = vi.fn(async () => ({
      ...admission(),
      automationActive: false,
    }));
    await expect(executeQuoteProposal(actor, p.id, ports)).rejects.toThrow(
      'forbidden',
    );
    expect(ports.findReceipt).not.toHaveBeenCalled();
  });
  it.each([
    (c: QuotePlanningContext) => ({
      ...c,
      source: { ...c.source, revision: 'email-v2' },
    }),
    (c: QuotePlanningContext) => ({
      ...c,
      articles: c.articles.map((a) => ({ ...a, unitPriceCents: 1 })),
    }),
    (c: QuotePlanningContext) => ({
      ...c,
      articles: c.articles.map((a) => ({ ...a, archived: true })),
    }),
    (c: QuotePlanningContext) => ({
      ...c,
      customers: c.customers.map((a) => ({ ...a, archived: true })),
    }),
    (c: QuotePlanningContext) => ({
      ...c,
      source: { ...c.source, body: 'Changed content' },
    }),
  ])('refuses changed business facts before commit', async (change) => {
    const ports = await execution();
    ports.loadContext = vi.fn(async () => change(context()));
    await expect(
      executeQuoteProposal(actor, 'proposal-a', ports),
    ).rejects.toThrow('stale_plan');
    expect(ports.commitDraft).not.toHaveBeenCalled();
  });
  it('refuses a proposal requiring review even with a valid hash', async () => {
    const p = await proposal({
      ...plan(),
      status: 'needs_review',
      reasons: ['low_confidence'],
      confidence: 0.8,
    });
    const ports = await execution(p);
    await expect(executeQuoteProposal(actor, p.id, ports)).rejects.toThrow(
      'review_required',
    );
    expect(ports.commitDraft).not.toHaveBeenCalled();
  });
  it('rechecks admission before commit after asynchronous resource loading', async () => {
    const ports = await execution();
    ports.authorize = vi
      .fn()
      .mockResolvedValueOnce(admission())
      .mockResolvedValue({ ...admission(), mayPrepareQuote: false });
    await expect(
      executeQuoteProposal(actor, 'proposal-a', ports),
    ).rejects.toThrow('forbidden');
    expect(ports.commitDraft).not.toHaveBeenCalled();
  });
  it.each([
    { organizationId: 'org-b' },
    { quoteId: '' },
    { customerId: 'client-b' },
    { status: 'issued' },
    { requiresHumanValidation: false },
    { fingerprint: '0'.repeat(64) },
    { extraFinancialEffect: 'issue' },
  ])('refuses malformed or cross-tenant receipt %j', async (patch) => {
    const p = await proposal(),
      ports = await execution(p);
    ports.commitDraft = vi.fn(
      async () => ({ ...receipt(p), ...patch }) as DraftQuoteReceipt,
    );
    await expect(executeQuoteProposal(actor, p.id, ports)).rejects.toThrow(
      'invalid_receipt',
    );
  });
  it('propagates an unconfirmed commit without an automatic blind retry', async () => {
    const ports = await execution();
    ports.commitDraft = vi.fn(async () => {
      throw Error('lost response');
    });
    await expect(
      executeQuoteProposal(actor, 'proposal-a', ports),
    ).rejects.toThrow('lost response');
    expect(ports.commitDraft).toHaveBeenCalledTimes(1);
  });
  it('does not expose the receipt after revocation during commit, or undo its effects', async () => {
    const ports = await execution();
    ports.authorize = vi
      .fn()
      .mockResolvedValueOnce(admission())
      .mockResolvedValueOnce(admission())
      .mockResolvedValue({ ...admission(), mayPrepareQuote: false });
    await expect(
      executeQuoteProposal(actor, 'proposal-a', ports),
    ).rejects.toThrow('forbidden');
    expect(ports.commitDraft).toHaveBeenCalledTimes(1);
  });
});

describe('Action Engine strict immutable contracts', () => {
  it('detaches and freezes nested projection values', () => {
    const original = context(),
      captured = validatePlanningContext(original);
    (original.articles[0] as { unitPriceCents: number }).unitPriceCents = 1;
    expect(captured.articles[0].unitPriceCents).toBe(19900);
    expect(Object.isFrozen(captured.source)).toBe(true);
    expect(Object.isFrozen(captured.articles[0])).toBe(true);
  });
  it.each(['source', 'customer', 'article'])(
    'refuses polluted tenant in %s',
    (kind) => {
      const c = structuredClone(context());
      if (kind === 'source')
        Object.assign(c.source, { organizationId: 'org-b' });
      if (kind === 'customer')
        Object.assign(c.customers[0], { organizationId: 'org-b' });
      if (kind === 'article')
        Object.assign(c.articles[0], { organizationId: 'org-b' });
      expect(() => validatePlanningContext(c)).toThrow('invalid_context');
    },
  );
  it('does not invoke getters on a caller-owned object', () => {
    const getter = vi.fn(() => 'org-a');
    expect(() =>
      captureActor({
        get organizationId() {
          return getter();
        },
        userId: 'user-a',
      }),
    ).toThrow('invalid_context');
    expect(getter).not.toHaveBeenCalled();
  });
  it('accepts USD explicitly but refuses unsupported currency exponents', () => {
    const c = context();
    expect(
      validatePlanningContext({
        ...c,
        currency: 'USD',
        articles: c.articles.map((a) => ({
          ...a,
          currency: 'USD',
          taxRateBp: 0,
        })),
      }).currency,
    ).toBe('USD');
    expect(() =>
      validatePlanningContext({
        ...c,
        currency: 'JPY',
        articles: c.articles.map((a) => ({ ...a, currency: 'JPY' })),
      }),
    ).toThrow('invalid_context');
  });
  it.each([
    { requiresHumanValidation: false },
    { kind: 'issue_invoice' },
    { netCents: 1 },
    { confidence: NaN },
    { status: 'ready', reasons: ['low_confidence'] },
    { extra: 'execute' },
  ])('rejects forged plan %j', (patch) => {
    expect(() => captureQuotePlan({ ...plan(), ...patch })).toThrow(
      'invalid_context',
    );
  });
  it('canonicalizes property ordering for stable fingerprints', async () => {
    const p = plan();
    const reversed = Object.fromEntries(
      Object.entries(p).reverse(),
    ) as QuotePlan;
    expect(await quotePlanFingerprint(p)).toBe(
      await quotePlanFingerprint(reversed),
    );
  });
});
