import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
import { digest } from './crypto';
import type { Workspace } from './types';
import { SUPPORT_LEGAL_VERSION } from './plans';
const state = vi.hoisted(() => ({
  db: null as unknown,
  env: { STRIPE_SECRET_KEY: 'sk_live_fixture' } as Record<string, string>,
  subscription: null as unknown,
  invoice: null as unknown,
  session: null as unknown,
  price: null as unknown,
  matchPreviewPrices: false,
  dynamicMock: false,
  expirationMode: 'success',
  dynamicMethods: ['card', 'twint'] as string[],
  sessionsById: new Map<string, unknown>(),
  sessionsByKey: new Map<string, unknown>(),
  expiredIds: [] as string[],
  calls: [] as { body: { line_items?: unknown }; options: unknown }[],
}));
vi.mock('@/lib/runtime', () => ({
  database: () => state.db,
  runtimeValue: (key: string) => state.env[key] || '',
  stripeConfiguration: () => ({
    secretKey: state.env.STRIPE_SECRET_KEY,
    testMode: 'owner_only',
    ownerAccountUserId: 'owner',
    ownerEmail: 'owner@example.test',
  }),
}));
vi.mock('stripe', () => ({
  default: class {
    static createFetchHttpClient() {
      return {};
    }
    subscriptions = { retrieve: async () => state.subscription };
    invoices = { retrieve: async () => state.invoice };
    // All money and routing below are fictitious. The real common D1 ledger,
    // atomic batches and production invoice validator remain unmocked.
    invoicePayments = {
      list: async () => ({
        has_more: false,
        data: [
          {
            id: 'inpay_fixture',
            invoice: (state.invoice as Stripe.Invoice).id,
            status: 'paid',
            livemode: (state.invoice as Stripe.Invoice).livemode,
            currency: 'chf',
            amount_paid: (state.invoice as Stripe.Invoice).amount_paid,
            payment: { type: 'payment_intent', payment_intent: 'pi_fixture' },
          },
        ],
      }),
    };
    paymentIntents = {
      retrieve: async () => ({
        id: 'pi_fixture',
        latest_charge: 'ch_fixture',
        status: 'succeeded',
        livemode: (state.invoice as Stripe.Invoice).livemode,
        currency: 'chf',
        customer: (state.invoice as Stripe.Invoice).customer,
        amount_received: (state.invoice as Stripe.Invoice).amount_paid,
      }),
    };
    charges = {
      retrieve: async () => ({
        id: 'ch_fixture',
        payment_intent: 'pi_fixture',
        status: 'succeeded',
        paid: true,
        captured: true,
        refunded: false,
        amount_refunded: 0,
        livemode: (state.invoice as Stripe.Invoice).livemode,
        currency: 'chf',
        customer: (state.invoice as Stripe.Invoice).customer,
        amount_captured: (state.invoice as Stripe.Invoice).amount_paid,
      }),
    };
    prices = { retrieve: async () => state.price };
    checkout = {
      sessions: {
        retrieve: async (id: string) =>
          state.sessionsById.get(id) ?? state.session,
        create: async (body: unknown, options: unknown) => {
          state.calls.push({ body: body as { line_items?: unknown }, options });
          const input = body as Stripe.Checkout.SessionCreateParams;
          if (state.dynamicMock || input.metadata?.support_request_id) {
            const key = (options as { idempotencyKey: string }).idempotencyKey;
            const previous = state.sessionsByKey.get(key);
            if (previous) return previous;
            const fresh = {
              ...(state.session as object),
              id:
                !state.dynamicMock && state.sessionsByKey.size === 0
                  ? 'cs_live_fixture'
                  : `cs_live_dynamic${state.sessionsByKey.size + 1}`,
              status: 'open',
              payment_status: 'unpaid',
              url: `https://checkout.stripe.com/c/pay/${key}`,
              mode: 'subscription',
              expires_at: input.expires_at,
              metadata: input.metadata,
              client_reference_id: input.client_reference_id,
              payment_method_types: state.dynamicMethods,
            };
            state.sessionsByKey.set(key, fresh);
            state.sessionsById.set(fresh.id, fresh);
            state.session = fresh;
            return fresh;
          }
          if (state.matchPreviewPrices) {
            const price = (body as Stripe.Checkout.SessionCreateParams)
              .line_items?.[0].price as string;
            const amounts: Record<string, number> = {
              price_starter: 2900,
              price_team: 4900,
              price_business: 9900,
            };
            return {
              ...(state.session as object),
              amount_total: amounts[price],
              currency: 'chf',
              mode: 'subscription',
            };
          }
          return state.session;
        },
        expire: async (id: string) => {
          state.expiredIds.push(id);
          if (state.expirationMode === 'open-error')
            throw new Error('expire unavailable');
          state.session = {
            ...((state.sessionsById.get(id) ?? state.session) as object),
            status:
              state.expirationMode === 'paid-race' ? 'complete' : 'expired',
            ...(state.expirationMode === 'paid-race'
              ? { payment_status: 'paid' }
              : {}),
          };
          state.sessionsById.set(id, state.session);
          if (['paid-race', 'expired-error'].includes(state.expirationMode))
            throw new Error('expire response unavailable');
          return state.session;
        },
      },
    };
  },
}));
import {
  billingState,
  verifySupportBilling,
  paidAccess,
  paidSupportPeriod,
  requireSupportSubscription,
  reserveAnalysis,
  finishAnalysis,
  persistSupportStripeEvent,
  createSupportCheckout,
  refreshSupportPayment,
  cancelSupportCheckout,
  type SubscriptionRow,
} from './billing';
const time = Math.floor(Date.now() / 1000),
  config = {
    productId: 'prod_support',
    prices: {
      starter: 'price_starter',
      team: 'price_team',
      business: 'price_business',
    },
    portalId: 'portal_support',
    livemode: true,
    keyBinding: '',
  };
