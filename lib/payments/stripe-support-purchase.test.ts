import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import {
  D1StripeSupportPurchase,
  type StripeSupportConfiguration,
  type StripeSupportTransport,
} from './stripe-support-purchase';
import { D1PurchaseIntents } from './purchase-intents';
import { SUPPORT_LEGAL_VERSION } from '@/lib/support/plans';
import { POST } from '@/app/api/support/checkout/route';

let sql: DatabaseSync, now: number, locale: 'fr' | 'de', lost: boolean;
let config: StripeSupportConfiguration,
  beforeRun: ((query: string) => void) | null;
let sessions: Map<string, Stripe.Checkout.Session>;
let create: ReturnType<typeof vi.fn>,
  retrieve: ReturnType<typeof vi.fn>,
  list: ReturnType<typeof vi.fn>,
  expire: ReturnType<typeof vi.fn>,
  price: ReturnType<typeof vi.fn>;
const http = vi.hoisted(() => ({
  user: null as ZentraUser | null,
  rate: vi.fn(),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: vi.fn(() => http.user) }));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => locale,
}));
vi.mock('@/lib/runtime', () => ({
  database: () => d1(),
  runtimeValue: () => '',
  stripeConfiguration: () => ({
    siteUrl: 'https://zentraapp.ch',
    siteOriginAliases: '',
  }),
}));
vi.mock('@/lib/support/billing', () => ({
  billingState: vi.fn(),
  refreshSupportPayment: vi.fn(),
}));
vi.mock('@/lib/account', () => ({ enforceAccountRateLimit: http.rate }));
const user = {
  userId: 'support-synthetic-owner',
  email: 'support-synthetic@example.test',
  displayName: 'Synthetic owner',
  fullName: 'Synthetic owner',
  emailConfirmed: true,
  provider: 'supabase',
} as ZentraUser;
const origin = 'https://zentraapp.ch';
function d1() {
  return {
    prepare(query: string) {
      let args: SQLInputValue[] = [];
      const p = {
        bind(...values: SQLInputValue[]) {
          args = values;
          return p;
        },
        async first() {
          return sql.prepare(query).get(...args) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...args) };
        },
        async run() {
          beforeRun?.(query);
          return { success: true, meta: sql.prepare(query).run(...args) };
        },
        query,
        get args() {
          return args;
        },
      };
      return p;
    },
    async batch(queries: Array<{ query: string; args: SQLInputValue[] }>) {
      sql.exec('BEGIN IMMEDIATE');
      try {
        const out = queries.map((q) => ({
          success: true,
          meta: sql.prepare(q.query).run(...q.args),
        }));
        sql.exec('COMMIT');
        return out;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}
const transport = () =>
  ({ price, create, retrieve, list, expire }) as StripeSupportTransport;
const store = () =>
  new D1StripeSupportPurchase(d1(), config, transport(), () => now);
const input = (patch: Record<string, unknown> = {}) => ({
  user,
  workspaceId: 'support-one',
  planId: 'team' as const,
  origin,
  legalVersion: SUPPORT_LEGAL_VERSION,
  ...patch,
});
const checkout = (patch: Record<string, unknown> = {}) =>
  store().checkout(input(patch));
const cancel = () => store().cancel({ user, workspaceId: 'support-one' });
const count = (table: string) =>
  sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n;
const row = () =>
  sql
    .prepare(
      'SELECT * FROM stripe_support_purchase_requests ORDER BY created_at,request_id',
    )
    .get()!;
function workspace(id = 'support-one', owner = user.userId) {
  sql
    .prepare(
      'INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',
    )
    .run(id, owner, 'Synthetic support', now, now);
}
function company() {
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,seat_limit) VALUES('draft_support_company','draft_customer','synthetic','incomplete',0,0,?,3)",
    )
    .run(now);
  sql
    .prepare(
      "INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES('company-one','Synthetic company','draft_support_company',?,?,?)",
    )
    .run(user.userId, now, now);
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at) VALUES('member-one','company-one',?,?,'Synthetic owner','owner',?)",
    )
    .run(user.userId, user.email, now);
  sql
    .prepare(
      "INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at) VALUES('support-one','company-one',1,0,?,?)",
    )
    .run(user.userId, now);
}
function legacy(
  sessionId: string | null = 'cs_test_legacy',
  patch: Partial<Stripe.Checkout.Session> = {},
) {
  sql
    .prepare(
      'INSERT INTO support_checkouts(workspace_id,nonce,plan_id,session_id,expires_at,owner_id,accepted_version,accepted_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      'support-one',
      'synthetic-legacy-nonce',
      'team',
      sessionId,
      now - 100,
      user.userId,
      'old-support-terms',
      now - 600,
    );
  if (sessionId)
    sessions.set('legacy', {
      id: sessionId,
      url: 'https://checkout.stripe.com/synthetic-legacy',
      mode: 'subscription',
      status: 'open',
      livemode: false,
      expires_at: now - 100,
      client_reference_id: 'support-one',
      payment_method_types: ['card'],
      metadata: {
        service: 'zentra-support',
        workspace_id: 'support-one',
        owner_id: user.userId,
        plan: 'team',
      },
      ...patch,
    } as Stripe.Checkout.Session);
}
beforeEach(() => {
  now = Math.floor(Date.now() / 1000);
  locale = 'fr';
  lost = false;
  beforeRun = null;
  sessions = new Map();
  http.user = null;
  http.rate.mockReset();
  sql = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + f, import.meta.url), 'utf8'),
    );
  workspace();
  config = {
    secretKey: 'sk_test_support_synthetic_not_a_real_key',
    livemode: false,
    productId: 'prod_support_synthetic',
    prices: {
      starter: 'price_starter_synthetic',
      team: 'price_team_synthetic',
      business: 'price_business_synthetic',
    },
  };
  price = vi.fn(async (id: string) => {
    const plan = id.includes('business')
      ? 'business'
      : id.includes('starter')
        ? 'starter'
        : 'team';
    return {
      id,
      active: true,
      livemode: config.livemode,
      currency: 'chf',
      unit_amount: { starter: 2900, team: 4900, business: 9900 }[plan],
      type: 'recurring',
      recurring: { interval: 'month', interval_count: 1 },
      tax_behavior: 'inclusive',
      metadata: { service: 'zentra-support', plan },
      product: { id: config.productId, active: true },
    };
  });
  create = vi.fn(async (parameters, key: string) => {
    if (!sessions.has(key))
      sessions.set(key, {
        id:
          'cs_test_' +
          parameters.metadata.support_request_id.replaceAll('-', ''),
        url: 'https://checkout.stripe.com/synthetic-support',
        mode: 'subscription',
        status: 'open',
        livemode: config.livemode,
        expires_at: parameters.expires_at,
        client_reference_id: parameters.client_reference_id,
        metadata: { ...parameters.metadata },
      } as Stripe.Checkout.Session);
    if (lost) {
      lost = false;
      throw new Error('Synthetic lost response');
    }
    return { ...sessions.get(key)! };
  });
  retrieve = vi.fn(async (id: string) => {
    const found = [...sessions.values()].find((s) => s.id === id);
    if (!found) throw new Error('Synthetic missing session');
    return { ...found };
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
});

