import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import { completePlan } from '@/lib/complete/plans';
import {
  D1StripeCompletePurchase,
  type StripeCompleteTransport,
} from './stripe-complete-purchase';
import { D1StripeCompleteProvisioning } from './stripe-complete-provisioning';
import type { SupportSettlementTransport } from './stripe-support-provisioning';
let sql: DatabaseSync,
  now: number,
  beforeRun: ((query: string) => void) | null,
  lost: boolean;
let create: ReturnType<typeof vi.fn>,
  retrieve: ReturnType<typeof vi.fn>,
  list: ReturnType<typeof vi.fn>,
  expire: ReturnType<typeof vi.fn>;
let sessions: Map<string, Stripe.Checkout.Session>, prices: Stripe.Price;
vi.mock('@/lib/runtime', () => ({
  database: () => d1(),
  runtimeValue: () => 'sk_test_synthetic',
  stripeConfiguration: () => ({
    secretKey: 'sk_test_synthetic',
    siteUrl: 'https://zentraapp.ch',
    priceIds: {},
    testMode: 'true',
  }),
}));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
const user = {
  userId: 'synthetic-complete-owner',
  email: 'owner@example.test',
  displayName: 'Synthetic owner',
  emailConfirmed: true,
} as ZentraUser;
const plan = completePlan('team')!,
  origin = 'https://zentraapp.ch';
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
    async batch(qs: Array<{ query: string; args: SQLInputValue[] }>) {
      sql.exec('BEGIN IMMEDIATE');
      try {
        const result = qs.map((q) => {
          beforeRun?.(q.query);
          return { success: true, meta: sql.prepare(q.query).run(...q.args) };
        });
        sql.exec('COMMIT');
        return result;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}
function controller() {
  return new D1StripeCompletePurchase(
    d1(),
    { secretKey: 'sk_test_synthetic', livemode: false },
    {
      price: async () => prices,
      create,
      retrieve,
      list,
      expire,
    } as StripeCompleteTransport,
    () => now,
  );
}
const checkout = (patch: Record<string, unknown> = {}) =>
  controller().checkout({ user, plan, origin, automaticTax: false, ...patch });
const count = (table: string) =>
  sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n;
const row = () =>
  sql
    .prepare(
      'SELECT * FROM stripe_complete_purchase_requests ORDER BY created_at,request_id',
    )
    .get()!;
function company(id = 'original', subscription = 'draft_original') {
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,seat_limit) VALUES(?,?,'unpaid','incomplete',0,0,?,3)",
    )
    .run(subscription, subscription, now);
  sql
    .prepare(
      'INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    )
    .run(id, 'Preserved company', subscription, user.userId, now, now);
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at) VALUES(?,?,?,?,?,'owner',?)",
    )
    .run('member_' + id, id, user.userId, user.email, user.displayName, now);
}
function financial() {
  const r = row(),
    s = [...sessions.values()][0];
  s.status = 'complete';
  s.payment_status = 'paid';
  s.subscription = 'sub_complete';
  s.customer = 'cus_complete';
  const subscription = {
    id: 'sub_complete',
    customer: 'cus_complete',
    livemode: false,
    status: 'active',
    cancel_at_period_end: false,
    metadata: JSON.parse(String(r.parameters_json)).subscription_data.metadata,
    automatic_tax: { enabled: false },
    items: {
      has_more: false,
      data: [
        {
          quantity: 1,
          price: prices,
          current_period_start: now - 5,
          current_period_end: now + 2592000,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
  const invoice = {
    id: 'in_complete',
    customer: 'cus_complete',
    livemode: false,
    status: 'paid',
    currency: 'chf',
    total: 9900,
    amount_paid: 9900,
    amount_remaining: 0,
    billing_reason: 'subscription_create',
    automatic_tax: { enabled: false, status: null },
    status_transitions: { paid_at: now },
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: 'sub_complete' },
    },
    lines: {
      has_more: false,
      data: [
        {
          currency: 'chf',
          quantity: 1,
          subtotal: 9900,
          period: { start: now - 5, end: now + 2592000 },
          parent: {
            type: 'subscription_item_details',
            subscription_item_details: {
              subscription: 'sub_complete',
              proration: false,
            },
          },
          pricing: {
            price_details: { price: prices.id },
            unit_amount_decimal: '9900',
          },
        },
      ],
    },
  } as unknown as Stripe.Invoice;
  const paymentIntent = {
    id: 'pi_complete',
    livemode: false,
    customer: 'cus_complete',
    currency: 'chf',
    status: 'succeeded',
    amount_received: 9900,
    latest_charge: 'ch_complete',
  } as unknown as Stripe.PaymentIntent;
  const charge = {
    id: 'ch_complete',
    livemode: false,
    customer: 'cus_complete',
    currency: 'chf',
    status: 'succeeded',
    paid: true,
    captured: true,
    amount_captured: 9900,
    amount_refunded: 0,
    refunded: false,
    payment_intent: 'pi_complete',
  } as unknown as Stripe.Charge;
  const transport = {
    session: retrieve,
    sessions: list,
    payments: vi.fn(async () => ({
      has_more: false,
      data: [
        {
          id: 'ip_complete',
          status: 'paid',
          livemode: false,
          invoice: 'in_complete',
          currency: 'chf',
          amount_paid: 9900,
          payment: { type: 'payment_intent', payment_intent: 'pi_complete' },
        },
      ],
    })),
    paymentIntent: vi.fn(async () => paymentIntent),
    charge: vi.fn(async () => charge),
  } as unknown as SupportSettlementTransport;
  const provision = () =>
    new D1StripeCompleteProvisioning(d1(), transport, () => now).provision(
      subscription,
      invoice,
      'stripe_key_' +
        String(
          sql
            .prepare(
              'SELECT provider_scope FROM stripe_complete_purchase_requests',
            )
            .get()!.provider_scope,
        ).replace('stripe_key_', ''),
      false,
    );
  return { subscription, invoice, charge, transport, provision };
}
beforeEach(() => {
  now = Math.floor(Date.parse('2026-10-06T10:11:12Z') / 1000);
  beforeRun = null;
  lost = false;
  sql = new DatabaseSync(':memory:');
  sql.function('unixepoch', () => now);
  for (const f of readdirSync('drizzle')
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort())
    sql.exec(readFileSync('drizzle/' + f, 'utf8'));
  if (
    !sql
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name='stripe_complete_purchase_requests'",
      )
      .get()
  )
    sql.exec(
      readFileSync(
        'D:/Codex-Zentra-Temporary/2026-10-06/postfinance-evidence/stripe-complete-0079-fragment.sql',
        'utf8',
      ),
    );
  sessions = new Map();
  prices = {
    id: 'price_complete_team',
    active: true,
    livemode: false,
    currency: 'chf',
    unit_amount: 9900,
    product: plan.productId,
    lookup_key: plan.lookupKey,
    metadata: { service: 'zentra-complet', bundle_plan: 'team' },
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    tax_behavior: 'inclusive',
  } as unknown as Stripe.Price;
  create = vi.fn(
    async (params: Stripe.Checkout.SessionCreateParams, key: string) => {
      let session = sessions.get(key);
      if (!session) {
        session = {
          id: 'cs_test_' + sessions.size,
          mode: 'subscription',
          status: 'open',
          payment_status: 'unpaid',
          livemode: false,
          client_reference_id: params.client_reference_id,
          expires_at: params.expires_at,
          metadata: params.metadata,
          url: 'https://checkout.stripe.com/c/pay/synthetic',
        } as Stripe.Checkout.Session;
        sessions.set(key, session);
      }
      if (lost) throw new Error('synthetic lost response');
      return session;
    },
  );
  retrieve = vi.fn(async (id: string) => {
    const session = [...sessions.values()].find((s) => s.id === id);
    if (!session) throw new Error('Missing synthetic session');
    return session;
  });
  list = vi.fn(async () => ({ data: [...sessions.values()], has_more: false }));
  expire = vi.fn(async (id: string) => {
    const s = await (
      retrieve as (id: string) => Promise<Stripe.Checkout.Session>
    )(id);
    if (s.status === 'complete') throw new Error('payment won');
    s.status = 'expired';
    return s;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Real transport forbidden');
    }),
  );
});
afterEach(() => {
  sql.close();
  vi.unstubAllGlobals();
});
describe('Complet real common ledger purchase and atomic handoff', () => {
  it('eight simultaneous clicks freeze one company/workspace/catalog and all four footprints', async () => {
    const out = await Promise.all(Array.from({ length: 8 }, () => checkout()));
    expect(new Set(out.map((v) => v.url)).size).toBe(1);
    expect(sessions.size).toBe(1);
    expect(new Set(create.mock.calls.map((c) => c[1])).size).toBe(1);
    expect(count('organizations')).toBe(1);
    expect(count('support_workspaces')).toBe(1);
    expect(count('stripe_complete_purchase_requests')).toBe(1);
    expect(count('purchase_intents')).toBe(1);
    expect(count('purchase_intent_footprints')).toBe(4);
    expect(count('complete_subscriptions')).toBe(0);
    const catalog = JSON.parse(String(row().catalog_json));
    expect(catalog).toMatchObject({
      priceChfCents: 9900,
      licensePlan: 'zentra-start-monthly-59-chf',
      seats: 3,
      analyses: 5000,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('preserves an existing enterprise and requires explicit choice for several', async () => {
    company();
    company('second', 'draft_second');
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
    await checkout({ organizationId: 'original' });
    expect(row().organization_id).toBe('original');
    expect(count('organizations')).toBe(2);
    await expect(checkout({ organizationId: 'second' })).rejects.toMatchObject({
      status: 409,
    });
  });
  it('keeps an uncertain result beyond expiry and only recovers a unique provider receipt', async () => {
    lost = true;
    await expect(checkout()).rejects.toThrow('lost response');
    expect(sql.prepare('SELECT state FROM purchase_intents').get()!.state).toBe(
      'uncertain',
    );
    now += 3601;
    lost = false;
    const result = await checkout();
    expect(result.url).toContain('stripe.com');
    expect(create).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
    await controller().cancel(user);
    expect(expire).toHaveBeenCalledOnce();
    expect(count('stripe_complete_purchase_requests')).toBe(1);
    expect(row().closed_at).toBe(now);
  });
  it('records a lost provider response after owner revocation and refuses any retry dispatch', async () => {
    const providerCreate =
      create.getMockImplementation()! as StripeCompleteTransport['create'];
    create.mockImplementationOnce(
      async (params: Stripe.Checkout.SessionCreateParams, key: string) => {
        await providerCreate(params, key);
        sql.prepare('UPDATE organization_members SET revoked_at=?').run(now);
        throw new Error('synthetic lost response after owner change');
      },
    );
    await expect(checkout()).rejects.toThrow(
      'synthetic lost response after owner change',
    );
    expect(sql.prepare('SELECT state FROM purchase_intents').get()!.state).toBe(
      'uncertain',
    );
    expect(row().closed_at).toBeNull();
    expect(count('stripe_complete_paid_projections')).toBe(0);
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) n FROM purchase_intent_footprints WHERE released_at IS NULL',
        )
        .get()!.n,
    ).toBe(4);
    await expect(checkout()).rejects.toMatchObject({ status: 403 });
    expect(create).toHaveBeenCalledOnce();
    expect(retrieve).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('does not release anything for an ambiguous or missing recovery result', async () => {
    lost = true;
    await expect(checkout()).rejects.toThrow();
    now += 86400;
    list.mockResolvedValue({ data: [], has_more: false });
    await expect(controller().cancel(user)).rejects.toMatchObject({
      status: 409,
    });
    expect(row().closed_at).toBeNull();
    expect(
      sql
        .prepare(
          'SELECT count(*) n FROM purchase_intent_footprints WHERE released_at IS NULL',
        )
        .get()!.n,
    ).toBe(4);
    expect(create).toHaveBeenCalledOnce();
  });
  it('cancellation only releases after verified expiry, including a lost expiration response', async () => {
    await checkout();
    expire.mockImplementationOnce(async (id: string) => {
      const s = await (
        retrieve as (id: string) => Promise<Stripe.Checkout.Session>
      )(id);
      s.status = 'expired';
      throw new Error('lost expire response');
    });
    await controller().cancel(user);
    expect(sql.prepare('SELECT state FROM purchase_intents').get()!.state).toBe(
      'expired',
    );
    expect(row().closed_at).toBe(now);
  });
  it('payment wins cancellation without releasing scopes', async () => {
    await checkout();
    const s = [...sessions.values()][0];
    expire.mockImplementationOnce(async () => {
      s.status = 'complete';
      throw new Error('payment wins');
    });
    await expect(controller().cancel(user)).rejects.toMatchObject({
      status: 409,
    });
    expect(row().closed_at).toBeNull();
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) n FROM purchase_intent_footprints WHERE released_at IS NULL',
        )
        .get()!.n,
    ).toBe(4);
  });
  it('status-only updates never write a paid cache or product projection', async () => {
    await checkout();
    const f = financial();
    expect(
      await new D1StripeCompleteProvisioning(
        d1(),
        f.transport,
        () => now,
      ).provision(f.subscription, null, String(row().provider_scope), false),
    ).toBe(true);
    expect(count('complete_subscriptions')).toBe(0);
    expect(count('stripe_complete_paid_projections')).toBe(0);
    expect(
      sql
        .prepare(
          "SELECT COUNT(*) n FROM subscriptions WHERE subscription_id='sub_complete'",
        )
        .get()!.n,
    ).toBe(0);
  });
  it('verified cash atomically binds all products and closes the original target without moving data', async () => {
    company();
    await checkout();
    const f = financial();
    expect(await f.provision()).toBe(true);
    expect(count('organizations')).toBe(1);
    expect(
      sql.prepare('SELECT subscription_id,name FROM organizations').get(),
    ).toMatchObject({
      subscription_id: 'sub_complete',
      name: 'Preserved company',
    });
    expect(count('support_gestion_links')).toBe(1);
    expect(count('stripe_complete_closed_paid_projections')).toBe(1);
    expect(sql.prepare('SELECT state FROM purchase_intents').get()!.state).toBe(
      'settled',
    );
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) n FROM purchase_intent_footprints WHERE released_at IS NULL',
        )
        .get()!.n,
    ).toBe(0);
    expect(
      sql
        .prepare(
          'SELECT seat_limit,entitlement_plan_id FROM subscriptions WHERE subscription_id=?',
        )
        .get('sub_complete'),
    ).toMatchObject({ seat_limit: 3, entitlement_plan_id: plan.licensePlan });
    expect(await f.provision()).toBe(false);
    expect(count('stripe_complete_paid_projections')).toBe(1);
  });
  it('a concurrent handoff after the last read replays only its exact closed cash evidence', async () => {
    company();
    await checkout();
    const f = financial(),
      database = d1(),
      scope = String(row().provider_scope);
    let raced = false;
    const concurrent = {
      prepare: database.prepare.bind(database),
      async batch(statements: D1PreparedStatement[]) {
        if (!raced) {
          raced = true;
          expect(await f.provision()).toBe(true);
        }
        return database.batch(statements);
      },
    } as Pick<D1Database, 'prepare' | 'batch'>;
    expect(
      await new D1StripeCompleteProvisioning(
        concurrent,
        f.transport,
        () => now,
      ).provision(f.subscription, f.invoice, scope, false),
    ).toBe(true);
    expect(raced).toBe(true);
    expect(count('stripe_complete_paid_projections')).toBe(1);
    expect(count('stripe_complete_closed_paid_projections')).toBe(1);
    expect(count('organizations')).toBe(1);
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) n FROM purchase_intent_footprints WHERE released_at IS NULL',
        )
        .get()!.n,
    ).toBe(0);
  });
  it.each([
    'owner',
    'target',
    'workspace',
    'price',
    'environment',
    'cash',
    'refund',
    'period',
  ])('refuses divergent %s with no partial rights', async (kind) => {
    company();
    await checkout();
    const f = financial();
    if (kind === 'owner')
      sql.prepare('UPDATE organization_members SET revoked_at=?').run(now);
    if (kind === 'target') {
      sql
        .prepare(
          "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('draft_other','other','other','incomplete',0,0,?)",
        )
        .run(now);
      sql
        .prepare("UPDATE organizations SET subscription_id='draft_other'")
        .run();
    }
    if (kind === 'workspace') f.subscription.metadata.workspace_id = 'other';
    if (kind === 'price') f.subscription.items.data[0].price.unit_amount = 1;
    if (kind === 'environment') f.subscription.livemode = true;
    if (kind === 'cash') f.charge.amount_captured = 1;
    if (kind === 'refund') f.charge.amount_refunded = 1;
    if (kind === 'period') f.invoice.lines.data[0].period.end = now - 1;
    await expect(f.provision()).rejects.toThrow();
    expect(count('complete_subscriptions')).toBe(0);
    expect(count('stripe_complete_paid_projections')).toBe(0);
    expect(row().closed_at).toBeNull();
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) n FROM purchase_intent_footprints WHERE released_at IS NULL',
        )
        .get()!.n,
    ).toBe(4);
    if (kind === 'refund') expect(count('complete_refunds')).toBe(1);
  });
  it('a lost company CAS aborts the entire handoff without leaving paid caches', async () => {
    company();
    await checkout();
    const f = financial();
    sql
      .prepare(
        "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('draft_other','other','other','incomplete',0,0,?)",
      )
      .run(now);
    beforeRun = (q) => {
      if (q.startsWith('UPDATE organizations SET subscription_id='))
        sql
          .prepare("UPDATE organizations SET subscription_id='draft_other'")
          .run();
    };
    await expect(f.provision()).rejects.toThrow('stripe_complete_handoff');
    expect(count('stripe_complete_paid_projections')).toBe(0);
    expect(count('complete_subscriptions')).toBe(0);
    expect(
      sql.prepare('SELECT subscription_id FROM organizations').get()!
        .subscription_id,
    ).toBe('draft_original');
  });
  it('a batch storage failure rolls back evidence, caches, company and footprints', async () => {
    company();
    await checkout();
    const f = financial();
    beforeRun = (q) => {
      if (q.startsWith('INSERT INTO support_gestion_links'))
        throw new Error('synthetic storage interruption');
    };
    await expect(f.provision()).rejects.toThrow('storage interruption');
    expect(count('stripe_complete_paid_projections')).toBe(0);
    expect(count('complete_subscriptions')).toBe(0);
    expect(
      sql.prepare('SELECT subscription_id FROM organizations').get()!
        .subscription_id,
    ).toBe('draft_original');
  });
  it('converts an existing trial in place and preserves its end, members and device activation', async () => {
    company('trial-company', 'trial_original');
    sql
      .prepare(
        'INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        user.userId,
        'synthetic-hash',
        'trial-company',
        'trial_original',
        now - 3600,
        now + 86400,
      );
    sql
      .prepare(
        'INSERT INTO complete_trials(user_id,organization_id,analyses) VALUES(?,?,250)',
      )
      .run(user.userId, 'trial-company');
    sql
      .prepare(
        'INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at) VALUES(?,?,?,?,?)',
      )
      .run(
        'synthetic-license',
        'trial_original',
        'synthetic-installation',
        now - 300,
        now - 300,
      );
    await checkout();
    expect(row().trial_subscription_id).toBe('trial_original');
    await financial().provision();
    expect(
      sql
        .prepare('SELECT converted_subscription_id,ends_at FROM account_trials')
        .get(),
    ).toMatchObject({
      converted_subscription_id: 'sub_complete',
      ends_at: now + 86400,
    });
    expect(
      sql
        .prepare(
          'SELECT subscription_id,installation_id FROM license_activations',
        )
        .get(),
    ).toMatchObject({
      subscription_id: 'sub_complete',
      installation_id: 'synthetic-installation',
    });
    expect(count('organizations')).toBe(1);
    expect(count('organization_members')).toBe(1);
  });
  it('a partial refund before grant cannot be replaced by a delayed positive cash result', async () => {
    await checkout();
    const f = financial();
    f.charge.amount_refunded = 1;
    await expect(f.provision()).rejects.toThrow();
    f.charge.amount_refunded = 0;
    await expect(f.provision()).rejects.toThrow();
    expect(count('complete_refunds')).toBe(1);
    expect(count('stripe_complete_paid_projections')).toBe(0);
  });
  it('does not freeze a workspace already associated with another company', async () => {
    company();
    company('other', 'draft_other');
    sql
      .prepare(
        'INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',
      )
      .run('existing-support', user.userId, 'Existing Support', now, now);
    sql
      .prepare(
        'INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at) VALUES(?,?,1,0,?,?)',
      )
      .run('existing-support', 'other', user.userId, now);
    await expect(
      checkout({ organizationId: 'original' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
    expect(count('stripe_complete_purchase_requests')).toBe(0);
  });
  it('atomic dispatch rechecks owner before any provider POST', async () => {
    beforeRun = (q) => {
      if (
        q.startsWith('UPDATE purchase_intents') &&
        q.includes("state='dispatched'")
      )
        sql.prepare('UPDATE organization_members SET revoked_at=?').run(now);
    };
    await expect(checkout()).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