const workspace = { id: 'w1', owner_id: 'owner' } as Workspace;
const user = {
  userId: 'owner',
  email: 'owner@example.test',
  emailConfirmed: true,
  provider: 'supabase',
  displayName: 'Owner',
  fullName: 'Owner',
} as const;
let sql: DatabaseSync;
function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_1',
    status: 'paid',
    livemode: true,
    currency: 'chf',
    amount_paid: 2900,
    amount_due: 2900,
    total: 2900,
    customer: 'cus_support',
    billing_reason: 'subscription_create',
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: 'sub_support',
        metadata: { service: 'zentra-support' },
      },
    },
    lines: {
      has_more: false,
      data: [
        {
          currency: 'chf',
          quantity: 1,
          subtotal: 2900,
          period: { start: time - 60, end: time + 86400 * 30 },
          pricing: { price_details: { price: 'price_starter' } },
          parent: {
            type: 'subscription_item_details',
            subscription_item_details: {
              subscription: 'sub_support',
              proration: false,
            },
          },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Invoice;
}
function row(overrides: Partial<SubscriptionRow> = {}) {
  return {
    workspace_id: 'w1',
    subscription_id: 'sub_support',
    customer_id: 'cus_support',
    plan_id: 'starter',
    status: 'active',
    paid_from: time - 60,
    paid_until: time + 86400,
    paid_plan_id: 'starter',
    last_paid_invoice_id: 'in_1',
    cancel_at_period_end: 0,
    livemode: 1,
    updated_at: time,
    ...overrides,
  };
}
function seedPaid(overrides: Partial<SubscriptionRow> = {}) {
  const value = row(overrides);
  sql
    .prepare(
      'INSERT INTO support_subscriptions(' +
        Object.keys(value).join(',') +
        ') VALUES(' +
        Object.values(value)
          .map(() => '?')
          .join(',') +
        ')',
    )
    .run(...Object.values(value));
}
it('an unresolved historical active subscription with no paid period still blocks another checkout', async () => {
  seedPaid({
    paid_from: 0,
    paid_until: 0,
    paid_plan_id: null,
    last_paid_invoice_id: null,
    status: 'active',
  });
  await expect(
    createSupportCheckout(workspace, user, {
      plan: 'starter',
      acceptTerms: true,
      legalVersion: SUPPORT_LEGAL_VERSION,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(state.calls).toHaveLength(0);
  expect(
    sql.prepare('SELECT COUNT(*) n FROM stripe_support_purchase_requests').get()
      ?.n,
  ).toBe(0);
});
beforeEach(async () => {
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => f.slice(0, -4)))
    sql.exec(
      readFileSync(
        new URL('../../drizzle/' + file + '.sql', import.meta.url),
        'utf8',
      ),
    );
  state.db = {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const api = {
        query,
        get values() {
          return values;
        },
        bind(...v: SQLInputValue[]) {
          values = v;
          return api;
        },
        async first() {
          return sql.prepare(query).get(...values) || null;
        },
        async all() {
          return { results: sql.prepare(query).all(...values) };
        },
        async run() {
          return { meta: sql.prepare(query).run(...values) };
        },
      };
      return api;
    },
    async batch(queries: Array<{ query: string; values: SQLInputValue[] }>) {
      sql.exec('BEGIN IMMEDIATE');
      try {
        const results = queries.map((q) => ({
          success: true,
          meta: sql.prepare(q.query).run(...q.values),
        }));
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
  state.env = {
    STRIPE_SECRET_KEY: 'sk_live_fixture',
    PUBLIC_SITE_URL: 'https://zentraapp.ch',
  };
  state.calls = [];
  state.matchPreviewPrices = false;
  state.dynamicMock = false;
  state.expirationMode = 'success';
  state.dynamicMethods = ['card', 'twint'];
  state.sessionsById.clear();
  state.sessionsByKey.clear();
  state.expiredIds = [];
  config.keyBinding = await digest(state.env.STRIPE_SECRET_KEY);
  sql
    .prepare(
      "INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('w1','owner','Fixture',?,?)",
    )
    .run(time, time);
  sql
    .prepare("INSERT INTO support_billing_config VALUES('stripe',?,?)")
    .run(JSON.stringify(config), time);
  state.price = {
    id: 'price_starter',
    product: { id: 'prod_support', active: true },
    active: true,
    livemode: true,
    currency: 'chf',
    unit_amount: 2900,
    type: 'recurring',
    recurring: { interval: 'month', interval_count: 1 },
    tax_behavior: 'inclusive',
    metadata: { service: 'zentra-support', plan: 'starter' },
  };
  state.subscription = {
    id: 'sub_support',
    customer: 'cus_support',
    livemode: true,
    status: 'active',
    metadata: {
      service: 'zentra-support',
      workspace_id: 'w1',
      owner_id: 'owner',
      plan: 'starter',
    },
    items: { data: [{ quantity: 1, price: state.price }] },
    latest_invoice: 'in_1',
    cancel_at_period_end: false,
  };
  state.invoice = invoice();
  state.session = {
    id: 'cs_live_fixture',
    mode: 'subscription',
    status: 'open',
    payment_status: 'unpaid',
    url: 'https://checkout.stripe.com/c/pay/cs_live_fixture',
    livemode: true,
    client_reference_id: 'w1',
    metadata: {
      service: 'zentra-support',
      workspace_id: 'w1',
      owner_id: 'owner',
      plan: 'starter',
    },
    subscription: 'sub_support',
  };
});
afterEach(() => sql.close());
it('bloque les opérations et le contenu sans paiement vérifié', async () => {
  expect((await billingState(workspace)).active).toBe(false);
  await expect(requireSupportSubscription(workspace)).rejects.toMatchObject({
    status: 402,
  });
  await expect(
    reserveAnalysis(workspace, 'ticket', 'lease'),
  ).rejects.toMatchObject({ status: 402 });
});
it.each([
  { paid_until: time - 1 },
  { paid_from: time + 1 },
  { livemode: 0 },
  { status: 'incomplete' },
  { status: 'canceled' },
  { status: 'unpaid' },
  { paid_plan_id: 'unknown' },
])('refuse un droit invalide %j', (change) => {
  expect(paidAccess(row(change), true, time)).toBe(false);
});
it('un échec de renouvellement ne retire pas une période déjà payée', () => {
  expect(paidAccess(row({ status: 'past_due' }), true, time)).toBe(true);
  expect(
    paidAccess(row({ status: 'past_due', paid_until: time }), true, time),
  ).toBe(false);
});
it('valide le prix, la devise, le propriétaire et la période de la facture', () => {
  expect(
    paidSupportPeriod(
      invoice(),
      state.subscription as Stripe.Subscription,
      config,
    )?.plan,
  ).toBe('starter');
  for (const change of [
    { amount_paid: 0 },
    { amount_due: 0 },
    { total: 3000 },
    { currency: 'usd' },
    { livemode: false },
    { customer: 'other' },
    { status: 'open' },
    { billing_reason: 'subscription_update' },
  ])
    expect(
      paidSupportPeriod(
        invoice(change),
        state.subscription as Stripe.Subscription,
        config,
      ),
    ).toBeNull();
  for (const change of [
    { quantity: 2 },
    { subtotal: 2800 },
    { currency: 'eur' },
    { period: { start: time - 60, end: time + 86400 * 365 } },
  ]) {
    const value = invoice();
    Object.assign(value.lines.data[0], change);
    expect(
      paidSupportPeriod(
        value,
        state.subscription as Stripe.Subscription,
        config,
      ),
    ).toBeNull();
  }
});
it('réserve atomiquement la dernière analyse et libère les échecs techniques', async () => {
  seedPaid();
  sql
    .prepare(
      "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<1999) INSERT INTO support_analysis_usage SELECT 'seed-'||n,'w1',?,'ticket','charged',0,? FROM x",
    )
    .run(time - 60, time);
  const attempts = await Promise.allSettled([
    reserveAnalysis(workspace, 'a', 'lease-a'),
    reserveAnalysis(workspace, 'b', 'lease-b'),
  ]);
  expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  const successful = attempts.find(
    (x) => x.status === 'fulfilled',
  ) as PromiseFulfilledResult<string>;
  await finishAnalysis(successful.value, false);
  await finishAnalysis(await reserveAnalysis(workspace, 'c', 'lease-c'), true);
  expect((await billingState(workspace)).used).toBe(2000);
  await finishAnalysis('lease-c', true);
  expect((await billingState(workspace)).used).toBe(2000);
  await expect(
    reserveAnalysis(workspace, 'd', 'lease-d'),
  ).rejects.toMatchObject({ status: 402 });
});
it('traite les webhooks rejoués sans prolonger ou reculer la période payée', async () => {
  const event = {
    type: 'invoice.paid',
    data: { object: state.invoice },
  } as Stripe.Event;
  expect(await persistSupportStripeEvent(event)).toBe(true);
  expect(await persistSupportStripeEvent(event)).toBe(true);
  expect((await billingState(workspace)).active).toBe(true);
  const end = (await billingState(workspace)).periodEnd;
  const old = invoice();
  old.id = 'in_old';
  old.lines.data[0].period = { start: time - 86400 * 30, end: time - 60 };
  state.invoice = old;
  await persistSupportStripeEvent({
    type: 'invoice.paid',
    data: { object: old },
  } as Stripe.Event);
  expect((await billingState(workspace)).periodEnd).toBe(end);
  (state.subscription as Stripe.Subscription).status = 'canceled';
  await persistSupportStripeEvent({
    type: 'customer.subscription.deleted',
    data: { object: state.subscription },
  } as Stripe.Event);
  expect((await billingState(workspace)).active).toBe(false);
});
it('laisse les événements ERP à leur propre gestionnaire', async () => {
  expect(
    await persistSupportStripeEvent({
      type: 'invoice.paid',
      data: {
        object: invoice({
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: 'sub_erp' },
          },
        }),
      },
    } as Stripe.Event),
  ).toBe(false);
});
it('ne fait pas confiance au retour de paiement d’un autre espace ou impayé', async () => {
  await expect(
    refreshSupportPayment(workspace, user, 'cs_live_fixture'),
  ).rejects.toMatchObject({ status: 409 });
  (state.session as Stripe.Checkout.Session).metadata!.workspace_id = 'w2';
  await expect(
    refreshSupportPayment(workspace, user, 'cs_live_fixture'),
  ).rejects.toMatchObject({ status: 403 });
  expect((await billingState(workspace)).active).toBe(false);
});
it('active le paiement au retour même si le webhook est en retard', async () => {
  Object.assign(state.session as object, {
    status: 'complete',
    payment_status: 'paid',
  });
  await refreshSupportPayment(workspace, user, 'cs_live_fixture');
  expect((await billingState(workspace)).active).toBe(true);
});
it('conserve un seul checkout et une preuve durable de consentement', async () => {
  const body = {
    plan: 'starter',
    acceptTerms: true,
    legalVersion: SUPPORT_LEGAL_VERSION,
  };
  await expect(
    createSupportCheckout(workspace, { ...user, userId: 'member' }, body),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    createSupportCheckout(workspace, user, { ...body, acceptTerms: false }),
  ).rejects.toThrow('conditions');
  const first = await createSupportCheckout(workspace, user, body),
    second = await createSupportCheckout(workspace, user, body);
  expect(first).toEqual(second);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].body.line_items).toEqual([
    { price: 'price_starter', quantity: 1 },
  ]);
  expect(state.calls[0].body).not.toHaveProperty('payment_method_types');
  expect(state.calls[0].body).toHaveProperty('mode', 'subscription');
  expect(
    sql.prepare('SELECT * FROM support_checkout_acceptances').all(),
  ).toHaveLength(1);
  await expect(
    createSupportCheckout(workspace, user, { ...body, plan: 'team' }),
  ).rejects.toThrow();
  await cancelSupportCheckout(workspace, user);
  expect(sql.prepare('SELECT state FROM purchase_intents').get()?.state).toBe(
    'expired',
  );
});
it('refuse la configuration d’un autre mode Stripe', async () => {
  state.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  expect((await billingState(workspace)).ready).toBe(false);
  seedPaid();
  expect((await billingState(workspace)).active).toBe(false);
});

it('reprend un paiement interrompu sans perdre la preuve des conditions', async () => {
  const body = {
    plan: 'starter',
    acceptTerms: true,
    legalVersion: SUPPORT_LEGAL_VERSION,
  };
  sql.exec(
    "CREATE TRIGGER fail_acceptance BEFORE INSERT ON support_checkout_acceptances BEGIN SELECT RAISE(ABORT, 'temporary storage failure'); END",
  );
  await expect(createSupportCheckout(workspace, user, body)).rejects.toThrow(
    'temporary storage failure',
  );
  sql.exec('DROP TRIGGER fail_acceptance');
  const result = await createSupportCheckout(workspace, user, body);
  expect(result.url).toBe((state.session as Stripe.Checkout.Session).url);
  expect(
    sql
      .prepare(
        'SELECT session_id,owner_id,legal_version FROM support_checkout_acceptances',
      )
      .all(),
  ).toEqual([
    {
      session_id: 'cs_live_fixture',
      owner_id: user.userId,
      legal_version: SUPPORT_LEGAL_VERSION,
    },
  ]);
  expect(
    new Set(
      state.calls.map(
        (call) => (call.options as { idempotencyKey: string }).idempotencyKey,
      ),
    ).size,
  ).toBe(1);
});

it('répare la preuve manquante d’un lien déjà préparé avec les conditions acceptées initialement', async () => {
  const body = {
    plan: 'starter',
    acceptTerms: true,
    legalVersion: SUPPORT_LEGAL_VERSION,
  };
  const clock = vi.spyOn(Date, 'now').mockReturnValue((time - 300) * 1000);
  try {
    await createSupportCheckout(workspace, user, body);
  } finally {
    clock.mockRestore();
  }
  sql.exec('DELETE FROM support_checkout_acceptances');
  await createSupportCheckout(workspace, user, body);
  expect(
    sql.prepare('SELECT accepted_at FROM support_checkout_acceptances').get()
      ?.accepted_at,
  ).toBe(time - 300);
  expect(state.calls).toHaveLength(1);
});

it('ferme le checkout de contrôle même quand sa validation échoue', async () => {
  await expect(verifySupportBilling()).rejects.toMatchObject({ status: 503 });
  expect((state.session as Stripe.Checkout.Session).status).toBe('expired');
  expect((await billingState(workspace)).active).toBe(false);
});
it.each([
  { methods: ['card', 'twint'], eligible: true },
  { methods: ['card'], eligible: false },
  { methods: undefined, eligible: false },
])(
  'rapporte TWINT uniquement quand Checkout le confirme : $eligible',
  async ({ methods, eligible }) => {
    state.matchPreviewPrices = true;
    Object.assign(state.session as object, { payment_method_types: methods });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    );
    try {
      const result = await verifySupportBilling();
      expect(result.twintEligible).toBe(eligible);
      expect(result.paymentTaken).toBe(false);
      expect(result.checkouts).toHaveLength(3);
      expect(result.checkouts.every((row) => row.expired)).toBe(true);
      expect(
        result.checkouts.every((row) => row.twintEligible === eligible),
      ).toBe(true);
      expect(result.checkouts[0].paymentMethodTypes).toEqual(methods ?? []);
      expect((await billingState(workspace)).active).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));

const checkoutBody = {
  plan: 'starter',
  acceptTerms: true,
  legalVersion: SUPPORT_LEGAL_VERSION,
};
async function seedLegacyCardCheckout() {
  sql
    .prepare(
      'INSERT INTO support_checkouts(workspace_id,nonce,plan_id,session_id,expires_at,owner_id,accepted_version,accepted_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      'w1',
      'legacy-nonce',
      'starter',
      'cs_live_fixture',
      time + 3600,
      'owner',
      SUPPORT_LEGAL_VERSION,
      time - 600,
    );
  sql
    .prepare('INSERT INTO support_checkout_acceptances VALUES(?,?,?,?,?,?)')
    .run(
      'cs_live_fixture',
      'w1',
      'owner',
      'starter',
      SUPPORT_LEGAL_VERSION,
      time - 600,
    );
  state.calls = [];
  state.dynamicMock = true;
  Object.assign(state.session as object, { payment_method_types: ['card'] });
  state.sessionsById.set('cs_live_fixture', state.session);
}
it.each(['success', 'expired-error'])(
  'remplace l’ancien lien carte seulement après sa fermeture confirmée : %s',
  async (mode) => {
    await seedLegacyCardCheckout();
    state.expirationMode = mode;
    const previous = sql
      .prepare('SELECT nonce,session_id FROM support_checkouts')
      .get();
    const result = await createSupportCheckout(workspace, user, checkoutBody);
    expect(result.url).not.toBe(
      'https://checkout.stripe.com/c/pay/cs_live_fixture',
    );
    expect(state.expiredIds).toEqual(['cs_live_fixture']);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].body).not.toHaveProperty('payment_method_types');
    expect(state.calls[0].body).toHaveProperty(
      'metadata.payment_methods',
      'dynamic-v1',
    );
    const current = sql
      .prepare('SELECT nonce,session_id,expires_at FROM support_checkouts')
      .get();
    expect(current?.nonce).toBe(previous?.nonce);
    expect(current?.session_id).toBe(previous?.session_id);
    expect(current?.expires_at).toBe(0);
    expect(
      sql
        .prepare('SELECT session_id FROM stripe_support_purchase_requests')
        .get()?.session_id,
    ).toBe('cs_live_dynamic1');
    expect(
      sql
        .prepare('SELECT count(*) AS n FROM support_checkout_acceptances')
        .get()?.n,
    ).toBe(2);
    expect((await billingState(workspace)).active).toBe(false);
  },
);
it('ne crée aucun nouveau lien si la fermeture de l’ancien est incertaine', async () => {
  await seedLegacyCardCheckout();
  state.expirationMode = 'open-error';
  const before = sql.prepare('SELECT * FROM support_checkouts').get();
  await expect(
    createSupportCheckout(workspace, user, checkoutBody),
  ).rejects.toMatchObject({ status: 503 });
  expect(state.calls).toHaveLength(0);
  expect(sql.prepare('SELECT * FROM support_checkouts').get()).toEqual(before);
});
it('conserve un paiement terminé pendant la fermeture et réconcilie ses droits sans nouveau lien', async () => {
  await seedLegacyCardCheckout();
  state.expirationMode = 'paid-race';
  const result = await createSupportCheckout(workspace, user, checkoutBody);
  expect(result.url).toContain('section=billing');
  expect(state.calls).toHaveLength(0);
  expect((await billingState(workspace)).active).toBe(true);
  expect(
    sql.prepare('SELECT session_id FROM support_checkouts').get()?.session_id,
  ).toBe('cs_live_fixture');
});
it('ne remplace pas en boucle une page dynamique offrant légitimement seulement la carte', async () => {
  await seedLegacyCardCheckout();
  state.dynamicMethods = ['card'];
  const first = await createSupportCheckout(workspace, user, checkoutBody);
  const second = await createSupportCheckout(workspace, user, checkoutBody);
  expect(first).toEqual(second);
  expect(state.calls).toHaveLength(1);
  expect(state.expiredIds).toHaveLength(1);
});
it('deux requêtes concurrentes utilisent la même nouvelle clé et une seule page payable', async () => {
  await seedLegacyCardCheckout();
  const results = await Promise.all([
    createSupportCheckout(workspace, user, checkoutBody),
    createSupportCheckout(workspace, user, checkoutBody),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(state.sessionsByKey.size).toBe(1);
  expect(
    new Set(
      state.calls.map(
        (call) => (call.options as { idempotencyKey: string }).idempotencyKey,
      ),
    ).size,
  ).toBe(1);
  expect(
    sql.prepare('SELECT count(*) AS n FROM support_checkout_acceptances').get()
      ?.n,
  ).toBe(2);
});
it.each([
  { livemode: false },
  { client_reference_id: 'other' },
  {
    metadata: {
      service: 'zentra-support',
      workspace_id: 'other',
      owner_id: 'owner',
    },
  },
])(
  'refuse de fermer une page non liée au titulaire et au mode attendu',
  async (override) => {
    await seedLegacyCardCheckout();
    Object.assign(state.session as object, override);
    await expect(
      createSupportCheckout(workspace, user, checkoutBody),
    ).rejects.toMatchObject({ status: 403 });
    expect(state.calls).toHaveLength(0);
    expect(state.expiredIds).toHaveLength(0);
  },
);
