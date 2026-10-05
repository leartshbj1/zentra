import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
const state = vi.hoisted(() => ({
  db: null as unknown,
  subscription: vi.fn(),
  invoice: vi.fn(),
  payments: vi.fn(),
  charge: vi.fn(),
  intent: vi.fn(),
  create: vi.fn(),
  retrieve: vi.fn(),
  expire: vi.fn(),
  prices: vi.fn(),
  product: vi.fn(),
  listSessions: vi.fn(),
  basePrice: vi.fn(),
  createProduct: vi.fn(),
  createPrice: vi.fn(),
  portalList: vi.fn(),
  portalCreate: vi.fn(),
  portalSession: vi.fn(),
  signingKey: '',
  updateSubscription: vi.fn(), scheduleCreate: vi.fn(), scheduleRetrieve: vi.fn(), scheduleUpdate: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => state.db,
  runtimeValue: (key: string) =>
    key === 'STRIPE_SECRET_KEY' ? 'sk_live_fixture' : '',
  stripeConfiguration: () => ({
    secretKey: 'sk_live_fixture',
    testMode: '',
    signingKey: state.signingKey,
    priceIds: { solo: 'price_solo', start: 'price_start', pro: 'price_pro' },
  }),
}));
vi.mock('@/lib/account', () => ({ requireBrowserMembership: vi.fn() }));
vi.mock('@/lib/referrals', () => ({
  authorizedReferralDiscount: async () => 0,
}));
vi.mock('stripe', () => ({
  default: class {
    static createFetchHttpClient() {
      return {};
    }
    subscriptions = { retrieve: state.subscription,update:state.updateSubscription };
    subscriptionSchedules={create:state.scheduleCreate,retrieve:state.scheduleRetrieve,update:state.scheduleUpdate};
    invoices = { retrieve: state.invoice };
    invoicePayments = { list: state.payments };
    charges = { retrieve: state.charge };
    paymentIntents = { retrieve: state.intent };
    checkout = {
      sessions: {
        create: state.create,
        retrieve: state.retrieve,
        expire: state.expire,
        list: state.listSessions,
      },
    };
    prices = {
      list: state.prices,
      retrieve: state.basePrice,
      create: state.createPrice,
    };
    products = { retrieve: state.product, create: state.createProduct };
    billingPortal = { configurations: {list:state.portalList,create:state.portalCreate},sessions:{create:state.portalSession} };
  },
}));
import { completePlan, COMPLETE_PLANS } from './plans';
import {
  completeAccess,
  completeSupportSubscription,
  provisionCompleteCompany,
} from './access';
import {
  subscriptionCompletePlan,
  persistCompleteRefund,
  ensureCompletePrice,
  ensureCompletePortalConfiguration,
  completePortal,
} from './stripe';
import {
  completeCheckout,
  cancelCompleteCheckout,
  assertNoCompleteCheckout,
} from './checkout';
import { SUPPORT_WORKSPACES_SQL } from '@/lib/support/workspace-access';
import { teamSeats, requireMemberSeat } from '@/lib/team-seats';
import { issueLicense } from '@/lib/license-token';
import {
  persistStripeEvent,
  upsertSubscription,
  validatePaidZentraInvoice,
  paidEntitlementForSubscription,
} from '@/lib/stripe';
import {
  automationEntitlement,
  requireAutomationEntitlement,
} from '@/lib/automation/entitlement';
import {
  billingState,
  reserveAnalysis,
  finishAnalysis,
} from '@/lib/support/billing';
import { automationBillingState } from '@/lib/automation/billing';
import type { ZentraUser } from '@/app/zentra-auth';
import type { Workspace } from '@/lib/support/types';
import { startAccountTrial,trialLicenseEntitlement } from '@/lib/account-trial';
import { completeTrial } from './trial';
import { quotePlanChange,changePlan,pendingPlanChange,resumePlanChange } from './change';
import { transitionAccess,transitionLicense } from './bridge';
import { subscriptionJourney,quotaAlert,skipJourneyStep } from './journey';
let db: DatabaseSync,
  sub: Stripe.Subscription,
  invoices: Map<string, Stripe.Invoice>,
  refunded: Set<string>;
const now = () => Math.floor(Date.now() / 1000);
let signingKeys: CryptoKeyPair;
beforeAll(async () => {
  signingKeys = await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']) as CryptoKeyPair;
  state.signingKey = Buffer.from(await crypto.subtle.exportKey('pkcs8',signingKeys.privateKey)).toString('base64url');
});
const user = {
  userId: 'owner',
  email: 'owner@example.test',
  displayName: 'Test PME',
  emailConfirmed: true,
  provider: 'supabase',
} as ZentraUser;
const plan = completePlan('team')!;
const price = {
  id: 'price_bundle',
  product: plan.productId,
  lookup_key: plan.lookupKey,
  currency: 'chf',
  unit_amount: 9900,
  active: true,
  livemode: true,
  type: 'recurring',
  tax_behavior: 'inclusive',
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
  metadata: { service: 'zentra-complet', bundle_plan: 'team' },
} as unknown as Stripe.Price;
function makeInvoice(
  id = 'in_current',
  start = now() - 60,
  end = now() + 30 * 86400,
) {
  const actualPrice = sub.items.data[0].price;
  const amount = actualPrice.unit_amount!;
  return {
    id,
    status: 'paid',
    livemode: true,
    currency: 'chf',
    total: amount,
    amount_paid: amount,
    customer: 'cus_bundle',
    automatic_tax: { enabled: true, status: 'complete' },
    billing_reason: 'subscription_cycle',
    status_transitions: { paid_at: now() },
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: sub.id, metadata: sub.metadata },
    },
    lines: {
      has_more: false,
      data: [
        {
          currency: 'chf',
          quantity: 1,
          subtotal: amount,
          parent: {
            type: 'subscription_item_details',
            subscription_item_details: {
              subscription: sub.id,
              proration: false,
            },
          },
          pricing: {
            unit_amount_decimal: String(amount),
            price_details: { price: actualPrice.id },
          },
          period: { start, end },
        },
      ],
    },
  } as unknown as Stripe.Invoice;
}
function event(type: string, invoiceId = 'in_current') {
  return {
    id: 'evt_' + crypto.randomUUID(),
    type,
    livemode: true,
    created: now(),
    data: {
      object:
        type === 'charge.refunded'
          ? { id: 'ch_' + invoiceId }
          : type.startsWith('invoice.')
            ? invoices.get(invoiceId)
            : sub,
    },
  } as Stripe.Event;
}
async function pay(id = 'in_current') {
  await persistStripeEvent(event('invoice.paid', id));
}
const org = () =>
  (
    db
      .prepare(
        'SELECT organization_id FROM organizations WHERE subscription_id=?',
      )
      .get(sub.id) as { organization_id: string } | undefined
  )?.organization_id;
const workspace = () =>
  db
    .prepare('SELECT * FROM support_workspaces WHERE owner_id=?')
    .get(user.userId) as unknown as Workspace;
