import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commitAutomationWorkflow,
  normalizeAutomationSource,
  prepareAutomationWorkflow,
  resolveLocalMeetingTime,
  type AutomationDependencies,
  type AutomationRunRecord,
  type AutomationRunStore,
  type ExecutionAuthority,
  type HumanApproval,
} from './automation';
import {
  proposeSubscriptionPlanChange,
  resolveSubscriptionOffer,
  subscriptionRights,
  verifyServerStripePrice,
  type SaasSubscriptionAuthority,
  type SaasSubscriptionOffer,
  type ServerStripePrice,
} from './subscriptions';
import type { CompanyConfiguration } from './types';

// Contract fixtures only: no catalogue prices, provider responses, approvals or grants below are live resources.
const NOW = Math.floor(Date.parse('2026-10-07T10:00:00Z') / 1000);
const CH: CompanyConfiguration = {
  schemaVersion: 1,
  organizationId: 'org-ch',
  country: 'CH',
  currency: 'CHF',
  language: 'fr',
  timeZone: 'Europe/Zurich',
  address: {
    country: 'CH',
    line1: 'Rue fictive 1',
    postalCode: '1201',
    city: 'Genève',
    subdivision: 'GE',
  },
  accountingBasis: 'accrual',
  invoiceNumberPrefix: 'TEST',
  taxConfiguration: { status: 'unconfigured' },
};
const US: CompanyConfiguration = {
  ...CH,
  organizationId: 'org-us',
  country: 'US',
  currency: 'USD',
  language: 'en',
  timeZone: 'America/New_York',
  address: {
    country: 'US',
    line1: '1 Fictional Street',
    postalCode: '10001',
    city: 'New York',
    subdivision: 'NY',
  },
};
function offer(
  overrides: Partial<SaasSubscriptionOffer> = {},
): SaasSubscriptionOffer {
  return {
    kind: 'saas_subscription',
    catalogVersion: 'mock-catalog-v1',
    country: 'CH',
    currency: 'CHF',
    module: 'gestion',
    plan: 'mock-plan',
    priceId: 'price_mock_gestion',
    productId: 'prod_mock_gestion',
    environment: 'TEST',
    unitAmountMinor: '1234',
    interval: 'month',
    intervalCount: 1,
    taxBehavior: 'exclusive',
    ...overrides,
  };
}
function price(selected = offer()): ServerStripePrice {
  return {
    id: selected.priceId,
    active: true,
    livemode: selected.environment === 'PRODUCTION',
    currency: selected.currency.toLowerCase(),
    unit_amount: Number(selected.unitAmountMinor),
    type: 'recurring',
    tax_behavior: selected.taxBehavior,
    recurring: {
      interval: selected.interval,
      interval_count: selected.intervalCount,
      usage_type: 'licensed',
    },
    product: { id: selected.productId, active: true },
  };
}
function subscription(selected = offer()): SaasSubscriptionAuthority {
  const organizationId = selected.country === 'US' ? 'org-us' : 'org-ch';
  return {
    kind: 'saas_subscription_authority',
    organizationId,
    subscriptionId: `sub_mock_${selected.module}`,
    offer: selected,
    status: 'active',
    evidence: {
      kind: 'verified_payment',
      referenceId: `mock-invoice-${selected.module}`,
      organizationId,
      subscriptionId: `sub_mock_${selected.module}`,
      environment: selected.environment,
      catalogVersion: selected.catalogVersion,
      priceId: selected.priceId,
      currency: selected.currency,
      startsAt: NOW - 3600,
      endsAt: NOW + 3600,
      revoked: false,
    },
  };
}
const rights = (
  authority: SaasSubscriptionAuthority | null,
  company: CompanyConfiguration = CH,
  now = NOW,
) =>
  subscriptionRights(company, authority, {
    module: 'gestion',
    environment: 'TEST',
    now,
  });

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('External networking forbidden in contract tests');
    }),
  ),
);
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('server subscription catalogue and verified prices', () => {
  it('does not infer a US offer or reuse a Swiss price', () => {
    expect(() =>
      resolveSubscriptionOffer(
        US,
        { module: 'gestion', plan: 'mock-plan', environment: 'TEST' },
        [offer()],
      ),
    ).toThrow('offer_unavailable');
    expect(() =>
      resolveSubscriptionOffer(
        US,
        { module: 'gestion', plan: 'mock-plan', environment: 'TEST' },
        [offer({ country: 'US', currency: 'CHF' })],
      ),
    ).toThrow('invalid_offer');
    expect(() =>
      resolveSubscriptionOffer(
        CH,
        { module: 'gestion', plan: 'mock-plan', environment: 'PRODUCTION' },
        [offer()],
      ),
    ).toThrow('offer_unavailable');
  });
  it('accepts an explicit synthetic USD catalogue only after exact server validation', () => {
    const entry = offer({
      country: 'US',
      currency: 'USD',
      priceId: 'price_mock_us',
      productId: 'prod_mock_us',
    });
    const selected = resolveSubscriptionOffer(
      US,
      { module: 'gestion', plan: 'mock-plan', environment: 'TEST' },
      [entry],
    );
    expect(verifyServerStripePrice(selected, price(selected))).toEqual(entry);
    expect(Object.isFrozen(selected)).toBe(true);
  });
  it('refuses duplicate catalogue matches and protects the selected snapshot from caller mutation', () => {
    const entry = { ...offer() };
    expect(() =>
      resolveSubscriptionOffer(
        CH,
        { module: 'gestion', plan: 'mock-plan', environment: 'TEST' },
        [entry, { ...entry }],
      ),
    ).toThrow('ambiguous_offer');
    const selected = resolveSubscriptionOffer(
      CH,
      { module: 'gestion', plan: 'mock-plan', environment: 'TEST' },
      [entry],
    );
    entry.plan = 'caller-changed';
    expect(selected.plan).toBe('mock-plan');
  });
  it.each([
    ['wrong id', { id: 'price_other' }],
    ['inactive', { active: false }],
    ['live price in TEST', { livemode: true }],
    ['currency', { currency: 'usd' }],
    ['amount', { unit_amount: 1235 }],
    ['fractional amount', { unit_amount: 1234.5 }],
    ['unknown amount', { unit_amount: null }],
    ['one time', { type: 'one_time' }],
    ['tax behavior', { tax_behavior: 'inclusive' }],
    ['unexpanded product', { product: 'prod_mock_gestion' }],
    [
      'deleted product',
      { product: { id: 'prod_mock_gestion', active: true, deleted: true } },
    ],
    ['wrong product', { product: { id: 'prod_other', active: true } }],
    [
      'inactive product',
      { product: { id: 'prod_mock_gestion', active: false } },
    ],
    [
      'yearly interval',
      {
        recurring: {
          interval: 'year',
          interval_count: 1,
          usage_type: 'licensed',
        },
      },
    ],
    [
      'interval count',
      {
        recurring: {
          interval: 'month',
          interval_count: 2,
          usage_type: 'licensed',
        },
      },
    ],
    [
      'metered',
      {
        recurring: {
          interval: 'month',
          interval_count: 1,
          usage_type: 'metered',
        },
      },
    ],
    ['no recurrence', { recurring: null }],
  ] as const)('rejects %s', (_name, patch) =>
    expect(() =>
      verifyServerStripePrice(offer(), {
        ...price(),
        ...patch,
      } as ServerStripePrice),
    ).toThrow('price_mismatch'),
  );
});

