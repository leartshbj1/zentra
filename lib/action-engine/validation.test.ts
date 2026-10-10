import { describe, expect, it, vi } from 'vitest';
import { executeQuoteProposal, quotePlanFingerprint } from './engine';
import {
  captureActor,
  captureQuotePlan,
  validatePlanAgainstContext,
  validatePlanningContext,
} from './validation';
import type {
  ActionActor,
  ActionAdmission,
  QuoteExecutionPorts,
  QuotePlan,
  StoredQuoteProposal,
} from './types';

// Synthetic company facts intentionally give a second valid catalogue article.
// Its mere presence in the catalogue must not authorize substituting it for the
// radiators actually requested by this message.
function context() {
  return {
    organizationId: 'company-demo',
    revision: 'company-r7',
    currency: 'CHF',
    source: {
      id: 'email-quote-request',
      revision: 'email-r2',
      organizationId: 'company-demo',
      senderEmail: 'camille@example.test',
      senderName: 'Camille Martin',
      subject: 'Radiator quote',
      body: 'Please prepare a quote for 3 radiators.',
    },
    customers: [
      {
        id: 'customer-camille',
        revision: 'customer-r1',
        organizationId: 'company-demo',
        name: 'Camille Martin',
        email: 'camille@example.test',
        archived: false,
      },
    ],
    articles: [
      {
        id: 'article-radiator',
        revision: 'radiator-r1',
        organizationId: 'company-demo',
        name: 'Radiators',
        description: 'Panel heating radiator',
        sku: 'RAD-600',
        unit: 'piece',
        currency: 'CHF',
        unitPriceCents: 55_000,
        taxRateBp: 810,
        archived: false,
      },
      {
        id: 'article-valve',
        revision: 'valve-r4',
        organizationId: 'company-demo',
        name: 'Valves',
        description: 'Heating valve',
        sku: 'VALVE-15',
        unit: 'piece',
        currency: 'CHF',
        unitPriceCents: 2_500,
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
    organizationId: 'company-demo',
    contextRevision: 'company-r7',
    sourceId: 'email-quote-request',
    sourceRevision: 'email-r2',
    status: 'ready',
    reasons: [],
    customer: {
      kind: 'existing',
      id: 'customer-camille',
      revision: 'customer-r1',
      name: 'Camille Martin',
    },
    title: 'Radiator quote',
    currency: 'CHF',
    lines: [
      {
        articleId: 'article-radiator',
        articleRevision: 'radiator-r1',
        description: 'Radiators',
        unit: 'piece',
        quantityMilli: 3_000,
        unitPriceCents: 55_000,
        taxRateBp: 810,
        netCents: 165_000,
        evidence: 'Please prepare a quote for 3 radiators',
      },
    ],
    netCents: 165_000,
    confidence: 0.99,
    requiresHumanValidation: true,
  };
}

const actor: ActionActor = {
  organizationId: 'company-demo',
  userId: 'user-camille',
};

function sparseArray(): unknown[] {
  const values: unknown[] = [];
  values.length = 1; // Deliberately a hole, not a dense [undefined] fixture.
  return values;
}
const admission = (): ActionAdmission => ({
  ...actor,
  revision: 'membership-r1',
  automationActive: true,
  mayPrepareQuote: true,
});

function execution(proposal: StoredQuoteProposal): QuoteExecutionPorts {
  return {
    authorize: vi.fn(async () => admission()),
    loadProposal: vi.fn(async () => proposal),
    findReceipt: vi.fn(async () => null),
    loadContext: vi.fn(async () => context()),
    commitDraft: vi.fn(async () => {
      throw new Error('A rejected proposal must never reach the writer');
    }),
  };
}

describe('source facts remain authoritative even with a recomputed valid fingerprint', () => {
  it('accepts a genuine unchanged plan and source as the control fixture', () => {
    expect(() =>
      validatePlanAgainstContext(
        captureQuotePlan(plan()),
        validatePlanningContext(context()),
      ),
    ).not.toThrow();
  });

  it('rejects a forged quantity and recomputed totals before any write', async () => {
    const original = plan();
    const forged = captureQuotePlan({
      ...original,
      lines: [
        { ...original.lines[0], quantityMilli: 4_000, netCents: 220_000 },
      ],
      netCents: 220_000,
    });
    const fingerprint = await quotePlanFingerprint(forged);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toBe(await quotePlanFingerprint(original));
    const ports = execution({
      id: 'proposal-forged-quantity',
      organizationId: actor.organizationId,
      fingerprint,
      plan: forged,
    });
    await expect(
      executeQuoteProposal(actor, 'proposal-forged-quantity', ports),
    ).rejects.toMatchObject({ code: 'stale_plan' });
    expect(ports.commitDraft).not.toHaveBeenCalled();
  });

  it('rejects a valid same-company article unrelated to the literal source evidence', async () => {
    const original = plan();
    const forged = captureQuotePlan({
      ...original,
      lines: [
        {
          ...original.lines[0],
          articleId: 'article-valve',
          articleRevision: 'valve-r4',
          description: 'Valves',
          unitPriceCents: 2_500,
          netCents: 7_500,
        },
      ],
      netCents: 7_500,
    });
    const fingerprint = await quotePlanFingerprint(forged);
    const ports = execution({
      id: 'proposal-forged-article',
      organizationId: actor.organizationId,
      fingerprint,
      plan: forged,
    });
    await expect(
      executeQuoteProposal(actor, 'proposal-forged-article', ports),
    ).rejects.toMatchObject({ code: 'stale_plan' });
    expect(ports.commitDraft).not.toHaveBeenCalled();
  });

  it('rejects duplicated evidence rather than doubling the requested amount', () => {
    const original = plan();
    const forged = {
      ...original,
      lines: [{ ...original.lines[0] }, { ...original.lines[0] }],
      netCents: 330_000,
    };
    // Either structural capture or the subsequent source comparison may reject
    // this. Neither may turn repeated evidence into an admissible plan.
    expect(() =>
      validatePlanAgainstContext(
        captureQuotePlan(forged),
        validatePlanningContext(context()),
      ),
    ).toThrow();
  });

  it('rejects evidence that is only a substring omitting a second literal quantity', () => {
    const input = context();
    input.source.body =
      'Please prepare a quote for 3 radiators or 4 radiators.';
    expect(() =>
      validatePlanAgainstContext(
        captureQuotePlan(plan()),
        validatePlanningContext(input),
      ),
    ).toThrow('stale_plan');
  });

  it('rejects a plan silently omitting another requested source line', () => {
    const input = context();
    input.source.body = 'Please prepare a quote for 3 radiators.\n2 valves';
    expect(() =>
      validatePlanAgainstContext(
        captureQuotePlan(plan()),
        validatePlanningContext(input),
      ),
    ).toThrow('stale_plan');
  });

  it('does not permit a new-client plan to evade an archived matching customer', () => {
    const input = context();
    input.customers[0].archived = true;
    const forged = {
      ...plan(),
      customer: {
        kind: 'new',
        name: 'Camille Martin',
        email: 'camille@example.test',
      },
    };
    expect(() =>
      validatePlanAgainstContext(
        captureQuotePlan(forged),
        validatePlanningContext(input),
      ),
    ).toThrow('stale_plan');
  });
});

describe('closed, inert JSON capture', () => {
  it('captures detached, frozen context records and arrays', () => {
    const input = context(),
      captured = validatePlanningContext(input);
    input.source.body = 'Mutated';
    input.customers[0].name = 'Changed';
    input.articles[0].unitPriceCents = 1;
    expect(captured.source.body).toBe(
      'Please prepare a quote for 3 radiators.',
    );
    expect(captured.customers[0].name).toBe('Camille Martin');
    expect(captured.articles[0].unitPriceCents).toBe(55_000);
    for (const value of [
      captured,
      captured.source,
      captured.customers,
      captured.customers[0],
      captured.articles,
      captured.articles[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it('rejects a sparse customer array rather than treating its hole as no customer', () => {
    const input = { ...context(), customers: sparseArray() };
    expect(() => validatePlanningContext(input)).toThrow('invalid_context');
  });

  it('rejects a sparse article array rather than skipping an unobserved resource', () => {
    const input = { ...context(), articles: sparseArray() };
    expect(() => validatePlanningContext(input)).toThrow('invalid_context');
  });

  it('rejects a sparse plan line array without silently changing its cardinality', () => {
    expect(() => captureQuotePlan({ ...plan(), lines: sparseArray() })).toThrow(
      'invalid_context',
    );
  });

  it('rejects a sparse review-reason array', () => {
    expect(() =>
      captureQuotePlan({
        ...plan(),
        status: 'needs_review',
        reasons: sparseArray(),
        lines: [],
        netCents: 0,
      }),
    ).toThrow('invalid_context');
  });

  it('rejects an array index getter without running it', () => {
    const input = context(),
      read = vi.fn(() => input.customers[0]);
    const customers = sparseArray();
    Object.defineProperty(customers, '0', {
      enumerable: true,
      configurable: true,
      get: read,
    });
    expect(() => validatePlanningContext({ ...input, customers })).toThrow(
      'invalid_context',
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects an own array map method without executing it', () => {
    const input = context(),
      map = vi.fn(() => []);
    Object.defineProperty(input.articles, 'map', {
      value: map,
      enumerable: true,
      configurable: true,
    });
    expect(() => validatePlanningContext(input)).toThrow('invalid_context');
    expect(map).not.toHaveBeenCalled();
  });

  it('rejects an own array map getter without running it', () => {
    const input = context(),
      read = vi.fn(() => Array.prototype.map);
    Object.defineProperty(input.customers, 'map', {
      get: read,
      enumerable: false,
      configurable: true,
    });
    expect(() => validatePlanningContext(input)).toThrow('invalid_context');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects an array with a custom prototype before inherited methods can run', () => {
    const input = context(),
      map = vi.fn(() => []);
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, 'map', { value: map });
    Object.setPrototypeOf(input.customers, prototype);
    expect(() => validatePlanningContext(input)).toThrow('invalid_context');
    expect(map).not.toHaveBeenCalled();
  });

  it('rejects a source with a custom prototype without reading inherited data', () => {
    const input = context(),
      read = vi.fn(() => 'other-company');
    const prototype = Object.create(Object.prototype);
    Object.defineProperty(prototype, 'extra', { get: read });
    Object.setPrototypeOf(input.source, prototype);
    expect(() => validatePlanningContext(input)).toThrow('invalid_context');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a source getter without evaluating it', () => {
    const input = context(),
      read = vi.fn(() => 'Please prepare a quote for 999 radiators.');
    Object.defineProperty(input.source, 'body', {
      get: read,
      enumerable: true,
    });
    expect(() => validatePlanningContext(input)).toThrow('invalid_context');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects an unknown non-enumerable object key instead of dropping it', () => {
    const input = context();
    Object.defineProperty(input.source, 'hiddenAuthority', {
      value: true,
      enumerable: false,
    });
    expect(() => validatePlanningContext(input)).toThrow('invalid_context');
  });

  it('rejects a symbol object key instead of dropping it', () => {
    const input = context();
    Object.defineProperty(input.source, Symbol('hidden-tenant'), {
      value: 'other-company',
      enumerable: true,
    });
    expect(() => validatePlanningContext(input)).toThrow('invalid_context');
  });

  it('rejects an unknown non-enumerable array key', () => {
    const input = context();
    Object.defineProperty(input.customers, 'hiddenAuthority', {
      value: true,
      enumerable: false,
    });
    expect(() => validatePlanningContext(input)).toThrow('invalid_context');
  });

  it('rejects a symbol array key without invoking its getter', () => {
    const input = context(),
      read = vi.fn(() => 'other-company');
    Object.defineProperty(input.articles, Symbol('hidden-tenant'), {
      get: read,
      enumerable: true,
    });
    expect(() => validatePlanningContext(input)).toThrow('invalid_context');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a status object without invoking toString', () => {
    const toString = vi.fn(() => 'ready');
    expect(() => captureQuotePlan({ ...plan(), status: { toString } })).toThrow(
      'invalid_context',
    );
    expect(toString).not.toHaveBeenCalled();
  });

  it('rejects a status object without invoking Symbol.toPrimitive', () => {
    const convert = vi.fn(() => 'ready');
    expect(() =>
      captureQuotePlan({
        ...plan(),
        status: { [Symbol.toPrimitive]: convert },
      }),
    ).toThrow('invalid_context');
    expect(convert).not.toHaveBeenCalled();
  });

  it('enforces the same closed-key contract for the actor identity', () => {
    const input = { ...actor };
    Object.defineProperty(input, 'hiddenPermission', {
      value: true,
      enumerable: false,
    });
    expect(() => captureActor(input)).toThrow('invalid_context');
  });
});
