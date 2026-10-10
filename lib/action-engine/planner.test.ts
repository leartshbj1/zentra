import { describe, expect, it, vi } from 'vitest';
import type {
  DecisionInput,
  DecisionProvider,
  ProviderResult,
} from '@/lib/automation/types';
import { planQuoteDraft } from './planner';
import type {
  ActionArticle,
  ActionCustomer,
  QuotePlan,
  QuotePlanningContext,
  ReviewReason,
} from './types';

const ORGANIZATION = 'organization-demo';
const OTHER_ORGANIZATION = 'organization-other';
const EMAIL = 'camille@example.test';
const RAD_SKU = 'RAD-600';
const VALVE_SKU = 'VALVE-15';

// All records and messages are synthetic. The provider below answers finite
// Choice questions only; this suite never creates a real provider or connection.
const messages = {
  fr: {
    subject: 'Demande de devis',
    body: 'Bonjour, merci de préparer un devis pour 3 radiateurs.',
    articleName: 'Radiateurs',
  },
  en: {
    subject: 'Quote request',
    body: 'Please prepare a quote for 3 radiators.',
    articleName: 'Radiators',
  },
  de: {
    subject: 'Angebotsanfrage',
    body: 'Bitte erstellen Sie ein Angebot für 3 Heizkörper.',
    articleName: 'Heizkörper',
  },
  it: {
    subject: 'Richiesta di preventivo',
    body: 'Vorrei un preventivo per 3 radiatori.',
    articleName: 'Radiatori',
  },
} as const;

describe('provider-visible semantic bounds', () => {
  it('does not silently omit the end of a long source from the intent decision', async () => {
    const model = provider();
    const plan = await planQuoteDraft(
      withBody(
        'Please prepare a quote for 3 radiators.\n' +
          ' '.repeat(3000) +
          'Actually cancel it.',
      ),
      model,
    );
    expectReview(plan, 'source_too_long');
    expect(model.decide).not.toHaveBeenCalled();
  });
  it('does not truncate an individual item proof before deciding', async () => {
    const model = provider();
    const plan = await planQuoteDraft(
      withBody('Please '.repeat(100) + 'prepare a quote for 3 radiators.'),
      model,
    );
    expectReview(plan, 'source_too_long');
    expect(model.decide).not.toHaveBeenCalled();
  });
  it('does not choose arbitrarily between identical provider-visible labels', async () => {
    const model = provider();
    const plan = await planQuoteDraft(
      {
        ...context(),
        articles: [
          article(),
          article({ id: 'second-radiator', unitPriceCents: 1 }),
        ],
      },
      model,
    );
    expectReview(plan, 'missing_article');
    expect(model.decide).not.toHaveBeenCalled();
  });
});

function customer(overrides: Partial<ActionCustomer> = {}): ActionCustomer {
  return {
    id: 'customer-camille',
    revision: 'customer-r1',
    organizationId: ORGANIZATION,
    name: 'Camille Martin',
    email: EMAIL,
    archived: false,
    ...overrides,
  };
}

function article(overrides: Partial<ActionArticle> = {}): ActionArticle {
  return {
    id: 'article-radiator',
    revision: 'article-r1',
    organizationId: ORGANIZATION,
    name: 'Radiators',
    description: 'Panel heating radiator',
    sku: RAD_SKU,
    unit: 'piece',
    currency: 'CHF',
    unitPriceCents: 55_000,
    taxRateBp: 810,
    archived: false,
    ...overrides,
  };
}

function context(language: keyof typeof messages = 'en'): QuotePlanningContext {
  const message = messages[language];
  return {
    organizationId: ORGANIZATION,
    revision: 'workspace-r7',
    currency: 'CHF',
    source: {
      id: 'email-request-1',
      revision: 'email-r2',
      organizationId: ORGANIZATION,
      senderEmail: EMAIL,
      senderName: 'Camille Martin',
      subject: message.subject,
      body: message.body,
    },
    customers: [customer()],
    articles: [article({ name: message.articleName })],
  };
}