describe('organization rights and plan-change proposals', () => {
  it('preferences and a cached active status grant no writes', () => {
    expect(rights(null).access).toBe('read_only');
    expect(rights({ ...subscription(), evidence: null }).reason).toBe(
      'missing_evidence',
    );
    expect(
      rights(subscription(), { ...CH, organizationId: 'another-organization' })
        .access,
    ).toBe('read_only');
  });
  it.each([
    'organizationId',
    'subscriptionId',
    'environment',
    'catalogVersion',
    'priceId',
    'currency',
  ] as const)('rejects evidence with mismatched %s', (name) => {
    const current = subscription();
    const altered = {
      ...current.evidence!,
      [name]:
        name === 'environment'
          ? 'PRODUCTION'
          : name === 'currency'
            ? 'USD'
            : 'other',
    };
    expect(rights({ ...current, evidence: altered }).access).toBe('read_only');
  });
  it('makes revoked/expired/future periods read-only at exact boundaries', () => {
    const current = subscription();
    expect(rights(current, CH, current.evidence!.startsAt).access).toBe(
      'read_write',
    );
    expect(rights(current, CH, current.evidence!.startsAt - 1).access).toBe(
      'read_only',
    );
    expect(rights(current, CH, current.evidence!.endsAt).reason).toBe(
      'expired',
    );
    expect(
      rights({ ...current, evidence: { ...current.evidence!, revoked: true } })
        .reason,
    ).toBe('revoked');
  });
  it('a paid canceled/past_due subscription keeps only its verified paid period', () => {
    for (const status of ['canceled', 'past_due'] as const) {
      const current = { ...subscription(), status };
      expect(rights(current).access).toBe('read_write');
      expect(rights(current, CH, current.evidence!.endsAt).access).toBe(
        'read_only',
      );
    }
  });
  it('a trial requires independently authorized evidence and the trialing state', () => {
    const trial = {
      ...subscription(),
      status: 'trialing' as const,
      evidence: {
        ...subscription().evidence!,
        kind: 'authorized_trial' as const,
      },
    };
    expect(rights(trial).access).toBe('read_write');
    expect(rights({ ...trial, status: 'active' }).access).toBe('read_only');
    expect(rights({ ...trial, evidence: null }).access).toBe('read_only');
  });
  it('Complet covers its modules within the same country, organization and environment', () => {
    const pack = subscription(offer({ module: 'complet' }));
    for (const requiredModule of [
      'gestion',
      'support',
      'automation',
      'complet',
    ] as const) {
      expect(
        subscriptionRights(CH, pack, {
          module: requiredModule,
          environment: 'TEST',
          now: NOW,
        }).access,
      ).toBe('read_write');
    }
    expect(
      subscriptionRights(US, pack, {
        module: 'automation',
        environment: 'TEST',
        now: NOW,
      }).access,
    ).toBe('read_only');
    expect(
      subscriptionRights(CH, pack, {
        module: 'automation',
        environment: 'PRODUCTION',
        now: NOW,
      }).access,
    ).toBe('read_only');
  });
  it('plan changes propose provider confirmation without losing the organization or existing data', () => {
    const current = subscription(),
      target = offer({ plan: 'mock-higher', priceId: 'price_mock_higher' });
    const original = structuredClone(current);
    const proposal = proposeSubscriptionPlanChange(CH, current, target, NOW);
    expect(proposal).toMatchObject({
      kind: 'saas_plan_change',
      organizationId: CH.organizationId,
      subscriptionId: current.subscriptionId,
      requiresProviderConfirmation: true,
      preserveExistingData: true,
    });
    expect(current).toEqual(original);
    expect(() =>
      proposeSubscriptionPlanChange(
        CH,
        current,
        offer({ country: 'US', currency: 'USD' }),
        NOW,
      ),
    ).toThrow('scope_mismatch');
    expect(() =>
      proposeSubscriptionPlanChange(
        CH,
        current,
        target,
        current.evidence!.endsAt,
      ),
    ).toThrow('access_denied');
  });
});

