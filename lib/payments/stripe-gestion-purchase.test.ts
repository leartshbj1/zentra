import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import {
  D1StripeGestionPurchase,
  type GestionStripeTransport,
} from './stripe-gestion-purchase';

vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
vi.mock('@/lib/runtime', () => ({
  stripeConfiguration: () => ({}),
  database: () => null,
  runtimeValue: () => '',
}));
let sql: DatabaseSync,
  now: number,
  configuration: Parameters<typeof controllerConfiguration>[0],
  lost: boolean;
let sessions: Map<string, Stripe.Checkout.Session>,
  create: ReturnType<typeof vi.fn>,
  retrieve: ReturnType<typeof vi.fn>,
  list: ReturnType<typeof vi.fn>,
  expire: ReturnType<typeof vi.fn>;
let beforeRun: ((query: string) => void) | null;
const user = {
  userId: 'synthetic-owner',
  email: 'synthetic@example.test',
  displayName: 'Synthetic owner',
  fullName: 'Synthetic owner',
  emailConfirmed: true,
  provider: 'supabase',
} as ZentraUser;
const origin = 'https://zentraapp.ch';
function controllerConfiguration(
  config: ReturnType<typeof import('@/lib/runtime').stripeConfiguration>,
) {
  return config;
}
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
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}
const transport = () =>
  ({ create, retrieve, list, expire }) as GestionStripeTransport;
const store = () =>
  new D1StripeGestionPurchase(d1(), configuration, transport(), () => now);
const input = (patch: Record<string, unknown> = {}) => ({
  user,
  planId: 'start' as const,
  origin,
  ...patch,
});
const checkout = (
  patch: Record<string, unknown> = {},
  referral = vi.fn(async () => null),
) => store().checkout(input(patch), referral);
function company(id = 'company-one', owner = user.userId) {
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,seat_limit) VALUES(?,?,?,'incomplete',0,0,?,3)",
    )
    .run('draft_' + id, 'draft_' + id, 'fixture', now);
  sql
    .prepare(
      'INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    )
    .run(id, 'Synthetic company', 'draft_' + id, owner, now, now);
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at) VALUES(?,?,?,?,?,'owner',?)",
    )
    .run('member-' + id, id, owner, user.email, user.displayName, now);
}
function complete() {
  sql
    .prepare(
      'INSERT INTO complete_checkouts(user_id,nonce,plan_id,parameters,expires_at) VALUES(?,?,?,?,?)',
    )
    .run(user.userId, 'synthetic-nonce', 'team', '{}', now + 3600);
}
function row() {
  return sql.prepare('SELECT * FROM gestion_purchase_requests').get()!;
}
function count(table: string) {
  return sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}