beforeEach(() => {
  vi.clearAllMocks();
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'),
    );
  function prepare(query: string) {
    let values: SQLInputValue[] = [];
    const p = {
      bind(...args: SQLInputValue[]) {
        values = args;
        return p;
      },
      first: async () => db.prepare(query).get(...values) || null,
      all: async () => ({ results: db.prepare(query).all(...values) }),
      run: async () => ({ meta: db.prepare(query).run(...values) }),
      execute: () => ({ meta: db.prepare(query).run(...values) }),
    };
    return p;
  }
  state.db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      db.exec('BEGIN');
      try {
        const result = statements.map((s) => s.execute());
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  sub = {
    id: 'sub_bundle',
    customer: 'cus_bundle',
    status: 'active',
    livemode: true,
    automatic_tax: { enabled: true },
    cancel_at_period_end: false,
    metadata: {
      service: 'zentra-complet',
      bundle_plan: 'team',
      plan: plan.licensePlan,
      account_user_id: user.userId,
    },
    items: {
      data: [{ quantity: 1, price, current_period_end: now() + 90 * 86400 }],
    },
  } as unknown as Stripe.Subscription;
  invoices = new Map([['in_current', makeInvoice()]]);
  refunded = new Set();
  state.subscription.mockImplementation(async () => sub);
  state.invoice.mockImplementation(async (id) => invoices.get(id));
  state.payments.mockImplementation(async (input) => {
    const id = input.invoice ?? input.payment.payment_intent.slice(3);
    return {
      has_more: false,
      data: [
        {
          amount_paid: invoices.get(id)!.amount_paid,
          invoice: id,
          payment: { type: 'payment_intent', payment_intent: 'pi_' + id },
        },
      ],
    };
  });
  state.intent.mockImplementation(async (id) => ({
    latest_charge: 'ch_' + id.slice(3),
  }));
  state.charge.mockImplementation(async (id) => ({
    id,
    customer: 'cus_bundle',
    livemode: true,
    payment_intent: 'pi_' + id.slice(3),
    refunded: refunded.has(id.slice(3)),
    amount_captured: invoices.get(id.slice(3))!.amount_paid,
    amount_refunded: refunded.has(id.slice(3)) ? invoices.get(id.slice(3))!.amount_paid : 0,
  }));
  state.prices.mockResolvedValue({ data: [price] });
  state.product.mockResolvedValue({
    id: plan.productId,
    active: true,
    tax_code: 'txcd_fixture',
  });
  const sessions = new Map<string, Stripe.Checkout.Session>();
  state.create.mockImplementation(async (params, options) => {
    if (!sessions.has(options.idempotencyKey))
      sessions.set(options.idempotencyKey, {
        id: 'cs_live_' + options.idempotencyKey,
        url: 'https://checkout.stripe.com/c/pay/fixture',
        status: 'open',
        ...params,
      } as Stripe.Checkout.Session);
    return sessions.get(options.idempotencyKey);
  });
  state.retrieve.mockImplementation(async (id) =>
    [...sessions.values()].find((s) => s.id === id),
  );
  state.listSessions.mockImplementation(async () => ({
    data: [...sessions.values()],
    has_more: false,
  }));
  state.expire.mockImplementation(async (id) => {
    const s = [...sessions.values()].find((s) => s.id === id)!;
    s.status = 'expired';
    return s;
  });
  db.prepare(
    'INSERT INTO checkout_attempts(claim_hash,checkout_session_id,created_at,expires_at,account_user_id,account_email,account_name) VALUES(?,?,?,?,?,?,?)',
  ).run(
    'initial',
    'cs_bound',
    1,
    now() + 86400,
    user.userId,
    user.email,
    user.displayName,
  );
});
afterEach(() => db.close());
async function bindCheckout() {
  await upsertSubscription(sub, {
    id: 'cs_bound',
    customer_details: { email: user.email, name: 'Test PME' },
  } as Stripe.Checkout.Session);
}
describe('Zentra Complet: one verified payment, three company-scoped products', () => {
  it('prepares a dedicated portal without creating a customer, checkout or subscription', async () => {
    state.portalList.mockResolvedValue({data:[],has_more:false});
    state.portalCreate.mockImplementation(async config => ({...config,id:'bpc_complete',livemode:true}));
    const config=await ensureCompletePortalConfiguration();
    expect(config.features).toMatchObject({invoice_history:{enabled:true},payment_method_update:{enabled:true},subscription_cancel:{enabled:true,mode:'at_period_end'},subscription_update:{enabled:false}});
    expect(state.portalCreate).toHaveBeenCalledWith(expect.objectContaining({metadata:{service:'zentra-complet'}}),{idempotencyKey:'zentra_complete_portal_v1'});
    expect(state.portalSession).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });
  it('reuses the correct portal and refuses unsafe or wrong-mode configurations', async () => {
    const config={id:'bpc_complete',livemode:true,metadata:{service:'zentra-complet'},features:{invoice_history:{enabled:true},payment_method_update:{enabled:true},subscription_cancel:{enabled:true,mode:'at_period_end'},subscription_update:{enabled:false}}};
    state.portalList.mockResolvedValue({data:[config],has_more:false});
    state.portalSession.mockResolvedValue({url:'https://billing.stripe.com/test-only'});
    expect(await completePortal('cus_owner','https://zentraapp.ch/compte/abonnement')).toEqual({url:'https://billing.stripe.com/test-only'});
    expect(state.portalSession).toHaveBeenCalledWith({customer:'cus_owner',configuration:'bpc_complete',return_url:'https://zentraapp.ch/compte/abonnement'});
    expect(state.portalCreate).not.toHaveBeenCalled();
    config.features.subscription_update.enabled=true;
    await expect(ensureCompletePortalConfiguration()).rejects.toMatchObject({status:503});
    state.portalList.mockResolvedValue({data:[],has_more:true});
    await expect(ensureCompletePortalConfiguration()).rejects.toMatchObject({status:503});
  });
  it.each(COMPLETE_PLANS)('activates $name with its precise company seats, Support quota and signed app licenses', async ({id}) => {
    const p = completePlan(id)!;
    sub.metadata = {...sub.metadata,bundle_plan:p.id,plan:p.licensePlan};
    sub.items.data[0].price = {...price,product:p.productId,lookup_key:p.lookupKey,unit_amount:p.priceChfCents,metadata:{service:'zentra-complet',bundle_plan:p.id}};
    invoices.set('in_current',makeInvoice());
    await bindCheckout(); await pay();
    expect(await teamSeats(org()!)).toMatchObject({planName:`Complet ${p.name}`,priceChfCents:p.priceChfCents,limit:p.seats,used:1});
    expect(await billingState(workspace())).toMatchObject({active:true,plan:p.support,limit:p.analyses,bundlePlan:p.name});
    expect(await automationBillingState(org()!)).toMatchObject({hasSubscription:true,bundlePlan:p.name});
    expect(await automationEntitlement({organizationId:org()!,userId:user.userId,role:'owner',founder:false})).toBe(true);
    for(let i=1;i<p.seats;i++) db.prepare('INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,?,?)').run(`mem_${i}`,org()!,`member_${i}`,`member${i}@example.test`,'member',i+1);
    expect(()=>db.prepare('INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,?,?)').run('over',org()!,'over','over@example.test','member',99)).toThrow('zentra seat limit reached');
    await requireMemberSeat(org()!,user.userId);
    for(const platform of ['Windows','macOS','iOS','Android']) {
      const installed=crypto.randomUUID(),session='dss_'+crypto.randomUUID();
      const license=await issueLicense({subscriptionId:sub.id,installationId:installed,customerName:'Test '+platform,periodEnd:invoices.get('in_current')!.lines.data[0].period.end,channel:'account',accessRole:'owner',accountUserId:user.userId,accountSessionId:session});
      expect(license.payload).toMatchObject({plan:p.licensePlan,installation_id:installed,account_user_id:user.userId,account_session_id:session});
      const rust=readFileSync(new URL('../../desktop/src-tauri/src/license.rs',import.meta.url),'utf8');
      expect(rust).toContain(`("${p.licensePlan}", ${license.payload.price_chf_cents.toLocaleString('en-US').replaceAll(',','_')})`);
      const [encoded,sig]=license.token.split('.');
      expect(await crypto.subtle.verify('Ed25519',signingKeys.publicKey,Buffer.from(sig,'base64url'),new TextEncoder().encode(encoded))).toBe(true);
    }
    expect((await teamSeats(org()!)).used).toBe(p.seats);
  });
  it('keeps paid Support and company members accessible when automatic transfer is paused', async () => {
    await bindCheckout(); await pay();
    db.prepare('INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,?,1)').run('mem_pause',org()!,'colleague','colleague@example.test','member');
    db.exec('UPDATE support_gestion_links SET enabled=0');
    expect(await billingState(workspace())).toMatchObject({active:true,limit:5000});
    expect(db.prepare(SUPPORT_WORKSPACES_SQL).all('colleague','colleague@example.test','colleague','colleague')).toMatchObject([{id:workspace().id}]);
    expect((await completeSupportSubscription(workspace().id))?.organization_id).toBe(org());
    await provisionCompleteCompany(sub.id,org()!,user.userId);
    expect(db.prepare('SELECT enabled FROM support_gestion_links').get()?.enabled).toBe(0);
  });
  it('denies a collaborator removed by a plan reduction in both Support and Automation', async () => {
    await bindCheckout(); await pay();
    db.prepare('INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,?,1)').run('mem_drop',org()!,'colleague','colleague@example.test','admin');
    db.exec("UPDATE subscriptions SET seat_limit=1,entitlement_plan_id='zentra-solo-monthly-49-chf'");
    expect(db.prepare(SUPPORT_WORKSPACES_SQL).all('colleague','colleague@example.test','colleague','colleague')).toEqual([]);
    await expect(requireAutomationEntitlement({organizationId:org()!,userId:'colleague',role:'admin',founder:false})).rejects.toMatchObject({status:403});
  });
  it('accepts the verified invoice period when Stripe expands its line price', async () => {
    const invoice=invoices.get('in_current')!;
    invoice.lines.data[0].pricing!.price_details!.price=price;
    await bindCheckout(); await pay();
    expect((await completeAccess(org()!))?.paid_from).toBe(invoice.lines.data[0].period.start);
  });
  it('publishes the exact approved prices, seats, quotas and savings', () => {
    expect(
      COMPLETE_PLANS.map((p) => {
        const q = completePlan(p.id)!;
        return [q.priceChfCents, q.seats, q.analyses, q.saving];
      }),
    ).toEqual([
      [7900, 1, 2000, 1400],
      [9900, 3, 5000, 2400],
      [16900, 10, 15000, 3400],
    ]);
  });
  it('does not grant on a checkout or active subscription without a paid invoice', async () => {
    await bindCheckout();
    expect(org()).toBeUndefined();
    expect(workspace()).toBeUndefined();
    await expect(paidEntitlementForSubscription(sub.id)).rejects.toMatchObject({
      status: 402,
    });
  });
  it('activates all products exactly once, with the paid period rather than the future subscription period', async () => {
    await bindCheckout();
    await pay();
    await pay();
    await bindCheckout();
    expect(db.prepare('SELECT COUNT(*) n FROM organizations').get()?.n).toBe(1);
    expect(
      db.prepare('SELECT COUNT(*) n FROM support_workspaces').get()?.n,
    ).toBe(1);
    expect(await completeAccess(org()!)).toMatchObject({
      paid_until: invoices.get('in_current')!.lines.data[0].period.end,
    });
    expect(await billingState(workspace())).toMatchObject({
      active: true,
      plan: 'team',
      limit: 5000,
      bundlePlan: 'Équipe',
    });
    expect(
      await automationEntitlement({
        organizationId: org()!,
        userId: user.userId,
        role: 'owner',
        founder: false,
      }),
    ).toBe(true);
    expect(await automationBillingState(org()!)).toMatchObject({
      bundlePlan: 'Équipe',
      priceChfCents: 0,
    });
    expect(
      db.prepare('SELECT auto_post FROM support_gestion_links').get()
        ?.auto_post,
    ).toBe(0);
    expect(
      db
        .prepare('SELECT COUNT(*) n FROM automation_settings WHERE enabled=1')
        .get()?.n,
    ).toBe(0);
    expect((await paidEntitlementForSubscription(sub.id)).seat_limit).toBe(3);
  });
  it('handles invoice-before-checkout delivery and preserves one existing trial company', async () => {
    await pay();
    expect(org()).toBeUndefined();
    db.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('trial_test','cus_t','trial','active',2000000000,1,1);
      INSERT INTO organizations VALUES('org_trial','Mon entreprise','trial_test','owner',1,1);
      INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('mem_trial','org_trial','owner','owner@example.test','owner',1);
      INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at) VALUES('owner','owner@example.test','org_trial','trial_test',1,2000000000);`);
    await bindCheckout();
    expect(org()).toBe('org_trial');
    expect(
      (await completeSupportSubscription(workspace().id))?.organization_id,
    ).toBe('org_trial');
  });
  it('shares access with authorized company members but rejects revoked members and other companies', async () => {
    await bindCheckout();
    await pay();
    db.prepare(
      'INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,?,1)',
    ).run('mem_second', org()!, 'second', 'second@example.test', 'member');
    await expect(
      requireAutomationEntitlement({
        organizationId: org()!,
        userId: 'second',
        role: 'member',
        founder: false,
      }),
    ).resolves.toMatchObject({ role: 'member' });
    expect(
      db
        .prepare(SUPPORT_WORKSPACES_SQL)
        .all('second', 'second@example.test', 'second', 'second'),
    ).toMatchObject([{ id: workspace().id, role: 'member' }]);
    expect(
      db
        .prepare(SUPPORT_WORKSPACES_SQL)
        .all('other', 'other@example.test', 'other', 'other'),
    ).toEqual([]);
    db.exec(
      "UPDATE organization_members SET revoked_at=1 WHERE user_id='second'",
    );
    expect(
      db
        .prepare(SUPPORT_WORKSPACES_SQL)
        .all('second', 'second@example.test', 'second', 'second'),
    ).toEqual([]);
    await expect(
      requireAutomationEntitlement({
        organizationId: org()!,
        userId: 'second',
        role: 'member',
        founder: false,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await completeAccess('org_other')).toBeNull();
  });
  it('reserves the final analysis atomically and releases failures', async () => {
    await bindCheckout();
    await pay();
    const w = workspace(),
      start = invoices.get('in_current')!.lines.data[0].period.start;
    db.prepare(
      "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<4999) INSERT INTO support_analysis_usage SELECT 'seed-'||n,?,?,'ticket','charged',0,1 FROM x",
    ).run(w.id, start);
    const results = await Promise.allSettled([
      reserveAnalysis(w, 'one', 'lease1'),
      reserveAnalysis(w, 'two', 'lease2'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const success = results.find(
      (r) => r.status === 'fulfilled',
    ) as PromiseFulfilledResult<string>;
    await finishAnalysis(success.value, false);
    const lease = await reserveAnalysis(w, 'retry', 'lease3');
    await finishAnalysis(lease, true);
    expect(await billingState(w)).toMatchObject({ used: 5000, limit: 5000 });
    await expect(reserveAnalysis(w, 'extra', 'lease4')).rejects.toMatchObject({
      status: 402,
    });
  });
  it('rejects mismatched prices, metadata, currency, invoice totals and test/live modes', async () => {
    for (const changed of [
      { unit_amount: 5900 },
      { currency: 'usd' },
      { product: 'prod_other' },
      { livemode: false },
      { lookup_key: 'other' },
    ]) {
      const bad = structuredClone(sub);
      Object.assign(bad.items.data[0].price, changed);
      expect(subscriptionCompletePlan(bad)).toBeNull();
    }
    const bad = structuredClone(sub);
    bad.metadata.plan = completePlan('solo')!.licensePlan;
    expect(subscriptionCompletePlan(bad)).toBeNull();
    const inv = { ...invoices.get('in_current')!, total: 5900 };
    await expect(validatePaidZentraInvoice(inv, sub)).rejects.toMatchObject({
      status: 402,
    });
  });
  it('does not extend on payment failure, old invoice replay or cancellation at period end', async () => {
    await bindCheckout();
    await pay();
    const before = await completeAccess(org()!);
    sub.cancel_at_period_end = true;
    sub.status = 'past_due';
    await persistStripeEvent(event('customer.subscription.updated'));
    expect(await completeAccess(org()!)).toMatchObject({
      paid_until: before!.paid_until,
      cancel_at_period_end: 1,
    });
    invoices.set(
      'in_old',
      makeInvoice('in_old', now() - 60 * 86400, now() - 30 * 86400),
    );
    await pay('in_old');
    expect((await completeAccess(org()!))?.paid_until).toBe(before!.paid_until);
    db.prepare('UPDATE complete_subscriptions SET paid_until=?').run(now() - 1);
    expect(await completeAccess(org()!)).toBeNull();
    expect(await billingState(workspace())).toMatchObject({ active: false });
  });
  it('revokes all products on a verified full refund, resists replay, and permits a new paid renewal', async () => {
    await bindCheckout();
    await pay();
    const company = org()!;
    refunded.add('in_current');
    expect(await persistCompleteRefund(event('charge.refunded'))).toBe(true);
    expect(await completeAccess(company)).toBeNull();
    expect(await billingState(workspace())).toMatchObject({ active: false });
    await expect(pay()).rejects.toMatchObject({ status: 402 });
    await bindCheckout();
    expect(await completeAccess(company)).toBeNull();
    const next = makeInvoice('in_next', now() - 30, now() + 31 * 86400);
    invoices.set('in_next', next);
    await pay('in_next');
    expect(await completeAccess(company)).not.toBeNull();
  });
  it('deduplicates concurrent checkout requests and keeps one immutable monthly pack price', async () => {
    const urls = await Promise.all([
      completeCheckout(user, plan, 'https://zentraapp.ch', true),
      completeCheckout(user, plan, 'https://zentraapp.ch', true),
    ]);
    expect(urls[0]).toEqual(urls[1]);
    expect(
      new Set(state.create.mock.calls.map((c) => c[1].idempotencyKey)).size,
    ).toBe(1);
    const body = state.create.mock.calls[0][0];
    expect(body.line_items).toEqual([{ price: price.id, quantity: 1 }]);
    expect(body.subscription_data.metadata).toMatchObject({
      service: 'zentra-complet',
      bundle_plan: 'team',
      plan: plan.licensePlan,
      account_user_id: user.userId,
    });
    expect(
      db.prepare('SELECT COUNT(*) n FROM legal_acceptances').get()?.n,
    ).toBe(1);
    await expect(
      completeCheckout(
        user,
        completePlan('solo')!,
        'https://zentraapp.ch',
        true,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await cancelCompleteCheckout(user);
    expect(state.expire).toHaveBeenCalledTimes(1);
  });
  it('refuses to sell a second pack to an existing paid company', async () => {
    await bindCheckout();
    await pay();
    await expect(
      completeCheckout(user, plan, 'https://zentraapp.ch', true),
    ).rejects.toMatchObject({ status: 409 });
    expect(state.create).not.toHaveBeenCalled();
    await expect(assertNoCompleteCheckout(user.userId)).rejects.toMatchObject({
      status: 409,
    });
  });
  it('recovers a lost checkout response without recreating an expired request', async () => {
    await completeCheckout(user, plan, 'https://zentraapp.ch', true);
    db.exec('DELETE FROM checkout_attempts; DELETE FROM legal_acceptances');
    db.prepare(
      'UPDATE complete_checkouts SET session_id=NULL,session_url=NULL,expires_at=?',
    ).run(now() - 1);
    await cancelCompleteCheckout(user);
    expect(state.listSessions).toHaveBeenCalledOnce();
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.expire).toHaveBeenCalledOnce();
    expect(
      db.prepare('SELECT COUNT(*) n FROM complete_checkouts').get()?.n,
    ).toBe(0);
  });
  it('keeps the lock when an interrupted checkout completed its payment', async () => {
    await completeCheckout(user, plan, 'https://zentraapp.ch', true);
    db.exec('DELETE FROM checkout_attempts; DELETE FROM legal_acceptances');
    const session = state.create.mock.results[0]!.value;
    (await session).status = 'complete';
    db.prepare(
      'UPDATE complete_checkouts SET session_id=NULL,session_url=NULL,expires_at=?',
    ).run(now() - 1);
    await expect(cancelCompleteCheckout(user)).rejects.toMatchObject({
      status: 409,
    });
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.expire).not.toHaveBeenCalled();
  });
  it('creates the approved recurring catalog using the configured product tax category', async () => {
    state.prices.mockResolvedValue({ data: [] });
    state.product.mockRejectedValue({ code: 'resource_missing' });
    state.basePrice.mockResolvedValue({
      product: { id: 'prod_base', tax_code: 'txcd_10103001' },
    });
    state.createProduct.mockResolvedValue({
      id: plan.productId,
      active: true,
      metadata: { service: 'zentra-complet' },
    });
    state.createPrice.mockResolvedValue(price);
    expect(await ensureCompletePrice(plan)).toEqual(price);
    expect(state.createProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        id: plan.productId,
        tax_code: 'txcd_10103001',
      }),
      { idempotencyKey: plan.productId },
    );
    expect(state.createPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        unit_amount: 9900,
        currency: 'chf',
        tax_behavior: 'inclusive',
        recurring: {
          interval: 'month',
          interval_count: 1,
          usage_type: 'licensed',
        },
      }),
      { idempotencyKey: plan.lookupKey },
    );
  });
  it('never moves an existing Support link to another company', async () => {
    await bindCheckout();
    await pay();
    const company = org()!;
    db.exec(
      `INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub_other','cus_b','price_b','active',2000000000,1,1);INSERT INTO organizations VALUES('org_other','Autre entreprise','sub_other','owner',1,1);`,
    );
    db.prepare('UPDATE support_gestion_links SET organization_id=?').run(
      'org_other',
    );
    await expect(
      provisionCompleteCompany(sub.id, company, user.userId),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      db.prepare('SELECT organization_id FROM support_gestion_links').get()
        ?.organization_id,
    ).toBe('org_other');
  });
});