const invoiceSource = (company: CompanyConfiguration = CH) => ({
  kind: 'vendor_invoice',
  organizationId: company.organizationId,
  sourceId: 'mock-invoice-source',
  language: 'en',
  text: 'Original supplier text, do not translate.',
  supplierId: 'supplier-mock',
  invoiceReference: 'INV-MOCK',
  amounts: {
    net: { currency: company.currency, minorUnits: '45000' },
    tax: { currency: company.currency, minorUnits: '3645' },
    total: { currency: company.currency, minorUnits: '48645' },
  },
});
const requestSource = (company: CompanyConfiguration = CH) => ({
  kind: 'customer_request',
  organizationId: company.organizationId,
  sourceId: 'mock-request',
  language: 'fr',
  text: 'Bonjour, mon chantier doit rester tel quel.',
  customerId: 'customer-mock',
  subject: 'Question sur mon chantier',
});

describe('country-independent normalized sources and explicit meeting times', () => {
  it('normalizes EN/FR field labels while preserving original text and exact amounts', () => {
    const fr = {
      ...invoiceSource(),
      kind: 'facture_fournisseur',
      language: 'fr',
      text: 'Le texte du fournisseur reste original.',
    };
    expect(normalizeAutomationSource(fr, CH)).toMatchObject({
      kind: 'vendor_invoice',
      text: fr.text,
      amounts: { total: { minorUnits: '48645' } },
    });
    const {
      language: _language,
      text: _text,
      subject: _subject,
      ...rest
    } = requestSource(US);
    expect(
      normalizeAutomationSource(
        {
          ...rest,
          kind: 'demande_client',
          langue: 'fr',
          texte: 'Texte français aux États-Unis',
          objet: 'Objet original',
        },
        US,
      ),
    ).toMatchObject({
      language: 'fr',
      text: 'Texte français aux États-Unis',
      subject: 'Objet original',
    });
    expect(normalizeAutomationSource(invoiceSource(US), US).kind).toBe(
      'vendor_invoice',
    );
  });
  it('requires structured invoice facts instead of extracting free-text amounts', () => {
    const { amounts: _amounts, ...unstructured } = invoiceSource();
    expect(() =>
      normalizeAutomationSource(
        { ...unstructured, text: 'Please pay CHF 486.45' },
        CH,
      ),
    ).toThrow('invalid_source');
    const wrongTotal = invoiceSource();
    wrongTotal.amounts.total.minorUnits = '48646';
    expect(() => normalizeAutomationSource(wrongTotal, CH)).toThrow(
      'invalid_source',
    );
    expect(() => normalizeAutomationSource(invoiceSource(CH), US)).toThrow(
      'invalid_source',
    );
    expect(() =>
      normalizeAutomationSource(
        { ...invoiceSource(US), amounts: invoiceSource(CH).amounts },
        US,
      ),
    ).toThrow('invalid_source');
  });
  it('rejects conflicting aliases, unsafe kinds and extra guessed fields', () => {
    expect(() =>
      normalizeAutomationSource({ ...requestSource(), langue: 'fr' }, CH),
    ).toThrow('invalid_source');
    expect(() =>
      normalizeAutomationSource({ ...requestSource(), kind: 'toString' }, CH),
    ).toThrow('invalid_source');
    expect(() =>
      normalizeAutomationSource(
        { ...requestSource(), bankAccount: 'guessed' },
        CH,
      ),
    ).toThrow('invalid_source');
  });
  it('resolves an explicit zone and blocks DST folds/gaps and invalid calendar dates', () => {
    expect(
      resolveLocalMeetingTime('2026-10-08T10:00', 'America/New_York'),
    ).toBe(Date.parse('2026-10-08T14:00:00Z') / 1000);
    expect(resolveLocalMeetingTime('2026-10-08T10:00', 'Europe/Zurich')).toBe(
      Date.parse('2026-10-08T08:00:00Z') / 1000,
    );
    expect(() =>
      resolveLocalMeetingTime('2026-03-08T02:30', 'America/New_York'),
    ).toThrow('nonexistent_time');
    expect(() =>
      resolveLocalMeetingTime('2026-11-01T01:30', 'America/New_York'),
    ).toThrow('ambiguous_time');
    expect(() => resolveLocalMeetingTime('2026-10-08T10:00', '')).toThrow(
      'invalid_time_zone',
    );
    expect(() =>
      resolveLocalMeetingTime('2026-02-30T10:00', 'America/New_York'),
    ).toThrow('invalid_source');
  });
  it('meeting normalization needs the configured explicit zone and a positive duration', () => {
    const meeting = {
      kind: 'rendez_vous',
      organizationId: US.organizationId,
      sourceId: 'mock-meeting',
      langue: 'fr',
      texte: 'Réunion originale',
      titre: 'Visite',
      debutLocal: '2026-10-08T10:00',
      finLocale: '2026-10-08T10:45',
      fuseauHoraire: US.timeZone,
    };
    const normalized = normalizeAutomationSource(meeting, US);
    expect(
      normalized.kind === 'meeting' && normalized.endsAt - normalized.startsAt,
    ).toBe(2700);
    expect(() =>
      normalizeAutomationSource(
        { ...meeting, fuseauHoraire: 'Europe/Zurich' },
        US,
      ),
    ).toThrow('invalid_time_zone');
    expect(() =>
      normalizeAutomationSource(
        { ...meeting, finLocale: meeting.debutLocal },
        US,
      ),
    ).toThrow('invalid_source');
  });
});