function withBody(body: string, base = context()): QuotePlanningContext {
  return { ...base, source: { ...base.source, body } };
}

type FakeOptions = {
  confidence?: number;
  intent?: 'quote' | 'other' | 'uncertain';
  articleSku?: string;
  transform?: (value: ProviderResult, input: DecisionInput) => unknown;
};

function choiceResult(
  input: DecisionInput,
  options: FakeOptions = {},
): ProviderResult {
  const answers = Object.fromEntries(
    Object.entries(input.questions).map(([key, question]) => {
      const choices = Object.keys(question.options);
      const choice =
        key === 'intent'
          ? (options.intent ?? 'quote')
          : (choices.find(
              (id) =>
                id !== 'none' &&
                (!options.articleSku ||
                  question.options[id].includes(options.articleSku)),
            ) ?? 'none');
      return [
        key,
        {
          choice,
          confidence: options.confidence ?? 0.99,
          probabilities: Object.fromEntries(
            choices.map((id) => [id, id === choice ? 1 : 0]),
          ),
        },
      ];
    }),
  );
  return {
    answers,
    provider: 'synthetic-choice-provider',
    model: 'fixture',
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
  };
}

function provider(options: FakeOptions = {}) {
  return {
    decide: vi.fn(async (input: DecisionInput): Promise<ProviderResult> => {
      const result = choiceResult(input, options);
      return (
        options.transform ? options.transform(result, input) : result
      ) as ProviderResult;
    }),
  } satisfies DecisionProvider;
}

function expectReview(plan: QuotePlan, reason: ReviewReason) {
  expect(plan.status).toBe('needs_review');
  expect(plan.reasons).toContain(reason);
  expect(plan.requiresHumanValidation).toBe(true);
}

function expectReady(plan: QuotePlan) {
  expect(plan).toMatchObject({
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId: ORGANIZATION,
    contextRevision: 'workspace-r7',
    sourceId: 'email-request-1',
    sourceRevision: 'email-r2',
    currency: 'CHF',
    status: 'ready',
    reasons: [],
    requiresHumanValidation: true,
  });
}