describe('Complete trial and shared subscription journey',()=>{
  it('gives one company 14 days, three seats and 250 analyses without creating Stripe objects',async()=>{
    const trial=await startAccountTrial(user,'PME essai',true);
    expect(await completeTrial(trial.organization_id)).toMatchObject({active:1,analyses:250});
    expect(await trialLicenseEntitlement(trial.subscription_id,user.userId)).toMatchObject({seat_limit:3});
    expect(await automationEntitlement({organizationId:trial.organization_id,userId:user.userId,role:'owner',founder:false})).toBe(true);
    expect((await billingState(workspace()))).toMatchObject({active:true,limit:250,status:'trialing'});
    const again=await startAccountTrial(user,'Autre nom',true);expect(again.ends_at).toBe(trial.ends_at);
    expect(state.create).not.toHaveBeenCalled();expect(state.scheduleCreate).not.toHaveBeenCalled();
    const view=await subscriptionJourney({organizationId:trial.organization_id,userId:user.userId,role:'owner',founder:false});
    expect(view.products.every(p=>p.active)).toBe(true);expect(view.monthlyChfCents).toBe(0);expect(view.steps.find(s=>s.id==='automation')?.done).toBe(false);
  });
  it('reserves the last trial analysis once under concurrency, releases failures, and stops exactly at expiry',async()=>{
    const trial=await startAccountTrial(user,'PME',true);const w=workspace();
    for(let i=0;i<249;i++){const r=await reserveAnalysis(w,'ticket-'+i,'trial-'+i);await finishAnalysis(r,true)}
    const results=await Promise.allSettled([0,1,2].map(i=>reserveAnalysis(w,'last-'+i,'last-'+i)));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const r=results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>;
    await finishAnalysis(r.value,false);const next=await reserveAnalysis(w,'retry','retry');await finishAnalysis(next,true);
    expect((await billingState(w))).toMatchObject({used:250,limit:250});
    await expect(reserveAnalysis(w,'extra','extra')).rejects.toMatchObject({status:402});
    db.prepare('UPDATE account_trials SET started_at=?,ends_at=? WHERE user_id=?').run(now()-86401,now()-1,user.userId);
    expect(await trialLicenseEntitlement(trial.subscription_id,user.userId)).toBeNull();
    expect((await billingState(w)).active).toBe(false);
    expect(await automationEntitlement({organizationId:trial.organization_id,userId:user.userId,role:'owner',founder:false})).toBe(false);
    expect((await startAccountTrial(user,'Again',true)).ends_at).toBeLessThan(now());
  });
  it('keeps onboarding choices company scoped and does not enable automation when skipping',async()=>{
    const trial=await startAccountTrial(user,'PME',true);const actor={organizationId:trial.organization_id,userId:user.userId,role:'owner',founder:false};
    await Promise.all([skipJourneyStep(actor,'team',true),skipJourneyStep(actor,'connection',true)]);
    const view=await subscriptionJourney(actor);expect(view.steps.filter(s=>s.skipped).map(s=>s.id).sort()).toEqual(['connection','team']);
    expect(view.steps.find(s=>s.id==='automation')?.done).toBe(false);
    await expect(skipJourneyStep({...actor,role:'member'},'automation',true)).rejects.toMatchObject({status:403});
    await skipJourneyStep(actor,'team',false);expect((await subscriptionJourney(actor)).steps.find(s=>s.id==='team')?.skipped).toBe(false);
  });
  it('warns at 80 percent and at the limit without billing overages',()=>{
    expect(quotaAlert(199,250)).toBeNull();expect(quotaAlert(200,250)).toMatchObject({level:'near',remaining:50});
    expect(quotaAlert(250,250)).toMatchObject({level:'reached',remaining:0});expect(quotaAlert(400,250)?.remaining).toBe(0);
  });
  it('offers a pack change when Automation is the only paid product',async()=>{
    const trial=await startAccountTrial(user,'PME Automation');
    db.prepare(`INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at) VALUES(?,?,?,'active',?,?,?,0,1,?)`).run(trial.organization_id,'sub_automation_only','cus_automation_only',now()-10,now()+86400,'in_automation_only',now());
    const actor={organizationId:trial.organization_id,userId:user.userId,role:'owner',founder:false};
    expect((await subscriptionJourney(actor)).canChange).toBe(true);
    expect((await subscriptionJourney({...actor,role:'member'})).canChange).toBe(false);
  });
});
async function changingFixture(){
  const current=invoices.get('in_current')!;sub.items.data[0].current_period_end=current.lines.data[0].period.end;
  sub.items.data[0].current_period_start=current.lines.data[0].period.start;
  await bindCheckout();await pay();
  const target=completePlan('pro')!;
  const targetPrice={...price,id:'price_pro_bundle',product:target.productId,lookup_key:target.lookupKey,unit_amount:target.priceChfCents,metadata:{service:'zentra-complet',bundle_plan:'pro'}};
  state.prices.mockResolvedValue({data:[targetPrice]});state.product.mockResolvedValue({id:target.productId,active:true,tax_code:'txcd_fixture'});
  let schedule:{id:string;created:number;subscription:string;metadata:Record<string,string>;status:string;phases:Stripe.SubscriptionScheduleUpdateParams.Phase[]}|null=null;
  state.scheduleCreate.mockImplementation(async(params)=>{expect(Object.keys(params)).toEqual(['from_subscription']);schedule={id:'sub_sched_change',created:now(),subscription:sub.id,metadata:{},status:'active',phases:[]};sub.schedule=schedule.id;return schedule});
  state.scheduleRetrieve.mockImplementation(async()=>schedule);
  state.scheduleUpdate.mockImplementation(async(_id,params)=>{schedule={...schedule,...params};if(params.phases[0].trial_end)sub.status='trialing';return schedule});
  return {target,targetPrice};
}
describe('self-service changes preserve company and paid periods',()=>{
  async function interruptedWithAddon() {
    await changingFixture();
    const company=org()!,until=sub.items.data[0].current_period_end+86400;
    db.prepare('DELETE FROM complete_subscriptions WHERE subscription_id=?').run(sub.id);
    db.prepare(`INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at) VALUES(?,?,?,'active',?,?,?,0,1,?)`).run(company,'sub_review_addon','cus_review_addon',now()-5,until,'in_review_addon',now());
    const addon={...sub,id:'sub_review_addon',customer:'cus_review_addon',metadata:{service:'zentra-automation'},items:{data:[{...sub.items.data[0],price:{...price,id:'price_review_addon'},current_period_end:until}]}} as unknown as Stripe.Subscription;
    state.subscription.mockImplementation(async(id)=>id===addon.id?addon:sub);
    state.updateSubscription.mockImplementation(async(_id,params)=>{Object.assign(addon,params);return addon});
    const quote=await quotePlanChange(user.userId,company,'pro');
    db.prepare(`INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at) VALUES(?,'review-provider-drift',?,?,'pro',?,'preparing',?,?,?)`).run(company,user.userId,sub.id,quote.effectiveAt,JSON.stringify(quote.snapshot),now(),now());
    return {row:(await pendingPlanChange(company))!,addon};
  }
  it('rejects a changed primary price before canceling a separately paid add-on renewal',async()=>{
    const {row,addon}=await interruptedWithAddon();
    sub.items.data[0].price={...sub.items.data[0].price,id:'price_changed_after_quote'} as Stripe.Price;
    await expect(resumePlanChange(row)).rejects.toMatchObject({status:409});
    expect(state.updateSubscription).not.toHaveBeenCalled();
    expect(addon.cancel_at_period_end).toBe(false);
    expect(state.scheduleCreate).not.toHaveBeenCalled();
  });
  it('rejects a changed primary customer before canceling a separately paid add-on renewal',async()=>{
    const {row,addon}=await interruptedWithAddon();
    sub.customer='cus_changed_after_quote';
    await expect(resumePlanChange(row)).rejects.toMatchObject({status:409});
    expect(state.updateSubscription).not.toHaveBeenCalled();
    expect(addon.cancel_at_period_end).toBe(false);
    expect(state.scheduleCreate).not.toHaveBeenCalled();
  });
  it('rechecks a primary period changed through webhook processing before canceling an add-on renewal',async()=>{
    const {row,addon}=await interruptedWithAddon();
    const retrieve=state.subscription.getMockImplementation()!;
    const changed=event('customer.subscription.updated'),paidEnd=sub.items.data[0].current_period_end;
    let delivered=false;
    state.subscription.mockImplementation(async(id)=>{
      if(id===addon.id&&!delivered){
        delivered=true;
        sub.items.data[0].current_period_end+=86400;
        await persistStripeEvent(changed);
      }
      return retrieve(id);
    });
    await expect(resumePlanChange(row)).rejects.toMatchObject({status:409});
    expect(state.updateSubscription).not.toHaveBeenCalled();
    expect(addon.cancel_at_period_end).toBe(false);
    expect(state.scheduleCreate).not.toHaveBeenCalled();
    expect(db.prepare('SELECT processed_at FROM stripe_events WHERE event_id=?').get(changed.id)?.processed_at).toBeGreaterThan(0);
    expect(db.prepare('SELECT entitlement_valid_until FROM subscriptions WHERE subscription_id=?').get(sub.id)).toMatchObject({entitlement_valid_until:paidEnd});
  });
  it('refuses an external schedule appearing after the quote before canceling an add-on renewal',async()=>{
    const {row,addon}=await interruptedWithAddon();
    sub.schedule='sub_sched_external_after_quote';
    state.scheduleCreate.mockRejectedValue(Object.assign(new Error('Subscription already has a schedule'),{type:'StripeInvalidRequestError'}));
    const refused=await resumePlanChange(row).catch(error=>error);
    expect(state.updateSubscription).not.toHaveBeenCalled();
    expect(addon.cancel_at_period_end).toBe(false);
    expect(state.scheduleUpdate).not.toHaveBeenCalled();
    expect(refused).toMatchObject({status:409});
  });
  it('refuses a durable schedule now owned by another operation before canceling an add-on renewal',async()=>{
    const {row,addon}=await interruptedWithAddon();
    sub.schedule='sub_sched_changed_owner';
    row.schedule_id='sub_sched_changed_owner';
    state.scheduleRetrieve.mockResolvedValue({id:row.schedule_id,subscription:sub.id,metadata:{zentra_change:'another-operation'},created:now(),status:'active',phases:[]});
    await expect(resumePlanChange(row)).rejects.toMatchObject({status:409});
    expect(state.updateSubscription).not.toHaveBeenCalled();
    expect(addon.cancel_at_period_end).toBe(false);
    expect(state.scheduleCreate).not.toHaveBeenCalled();
    expect(state.scheduleUpdate).not.toHaveBeenCalled();
  });
  it('replays its own lost schedule creation without canceling an add-on twice',async()=>{
    const {row,addon}=await interruptedWithAddon();
    const create=state.scheduleCreate.getMockImplementation()!;
    let created:Awaited<ReturnType<typeof create>>|null=null;
    state.scheduleCreate.mockImplementation(async(...args:unknown[])=>{
      if(created)return created;
      created=await create(...args);
      throw new Error('create response lost');
    });
    await expect(resumePlanChange(row)).rejects.toThrow('create response lost');
    expect((await pendingPlanChange(row.organization_id))?.schedule_id).toBeNull();
    await resumePlanChange((await pendingPlanChange(row.organization_id))!);
    expect(state.updateSubscription).toHaveBeenCalledTimes(1);
    expect(addon.cancel_at_period_end).toBe(true);
    expect(state.scheduleCreate).toHaveBeenCalledTimes(2);
    expect(state.scheduleCreate.mock.calls[0][1]).toEqual(state.scheduleCreate.mock.calls[1][1]);
    expect(state.scheduleUpdate).toHaveBeenCalledTimes(1);
    expect((await pendingPlanChange(row.organization_id))?.state).toBe('scheduled');
  });
  it('resumes a refused ordinary change after valid preflight without canceling twice or extending paid rights',async()=>{
    const {row,addon}=await interruptedWithAddon(),company=row.organization_id;
    const paidEnd=sub.items.data[0].current_period_end,addonEnd=addon.items.data[0].current_period_end;
    const customer=sub.customer;
    sub.customer='cus_drifted_then_restored';
    await expect(resumePlanChange(row)).rejects.toMatchObject({status:409});
    expect(state.updateSubscription).not.toHaveBeenCalled();
    sub.customer=customer;
    await resumePlanChange(row);
    await resumePlanChange((await pendingPlanChange(company))!);
    expect(state.updateSubscription).toHaveBeenCalledTimes(1);
    expect(state.scheduleCreate).toHaveBeenCalledTimes(1);
    expect(state.scheduleUpdate).toHaveBeenCalledTimes(1);
    expect(addon.cancel_at_period_end).toBe(true);
    expect(addon.items.data[0].current_period_end).toBe(addonEnd);
    expect(sub.items.data[0].current_period_end).toBe(paidEnd);
    expect((await teamSeats(company)).limit).toBe(3);
    expect(db.prepare('SELECT entitlement_valid_until FROM subscriptions WHERE subscription_id=?').get(sub.id)).toMatchObject({entitlement_valid_until:paidEnd});
  });
  it('quotes without mutation, schedules one existing subscription and keeps old rights until settlement',async()=>{
    const {target,targetPrice}=await changingFixture();const company=org()!;
    const quote=await quotePlanChange(user.userId,company,'pro');expect(quote.effectiveAt).toBe(sub.items.data[0].current_period_end);
    expect(state.scheduleCreate).not.toHaveBeenCalled();
    await changePlan(user.userId,company,'pro',quote.fingerprint);
    await changePlan(user.userId,company,'pro',quote.fingerprint);
    expect(state.scheduleCreate).toHaveBeenCalledTimes(1);expect(state.scheduleUpdate).toHaveBeenCalledTimes(1);
    expect(state.create).not.toHaveBeenCalled();expect((await teamSeats(company)).limit).toBe(3);
    expect(org()).toBe(company);expect((await pendingPlanChange(company))?.state).toBe('scheduled');
    // At the boundary a Stripe status update alone must not unlock ten seats.
    sub.metadata={...sub.metadata,bundle_plan:'pro',plan:target.licensePlan};sub.items.data[0].price=targetPrice as Stripe.Price;
    await upsertSubscription(sub);expect((await teamSeats(company)).limit).toBe(3);
    // Advance the stored boundary to now; future-dated settlement alone cannot finish a change.
    db.prepare('UPDATE complete_plan_changes SET effective_at=? WHERE organization_id=?').run(now()-1,company);
    invoices.set('in_new',makeInvoice('in_new',now()-1,quote.effectiveAt+30*86400));
    await pay('in_new');expect((await teamSeats(company)).limit).toBe(10);expect(org()).toBe(company);
    expect((await pendingPlanChange(company))?.state).toBe('completed');
  });
  it('rejects another owner and a changed quotation before any billing mutation',async()=>{
    await changingFixture();await expect(quotePlanChange('outsider',org()!,'pro')).rejects.toMatchObject({status:403});
    await expect(changePlan(user.userId,org()!,'pro','stale')).rejects.toMatchObject({status:409});expect(state.scheduleCreate).not.toHaveBeenCalled();
  });
  it('does not reprogram an external schedule',async()=>{
    await changingFixture();sub.schedule='sub_sched_external';await expect(quotePlanChange(user.userId,org()!,'pro')).rejects.toMatchObject({status:409});expect(state.scheduleUpdate).not.toHaveBeenCalled();
  });
  it('resumes after a lost schedule response without creating a second subscription',async()=>{
    await changingFixture();const company=org()!,quote=await quotePlanChange(user.userId,company,'pro');
    const update=state.scheduleUpdate.getMockImplementation()!;
    state.scheduleUpdate.mockImplementationOnce(async(...args:unknown[])=>{await update(...args);throw new Error('response lost')});
    await expect(changePlan(user.userId,company,'pro',quote.fingerprint)).rejects.toThrow('response lost');
    expect((await pendingPlanChange(company))?.state).toBe('preparing');
    await changePlan(user.userId,company,'pro',quote.fingerprint);
    expect(state.scheduleCreate).toHaveBeenCalledTimes(1);expect(state.create).not.toHaveBeenCalled();
    expect((await pendingPlanChange(company))?.state).toBe('scheduled');
  });
  it('stops separate add-on renewals before scheduling and gifts only the gap to the final paid date',async()=>{
    await changingFixture();const company=org()!,until=sub.items.data[0].current_period_end+86400;
    // Reproduce three separately paid products, with different renewal dates.
    db.prepare('DELETE FROM complete_subscriptions WHERE subscription_id=?').run(sub.id);
    db.prepare(`INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at) VALUES(?,?,?,'active',?,?,?,0,1,?)`).run(company,'sub_addon','cus_addon',now()-5,until,'in_addon',now());
    const addon={...sub,id:'sub_addon',customer:'cus_addon',metadata:{service:'zentra-automation'},items:{data:[{...sub.items.data[0],price:{...price,id:'price_addon'},current_period_end:until}]}} as unknown as Stripe.Subscription;
    state.subscription.mockImplementation(async(id)=>id==='sub_addon'?addon:sub);
    state.updateSubscription.mockImplementation(async(id,params)=>{expect(id).toBe('sub_addon');Object.assign(addon,params);return addon});
    const quote=await quotePlanChange(user.userId,company,'pro');expect(quote.effectiveAt).toBe(until);
    await changePlan(user.userId,company,'pro',quote.fingerprint);
    expect(state.updateSubscription.mock.invocationCallOrder[0]).toBeLessThan(state.scheduleUpdate.mock.invocationCallOrder[0]);
    expect(state.scheduleUpdate.mock.calls[0][1].phases[0].trial_end).toBe(until);
    expect((await transitionAccess(company))?.until).toBe(until);
    expect((await transitionLicense(sub.id,user.userId))?.seat_limit).toBe(3);
    expect(await transitionLicense(sub.id,'outsider')).toBeNull();
    db.prepare('UPDATE subscriptions SET entitlement_valid_until=0 WHERE subscription_id=?').run(sub.id);
    expect(await transitionAccess(company)).toBeNull();
  });
});

 it('upgrades an existing free Gestion trial in place without extending its end date',async()=>{
   const old=await startAccountTrial(user,'PME',false);
   const upgraded=await startAccountTrial(user,'PME',true);
   expect(upgraded.organization_id).toBe(old.organization_id);expect(upgraded.ends_at).toBe(old.ends_at);
   expect((await trialLicenseEntitlement(old.subscription_id,user.userId))?.seat_limit).toBe(3);
   expect((await billingState(workspace())).limit).toBe(250);
 });
 it('reserves future pack seats atomically when an invitation races with scheduling',async()=>{
   await changingFixture();const company=org()!;
   const insert=(email:string)=>db.prepare(`INSERT INTO organization_invitations(invitation_id,organization_id,invited_email,role,token_hash,created_by_user_id,created_at,expires_at) VALUES(?,?,?,'member',?,'owner',?,?)`).run(crypto.randomUUID(),company,email,crypto.randomUUID(),now(),now()+3600);
   // A downgrade is scheduled with just the owner, then two competing invitations arrive.
   db.prepare(`INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at) VALUES(?,'seat-race','owner',?,'solo',?,'preparing','{}',?,?)`).run(company,sub.id,now()+86400,now(),now());
   expect(()=>insert('late@example.test')).toThrow('zentra seat limit reached');
   db.prepare('DELETE FROM complete_plan_changes').run();insert('member@example.test');
   expect(()=>db.prepare(`INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at) VALUES(?,'race-2','owner',?,'solo',?,'preparing','{}',?,?)`).run(company,sub.id,now()+86400,now(),now())).toThrow('zentra seat limit reached');
 });