/** Explicit mock durable CAS adapter; it proves library contracts, not a production database. */
class MockRunStore implements AutomationRunStore {
  private readonly rows = new Map<string, AutomationRunRecord>();
  beforeCas: ((next: AutomationRunRecord) => void) | null = null;
  async createIfAbsent(record: AutomationRunRecord) {
    const id = `${record.organizationId}/${record.requestId}`;
    const previous = this.rows.get(id);
    if (previous) return { created: false, record: structuredClone(previous) };
    this.rows.set(id, structuredClone(record));
    return { created: true, record: structuredClone(record) };
  }
  async read(organizationId: string, requestId: string) {
    const row = this.rows.get(`${organizationId}/${requestId}`);
    return row ? structuredClone(row) : null;
  }
  async compareAndSwap(
    organizationId: string,
    requestId: string,
    revision: number,
    next: AutomationRunRecord,
  ) {
    this.beforeCas?.(next);
    const id = `${organizationId}/${requestId}`,
      old = this.rows.get(id);
    if (!old || old.revision !== revision) return null;
    if (
      next.revision !== revision + 1 ||
      next.organizationId !== old.organizationId ||
      next.requestId !== old.requestId ||
      next.fingerprint !== old.fingerprint ||
      next.actorId !== old.actorId ||
      next.authorityFingerprint !== old.authorityFingerprint ||
      JSON.stringify(next.source) !== JSON.stringify(old.source)
    )
      throw new Error('Mock CAS rejected immutable change');
    this.rows.set(id, structuredClone(next));
    return structuredClone(next);
  }
}
function fixture(company: CompanyConfiguration = CH) {
  const countryOffer = { country: company.country, currency: company.currency };
  let current: ExecutionAuthority = {
    organizationId: company.organizationId,
    userId: 'mock-owner',
    membershipActive: true,
    role: 'owner',
    company,
    environment: 'TEST',
    subscriptions: [
      subscription(offer({ ...countryOffer })),
      subscription(
        offer({
          ...countryOffer,
          module: 'automation',
          priceId: 'price_mock_auto',
          productId: 'prod_mock_auto',
        }),
      ),
    ],
    consent: { approved: true, version: 'mock-consent-v1' },
    enabledWorkflows: ['vendor_invoice', 'customer_request', 'meeting'],
  };
  let now = NOW;
  const approvals = new Map<string, HumanApproval>(),
    store = new MockRunStore();
  const classifier = {
    classify: vi.fn(async (source: { kind: string }) => ({
      kind: source.kind,
      confidence: 0.99,
    })),
  };
  const sink = {
    commit: vi.fn(
      async (
        _input: Parameters<AutomationDependencies['sink']['commit']>[0],
      ) => ({ referenceId: 'mock-effect-1' }),
    ),
  };
  const deps: AutomationDependencies = {
    store,
    classifier,
    sink,
    clock: () => now,
    readAuthority: vi.fn(async () => structuredClone(current)),
    readApproval: vi.fn(async (id) => approvals.get(id) ?? null),
  };
  const input = {
    organizationId: company.organizationId,
    userId: 'mock-owner',
    requestId: 'mock-run',
    source: invoiceSource(company),
  };
  return {
    deps,
    input,
    classifier,
    sink,
    store,
    approvals,
    authority: () => current,
    setAuthority: (next: ExecutionAuthority) => {
      current = next;
    },
    setTime: (next: number) => {
      now = next;
    },
    approve: (fingerprint: string) => {
      const approval = {
        approvalId: 'mock-approval',
        organizationId: company.organizationId,
        requestId: input.requestId,
        fingerprint,
        approverId: input.userId,
        approved: true,
        expiresAt: NOW + 60,
      };
      approvals.set(approval.approvalId, approval);
      return approval;
    },
  };
}
async function approved(f: ReturnType<typeof fixture>) {
  const prepared = await prepareAutomationWorkflow(f.input, f.deps);
  f.approve(prepared.proposal!.fingerprint);
  return {
    organizationId: f.input.organizationId,
    userId: f.input.userId,
    requestId: f.input.requestId,
    approvalId: 'mock-approval',
  };
}

