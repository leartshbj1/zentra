import { describe, expect, it, vi } from 'vitest';
import type { DecisionInput } from '@/lib/automation/types';
import {
  quotePreparationInput,
  quotePreparationInputFingerprint,
} from './intake';
import {
  QuotePreparationError,
  type QuotePreparationIntake,
} from './intake-types';
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
    quoteNumber: null,
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
    intake: {
      read: vi.fn(async () => null),
      claim: vi.fn(async (a, input) => ({
        state: 'owned' as const,
        claim: {
          id: '00000000-0000-4000-8000-000000000001',
          input,
          inputHash: await quotePreparationInputFingerprint(input),
          userId: a.userId,
          ownerToken: '00000000-0000-4000-8000-000000000002',
          leaseUntil: 1800000000,
        },
      })),
      start: vi.fn(async () => undefined),
      finish: vi.fn(async (_a, claim, plan, fingerprint) => ({
        inputHash: claim.inputHash,
        plan,
        fingerprint,
      })),
      uncertain: vi.fn(async () => undefined),
    },
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
  it('commits the started marker before invoking the provider', async () => {
    const ports = preparation(),
      order: string[] = [];
    const decide = ports.provider.decide;
    ports.intake.start = vi.fn(async () => {
      order.push('started');
    });
    ports.provider = {
      decide: vi.fn(async (input) => {
        order.push('provider');
        return decide(input);
      }),
    };
    await prepareQuoteProposal(actor, 'ticket-a', ports);
    expect(order).toEqual(['started', 'provider']);
    expect(ports.intake.finish).toHaveBeenCalledTimes(1);
  });
  it.each(['held', 'uncertain'] as const)(
    'does not freeze an %s intake as a review proposal',
    async (state) => {
      const ports = preparation();
      ports.intake.claim = vi.fn(async () => ({ state, sourceId: 'ticket-a' }));
      await expect(
        prepareQuoteProposal(actor, 'ticket-a', ports),
      ).rejects.toThrow(state);
      expect(ports.provider.decide).not.toHaveBeenCalled();
      expect(ports.intake.start).not.toHaveBeenCalled();
      expect(ports.intake.finish).not.toHaveBeenCalled();
      expect(ports.saveProposal).not.toHaveBeenCalled();
    },
  );
  it('does not call the provider after an ambiguous start acknowledgement', async () => {
    const ports = preparation();
    ports.intake.start = vi.fn(async () => {
      throw new QuotePreparationError('service_unavailable');
    });
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow('service_unavailable');
    expect(ports.provider.decide).not.toHaveBeenCalled();
    expect(ports.intake.finish).not.toHaveBeenCalled();
    expect(ports.saveProposal).not.toHaveBeenCalled();
  });
  it('keeps a failed provider call uncertain instead of persisting provider_unavailable forever', async () => {
    const ports = preparation();
    ports.provider = {
      decide: vi.fn(async () => {
        throw Error('private network failure');
      }),
    };
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow('uncertain');
    expect(ports.intake.uncertain).toHaveBeenCalledTimes(1);
    expect(ports.intake.finish).not.toHaveBeenCalled();
    expect(ports.saveProposal).not.toHaveBeenCalled();
  });
  it('does not disguise an uncertain call when its state notification also fails', async () => {
    const ports = preparation();
    ports.provider = {
      decide: vi.fn(async () => {
        throw Error('private timeout');
      }),
    };
    ports.intake.uncertain = vi.fn(async () => {
      throw Error('private SQL failure');
    });
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow(/^uncertain$/);
    expect(ports.intake.finish).not.toHaveBeenCalled();
    expect(ports.saveProposal).not.toHaveBeenCalled();
  });
  it('finishes a deterministic review with no provider call and no started marker', async () => {
    const ports = preparation();
    ports.loadContext = vi.fn(async () => ({
      ...context(),
      customers: [],
      source: { ...context().source, senderName: '' },
    }));
    const result = await prepareQuoteProposal(actor, 'ticket-a', ports);
    expect(result.plan.reasons).toContain('missing_customer_name');
    expect(ports.provider.decide).not.toHaveBeenCalled();
    expect(ports.intake.start).not.toHaveBeenCalled();
    expect(ports.intake.finish).toHaveBeenCalledTimes(1);
  });
  it('recovers a finished plan after a failed ledger save without another model call', async () => {
    const ports = preparation();
    const finish = ports.intake.finish;
    ports.intake.finish = vi.fn<QuotePreparationIntake['finish']>(
      async (...args) => {
        const result = await finish(...args);
        ports.intake.claim = vi.fn(async () => ({
          state: 'finished' as const,
          result,
        }));
        return result;
      },
    );
    const save = ports.saveProposal;
    ports.saveProposal = vi
      .fn()
      .mockRejectedValueOnce(Error('lost proposal save response'))
      .mockImplementation(save);
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow('lost proposal save response');
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).resolves.toMatchObject({ plan: { status: 'ready' } });
    expect(ports.provider.decide).toHaveBeenCalledTimes(1);
    expect(ports.intake.start).toHaveBeenCalledTimes(1);
    expect(ports.intake.finish).toHaveBeenCalledTimes(1);
  });
  it('rejects a forged stored input hash before granting a provider attempt', async () => {
    const ports = preparation();
    const claim = ports.intake.claim;
    ports.intake.claim = vi.fn<QuotePreparationIntake['claim']>(
      async (...args) => {
        const claimed = await claim(...args);
        if (claimed.state !== 'owned') throw Error('fixture');
        return {
          ...claimed,
          claim: { ...claimed.claim, inputHash: '0'.repeat(64) },
        };
      },
    );
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow('invalid_record');
    expect(ports.intake.start).not.toHaveBeenCalled();
    expect(ports.provider.decide).not.toHaveBeenCalled();
  });
  it('rejects a stored result whose fingerprint does not match its plan', async () => {
    const ports = preparation(),
      input = await quotePreparationInput(context());
    ports.intake.claim = vi.fn(async () => ({
      state: 'finished' as const,
      result: {
        inputHash: await quotePreparationInputFingerprint(input),
        plan: plan(),
        fingerprint: '0'.repeat(64),
      },
    }));
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow('invalid_record');
    expect(ports.saveProposal).not.toHaveBeenCalled();
    expect(ports.provider.decide).not.toHaveBeenCalled();
  });
  it('does not invoke a getter while capturing a claim outcome', async () => {
    const ports = preparation(),
      getter = vi.fn(() => 'held');
    ports.intake.claim = vi.fn(
      async () =>
        ({
          get state() {
            return getter();
          },
          sourceId: 'ticket-a',
        }) as Awaited<ReturnType<QuotePreparationIntake['claim']>>,
    );
    await expect(
      prepareQuoteProposal(actor, 'ticket-a', ports),
    ).rejects.toThrow('invalid_record');
    expect(getter).not.toHaveBeenCalled();
    expect(ports.provider.decide).not.toHaveBeenCalled();
  });
  it('prepares a real typed proposal, without issue/send/payment capabilities', async () => {
    const ports = preparation();
    const result = await prepareQuoteProposal(actor, 'ticket-a', ports);
    expect(result.plan.status).toBe('ready');
    expect(result.plan.requiresHumanValidation).toBe(true);
    expect(result.plan.lines[0].unitPriceCents).toBe(19900);
    expect(ports.provider.decide).toHaveBeenCalledTimes(1);
    expect(ports.authorize).toHaveBeenCalledTimes(5);
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
  it('captures each adapter once even when a port is supplied by a getter', async () => {
    const ports = preparation(),
      originalProvider = ports.provider,
      originalIntake = ports.intake;
    const providerGetter = vi.fn(() => {
      if (providerGetter.mock.calls.length > 1) throw Error('provider swapped');
      return originalProvider;
    });
    const intakeGetter = vi.fn(() => {
      if (intakeGetter.mock.calls.length > 1) throw Error('intake swapped');
      return originalIntake;
    });
    Object.defineProperty(ports, 'provider', { get: providerGetter });
    Object.defineProperty(ports, 'intake', { get: intakeGetter });
    const result = await prepareQuoteProposal(actor, 'ticket-a', ports);
    expect(result.plan.status).toBe('ready');
    expect(providerGetter).toHaveBeenCalledTimes(1);
    expect(intakeGetter).toHaveBeenCalledTimes(1);
    expect(originalProvider.decide).toHaveBeenCalledTimes(1);
    expect(originalIntake.finish).toHaveBeenCalledTimes(1);
  });
  it('commits only a valid server-stored plan and captures the draft receipt', async () => {
    const ports = await execution();
    expect(
      await executeQuoteProposal(actor, 'proposal-a', ports),
    ).toMatchObject({
      quoteId: 'quote-a',
      quoteNumber: null,
      status: 'draft',
    });
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
  it('keeps the creation receipt unnumbered after the document is issued later', async () => {
    const p = await proposal(),
      ports = await execution(p),
      historical = receipt(p);
    // The mutable document and the immutable creation receipt are distinct facts.
    const currentDocument = {
      id: historical.quoteId,
      number: 'DV-2026-0001',
      status: 'emis',
    };
    ports.findReceipt = vi.fn(async () => historical);
    ports.loadContext = vi.fn(async () => {
      throw Error('The current document must not replace its creation receipt');
    });
    const recovered = await executeQuoteProposal(actor, p.id, ports);
    expect(recovered).toEqual(historical);
    expect(recovered.quoteNumber).toBeNull();
    expect(recovered.status).toBe('draft');
    expect(currentDocument).toEqual({
      id: recovered.quoteId,
      number: 'DV-2026-0001',
      status: 'emis',
    });
    expect(ports.loadContext).not.toHaveBeenCalled();
    expect(ports.commitDraft).not.toHaveBeenCalled();
  });
  it('refuses a numbered historical receipt without preparing or writing again', async () => {
    const p = await proposal(),
      ports = await execution(p);
    ports.findReceipt = vi.fn(
      async () =>
        ({
          ...receipt(p),
          quoteNumber: 'DV-2026-0001',
        }) as unknown as DraftQuoteReceipt,
    );
    await expect(executeQuoteProposal(actor, p.id, ports)).rejects.toThrow(
      'invalid_receipt',
    );
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
    { quoteNumber: 'DV-2026-0001' },
    { quoteNumber: '' },
    { quoteNumber: undefined },
    { status: 'issued' },
    { requiresHumanValidation: false },
    { fingerprint: '0'.repeat(64) },
    { extraFinancialEffect: 'issue' },
  ])('refuses malformed or cross-tenant receipt %j', async (patch) => {
    const p = await proposal(),
      ports = await execution(p);
    ports.commitDraft = vi.fn(
      async () => ({ ...receipt(p), ...patch }) as unknown as DraftQuoteReceipt,
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