beforeEach(() => {
  now = Math.floor(Date.now() / 1000);
  lost = false;
  beforeRun = null;
  sessions = new Map();
  sql = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + f, import.meta.url), 'utf8'),
    );
  configuration = {
    secretKey: 'sk_test_synthetic_not_a_real_key',
    signingKey: Buffer.from(
      '302e020100300506032b657004220420' + '01'.repeat(32),
      'hex',
    ).toString('base64url'),
    priceIds: {
      solo: 'price_solo_fixture',
      start: 'price_start_fixture',
      pro: 'price_pro_fixture',
    },
    testMode: 'accounts_only',
  } as typeof configuration;
  create = vi.fn(async (r, params) => {
    const key = String(r.claim_hash);
    if (!sessions.has(key))
      sessions.set(key, {
        id: 'cs_test_' + r.request_id.replaceAll('-', ''),
        url: 'https://checkout.stripe.com/synthetic',
        status: 'open',
        mode: 'subscription',
        livemode: r.environment === 'PRODUCTION',
        client_reference_id: params.client_reference_id,
        metadata: { ...params.metadata },
        expires_at: params.expires_at,
      } as Stripe.Checkout.Session);
    if (lost) {
      lost = false;
      throw new Error('Synthetic lost response');
    }
    return sessions.get(key)!;
  });
  retrieve = vi.fn(async (id) => {
    const found = [...sessions.values()].find((s) => s.id === id);
    if (!found) throw new Error('Synthetic missing');
    return { ...found };
  });
  list = vi.fn(async () => ({ data: [...sessions.values()], has_more: false }));
  expire = vi.fn(async (id) => {
    const s = [...sessions.values()].find((s) => s.id === id)!;
    s.status = 'expired';
    s.url = null;
    return { ...s };
  });
});
afterEach(() => sql.close());
describe('durable real Gestion purchase controller', () => {
  it('reserves one zero-right draft and identical Checkout/claim for eight simultaneous clicks', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => checkout()),
    );
    expect(
      new Set(results.map((r) => ('sessionId' in r ? r.sessionId : null))).size,
    ).toBe(1);
    expect(
      new Set(results.map((r) => ('claim' in r ? r.claim : null))).size,
    ).toBe(1);
    expect(count('organizations')).toBe(1);
    expect(count('organization_members')).toBe(1);
    expect(count('purchase_intents')).toBe(1);
    expect(count('gestion_purchase_requests')).toBe(1);
    expect(
      sql
        .prepare(
          'SELECT status,entitlement_valid_until,last_paid_invoice_id FROM subscriptions',
        )
        .get(),
    ).toMatchObject({
      status: 'incomplete',
      entitlement_valid_until: 0,
      last_paid_invoice_id: null,
    });
    expect(count('account_trials')).toBe(0);
    expect(count('license_activations')).toBe(0);
    const params = create.mock.calls.map((c) => JSON.stringify(c[1]));
    expect(new Set(params).size).toBe(1);
    expect(String(row().sealed_claim)).not.toContain(
      'claim' in results[0] ? results[0].claim : 'not',
    );
    expect(count('checkout_attempts')).toBe(1);
    expect(count('legal_acceptances')).toBe(1);
  });
  it('asks which company to use on the first purchase even when one is a trial', async () => {
    company('trial-one');
    company('other');
    sql
      .prepare(
        'INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        user.userId,
        'fixture-email-hash',
        'trial-one',
        'draft_trial-one',
        now,
        now + 1000,
      );
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
    expect(count('gestion_purchase_requests')).toBe(0);
    await checkout({ organizationId: 'trial-one' });
    expect(row().organization_id).toBe('trial-one');
  });
  it('recovers by reads once fewer than 30 minutes remain for the frozen Stripe expiry', async () => {
    lost = true;
    await expect(checkout()).rejects.toThrow('lost response');
    now += 1801;
    await checkout();
    expect(create).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
  });
  it('requires no renewed terms or matching newly selected plan to cancel the exact original checkout', async () => {
    await checkout();
    expect(
      await checkout({
        abandon: true,
        planId: 'pro',
        referralCode: 'ZT-' + 'B'.repeat(16),
      }),
    ).toEqual({ canceled: true });
    expect(create).toHaveBeenCalledOnce();
    expect(expire).toHaveBeenCalledOnce();
    expect(count('gestion_purchase_requests')).toBe(1);
  });
  it('a cancel with no prior request never creates a draft or invokes referral/payment', async () => {
    const ref = vi.fn(async () => null);
    expect(await store().checkout(input({ abandon: true }), ref)).toEqual({
      canceled: true,
    });
    expect(ref).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(count('organizations')).toBe(0);
  });
  it('freezes price/email/tax/locale on retry rather than reconstructing current config', async () => {
    lost = true;
    await expect(checkout()).rejects.toThrow('lost response');
    configuration.priceIds.start = 'price_rotated';
    configuration.testMode = 'owner_only';
    const second = await checkout({
      user: { ...user, email: 'changed@example.test', displayName: 'Changed' },
    });
    expect('sessionId' in second).toBe(true);
    expect(create.mock.calls[1][1]).toEqual(create.mock.calls[0][1]);
    expect(row().account_email).toBe(user.email);
  });
  it('never posts again after an uncertain original session has expired; recovers one exact match', async () => {
    lost = true;
    await expect(checkout()).rejects.toThrow('lost response');
    now += 3601;
    const result = await checkout();
    expect('sessionId' in result).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
  });
  it.each(['empty', 'ambiguous', 'overflow'])(
    'retains uncertain reservation for bounded %s recovery',
    async (kind) => {
      lost = true;
      await expect(checkout()).rejects.toThrow();
      now += 3601;
      const original = [...sessions.values()][0];
      list.mockResolvedValue({
        data:
          kind === 'empty'
            ? []
            : kind === 'ambiguous'
              ? [original, { ...original, id: 'cs_test_duplicate' }]
              : [original],
        has_more: kind === 'overflow',
      });
      await expect(checkout()).rejects.toMatchObject({ status: 409 });
      expect(create).toHaveBeenCalledOnce();
      expect(row().closed_at).toBeNull();
      expect(
        sql.prepare('SELECT released_at FROM purchase_intent_footprints').get()
          ?.released_at,
      ).toBeNull();
    },
  );
  it.each([
    'owner',
    'organization',
    'request',
    'claim',
    'plan',
    'environment',
    'expiry',
  ])(
    'refuses foreign %s provider response before receipts/cookie binding',
    async (kind) => {
      create.mockImplementationOnce(async (r, p) => ({
        id: 'cs_test_forged',
        status: 'open',
        mode: 'subscription',
        url: 'https://checkout.stripe.com/synthetic',
        livemode: kind === 'environment',
        client_reference_id: kind === 'claim' ? 'wrong' : r.claim_hash,
        expires_at: kind === 'expiry' ? r.expires_at + 1 : r.expires_at,
        metadata: {
          ...p.metadata,
          ...(kind === 'owner' ? { account_user_id: 'foreign' } : {}),
          ...(kind === 'organization' ? { organization_id: 'foreign' } : {}),
          ...(kind === 'request' ? { gestion_request_id: 'foreign' } : {}),
          ...(kind === 'plan' ? { plan: 'foreign' } : {}),
        },
      }));
      await expect(checkout()).rejects.toMatchObject({ status: 403 });
      expect(count('checkout_attempts')).toBe(0);
      expect(count('legal_acceptances')).toBe(0);
      expect(row().session_id).toBeNull();
    },
  );
  it('requires a chosen owned company when multiple exist and permits distinct targets', async () => {
    company('one');
    company('two');
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
    const a = await checkout({ organizationId: 'one' }),
      b = await checkout({ organizationId: 'two' });
    expect(a).not.toEqual(b);
    expect(count('purchase_intents')).toBe(2);
    expect(count('organizations')).toBe(2);
  });
  it('preserves the trial target chosen before payment even if another company appears later', async () => {
    company('trial-one');
    sql
      .prepare(
        'INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        user.userId,
        'fixture-email-hash',
        'trial-one',
        'draft_trial-one',
        now,
        now + 1000,
      );
    const a = await checkout();
    company('later');
    const b = await checkout();
    expect(a).toEqual(b);
    expect(row().organization_id).toBe('trial-one');
  });
  it.each(['foreign', 'revoked', 'member'])(
    'never accepts a %s company target',
    async (kind) => {
      company('one', kind === 'foreign' ? 'foreign' : user.userId);
      if (kind === 'revoked')
        sql.exec('UPDATE organization_members SET revoked_at=1');
      if (kind === 'member')
        sql.exec("UPDATE organization_members SET role='member'");
      await expect(checkout({ organizationId: 'one' })).rejects.toMatchObject({
        status: 403,
      });
      expect(create).not.toHaveBeenCalled();
    },
  );
  it('refuses a paid target before another provider POST and directs to change formula', async () => {
    company();
    sql
      .prepare(
        "UPDATE subscriptions SET status='active',entitlement_valid_until=?,last_paid_invoice_id='in_paid' WHERE subscription_id='draft_company-one'",
      )
      .run(now + 3600);
    // Real Stripe occupancy needs the actual provider prefix.
    sql.exec(
      "UPDATE subscriptions SET subscription_id='sub_paid' WHERE subscription_id='draft_company-one'; UPDATE organizations SET subscription_id='sub_paid'",
    );
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
  });
  it('protects legacy pack both orders, including the request-before-intent window', async () => {
    company();
    complete();
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
    sql.exec('DELETE FROM complete_checkouts');
    beforeRun = (q) => {
      if (q.startsWith('UPDATE gestion_purchase_requests SET intent_id')) {
        beforeRun = null;
        expect(() => complete()).toThrow('gestion_purchase_complete');
      }
    };
    await checkout();
    expect(() => complete()).toThrow('gestion_purchase_complete');
  });
  it('prepares referral before inactive draft owner membership and reuses frozen coupon on retries', async () => {
    const ref = vi.fn(async () => {
      expect(count('organization_members')).toBe(0);
      return { claimId: 'referral-synthetic', couponId: 'coupon-synthetic' };
    });
    const code = 'ZT-' + 'A'.repeat(16);
    const a = await store().checkout(input({ referralCode: code }), ref);
    const b = await store().checkout(input({ referralCode: code }), ref);
    expect(a).toEqual(b);
    expect(ref).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][1]).toMatchObject({
      discounts: [{ coupon: 'coupon-synthetic' }],
      metadata: { referral_claim: 'referral-synthetic' },
    });
    await expect(
      checkout({ referralCode: 'ZT-' + 'B'.repeat(16) }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('requires an explicit verified expiry/cancel, keeps history and creates fresh params only after abandonment', async () => {
    const a = await checkout();
    expect('claim' in a).toBe(true);
    expect(await checkout({ abandon: true })).toEqual({ canceled: true });
    expect(expire).toHaveBeenCalledOnce();
    expect(sql.prepare('SELECT state FROM purchase_intents').get()?.state).toBe(
      'expired',
    );
    const b = await checkout({ planId: 'pro' });
    expect(b).not.toEqual(a);
    expect(count('gestion_purchase_requests')).toBe(2);
    expect(count('purchase_intents')).toBe(2);
    expect(count('organizations')).toBe(1);
  });
  it('does not expire a completed session or finalize paid state from completion alone', async () => {
    await checkout();
    [...sessions.values()][0].status = 'complete';
    await expect(checkout({ abandon: true })).rejects.toMatchObject({
      status: 409,
    });
    expect(expire).not.toHaveBeenCalled();
    expect(sql.prepare('SELECT state FROM purchase_intents').get()?.state).toBe(
      'dispatched',
    );
    const result = await checkout();
    expect(result).toMatchObject({ url: origin + '/compte' });
    expect(count('license_activations')).toBe(0);
  });
  it('refuses missing signing configuration before any draft/reservation or provider call', async () => {
    configuration.signingKey = 'wrong';
    await expect(checkout()).rejects.toMatchObject({ status: 503 });
    expect(count('organizations')).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });
  it('separates TEST and PRODUCTION drafts and never reuses a rotated merchant scope', async () => {
    await checkout();
    configuration.secretKey = 'sk_test_rotated_fixture';
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
    expect(create).toHaveBeenCalledOnce();
    configuration.secretKey = 'sk_live_synthetic_not_a_real_key';
    await checkout();
    expect(count('organizations')).toBe(2);
    expect(count('gestion_purchase_requests')).toBe(2);
  });
  it('keeps frozen parameters/targets and history immutable in the actual migration', async () => {
    await checkout();
    expect(() =>
      sql.exec("UPDATE gestion_purchase_requests SET plan_id='pro'"),
    ).toThrow(/immutable|binding/);
    expect(() => sql.exec('DELETE FROM gestion_purchase_requests')).toThrow(
      'history',
    );
    expect(() =>
      sql.exec("UPDATE gestion_purchase_drafts SET organization_id='other'"),
    ).toThrow('immutable');
  });
});