it('keeps the company and device activation when the paid source was Support',async()=>{
 const {target,targetPrice}=await changingFixture();const company=org()!,w=workspace(),until=sub.items.data[0].current_period_end;
 db.prepare('DELETE FROM complete_subscriptions WHERE subscription_id=?').run(sub.id);
 db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,customer_name,price_id,plan_id,entitlement_plan_id,seat_limit,status,current_period_end,entitlement_valid_until,livemode,updated_at) VALUES('trial_existing','trial_existing','PME','free_trial','zentra-start-monthly-59-chf','zentra-start-monthly-59-chf',3,'trialing',?,?,0,?)`).run(until,until,now());
 // Use the exact current Gestion claim from the existing company fixture.
 db.prepare('UPDATE subscriptions SET plan_id=?,entitlement_plan_id=? WHERE subscription_id=?').run(plan.licensePlan,plan.licensePlan,'trial_existing');
 db.prepare('UPDATE organizations SET subscription_id=? WHERE organization_id=?').run('trial_existing',company);
 db.prepare(`INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at) VALUES('lic_existing','trial_existing','55af29dd-fdaa-4993-ae78-17f9ca220e51',?,?)`).run(now(),now());
 db.prepare(`INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,paid_plan_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at) VALUES(?,?,?,'team','team','active',?,?,?,0,1,?)`).run(w.id,sub.id,'cus_bundle',now()-60,until,'in_current',now());
 sub.metadata={service:'zentra-support',workspace_id:w.id,plan:'team'};
 const quote=await quotePlanChange(user.userId,company,'pro');expect(quote.snapshot.primary).toBe(sub.id);expect(quote.snapshot.oldSubscription).toBe('trial_existing');
 await changePlan(user.userId,company,'pro',quote.fingerprint);
 db.prepare('UPDATE complete_plan_changes SET effective_at=? WHERE organization_id=?').run(now()-1,company);
 sub.metadata={...sub.metadata,service:'zentra-complet',bundle_plan:'pro',plan:target.licensePlan,organization_id:company,account_user_id:user.userId};sub.items.data[0].price=targetPrice as Stripe.Price;
 invoices.set('in_support_to_pack',makeInvoice('in_support_to_pack',now()-1,until+30*86400));await pay('in_support_to_pack');
 expect(org()).toBe(company);expect(db.prepare('SELECT subscription_id FROM license_activations WHERE license_id=?').get('lic_existing')?.subscription_id).toBe(sub.id);
 expect((await pendingPlanChange(company))?.state).toBe('completed');expect((await teamSeats(company)).limit).toBe(10);expect((await billingState(workspace())).limit).toBe(15000);
});

it.each(['admin','accountant','member'])('shares the real Complete trial with an invited %s in its own company',async(role)=>{
  const trial=await startAccountTrial(user,'PME essai',true);
  const colleague='trial-colleague',email='trial-colleague@example.test';
  db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES('trial-colleague-membership',?,?,?,?,?)`).run(trial.organization_id,colleague,email,role,now());
  const supportRows=db.prepare(SUPPORT_WORKSPACES_SQL).all(colleague,email,colleague,colleague);
  expect(supportRows).toHaveLength(1);
  expect(supportRows[0].id).toBe(workspace().id);
  expect(supportRows[0].role).toBe(role==='admin'?'admin':'member');
  const actor={organizationId:trial.organization_id,userId:colleague,role,founder:false};
  expect(await automationEntitlement(actor)).toBe(true);
  expect(await trialLicenseEntitlement(trial.subscription_id,colleague)).toMatchObject({seat_limit:3});
  expect((await billingState(workspace())).active).toBe(true);
  // The same account has no delegated access to another company's Support.
  await startAccountTrial({...user,userId:'other-trial-owner',email:'other-trial@example.test'},'Autre PME',true);
  expect(db.prepare(SUPPORT_WORKSPACES_SQL).all(colleague,email,colleague,colleague)).toEqual(supportRows);
});