describe('Support durable purchase, real migrations and atomic common reservations', () => {
  it('resumes eight concurrent clicks with one request, footprint, provider key and frozen parameters', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => checkout()),
    );
    expect(new Set(results.map((r) => r.url)).size).toBe(1);
    expect(count('stripe_support_purchase_requests')).toBe(1);
    expect(count('purchase_intents')).toBe(1);
    expect(count('purchase_intent_footprints')).toBe(1);
    expect(sessions.size).toBe(1);
    expect(new Set(create.mock.calls.map((c) => c[1])).size).toBe(1);
    expect(
      new Set(create.mock.calls.map((c) => JSON.stringify(c[0]))).size,
    ).toBe(1);
    expect(create.mock.calls[0][0]).not.toHaveProperty('payment_method_types');
    expect(create.mock.calls[0][0].automatic_tax.enabled).toBe(false);
    expect(count('support_subscriptions')).toBe(0);
  });
  it('freezes the linked company and reserves both Support footprints', async () => {
    company();
    await checkout();
    expect(count('purchase_intent_footprints')).toBe(2);
    expect(row().organization_id).toBe('company-one');
    expect(
      create.mock.calls[0][0].subscription_data.metadata.organization_id,
    ).toBe('company-one');
  });
  it('rejects another owner and an inactive owner of a linked company before any provider work', async () => {
    await expect(
      checkout({ user: { ...user, userId: 'other-owner' } }),
    ).rejects.toMatchObject({ status: 403 });
    company();
    sql
      .prepare(
        "UPDATE organization_members SET revoked_at=? WHERE membership_id='member-one'",
      )
      .run(now);
    await expect(checkout()).rejects.toMatchObject({ status: 403 });
    expect(create).not.toHaveBeenCalled();
    expect(price).not.toHaveBeenCalled();
  });
  it('keeps original email, language, price, terms and acceptance on a lost-response retry', async () => {
    lost = true;
    await expect(checkout()).rejects.toThrow('Synthetic lost response');
    const first = structuredClone(create.mock.calls[0][0]),
      accepted = row().accepted_at;
    locale = 'de';
    now += 100;
    config.prices.team = 'price_updated_after_reservation';
    await checkout({ user: { ...user, email: 'updated@example.test' } });
    expect(create.mock.calls[1][0]).toEqual(first);
    expect(price).toHaveBeenCalledTimes(1);
    expect(
      sql
        .prepare(
          'SELECT accepted_at,legal_version FROM support_checkout_acceptances',
        )
        .get(),
    ).toEqual({ accepted_at: accepted, legal_version: SUPPORT_LEGAL_VERSION });
    expect(
      sql
        .prepare('SELECT document_version,accepted_at FROM legal_acceptances')
        .get(),
    ).toEqual({
      document_version: SUPPORT_LEGAL_VERSION,
      accepted_at: new Date(Number(accepted) * 1000).toISOString(),
    });
  });
  it.each([
    { planId: 'business' },
    { origin: 'https://different.example.test' },
    { legalVersion: 'different-terms' },
  ])('refuses changed request context %j', async (patch) => {
    await checkout();
    await expect(checkout(patch)).rejects.toMatchObject({
      status: 'legalVersion' in patch ? 400 : 409,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(count('stripe_support_purchase_requests')).toBe(1);
  });
  it('rejects a different provider-key scope without retrieving the old session', async () => {
    await checkout();
    config.secretKey = 'sk_test_different_synthetic_key';
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
    expect(retrieve).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('separates TEST and PRODUCTION without opening paid rights in either', async () => {
    await checkout();
    config.secretKey = 'sk_live_synthetic_support_not_a_real_key';
    config.livemode = true;
    await checkout();
    expect(count('stripe_support_purchase_requests')).toBe(2);
    expect(count('purchase_intent_footprints')).toBe(2);
    expect(count('support_subscriptions')).toBe(0);
  });
  it.each(['amount', 'product', 'environment', 'interval'])(
    'rejects an invalid %s price before persisting or dispatching',
    async (fault) => {
      price.mockImplementationOnce(async (id) => ({
        id,
        active: true,
        livemode: fault === 'environment',
        currency: 'chf',
        unit_amount: fault === 'amount' ? 1 : 4900,
        type: 'recurring',
        recurring: {
          interval: fault === 'interval' ? 'year' : 'month',
          interval_count: 1,
        },
        tax_behavior: 'inclusive',
        metadata: { service: 'zentra-support', plan: 'team' },
        product: {
          id: fault === 'product' ? 'other' : config.productId,
          active: true,
        },
      }));
      await expect(checkout()).rejects.toMatchObject({ status: 503 });
      expect(count('stripe_support_purchase_requests')).toBe(0);
      expect(create).not.toHaveBeenCalled();
    },
  );
  it('recovers a lost response with reads only after the frozen POST window', async () => {
    lost = true;
    await expect(checkout()).rejects.toThrow('Synthetic lost response');
    now += 1900;
    await checkout();
    expect(create).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(row().session_id).toBeTruthy();
  });
  it.each(['missing', 'ambiguous', 'truncated'])(
    'holds an uncertain %s response even after a day; never resets the request',
    async (kind) => {
      lost = true;
      await expect(checkout()).rejects.toThrow('Synthetic lost response');
      const before = row().request_id;
      now += 86401;
      if (kind === 'missing') sessions.clear();
      if (kind === 'ambiguous') {
        const session = [...sessions.values()][0];
        sessions.set('second', { ...session, id: 'cs_test_conflictingsecond' });
      }
      if (kind === 'truncated')
        list.mockResolvedValue({
          data: [...sessions.values()],
          has_more: true,
        });
      await expect(checkout()).rejects.toMatchObject({ status: 409 });
      await expect(cancel()).rejects.toMatchObject({ status: 409 });
      expect(create).toHaveBeenCalledTimes(1);
      expect(row().request_id).toBe(before);
      expect(
        sql.prepare('SELECT state FROM purchase_intents').get()?.state,
      ).toBe('uncertain');
      expect(
        sql.prepare('SELECT released_at FROM purchase_intent_footprints').get()
          ?.released_at,
      ).toBeNull();
    },
  );
  it.each(['owner', 'workspace', 'plan', 'environment', 'expiry', 'price'])(
    'rejects a mismatched %s provider receipt without exposing its URL',
    async (fault) => {
      const original = create.getMockImplementation()! as (
        ...args: unknown[]
      ) => Promise<Stripe.Checkout.Session>;
      create.mockImplementationOnce(async (...args) => {
        const s = (await original(...args)) as Stripe.Checkout.Session;
        s.metadata = { ...s.metadata };
        if (fault === 'owner') s.metadata!.owner_id = 'other';
        if (fault === 'workspace') s.metadata!.workspace_id = 'other';
        if (fault === 'plan') s.metadata!.plan = 'starter';
        if (fault === 'environment') s.livemode = true;
        if (fault === 'expiry') s.expires_at += 1;
        if (fault === 'price') s.metadata!.price_id = 'other';
        return s;
      });
      await expect(checkout()).rejects.toMatchObject({ status: 403 });
      expect(row().session_id).toBeNull();
      expect(
        sql.prepare('SELECT provider_reference FROM purchase_intents').get()
          ?.provider_reference,
      ).toBeNull();
      expect(count('support_subscriptions')).toBe(0);
    },
  );
  it('cancels a reserved request without a provider POST and preserves history', async () => {
    beforeRun = (q) => {
      if (
        q.startsWith('UPDATE stripe_support_purchase_requests SET intent_id')
      ) {
        beforeRun = null;
        throw new Error('Synthetic interrupted linkage');
      }
    };
    await expect(checkout()).rejects.toThrow('Synthetic interrupted linkage');
    await expect(cancel()).resolves.toEqual({ canceled: true });
    expect(create).not.toHaveBeenCalled();
    expect(count('stripe_support_purchase_requests')).toBe(1);
    expect(row().closed_at).toBe(now);
    expect(sql.prepare('SELECT state FROM purchase_intents').get()?.state).toBe(
      'released',
    );
  });
  it('cancels only after provider-confirmed expiration and permits an explicit new plan', async () => {
    await checkout();
    await expect(cancel()).resolves.toEqual({ canceled: true });
    expect(expire).toHaveBeenCalledTimes(1);
    expect(count('stripe_support_purchase_requests')).toBe(1);
    await checkout({ planId: 'business' });
    expect(count('stripe_support_purchase_requests')).toBe(2);
    expect(count('purchase_intents')).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) n FROM purchase_intent_footprints WHERE released_at IS NULL',
        )
        .get()?.n,
    ).toBe(1);
  });
  it('never releases when payment completes while the page is expiring', async () => {
    await checkout();
    const s = [...sessions.values()][0];
    expire.mockImplementationOnce(async () => {
      s.status = 'complete';
      s.payment_status = 'paid';
      throw new Error('Synthetic payment won');
    });
    await expect(cancel()).rejects.toMatchObject({ status: 409 });
    expect(row().closed_at).toBeNull();
    expect(
      sql.prepare('SELECT released_at FROM purchase_intent_footprints').get()
        ?.released_at,
    ).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('does not finalize settled or grant rights from a complete session alone', async () => {
    await checkout();
    const s = [...sessions.values()][0];
    s.status = 'complete';
    s.subscription = 'sub_synthetic_support';
    s.payment_status = 'paid';
    const result = await checkout();
    expect(result).toHaveProperty('completedSessionId', s.id);
    expect(row().subscription_id).toBe(s.subscription);
    expect(sql.prepare('SELECT state FROM purchase_intents').get()?.state).toBe(
      'dispatched',
    );
    expect(count('support_subscriptions')).toBe(0);
    await expect(cancel()).rejects.toMatchObject({ status: 409 });
  });
  it('expires a known legacy card page before opening any durable dynamic page', async () => {
    legacy();
    await checkout();
    expect(expire.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0],
    );
    expect(
      sql
        .prepare('SELECT nonce,session_id,expires_at FROM support_checkouts')
        .get(),
    ).toEqual({
      nonce: 'synthetic-legacy-nonce',
      session_id: 'cs_test_legacy',
      expires_at: 0,
    });
    expect(count('purchase_intents')).toBe(1);
  });
  it('preserves a completed legacy purchase and its original consent without creating anything else', async () => {
    legacy('cs_test_legacy', { status: 'complete', payment_status: 'paid' });
    const result = await checkout();
    expect(result).toHaveProperty('legacySessionId', 'cs_test_legacy');
    expect(create).not.toHaveBeenCalled();
    expect(count('stripe_support_purchase_requests')).toBe(0);
    expect(
      sql
        .prepare(
          'SELECT legal_version,accepted_at FROM support_checkout_acceptances',
        )
        .get(),
    ).toEqual({ legal_version: 'old-support-terms', accepted_at: now - 600 });
  });
  it('never clears an unknown legacy response because its local TTL passed', async () => {
    legacy(null);
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
    await expect(cancel()).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
    expect(count('stripe_support_purchase_requests')).toBe(0);
  });
  it('atomically prevents a PFP reservation and Stripe Support from occupying the same workspace', async () => {
    await new D1PurchaseIntents(d1(), () => now).reserve({
      ownerId: user.userId,
      environment: 'TEST',
      provider: 'postfinance',
      providerScope: 'https://synthetic.postfinance.test|123',
      product: 'support',
      organizationId: null,
      workspaceId: 'support-one',
      planId: 'team',
      parameters: { synthetic: true },
      terms: { version: SUPPORT_LEGAL_VERSION, consentVersion: null, origin },
    });
    await expect(checkout()).rejects.toThrow(
      /stripe_support_purchase_conflict|paiement|abonnement/,
    );
    expect(create).not.toHaveBeenCalled();
    expect(count('stripe_support_purchase_requests')).toBe(0);
  });
  it('guards both legacy Complete insert orderings even across a paused preflight', async () => {
    beforeRun = (q) => {
      if (q.startsWith('INSERT INTO stripe_support_purchase_requests')) {
        beforeRun = null;
        sql
          .prepare(
            "INSERT INTO complete_checkouts(user_id,nonce,plan_id,parameters,expires_at) VALUES(?,'complete-nonce','team','{}',?)",
          )
          .run(user.userId, now + 3600);
      }
    };
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
    sql.prepare('DELETE FROM complete_checkouts').run();
    await checkout();
    expect(() =>
      sql
        .prepare(
          "INSERT INTO complete_checkouts(user_id,nonce,plan_id,parameters,expires_at) VALUES(?,'complete-nonce','team','{}',?)",
        )
        .run(user.userId, now + 3600),
    ).toThrow(/stripe_support_purchase_conflict/);
  });
  it('fails closed if the linked company changes before common dispatch', async () => {
    // A standalone workspace becomes linked after its immutable request is saved.
    beforeRun = (q) => {
      if (
        q.startsWith('UPDATE stripe_support_purchase_requests SET intent_id')
      ) {
        beforeRun = null;
        company();
      }
    };
    await expect(checkout()).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(count('support_subscriptions')).toBe(0);
  });
  it('SQL rejects financial mutation, receipt reassignment and deletion', async () => {
    await checkout();
    expect(() =>
      sql
        .prepare(
          "UPDATE stripe_support_purchase_requests SET plan_id='business'",
        )
        .run(),
    ).toThrow(/immutable|binding/);
    expect(() =>
      sql
        .prepare(
          "UPDATE stripe_support_purchase_requests SET session_id='cs_test_other'",
        )
        .run(),
    ).toThrow(/binding/);
    expect(() =>
      sql.prepare('DELETE FROM stripe_support_purchase_requests').run(),
    ).toThrow(/history/);
  });
});
describe('Support dedicated checkout HTTP boundary', () => {
  const request = (body: unknown, requestOrigin = origin) =>
    new Request(origin + '/api/support/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: requestOrigin },
      body: JSON.stringify(body),
    });
  it('rejects another origin and unauthenticated account before rate/provider work', async () => {
    expect((await POST(request({}, 'https://other.example.test'))).status).toBe(
      403,
    );
    expect((await POST(request({ workspaceId: 'support-one' }))).status).toBe(
      401,
    );
    expect(http.rate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it('bounds request JSON, rejects unsupported action and never accepts provider/price from the caller', async () => {
    http.user = user;
    expect(
      (
        await POST(
          request({
            workspaceId: 'support-one',
            action: 'dispatch',
            price: 'caller-price',
            provider: 'caller',
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request({ workspaceId: 'support-one', extra: 'x'.repeat(5000) }),
        )
      ).status,
    ).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });
});
