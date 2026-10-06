import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import {
  D1StripeAutomationPurchase,
  stripeAutomationCheckout,
  type StripeAutomationConfiguration,
  type StripeAutomationTransport,
} from './stripe-automation-purchase';
import { D1PurchaseIntents } from './purchase-intents';
import { D1PrepaidPeriods } from './prepaid-periods';
import { AUTOMATION_TERMS_VERSION } from '@/lib/automation/billing';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';
let sql: DatabaseSync,
  now: number,
  locale: 'fr' | 'de',
  lost: boolean,
  hook: ((query: string) => void) | null;
let config: StripeAutomationConfiguration,
  sessions: Map<string, Stripe.Checkout.Session>;
let price: ReturnType<typeof vi.fn>,
  create: ReturnType<typeof vi.fn>,
  retrieve: ReturnType<typeof vi.fn>,
  list: ReturnType<typeof vi.fn>,
  expire: ReturnType<typeof vi.fn>,
  originalFetch: typeof fetch;
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => locale,
}));
vi.mock('@/lib/runtime', () => ({
  database: () => d1(),
  runtimeValue: () => '',
  stripeConfiguration: () => ({
    siteUrl: 'https://zentraapp.ch',
    secretKey: '',
    testMode: '',
    ownerAccountUserId: '',
    ownerEmail: '',
  }),
}));
const user = {
  userId: 'automation-fixture-owner',
  email: 'automation-owner@example.test',
  displayName: 'Fictional owner',
  fullName: null,
  provider: 'supabase',
  emailConfirmed: true,
} satisfies ZentraUser;
function d1() {
  return {
    prepare(query: string) {
      let args: SQLInputValue[] = [];
      const p = {
        bind(...v: SQLInputValue[]) {
          args = v;
          return p;
        },
        async first() {
          return sql.prepare(query).get(...args) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...args) };
        },
        async run() {
          hook?.(query);
          return { success: true, meta: sql.prepare(query).run(...args) };
        },
        query,
        get args() {
          return args;
        },
      };
      return p;
    },
    async batch(queries: { query: string; args: SQLInputValue[] }[]) {
      sql.exec('BEGIN IMMEDIATE');
      try {
        const out = queries.map((q) => ({
          success: true,
          meta: sql.prepare(q.query).run(...q.args),
        }));
        sql.exec('COMMIT');
        return out;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}
const store = () =>
  new D1StripeAutomationPurchase(
    d1(),
    config,
    { price, create, retrieve, list, expire } as StripeAutomationTransport,
    () => now,
  );
const input = (patch: Record<string, unknown> = {}) => ({
  user,
  organizationId: 'automation-one',
  origin: 'https://zentraapp.ch',
  legalVersion: AUTOMATION_TERMS_VERSION,
  consentVersion: AUTOMATION_CONSENT_VERSION,
  ...patch,
});
const checkout = (patch: Record<string, unknown> = {}) =>
  store().checkout(input(patch));
const cancel = () => store().cancel({ user, organizationId: 'automation-one' });
const count = (t: string) =>
  sql.prepare('SELECT COUNT(*) n FROM ' + t).get()!.n;
const row = () =>
  sql
    .prepare(
      'SELECT * FROM stripe_automation_purchase_requests ORDER BY created_at,request_id',
    )
    .get()!;
function company(id = 'automation-one') {
  const sub = 'sub_base_' + id.replaceAll('-', '');
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at,seat_limit) VALUES(?,?,?,'active',?,?,0,?,3)",
    )
    .run(
      sub,
      'cus_base_fixture',
      'price_base',
      now + 864000,
      now + 864000,
      now,
    );
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(id, 'Fictional company', sub, user.userId, now, now);
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,'owner',?)",
    )
    .run('member_' + id, id, user.userId, user.email, now);
}
beforeEach(() => {
  now = Math.floor(Date.now() / 1000);
  locale = 'fr';
  lost = false;
  hook = null;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    throw Error('External HTTP forbidden');
  });
  sql = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + f, import.meta.url), 'utf8'),
    );
  company();
  config = {
    secretKey: 'sk_test_automation_fixture_not_real',
    productId: 'prod_automation_fixture',
    priceId: 'price_automation_fixture',
    livemode: false,
    automaticTax: false,
  };
  sessions = new Map();
  price = vi.fn(async (id: string) => ({
    id,
    active: true,
    livemode: config.livemode,
    currency: 'chf',
    unit_amount: 1500,
    type: 'recurring',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    tax_behavior: 'inclusive',
    metadata: { service: 'zentra_automation' },
    product: { id: config.productId, active: true },
  }));
  create = vi.fn(
    async (p: Stripe.Checkout.SessionCreateParams, key: string) => {
      if (!sessions.has(key))
        sessions.set(key, {
          id:
            'cs_test_' +
            String(p.metadata!.automation_request_id!).replaceAll('-', ''),
          url: 'https://checkout.stripe.com/synthetic-automation',
          mode: 'subscription',
          status: 'open',
          livemode: config.livemode,
          expires_at: p.expires_at,
          client_reference_id: p.client_reference_id,
          customer: p.customer as string,
          metadata: { ...p.metadata },
        } as Stripe.Checkout.Session);
      if (lost) {
        lost = false;
        throw Error('Synthetic lost response');
      }
      return { ...sessions.get(key)! };
    },
  );
  retrieve = vi.fn(async (id: string) => {
    const s = [...sessions.values()].find((s) => s.id === id);
    if (!s) throw Error('Synthetic session missing');
    return { ...s };
  });
  list = vi.fn(async () => ({
    data: [...sessions.values()].map((s) => ({ ...s })),
    has_more: false,
  }));
  expire = vi.fn(async (id: string) => {
    const s = [...sessions.values()].find((s) => s.id === id)!;
    s.status = 'expired';
    s.url = null;
    return { ...s };
  });
});
afterEach(() => {
  sql?.close();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  globalThis.fetch = originalFetch;
});
describe('Automation durable checkout with real migrations and atomic common ledger', () => {
  it('eight concurrent clicks freeze one request and one provider idempotency key without rights', async () => {
    const r = await Promise.all(Array.from({ length: 8 }, () => checkout()));
    expect(new Set(r.map((r) => r.url)).size).toBe(1);
    expect(count('stripe_automation_purchase_requests')).toBe(1);
    expect(count('purchase_intents')).toBe(1);
    expect(count('purchase_intent_footprints')).toBe(1);
    expect(count('automation_subscriptions')).toBe(0);
    expect(sessions.size).toBe(1);
    expect(new Set(create.mock.calls.map((c) => c[1])).size).toBe(1);
    expect(
      new Set(create.mock.calls.map((c) => JSON.stringify(c[0]))).size,
    ).toBe(1);
    expect(create.mock.calls[0][0]).not.toHaveProperty('payment_method_types');
    expect(create.mock.calls[0][0].subscription_data.billing_mode).toEqual({
      type: 'flexible',
    });
  });
  it('distinct paid companies retain distinct scopes', async () => {
    company('automation-two');
    await Promise.all([
      checkout(),
      checkout({ organizationId: 'automation-two' }),
    ]);
    expect(count('purchase_intents')).toBe(2);
    expect(count('purchase_intent_footprints')).toBe(2);
    expect(sessions.size).toBe(2);
  });
  it('freezes tax, locale, original consent time and price before a lost response retry', async () => {
    lost = true;
    await expect(checkout()).rejects.toThrow('Synthetic lost response');
    const saved = JSON.parse(row().parameters_json as string);
    const accepted = row().accepted_at;
    config.priceId = 'price_changed';
    config.automaticTax = true;
    locale = 'de';
    now += 60;
    await checkout();
    expect(create.mock.calls[1][0]).toEqual(saved);
    expect(price).toHaveBeenCalledTimes(1);
    expect(row().accepted_at).toBe(accepted);
    expect(count('legal_acceptances')).toBe(1);
  });
  it.each(['owner', 'base', 'customer', 'deleted'])(
    'records a lost provider response as uncertain even when %s changed during dispatch',
    async (kind) => {
      create.mockImplementationOnce(async () => {
        if (kind === 'owner')
          sql.exec("UPDATE organization_members SET role='member'");
        if (kind === 'base')
          sql.exec('UPDATE subscriptions SET entitlement_valid_until=0');
        if (kind === 'customer')
          sql.exec("UPDATE subscriptions SET customer_id='cus_changed'");
        if (kind === 'deleted')
          sql
            .prepare(
              'INSERT INTO account_session_policy(user_id,revoked_before,deleted_at) VALUES(?,0,?)',
            )
            .run(user.userId, now);
        throw Error('Synthetic provider response lost after target changed');
      });
      await expect(checkout()).rejects.toThrow(
        'Synthetic provider response lost after target changed',
      );
      expect(
        sql.prepare('SELECT state FROM purchase_intents').get()!.state,
      ).toBe('uncertain');
      expect(
        sql.prepare('SELECT released_at FROM purchase_intent_footprints').get()!
          .released_at,
      ).toBeNull();
      expect(row().closed_at).toBeNull();
      await expect(checkout()).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);
      expect(count('automation_subscriptions')).toBe(0);
    },
  );
  it('refuses a prepaid option identity on this company before merchant admission without granting access', async () => {
    sql
      .prepare(
        "INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,livemode,updated_at) VALUES('automation-one','pfp_cached_option','prepaid:fixture','active',1,?)",
      )
      .run(now);
    await expect(
      stripeAutomationCheckout(
        'automation-one',
        user,
        {},
        'https://zentraapp.ch',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
    expect(count('purchase_intents')).toBe(0);
    expect(count('prepaid_settlement_proofs')).toBe(0);
  });
  it.each([
    ['automation-one', 'PRODUCTION', 409],
    ['automation-two', 'PRODUCTION', 403],
    ['automation-one', 'TEST', 403],
  ] as const)(
    'scopes reserved prepaid purchases to company %s in %s',
    async (organizationId, environment, status) => {
      company('automation-two');
      await new D1PrepaidPeriods(d1(), () => now).createContract({
        contractId: 'pfp_40000000-0000-4000-8000-000000000001',
        ownerId: user.userId,
        organizationId,
        workspaceId: null,
        apiOrigin: 'https://checkout.postfinance.ch',
        spaceId: 405,
        environment,
        productKey: 'automation',
      });
      await expect(
        stripeAutomationCheckout(
          'automation-one',
          user,
          {},
          'https://zentraapp.ch',
        ),
      ).rejects.toMatchObject({ status });
      expect(create).not.toHaveBeenCalled();
      expect(count('purchase_intents')).toBe(0);
      expect(count('prepaid_settlement_proofs')).toBe(0);
    },
  );
  it.each(['owner', 'base', 'customer', 'deleted'])(
    'rejects changed %s before a retry POST including a SQL race after target SELECT',
    async (kind) => {
      lost = true;
      await expect(checkout()).rejects.toThrow();
      const original = create.mock.calls.length;
      let changed = false;
      hook = (q) => {
        if (!changed && q.includes('state=state')) {
          changed = true;
          if (kind === 'owner')
            sql.exec("UPDATE organization_members SET role='member'");
          if (kind === 'base')
            sql.exec('UPDATE subscriptions SET entitlement_valid_until=0');
          if (kind === 'customer')
            sql.exec("UPDATE subscriptions SET customer_id='cus_changed'");
          if (kind === 'deleted')
            sql
              .prepare(
                'INSERT INTO account_session_policy(user_id,revoked_before,deleted_at) VALUES(?,0,?)',
              )
              .run(user.userId, now);
        }
      };
      await expect(checkout()).rejects.toThrow();
      expect(changed).toBe(true);
      expect(create.mock.calls.length).toBe(original);
      expect(count('automation_subscriptions')).toBe(0);
    },
  );
  it.each(['base', 'owner', 'customer', 'deleted'])(
    'refuses %s no longer matching before initial provider dispatch',
    async (kind) => {
      if (kind === 'base')
        sql.exec('UPDATE subscriptions SET entitlement_valid_until=0');
      if (kind === 'owner')
        sql.exec("UPDATE organization_members SET role='member'");
      if (kind === 'customer')
        sql.exec("UPDATE subscriptions SET customer_id='invalid'");
      if (kind === 'deleted')
        sql
          .prepare(
            'INSERT INTO account_session_policy(user_id,revoked_before,deleted_at) VALUES(?,0,?)',
          )
          .run(user.userId, now);
      await expect(checkout()).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
    },
  );
  it('stops unknown expired financial results without reusing a fresh TTL', async () => {
    lost = true;
    await expect(checkout()).rejects.toThrow();
    now += 86400;
    list.mockResolvedValue({ data: [], has_more: false });
    await expect(checkout()).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    expect(sql.prepare('SELECT state FROM purchase_intents').get()!.state).toBe(
      'uncertain',
    );
    expect(row().closed_at).toBeNull();
    expect(
      sql.prepare('SELECT released_at FROM purchase_intent_footprints').get()!
        .released_at,
    ).toBeNull();
  });
  it.each(['truncated', 'ambiguous'])(
    'does not dispatch after %s recovery',
    async (kind) => {
      lost = true;
      await expect(checkout()).rejects.toThrow();
      now += 2000;
      const s = [...sessions.values()][0];
      list.mockResolvedValue({
        data: kind === 'ambiguous' ? [s, { ...s, id: 'cs_test_other' }] : [s],
        has_more: kind === 'truncated',
      });
      await expect(checkout()).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps original terms immutable and rejects a different account or provider binding', async () => {
    await checkout();
    await expect(checkout({ legalVersion: 'changed' })).rejects.toThrow();
    await expect(
      checkout({ user: { ...user, userId: 'other' } }),
    ).rejects.toThrow();
    config.secretKey = 'sk_test_different_fixture';
    await expect(checkout()).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    expect(() =>
      sql.exec(
        "UPDATE stripe_automation_purchase_requests SET consent_version='changed'",
      ),
    ).toThrow();
    expect(() =>
      sql.exec('DELETE FROM stripe_automation_purchase_requests'),
    ).toThrow();
  });
  it.each([
    'owner_id',
    'organization_id',
    'base_subscription_id',
    'price_id',
    'customer',
    'livemode',
  ])('rejects foreign session %s without binding/grant', async (field) => {
    lost = true;
    await expect(checkout()).rejects.toThrow();
    const s = [...sessions.values()][0];
    if (field === 'customer') s.customer = 'cus_wrong';
    else if (field === 'livemode') s.livemode = true;
    else s.metadata![field] = 'wrong';
    await expect(checkout()).rejects.toThrow();
    expect(row().session_id).toBeNull();
    expect(count('automation_subscriptions')).toBe(0);
  });
  it('requires verified cancellation before a new expired checkout', async () => {
    await checkout();
    [...sessions.values()][0].status = 'expired';
    await expect(checkout()).rejects.toThrow();
    await expect(cancel()).resolves.toEqual({ canceled: true });
    now++;
    await checkout();
    expect(sessions.size).toBe(2);
    expect(count('purchase_intents')).toBe(2);
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) n FROM purchase_intent_footprints WHERE released_at IS NULL',
        )
        .get()!.n,
    ).toBe(1);
  });
  it('will not cancel a completed or uncertain payment', async () => {
    await checkout();
    [...sessions.values()][0].status = 'complete';
    await expect(cancel()).rejects.toThrow();
    expect(expire).not.toHaveBeenCalled();
    expect(row().closed_at).toBeNull();
  });
  it('holds a legacy result with no session even past TTL', async () => {
    sql
      .prepare(
        'INSERT INTO automation_checkouts(organization_id,attempt_id,user_id,session_id,expires_at,request_json,created_at) VALUES(?,?,?,NULL,?,NULL,?)',
      )
      .run('automation-one', 'legacy', user.userId, now - 1, now - 3600);
    await expect(checkout()).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(count('stripe_automation_purchase_requests')).toBe(0);
  });
  it('refuses a conflicting common footprint regardless of provider', async () => {
    await new D1PurchaseIntents(d1(), () => now).reserve({
      ownerId: user.userId,
      organizationId: 'automation-one',
      workspaceId: null,
      environment: 'TEST',
      provider: 'postfinance',
      providerScope: 'synthetic-pfp-scope',
      product: 'automation',
      planId: null,
      parameters: { price: 1500 },
      terms: {
        version: 'synthetic',
        consentVersion: null,
        origin: 'https://zentraapp.ch',
      },
      reservationSeconds: 3600,
    });
    await expect(checkout()).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it.each(['id', 'attempt', 'valid'])(
    'resolves a legacy session only with the exact frozen attempt: %s',
    async (kind) => {
      const legacy = {
        id: 'cs_test_legacy',
        mode: 'subscription',
        status: 'open',
        livemode: false,
        customer: 'cus_base_fixture',
        expires_at: now - 60,
        metadata: {
          service: 'zentra_automation',
          organization_id: 'automation-one',
          owner_id: user.userId,
          attempt_id: 'legacy-attempt',
        },
      } as unknown as Stripe.Checkout.Session;
      const frozen = {
        mode: 'subscription',
        customer: 'cus_base_fixture',
        expires_at: legacy.expires_at,
        metadata: { ...legacy.metadata },
      };
      sql
        .prepare(
          'INSERT INTO automation_checkouts(organization_id,attempt_id,user_id,session_id,expires_at,request_json,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          'automation-one',
          'legacy-attempt',
          user.userId,
          legacy.id,
          legacy.expires_at,
          JSON.stringify(frozen),
          now - 3600,
        );
      sessions.set('legacy', legacy);
      if (kind === 'id')
        retrieve.mockResolvedValue({ ...legacy, id: 'cs_test_foreign' });
      if (kind === 'attempt') legacy.metadata!.attempt_id = 'foreign';
      if (kind === 'valid') {
        await checkout();
        expect(expire).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledTimes(1);
      } else {
        await expect(checkout()).rejects.toThrow();
        expect(expire).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      }
    },
  );
});