it.each(['read_only','revoked','outsider'])('does not grant trial Support to a %s account',async(kind)=>{
  const trial=await startAccountTrial(user,'PME essai',true),colleague='trial-colleague',email='trial-colleague@example.test';
  if(kind!=='outsider')db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at,revoked_at)
    VALUES('trial-colleague-membership',?,?,?,?,?,?)`).run(trial.organization_id,colleague,email,kind==='read_only'?'read_only':'member',now(),kind==='revoked'?now():null);
  expect(db.prepare(SUPPORT_WORKSPACES_SQL).all(colleague,email,colleague,colleague)).toEqual([]);
  await expect(requireAutomationEntitlement({organizationId:trial.organization_id,userId:colleague,role:'owner',founder:false})).rejects.toMatchObject({status:403});
});

it('ends delegated Support, Automation and Gestion access when the Complete trial expires',async()=>{
  const trial=await startAccountTrial(user,'PME essai',true),colleague='trial-colleague',email='trial-colleague@example.test';
  db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES('trial-colleague-membership',?,?,?,'member',?)`).run(trial.organization_id,colleague,email,now());
  expect(db.prepare(SUPPORT_WORKSPACES_SQL).all(colleague,email,colleague,colleague)).toHaveLength(1);
  db.prepare('UPDATE account_trials SET started_at=?,ends_at=? WHERE user_id=?').run(now()-14*86400-1,now()-1,user.userId);
  db.prepare('UPDATE subscriptions SET current_period_end=?,entitlement_valid_until=? WHERE subscription_id=?').run(now()-1,now()-1,trial.subscription_id);
  expect(db.prepare(SUPPORT_WORKSPACES_SQL).all(colleague,email,colleague,colleague)).toEqual([]);
  expect((await billingState(workspace())).active).toBe(false);
  expect(await automationEntitlement({organizationId:trial.organization_id,userId:colleague,role:'member',founder:false})).toBe(false);
  expect(await trialLicenseEntitlement(trial.subscription_id,colleague)).toBeNull();
});