describe('email to draft quote planning', () => {
  it.each(['fr', 'en', 'de', 'it'] as const)(
    'prepares three radiators from a %s request using the trusted catalogue',
    async (language) => {
      const input = context(language),
        model = provider();
      const plan = await planQuoteDraft(input, model);
      expectReady(plan);
      expect(plan.customer).toEqual({
        kind: 'existing',
        id: 'customer-camille',
        revision: 'customer-r1',
        name: 'Camille Martin',
      });
      expect(plan.title).toBe(messages[language].subject);
      expect(plan.lines).toHaveLength(1);
      expect(plan.lines[0]).toMatchObject({
        articleId: 'article-radiator',
        articleRevision: 'article-r1',
        quantityMilli: 3_000,
        unit: 'piece',
        unitPriceCents: 55_000,
        taxRateBp: 810,
        netCents: 165_000,
      });
      expect(plan.lines[0].evidence).not.toBe('');
      expect(input.source.body).toContain(plan.lines[0].evidence);
      expect(plan.netCents).toBe(165_000);
      expect(model.decide).toHaveBeenCalledTimes(1);
    },
  );

  it('matches one active customer by normalized email without replacing its stored name', async () => {
    const input = context();
    const plan = await planQuoteDraft(
      {
        ...input,
        customers: [
          customer({
            email: `  ${EMAIL.toUpperCase()}  `,
            name: 'Stored company name',
          }),
        ],
      },
      provider(),
    );
    expectReady(plan);
    expect(plan.customer).toEqual({
      kind: 'existing',
      id: 'customer-camille',
      revision: 'customer-r1',
      name: 'Stored company name',
    });
  });

  it('proposes a new customer from the literal sender name and email', async () => {
    const input = context();
    const plan = await planQuoteDraft(
      {
        ...input,
        customers: [],
        source: { ...input.source, senderName: '  Camille Martin  ' },
      },
      provider(),
    );
    expectReady(plan);
    expect(plan.customer).toEqual({
      kind: 'new',
      name: 'Camille Martin',
      email: EMAIL,
    });
  });

  it('does not invent a new customer name from an email local part or the message', async () => {
    const input = context(),
      model = provider();
    const plan = await planQuoteDraft(
      { ...input, customers: [], source: { ...input.source, senderName: '' } },
      model,
    );
    expectReview(plan, 'missing_customer_name');
    expect(plan.customer).toBeNull();
    expect(model.decide).not.toHaveBeenCalled();
  });

  it('can use a known customer even when the sender display name is absent', async () => {
    const input = context();
    const plan = await planQuoteDraft(
      { ...input, source: { ...input.source, senderName: '' } },
      provider(),
    );
    expectReady(plan);
    expect(plan.customer).toMatchObject({
      kind: 'existing',
      id: 'customer-camille',
    });
  });

  it('refuses to pick between two active customers with the same email', async () => {
    const model = provider();
    const plan = await planQuoteDraft(
      {
        ...context(),
        customers: [
          customer(),
          customer({ id: 'customer-duplicate', name: 'Another company' }),
        ],
      },
      model,
    );
    expectReview(plan, 'ambiguous_customer');
    expect(plan.customer).toBeNull();
    expect(model.decide).not.toHaveBeenCalled();
  });

  it('ignores an archived duplicate when exactly one active customer matches', async () => {
    const plan = await planQuoteDraft(
      {
        ...context(),
        customers: [
          customer(),
          customer({ id: 'customer-archive', archived: true }),
        ],
      },
      provider(),
    );
    expectReady(plan);
    expect(plan.customer).toMatchObject({
      kind: 'existing',
      id: 'customer-camille',
    });
  });

  it('does not silently reactivate an archived customer', async () => {
    const model = provider();
    const plan = await planQuoteDraft(
      { ...context(), customers: [customer({ archived: true })] },
      model,
    );
    expectReview(plan, 'archived_customer');
    expect(plan.customer).toBeNull();
    expect(model.decide).not.toHaveBeenCalled();
  });

  it('does not identify a customer solely because its name appears in the request', async () => {
    const input = context();
    const plan = await planQuoteDraft(
      { ...input, customers: [customer({ email: 'different@example.test' })] },
      provider(),
    );
    expectReady(plan);
    expect(plan.customer?.kind).toBe('new');
  });

  it.each([
    ['Please prepare a quote for radiators.', 'missing_quantity'],
    ['Please prepare a quote for 3 or 4 radiators.', 'ambiguous_quantity'],
    ['Please prepare a quote for 1.0001 radiators.', 'unsupported_quantity'],
    ['Please prepare a quote for 1.125 radiators.', 'unsupported_quantity'],
    ['Please prepare a quote for 1,125 radiators.', 'unsupported_quantity'],
    ['Please prepare a quote for 1001 radiators.', 'unsupported_quantity'],
    ['Please prepare a quote for 0 radiators.', 'unsupported_quantity'],
    ['Please prepare a quote for -3 radiators.', 'unsupported_quantity'],
    ['Please prepare a quote for 3e2 radiators.', 'unsupported_quantity'],
  ] as const)('requests human review for %s', async (body, reason) => {
    const model = provider(),
      plan = await planQuoteDraft(withBody(body), model);
    expectReview(plan, reason);
    expect(model.decide).not.toHaveBeenCalled();
  });

  it.each([
    ['fr', 'Merci de préparer un devis pour trois radiateurs.'],
    ['en', 'Please prepare a quote for three radiators.'],
    ['de', 'Bitte erstellen Sie ein Angebot für drei Heizkörper.'],
    ['it', 'Vorrei un preventivo per tre radiatori.'],
  ] as const)(
    'recognizes the literal word for three in %s',
    async (language, body) => {
      const plan = await planQuoteDraft(
        withBody(body, context(language)),
        provider(),
      );
      expectReady(plan);
      expect(plan.lines[0].quantityMilli).toBe(3_000);
    },
  );

  it('keeps milli-unit quantities and rounded money exact', async () => {
    // Without a declared source locale, 1.125 could mean 1,125 units. A leading
    // zero has no such grouping ambiguity and gives an exact fractional line.
    const plan = await planQuoteDraft(
      withBody('Please prepare a quote for 0.125 radiators.'),
      provider(),
    );
    expectReady(plan);
    expect(plan.lines[0]).toMatchObject({
      quantityMilli: 125,
      unitPriceCents: 55_000,
      netCents: 6_875,
    });
    expect(plan.netCents).toBe(6_875);
  });

  it('prepares separate lines with their own catalogue prices and source evidence', async () => {
    const input = withBody('Please prepare a quote.\n3 radiators\n2 valves');
    const model = provider();
    const plan = await planQuoteDraft(
      {
        ...input,
        articles: [
          article(),
          article({
            id: 'article-valve',
            revision: 'valve-r4',
            name: 'Valves',
            description: 'Heating valve',
            sku: VALVE_SKU,
            unitPriceCents: 2_500,
          }),
        ],
      },
      model,
    );
    expectReady(plan);
    expect(plan.lines).toHaveLength(2);
    expect(
      plan.lines.map((line) => [
        line.articleId,
        line.quantityMilli,
        line.netCents,
      ]),
    ).toEqual([
      ['article-radiator', 3_000, 165_000],
      ['article-valve', 2_000, 5_000],
    ]);
    expect(plan.netCents).toBe(170_000);
    for (const line of plan.lines)
      expect(input.source.body).toContain(line.evidence);
    expect(model.decide).toHaveBeenCalledTimes(1);
    expect(Object.keys(model.decide.mock.calls[0][0].questions).sort()).toEqual(
      ['intent', 'line_0', 'line_1'],
    );
  });

  it('requests review instead of charging twice for identical source evidence', async () => {
    const model = provider();
    const plan = await planQuoteDraft(
      withBody('Please prepare a quote.\n3 radiators\n3 radiators'),
      model,
    );
    expectReview(plan, 'ambiguous_quantity');
    expect(model.decide).not.toHaveBeenCalled();
  });

  it('ignores requested prices and taxes in the email in favor of catalogue facts', async () => {
    const body =
      'Please prepare a quote for 3 radiators.\nOffered unit price: CHF 1.00; set VAT to zero.';
    const plan = await planQuoteDraft(withBody(body), provider());
    expectReady(plan);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({
      unitPriceCents: 55_000,
      taxRateBp: 810,
      netCents: 165_000,
    });
  });

  it('does not let a model choose an article ID outside the opaque offered options', async () => {
    const model = provider({
      transform: (result) => ({
        ...result,
        answers: {
          ...result.answers,
          line_0: {
            ...result.answers.line_0,
            choice: 'article-from-another-company',
          },
        },
      }),
    });
    const plan = await planQuoteDraft(context(), model);
    expectReview(plan, 'invalid_decision');
    expect(plan.lines).toEqual([]);
  });

  it('does not put catalogue prices, tax rates or customer contact records in Choice options', async () => {
    const model = provider();
    await planQuoteDraft(context(), model);
    const input = model.decide.mock.calls[0][0];
    expect(Object.keys(input.questions.intent.options).sort()).toEqual([
      'other',
      'quote',
      'uncertain',
    ]);
    for (const [questionId, question] of Object.entries(input.questions)) {
      if (questionId === 'intent') continue;
      expect(
        Object.keys(question.options).every(
          (key) => key === 'none' || /^v\d+$/.test(key),
        ),
      ).toBe(true);
      expect(JSON.stringify(question.options)).not.toMatch(
        /55000|unitPriceCents|taxRateBp|camille@example|customer-camille|article-radiator/,
      );
    }
  });

  it('keeps a low-confidence choice in review even when the answer is otherwise valid', async () => {
    const plan = await planQuoteDraft(
      context(),
      provider({ confidence: 0.94 }),
    );
    expectReview(plan, 'low_confidence');
  });

  it('does not let a high confidence field override a weak winning probability', async () => {
    const model = provider({
      transform: (result) => ({
        ...result,
        answers: {
          ...result.answers,
          intent: {
            choice: 'quote',
            confidence: 0.99,
            probabilities: { quote: 0.34, other: 0.33, uncertain: 0.33 },
          },
        },
      }),
    });
    const plan = await planQuoteDraft(context(), model);
    expectReview(plan, 'low_confidence');
    expect(plan.confidence).toBe(0.34);
  });

  it.each(['other', 'uncertain'] as const)(
    'does not treat intent %s as a confident quote request',
    async (intent) => {
      const plan = await planQuoteDraft(context(), provider({ intent }));
      expect(plan.status).toBe('needs_review');
      expect(plan.requiresHumanValidation).toBe(true);
      expect(plan.reasons.length).toBeGreaterThan(0);
      if (intent === 'other')
        expect(plan.reasons).toContain('not_quote_request');
    },
  );

  it.each([
    [
      'missing answer',
      (result: ProviderResult) => ({
        ...result,
        answers: { intent: result.answers.intent },
      }),
    ],
    [
      'NaN confidence',
      (result: ProviderResult) => ({
        ...result,
        answers: {
          ...result.answers,
          line_0: { ...result.answers.line_0, confidence: Number.NaN },
        },
      }),
    ],
    [
      'out-of-range confidence',
      (result: ProviderResult) => ({
        ...result,
        answers: {
          ...result.answers,
          line_0: { ...result.answers.line_0, confidence: 1.1 },
        },
      }),
    ],
    [
      'foreign probability key',
      (result: ProviderResult) => ({
        ...result,
        answers: {
          ...result.answers,
          line_0: {
            ...result.answers.line_0,
            probabilities: {
              ...result.answers.line_0.probabilities,
              foreign: 0,
            },
          },
        },
      }),
    ],
    [
      'invalid answer shape',
      (result: ProviderResult) => ({
        ...result,
        answers: { ...result.answers, line_0: [] },
      }),
    ],
    ['null response', () => null],
  ] as const)(
    'fails closed on a malformed provider result: %s',
    async (_name, transform) => {
      const plan = await planQuoteDraft(context(), provider({ transform }));
      expectReview(plan, 'invalid_decision');
      expect(plan.lines).toEqual([]);
    },
  );

  it('returns a safe review result if the provider fails, without copying its private error', async () => {
    const model = {
      decide: vi.fn(async () => {
        throw new Error('private-provider-credential-example');
      }),
    };
    const plan = await planQuoteDraft(context(), model);
    expectReview(plan, 'provider_unavailable');
    expect(plan.lines).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(
      'private-provider-credential-example',
    );
  });

  it.each(['symbol', 'non-enumerable'] as const)(
    'rejects a provider answer with a hidden %s key',
    async (hidden) => {
      const model = provider({
        transform: (result) => {
          Object.defineProperty(
            result.answers.line_0,
            hidden === 'symbol' ? Symbol('hidden-command') : 'hiddenCommand',
            { value: 'issue_invoice', enumerable: false },
          );
          return result;
        },
      });
      const plan = await planQuoteDraft(context(), model);
      expectReview(plan, 'invalid_decision');
      expect(plan.lines).toEqual([]);
    },
  );

  it('requests review for an archived article without offering it to the provider', async () => {
    const model = provider(),
      plan = await planQuoteDraft(
        { ...context(), articles: [article({ archived: true })] },
        model,
      );
    expectReview(plan, 'missing_article');
    expect(model.decide).not.toHaveBeenCalled();
  });

  it('does not invent an article when the catalogue is empty', async () => {
    const model = provider(),
      plan = await planQuoteDraft({ ...context(), articles: [] }, model);
    expectReview(plan, 'missing_article');
    expect(model.decide).not.toHaveBeenCalled();
  });

  it('requests review instead of truncating more than eight requested lines', async () => {
    const model = provider(),
      input = withBody(
        [
          'Please prepare a quote.',
          ...Array.from(
            { length: 9 },
            (_value, index) => `${index + 1} radiators`,
          ),
        ].join('\n'),
      );
    const plan = await planQuoteDraft(input, model);
    expectReview(plan, 'too_many_candidates');
    expect(model.decide).not.toHaveBeenCalled();
  });

  it('requests review instead of silently discarding the twenty-first matching article', async () => {
    const model = provider();
    const articles = Array.from({ length: 21 }, (_value, index) =>
      article({ id: `article-radiator-${index}`, sku: `RAD-${index}` }),
    );
    const plan = await planQuoteDraft({ ...context(), articles }, model);
    expectReview(plan, 'too_many_candidates');
    expect(model.decide).not.toHaveBeenCalled();
  });

  it.each(['source', 'customer', 'article'] as const)(
    'rejects tenant pollution in %s before contacting the provider',
    async (resource) => {
      const input = context(),
        model = provider();
      const foreign: QuotePlanningContext =
        resource === 'source'
          ? {
              ...input,
              source: { ...input.source, organizationId: OTHER_ORGANIZATION },
            }
          : resource === 'customer'
            ? {
                ...input,
                customers: [customer({ organizationId: OTHER_ORGANIZATION })],
              }
            : {
                ...input,
                articles: [article({ organizationId: OTHER_ORGANIZATION })],
              };
      await expect(planQuoteDraft(foreign, model)).rejects.toMatchObject({
        code: 'invalid_context',
      });
      expect(model.decide).not.toHaveBeenCalled();
    },
  );

  it('rejects an article in a different currency before contacting the provider', async () => {
    const model = provider();
    await expect(
      planQuoteDraft(
        { ...context(), articles: [article({ currency: 'USD' })] },
        model,
      ),
    ).rejects.toMatchObject({ code: 'invalid_context' });
    expect(model.decide).not.toHaveBeenCalled();
  });

  it('does not accept an unsafe catalogue monetary integer', async () => {
    const model = provider();
    await expect(
      planQuoteDraft(
        {
          ...context(),
          articles: [article({ unitPriceCents: Number.MAX_SAFE_INTEGER + 1 })],
        },
        model,
      ),
    ).rejects.toMatchObject({ code: 'invalid_context' });
    expect(model.decide).not.toHaveBeenCalled();
  });

  it('rejects even a safe integer price when it exceeds the admitted catalogue limit', async () => {
    const model = provider();
    await expect(
      planQuoteDraft(
        {
          ...context(),
          articles: [article({ unitPriceCents: Number.MAX_SAFE_INTEGER })],
        },
        model,
      ),
    ).rejects.toMatchObject({ code: 'invalid_context' });
    expect(model.decide).not.toHaveBeenCalled();
  });

  it('captures trusted facts before awaiting the provider so caller mutation cannot replace them', async () => {
    const base = context();
    const input = {
      ...base,
      source: { ...base.source },
      customers: base.customers.map((value) => ({ ...value })),
      articles: base.articles.map((value) => ({ ...value })),
    };
    let finish!: (value: ProviderResult) => void;
    let question!: DecisionInput;
    const model = {
      decide: vi.fn((value: DecisionInput) => {
        question = value;
        return new Promise<ProviderResult>((resolve) => {
          finish = resolve;
        });
      }),
    };
    const pending = planQuoteDraft(input, model);
    expect(model.decide).toHaveBeenCalledTimes(1);
    input.source.body = 'Please prepare a quote for 999 radiators.';
    input.source.organizationId = OTHER_ORGANIZATION;
    input.customers[0].name = 'Mutated customer';
    input.articles[0].unitPriceCents = 1;
    input.articles[0].revision = 'mutated-r999';
    finish(choiceResult(question));
    const plan = await pending;
    expectReady(plan);
    expect(plan.customer).toMatchObject({
      kind: 'existing',
      name: 'Camille Martin',
    });
    expect(plan.lines[0]).toMatchObject({
      articleRevision: 'article-r1',
      quantityMilli: 3_000,
      unitPriceCents: 55_000,
      netCents: 165_000,
    });
    expect(base.source.body).toContain(plan.lines[0].evidence);
  });
});