describe('injected Automation preparation, approval and mutation contracts', () => {
  it.each([CH, US])(
    'all three structured workflows propose and commit with human approval for $country',
    async (company) => {
      const sources = [
        invoiceSource(company),
        requestSource(company),
        {
          kind: 'meeting',
          organizationId: company.organizationId,
          sourceId: 'mock-meeting',
          language: 'en',
          text: 'Original meeting text',
          title: 'Site visit',
          localStart: '2026-10-08T10:00',
          localEnd: '2026-10-08T10:45',
          timeZone: company.timeZone,
        },
      ];
      for (const source of sources) {
        const f = fixture(company);
        if (source.kind !== 'vendor_invoice')
          f.setAuthority({ ...f.authority(), role: 'member' });
        const prepared = await prepareAutomationWorkflow(
          { ...f.input, source },
          f.deps,
        );
        expect(prepared.state).toBe('proposed');
        expect(prepared.proposal?.action).toBe(
          source.kind === 'vendor_invoice'
            ? 'record_vendor_invoice_draft'
            : source.kind === 'customer_request'
              ? 'create_customer_request'
              : 'draft_meeting',
        );
        expect(f.sink.commit).not.toHaveBeenCalled();
        f.approve(prepared.proposal!.fingerprint);
        const committed = await commitAutomationWorkflow(
          {
            organizationId: company.organizationId,
            userId: f.input.userId,
            requestId: f.input.requestId,
            approvalId: 'mock-approval',
          },
          f.deps,
        );
        expect(committed.state).toBe('completed');
        expect(f.sink.commit).toHaveBeenCalledTimes(1);
      }
    },
  );
  it('prepares the same country-independent financial draft for CH and US without executing it', async () => {
    for (const company of [CH, US]) {
      const f = fixture(company),
        result = await prepareAutomationWorkflow(f.input, f.deps);
      expect(result).toMatchObject({
        state: 'proposed',
        proposal: {
          action: 'record_vendor_invoice_draft',
          financial: true,
          requiresHumanApproval: true,
        },
      });
      expect(f.sink.commit).not.toHaveBeenCalled();
    }
  });
  it.each([
    'revoked_member',
    'foreign_tenant',
    'member_finance',
    'read_only_role',
    'missing_paid_base',
    'expired_addon',
    'no_consent',
    'workflow_disabled',
  ] as const)('denies %s before provider classification', async (scenario) => {
    const f = fixture(),
      authority = f.authority();
    const overrides: Partial<ExecutionAuthority> =
      scenario === 'revoked_member'
        ? { membershipActive: false }
        : scenario === 'foreign_tenant'
          ? { organizationId: 'foreign-org' }
          : scenario === 'member_finance'
            ? { role: 'member' }
            : scenario === 'read_only_role'
              ? { role: 'read_only' }
              : scenario === 'no_consent'
                ? { consent: { approved: false, version: 'mock-v1' } }
                : scenario === 'workflow_disabled'
                  ? { enabledWorkflows: ['meeting'] }
                  : scenario === 'missing_paid_base'
                    ? { subscriptions: authority.subscriptions.slice(1) }
                    : {
                        subscriptions: [
                          authority.subscriptions[0],
                          {
                            ...authority.subscriptions[1],
                            evidence: {
                              ...authority.subscriptions[1].evidence!,
                              endsAt: NOW,
                            },
                          },
                        ],
                      };
    f.setAuthority({ ...authority, ...overrides });
    await expect(prepareAutomationWorkflow(f.input, f.deps)).rejects.toThrow();
    expect(f.classifier.classify).not.toHaveBeenCalled();
    expect(f.sink.commit).not.toHaveBeenCalled();
  });
  it('accepts Complet alone but rejects contradictory duplicate grants', async () => {
    const f = fixture(),
      pack = subscription(offer({ module: 'complet' }));
    f.setAuthority({ ...f.authority(), subscriptions: [pack] });
    expect((await prepareAutomationWorkflow(f.input, f.deps)).state).toBe(
      'proposed',
    );
    const duplicate = fixture();
    duplicate.setAuthority({
      ...duplicate.authority(),
      subscriptions: [...duplicate.authority().subscriptions, pack],
    });
    await expect(
      prepareAutomationWorkflow(duplicate.input, duplicate.deps),
    ).rejects.toThrow('permission_denied');
  });
  it('eight simultaneous identical preparations classify once; changed input cannot reuse their request', async () => {
    const f = fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        prepareAutomationWorkflow(f.input, f.deps),
      ),
    );
    expect(results.some((result) => result.state === 'proposed')).toBe(true);
    expect(f.classifier.classify).toHaveBeenCalledTimes(1);
    await expect(
      prepareAutomationWorkflow(
        {
          ...f.input,
          source: { ...f.input.source, text: 'Changed original text' },
        },
        f.deps,
      ),
    ).rejects.toThrow('idempotency_conflict');
  });
  it.each([
    { kind: 'meeting', confidence: 0.99 },
    { kind: 'vendor_invoice', confidence: 0.89 },
    { kind: 'vendor_invoice', confidence: 1.1 },
    { kind: 'vendor_invoice', confidence: 0.99, execute: true },
  ])('keeps unsafe classification for human review: %j', async (output) => {
    const f = fixture();
    f.classifier.classify.mockResolvedValueOnce(output);
    expect(await prepareAutomationWorkflow(f.input, f.deps)).toMatchObject({
      state: 'review_required',
      proposal: null,
    });
    expect(f.sink.commit).not.toHaveBeenCalled();
  });
  it('pre-effect provider failure permits only explicit bounded preparation retry', async () => {
    const f = fixture();
    f.classifier.classify.mockRejectedValue(
      new Error('Mock classification transport lost'),
    );
    expect((await prepareAutomationWorkflow(f.input, f.deps)).state).toBe(
      'failed',
    );
    await prepareAutomationWorkflow(f.input, f.deps);
    expect(f.classifier.classify).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++)
      await prepareAutomationWorkflow(
        { ...f.input, retryPreparation: true },
        f.deps,
      );
    expect(f.classifier.classify).toHaveBeenCalledTimes(3);
    expect(f.sink.commit).not.toHaveBeenCalled();
  });
  it('revalidates role and configuration after classification awaits', async () => {
    const f = fixture();
    f.classifier.classify.mockImplementationOnce(async (source) => {
      f.setAuthority({ ...f.authority(), membershipActive: false });
      return { kind: source.kind, confidence: 0.99 };
    });
    await expect(prepareAutomationWorkflow(f.input, f.deps)).rejects.toThrow(
      'permission_denied',
    );
    expect(
      (await f.store.read(f.input.organizationId, f.input.requestId))?.state,
    ).toBe('failed');
    expect(f.sink.commit).not.toHaveBeenCalled();
    const changed = fixture();
    changed.classifier.classify.mockImplementationOnce(async (source) => {
      changed.setAuthority({
        ...changed.authority(),
        company: { ...CH, language: 'en' },
      });
      return { kind: source.kind, confidence: 0.99 };
    });
    await expect(
      prepareAutomationWorkflow(changed.input, changed.deps),
    ).rejects.toThrow('configuration_changed');
  });
  it.each([
    'missing',
    'wrong_fingerprint',
    'foreign_org',
    'expired',
    'different_approver',
    'rejected',
  ] as const)(
    'rejects %s server approval without effects',
    async (scenario) => {
      const f = fixture(),
        input = await approved(f),
        original = f.approvals.get(input.approvalId)!;
      if (scenario === 'missing') f.approvals.clear();
      else
        f.approvals.set(input.approvalId, {
          ...original,
          ...(scenario === 'wrong_fingerprint'
            ? { fingerprint: '0'.repeat(64) }
            : scenario === 'foreign_org'
              ? { organizationId: 'foreign-org' }
              : scenario === 'expired'
                ? { expiresAt: NOW }
                : scenario === 'different_approver'
                  ? { approverId: 'another-user' }
                  : { approved: false }),
        });
      await expect(commitAutomationWorkflow(input, f.deps)).rejects.toThrow(
        'approval_required',
      );
      expect(f.sink.commit).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, 'financial_commit'])(
    'rejects a stored proposal with invalid kind %s before dispatch',
    async (kind) => {
      const f = fixture(),
        input = await approved(f),
        saved = (await f.store.read(input.organizationId, input.requestId))!;
      vi.spyOn(f.store, 'read').mockResolvedValueOnce({
        ...saved,
        proposal: { ...saved.proposal, kind },
      } as unknown as AutomationRunRecord);
      const cas = vi.spyOn(f.store, 'compareAndSwap');
      await expect(commitAutomationWorkflow(input, f.deps)).rejects.toThrow(
        'invalid_store_record',
      );
      expect(cas).not.toHaveBeenCalled();
      expect(f.sink.commit).not.toHaveBeenCalled();
    },
  );
  it('eight simultaneous approvals commit once with a stable tenant idempotency key; completed replay does not dispatch', async () => {
    const f = fixture(),
      input = await approved(f);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => commitAutomationWorkflow(input, f.deps)),
    );
    expect(results.some((result) => result.state === 'completed')).toBe(true);
    expect(f.sink.commit).toHaveBeenCalledTimes(1);
    expect(f.sink.commit.mock.calls[0][0]).toMatchObject({
      actorId: input.userId,
      approvalId: input.approvalId,
      idempotencyKey: `${input.organizationId}:${input.requestId}:${f.approvals.get(input.approvalId)!.fingerprint}`,
    });
    expect((await commitAutomationWorkflow(input, f.deps)).state).toBe(
      'completed',
    );
    expect(f.sink.commit).toHaveBeenCalledTimes(1);
  });
  it('revocation or approval expiry during dispatch CAS blocks the sink', async () => {
    for (const cause of ['member', 'approval'] as const) {
      const f = fixture(),
        input = await approved(f);
      f.store.beforeCas = (next) => {
        if (next.state === 'dispatching') {
          if (cause === 'member')
            f.setAuthority({ ...f.authority(), membershipActive: false });
          else f.setTime(NOW + 60);
        }
      };
      await expect(commitAutomationWorkflow(input, f.deps)).rejects.toThrow(
        cause === 'member' ? 'permission_denied' : 'approval_required',
      );
      expect(f.sink.commit).not.toHaveBeenCalled();
      expect(
        (await f.store.read(input.organizationId, input.requestId))?.state,
      ).toBe('failed');
    }
  });
  it('a mutable approval object changing during CAS cannot authorize a different proposal', async () => {
    const f = fixture(),
      input = await approved(f);
    const mutableApproval = { ...f.approvals.get(input.approvalId)! };
    f.approvals.set(input.approvalId, mutableApproval);
    f.store.beforeCas = (next) => {
      if (next.state === 'dispatching')
        mutableApproval.fingerprint = '0'.repeat(64);
    };
    await expect(commitAutomationWorkflow(input, f.deps)).rejects.toThrow(
      'approval_required',
    );
    expect(f.sink.commit).not.toHaveBeenCalled();
  });
  it('lost sink response becomes uncertain and is never automatically redispatched', async () => {
    const f = fixture(),
      input = await approved(f);
    f.sink.commit.mockRejectedValueOnce(
      new Error('Mock response lost after possible commit'),
    );
    expect(await commitAutomationWorkflow(input, f.deps)).toMatchObject({
      state: 'uncertain',
      failure: { retryable: false },
    });
    expect((await commitAutomationWorkflow(input, f.deps)).state).toBe(
      'uncertain',
    );
    expect(
      (
        await prepareAutomationWorkflow(
          { ...f.input, retryPreparation: true },
          f.deps,
        )
      ).state,
    ).toBe('uncertain');
    expect(f.sink.commit).toHaveBeenCalledTimes(1);
  });
});