it('keeps the trial team at three people with the owner included',async()=>{
  const trial=await startAccountTrial(user,'PME essai',true);
  for(const colleague of ['trial-first','trial-second'])db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES(?,?,?,?,'member',?)`).run(colleague,trial.organization_id,colleague,`${colleague}@example.test`,now());
  expect((await teamSeats(trial.organization_id))).toMatchObject({used:3,limit:3,available:0});
  expect(()=>db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES('trial-overflow',?,'trial-overflow','trial-overflow@example.test','member',?)`).run(trial.organization_id,now())).toThrow('zentra seat limit reached');
  for(const colleague of ['trial-first','trial-second'])expect(db.prepare(SUPPORT_WORKSPACES_SQL).all(colleague,`${colleague}@example.test`,colleague,colleague)).toHaveLength(1);
});

describe('v3 captured billing sources and scheduled link delivery', () => {
  async function threePaidSources() {
    await changingFixture();
    const company = org()!, w = workspace(), paidEnd = sub.items.data[0].current_period_end;
    db.prepare('DELETE FROM complete_subscriptions WHERE subscription_id=?').run(sub.id);
    const addon = (kind: 'support' | 'automation', offset: number) => ({
      ...sub, id: `sub_v3_${kind}`, customer: `cus_v3_${kind}`,
      metadata: { service: `zentra-${kind}` },
      items: { data: [{ ...sub.items.data[0], price: { ...price, id: `price_v3_${kind}` }, current_period_end: paidEnd + offset * 86400 }] },
    } as unknown as Stripe.Subscription);
    const support = addon('support', 1), automation = addon('automation', 2);
    db.prepare(`INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,paid_plan_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at) VALUES(?,?,?,'team','team','active',?,?,?,0,1,?)`)
      .run(w.id, support.id, support.customer as string, now()-5, support.items.data[0].current_period_end, 'in_v3_support', now());
    db.prepare(`INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at) VALUES(?,?,?,'active',?,?,?,0,1,?)`)
      .run(company, automation.id, automation.customer as string, now()-5, automation.items.data[0].current_period_end, 'in_v3_automation', now());
    const sources = { gestion: sub, support, automation };
    state.subscription.mockImplementation(async (id) => {
      const found = Object.values(sources).find((source) => source.id === id);
      if (!found) throw new Error('Fixture refused unknown subscription');
      return found;
    });
    state.updateSubscription.mockImplementation(async (id, params) => {
      const found = Object.values(sources).find((source) => source.id === id);
      if (!found) throw new Error('Fixture refused unknown subscription update');
      Object.assign(found, params); return found;
    });
    const quote = await quotePlanChange(user.userId, company, 'pro');
    expect(quote.snapshot.sources.map((source) => source.kind)).toEqual(['gestion','support','automation']);
    db.prepare(`INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at) VALUES(?,'v3-three-sources',?,?,'pro',?,'preparing',?,?,?)`)
      .run(company, user.userId, sub.id, quote.effectiveAt, JSON.stringify(quote.snapshot), now(), now());
    return { sources, row: (await pendingPlanChange(company))! };
  }
  function paidRows() {
    return {
      gestion: db.prepare('SELECT * FROM subscriptions ORDER BY subscription_id').all(),
      complete: db.prepare('SELECT * FROM complete_subscriptions ORDER BY subscription_id').all(),
      support: db.prepare('SELECT * FROM support_subscriptions ORDER BY workspace_id').all(),
      automation: db.prepare('SELECT * FROM automation_subscriptions ORDER BY organization_id').all(),
      usage: db.prepare('SELECT * FROM support_analysis_usage ORDER BY workspace_id,id').all(),
    };
  }
  const drifts = ['customer', 'price', 'period', 'schedule', 'pending_update'] as const;
  const kinds = ['gestion', 'support', 'automation'] as const;
  for (const kind of kinds) for (const drift of drifts) {
    it(`refuses preexisting ${kind} ${drift} drift before any add-on cancellation`, async () => {
      const { sources, row } = await threePaidSources(), source = sources[kind], paid = paidRows();
      if (drift === 'customer') source.customer = 'cus_v3_changed';
      if (drift === 'price') source.items.data[0].price = { ...source.items.data[0].price, id: 'price_v3_changed' };
      if (drift === 'period') source.items.data[0].current_period_end += 86400;
      if (drift === 'pending_update') source.pending_update = {} as Stripe.Subscription.PendingUpdate;
      if (drift === 'schedule') {
        source.schedule = 'sub_sched_v3_external';
        state.scheduleCreate.mockRejectedValue(Object.assign(new Error('External schedule belongs to another operation'), { type: 'StripeInvalidRequestError' }));
      }
      const outcome = await resumePlanChange(row).catch((error) => error);
      expect(state.updateSubscription).not.toHaveBeenCalled();
      expect(sources.support.cancel_at_period_end).toBe(false);
      expect(sources.automation.cancel_at_period_end).toBe(false);
      expect(state.scheduleUpdate).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ status: 409 });
      expect((await pendingPlanChange(row.organization_id))?.state).toBe('preparing');
      expect(paidRows()).toEqual(paid);
    });
  }
  it('rechecks each add-on after the last primary read before its cancellation', async () => {
    const { sources, row } = await threePaidSources(), read = state.subscription.getMockImplementation()!;
    let primaryReads = 0;
    state.subscription.mockImplementation(async (id) => {
      // The initial all-source preflight is valid. Drift arrives during the fresh
      // primary check immediately before the first effect, after old add-on reads.
      if (id === sources.gestion.id && ++primaryReads === 2) sources.support.customer = 'cus_v3_raced';
      return read(id);
    });
    await expect(resumePlanChange(row)).rejects.toMatchObject({ status: 409 });
    expect(primaryReads).toBe(2);
    expect(state.updateSubscription).not.toHaveBeenCalled();
    expect(state.scheduleCreate).not.toHaveBeenCalled();
  });
  it('schedules three valid sources once with unchanged paid periods, gifts, phase keys and rights', async () => {
    const { sources, row } = await threePaidSources(), paid = paidRows();
    const periods = Object.values(sources).map((source) => source.items.data[0].current_period_end);
    await resumePlanChange(row);
    await resumePlanChange((await pendingPlanChange(row.organization_id))!);
    expect(state.updateSubscription.mock.calls).toEqual([
      [sources.support.id, { cancel_at_period_end: true, proration_behavior: 'none' }, { idempotencyKey: `complete-change-${row.operation_id}-${sources.support.id}` }],
      [sources.automation.id, { cancel_at_period_end: true, proration_behavior: 'none' }, { idempotencyKey: `complete-change-${row.operation_id}-${sources.automation.id}` }],
    ]);
    expect(state.scheduleCreate).toHaveBeenCalledTimes(1);
    expect(state.scheduleCreate.mock.calls[0]).toEqual([{ from_subscription: sources.gestion.id }, { idempotencyKey: `complete-schedule-${row.operation_id}` }]);
    expect(state.scheduleUpdate).toHaveBeenCalledTimes(1);
    const [, update, options] = state.scheduleUpdate.mock.calls[0];
    expect(options).toEqual({ idempotencyKey: `complete-phases-${row.operation_id}` });
    expect(update).toMatchObject({ proration_behavior: 'none', end_behavior: 'release', phases: [
      { start_date: sources.gestion.items.data[0].current_period_start, end_date: row.effective_at, trial_end: row.effective_at, items: [{ price: sources.gestion.items.data[0].price.id, quantity: 1 }], proration_behavior: 'none' },
      { start_date: row.effective_at, duration: { interval: 'month', interval_count: 1 }, items: [{ price: 'price_pro_bundle', quantity: 1 }], billing_cycle_anchor: 'phase_start', proration_behavior: 'none' },
    ] });
    expect(Object.values(sources).map((source) => source.items.data[0].current_period_end)).toEqual(periods);
    expect(paidRows()).toEqual(paid);
    expect((await teamSeats(row.organization_id)).limit).toBe(3);
    expect(state.create).not.toHaveBeenCalled();
  });
  it('keeps the final primary barrier if its period drifts during the fresh add-on read', async () => {
    const { sources, row } = await threePaidSources(), read = state.subscription.getMockImplementation()!;
    let supportReads = 0;
    state.subscription.mockImplementation(async (id) => {
      if (id === sources.support.id && ++supportReads === 2) sources.gestion.items.data[0].current_period_end += 86400;
      return read(id);
    });
    await expect(resumePlanChange(row)).rejects.toMatchObject({ status: 409 });
    expect(supportReads).toBe(2);
    expect(state.updateSubscription).not.toHaveBeenCalled();
    expect(sources.support.cancel_at_period_end).toBe(false);
    expect(state.scheduleCreate).not.toHaveBeenCalled();
  });
  for (const table of ['support_workspaces', 'support_gestion_links'] as const) for (const position of ['before', 'after'] as const) {
    it(`repairs scheduled SQLite linking after a response lost ${position} ${table} commit`, async () => {
      await changingFixture();
      const company = org()!, oldWorkspace = workspace(), quote = await quotePlanChange(user.userId, company, 'pro');
      db.prepare(`INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at) VALUES(?,'v3-link-loss',?,?,'pro',?,'preparing',?,?,?)`)
        .run(company, user.userId, sub.id, quote.effectiveAt, JSON.stringify(quote.snapshot), now(), now());
      const row = (await pendingPlanChange(company))!;
      db.prepare('DELETE FROM support_gestion_links WHERE organization_id=?').run(company);
      db.prepare('DELETE FROM support_workspaces WHERE id=?').run(oldWorkspace.id);
      expect(workspace()).toBeUndefined();
      const paid = paidRows(), real = state.db as { prepare: (query: string) => { run: () => Promise<unknown> } };
      let fault = true, committed = false;
      state.db = {
        ...real,
        prepare(query: string) {
          const statement = real.prepare(query);
          if (query.trimStart().startsWith(`INSERT INTO ${table}(`)) {
            const run = statement.run.bind(statement);
            statement.run = async () => {
              if (fault) {
                fault = false;
                if (position === 'after') { await run(); committed = true; }
                throw new Error('Synthetic link response lost');
              }
              return run();
            };
          }
          return statement;
        },
      };
      await expect(resumePlanChange(row)).rejects.toThrow('Synthetic link response lost');
      expect(committed).toBe(position === 'after');
      const pending = (await pendingPlanChange(row.organization_id))!;
      expect(pending.state).toBe('scheduled');
      expect(db.prepare('SELECT COUNT(*) AS n FROM support_workspaces WHERE owner_id=?').get(user.userId)?.n)
        .toBe(table === 'support_workspaces' && position === 'before' ? 0 : 1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM support_gestion_links WHERE organization_id=?').get(row.organization_id)?.n)
        .toBe(table === 'support_gestion_links' && position === 'after' ? 1 : 0);
      state.db = real;
      const calls = [state.updateSubscription.mock.calls.length, state.scheduleCreate.mock.calls.length, state.scheduleUpdate.mock.calls.length, state.subscription.mock.calls.length, state.prices.mock.calls.length];
      await resumePlanChange(pending);
      await resumePlanChange((await pendingPlanChange(row.organization_id))!);
      expect(db.prepare('SELECT COUNT(*) AS n FROM support_gestion_links WHERE organization_id=?').get(row.organization_id)?.n).toBe(1);
      expect([state.updateSubscription.mock.calls.length, state.scheduleCreate.mock.calls.length, state.scheduleUpdate.mock.calls.length, state.subscription.mock.calls.length, state.prices.mock.calls.length]).toEqual(calls);
      expect(paidRows()).toEqual(paid);
      expect((await teamSeats(row.organization_id)).limit).toBe(3);
    });
  }
  it('refuses scheduled linking to an already foreign company without moving the workspace or changing rights', async () => {
    const { row } = await threePaidSources(), w = workspace();
    await resumePlanChange(row);
    const foreign = await startAccountTrial({ ...user, userId: 'v3-other-owner', email: 'v3-other@example.test' }, 'Other fixture company', true);
    db.prepare('DELETE FROM support_gestion_links WHERE organization_id IN (?,?)').run(row.organization_id, foreign.organization_id);
    db.prepare(`INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at) VALUES(?,?,1,0,?,?)`).run(w.id, foreign.organization_id, user.userId, now());
    const paid = paidRows(), links = db.prepare('SELECT * FROM support_gestion_links ORDER BY workspace_id').all();
    state.updateSubscription.mockClear(); state.scheduleCreate.mockClear(); state.scheduleUpdate.mockClear();
    await expect(resumePlanChange((await pendingPlanChange(row.organization_id))!)).rejects.toMatchObject({ status: 409 });
    expect(db.prepare('SELECT * FROM support_gestion_links ORDER BY workspace_id').all()).toEqual(links);
    expect(paidRows()).toEqual(paid);
    expect(state.updateSubscription).not.toHaveBeenCalled();
    expect(state.scheduleCreate).not.toHaveBeenCalled();
    expect(state.scheduleUpdate).not.toHaveBeenCalled();
  });
  describe('v4 captured source eligibility', () => {
    const economicDrifts = ['quantity', 'subscription_discount', 'item_discount', 'pause_collection', 'has_more', 'currency', 'interval', 'interval_count', 'status'] as const;
    function changeEconomicTerms(source: Stripe.Subscription, drift: typeof economicDrifts[number]) {
      const item = source.items.data[0];
      if (drift === 'quantity') item.quantity = 2;
      if (drift === 'subscription_discount') source.discounts = ['di_v4_subscription'];
      if (drift === 'item_discount') item.discounts = ['di_v4_item'];
      if (drift === 'pause_collection') source.pause_collection = { behavior: 'void', resumes_at: null };
      if (drift === 'has_more') source.items.has_more = true;
      if (drift === 'currency') item.price = { ...item.price, currency: 'eur' };
      if (drift === 'interval') item.price = { ...item.price, recurring: { ...item.price.recurring!, interval: 'year' } };
      if (drift === 'interval_count') item.price = { ...item.price, recurring: { ...item.price.recurring!, interval_count: 2 } };
      if (drift === 'status') source.status = 'past_due';
    }
    for (const kind of kinds) for (const drift of economicDrifts) {
      it(`refuses ${kind} ${drift} unsupported by the same real quote before any cancellation`, async () => {
        const { sources, row } = await threePaidSources(), paid = paidRows();
        changeEconomicTerms(sources[kind], drift);
        await expect(quotePlanChange(user.userId, row.organization_id, 'pro')).rejects.toMatchObject({ status: 409 });
        const outcome = await resumePlanChange(row).catch((error) => error);
        expect(state.updateSubscription).not.toHaveBeenCalled();
        expect(state.scheduleCreate).not.toHaveBeenCalled();
        expect(state.scheduleUpdate).not.toHaveBeenCalled();
        expect(sources.support.cancel_at_period_end).toBe(false);
        expect(sources.automation.cancel_at_period_end).toBe(false);
        expect(outcome).toMatchObject({ status: 409 });
        expect((await pendingPlanChange(row.organization_id))?.state).toBe('preparing');
        expect(paidRows()).toEqual(paid);
      });
    }
    for (const kind of ['support', 'automation'] as const) {
      it(`preserves the already canceled ${kind} source and its captured paid period`, async () => {
        const { sources, row } = await threePaidSources(), source = sources[kind], paid = paidRows();
        source.status = 'canceled';
        const until = source.items.data[0].current_period_end;
        await resumePlanChange(row);
        await resumePlanChange((await pendingPlanChange(row.organization_id))!);
        expect(state.updateSubscription).toHaveBeenCalledTimes(1);
        expect(state.updateSubscription.mock.calls[0][0]).toBe(kind === 'support' ? sources.automation.id : sources.support.id);
        expect(source.cancel_at_period_end).toBe(false);
        expect(source.items.data[0].current_period_end).toBe(until);
        expect(paidRows()).toEqual(paid);
        expect(state.scheduleCreate).toHaveBeenCalledTimes(1);
        expect(state.scheduleUpdate).toHaveBeenCalledTimes(1);
      });
      it(`does not let canceled ${kind} status bypass the economic source guard`, async () => {
        const { sources, row } = await threePaidSources();
        sources[kind].status = 'canceled';
        sources[kind].items.data[0].quantity = 2;
        const outcome = await resumePlanChange(row).catch((error) => error);
        expect(state.updateSubscription).not.toHaveBeenCalled();
        expect(state.scheduleCreate).not.toHaveBeenCalled();
        expect(state.scheduleUpdate).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ status: 409 });
      });
    }
    it('revalidates late Automation quantity and resumes the same partial operation once restored', async () => {
      const { sources, row } = await threePaidSources(), read = state.subscription.getMockImplementation()!, paid = paidRows();
      let reads = 0;
      state.subscription.mockImplementation(async (id) => {
        if (id === sources.automation.id && ++reads === 2) sources.automation.items.data[0].quantity = 2;
        return read(id);
      });
      await expect(resumePlanChange(row)).rejects.toMatchObject({ status: 409 });
      // A drift arriving after preflight can still leave the earlier valid source
      // canceled. The changed source is refused; this is explicitly not atomic.
      expect(state.updateSubscription.mock.calls.map((call) => call[0])).toEqual([sources.support.id]);
      expect(sources.automation.cancel_at_period_end).toBe(false);
      expect(state.scheduleCreate).not.toHaveBeenCalled();
      sources.automation.items.data[0].quantity = 1;
      await resumePlanChange((await pendingPlanChange(row.organization_id))!);
      await resumePlanChange((await pendingPlanChange(row.organization_id))!);
      expect(state.updateSubscription.mock.calls.map((call) => call[0])).toEqual([sources.support.id, sources.automation.id]);
      expect(state.updateSubscription.mock.calls.map((call) => call[2])).toEqual([
        { idempotencyKey: `complete-change-${row.operation_id}-${sources.support.id}` },
        { idempotencyKey: `complete-change-${row.operation_id}-${sources.automation.id}` },
      ]);
      expect(state.scheduleCreate).toHaveBeenCalledTimes(1);
      expect(state.scheduleUpdate).toHaveBeenCalledTimes(1);
      expect(paidRows()).toEqual(paid);
    });
    async function lostGiftPhaseResponse() {
      const fixture = await threePaidSources(), update = state.scheduleUpdate.getMockImplementation()!;
      state.scheduleUpdate.mockImplementationOnce(async (...args: unknown[]) => {
        await update(...args);
        throw new Error('Synthetic gift-phase response lost');
      });
      await expect(resumePlanChange(fixture.row)).rejects.toThrow('Synthetic gift-phase response lost');
      expect(sub.status).toBe('trialing');
      const pending = (await pendingPlanChange(fixture.row.organization_id))!;
      expect(pending.state).toBe('preparing');
      expect(pending.schedule_id).toBe('sub_sched_change');
      expect(state.scheduleUpdate.mock.calls[0][1].phases[0].trial_end).toBe(pending.effective_at);
      return { ...fixture, row: pending };
    }
    it('admits only the legitimate trialing primary gift on its proven same-operation schedule', async () => {
      const { row } = await lostGiftPhaseResponse(), paid = paidRows();
      await resumePlanChange(row);
      await resumePlanChange((await pendingPlanChange(row.organization_id))!);
      expect(state.updateSubscription).toHaveBeenCalledTimes(2);
      expect(state.scheduleCreate).toHaveBeenCalledTimes(1);
      expect(state.scheduleUpdate).toHaveBeenCalledTimes(2);
      expect(state.scheduleUpdate.mock.calls[0][2]).toEqual(state.scheduleUpdate.mock.calls[1][2]);
      expect(paidRows()).toEqual(paid);
    });
    it('does not let a proven owned primary schedule bypass the quantity guard', async () => {
      const { row } = await lostGiftPhaseResponse();
      sub.items.data[0].quantity = 2;
      const outcome = await resumePlanChange(row).catch((error) => error);
      expect(state.updateSubscription).toHaveBeenCalledTimes(2);
      expect(state.scheduleCreate).toHaveBeenCalledTimes(1);
      expect(state.scheduleUpdate).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ status: 409 });
      expect((await pendingPlanChange(row.organization_id))?.state).toBe('preparing');
    });
    it('refuses a paused primary even when its schedule belongs to this operation', async () => {
      const { row } = await lostGiftPhaseResponse();
      sub.status = 'paused';
      const outcome = await resumePlanChange(row).catch((error) => error);
      expect(state.scheduleUpdate).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ status: 409 });
    });
    it('refuses a trialing primary on its owned schedule when this operation planned no gift gap', async () => {
      await changingFixture();
      const company = org()!, quote = await quotePlanChange(user.userId, company, 'pro'), update = state.scheduleUpdate.getMockImplementation()!;
      state.scheduleUpdate.mockImplementationOnce(async (...args: unknown[]) => {
        await update(...args);
        throw new Error('Synthetic no-gap phase response lost');
      });
      await expect(changePlan(user.userId, company, 'pro', quote.fingerprint)).rejects.toThrow('Synthetic no-gap phase response lost');
      const row = (await pendingPlanChange(company))!;
      expect(row.effective_at).toBe(sub.items.data[0].current_period_end);
      expect(state.scheduleUpdate.mock.calls[0][1].phases[0].trial_end).toBeUndefined();
      sub.status = 'trialing';
      const outcome = await resumePlanChange(row).catch((error) => error);
      expect(state.scheduleCreate).toHaveBeenCalledTimes(1);
      expect(state.scheduleUpdate).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ status: 409 });
    });
  });
});
