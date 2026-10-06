import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
const runtime = vi.hoisted(() => ({ database: vi.fn() }));
vi.mock('./runtime', () => ({
  database: runtime.database,
  stripeConfiguration: () => ({}),
  runtimeValue: () => '',
}));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
// Product provisioning keeps its separate full-schema complete integration tests.
vi.mock('@/lib/complete/access', () => ({ provisionCompleteCompany: vi.fn() }));
import {
  linkPaidCheckoutAccount,
  linkPaidCompany,
} from './subscription-account';
import { D1StripeGestionPurchase } from './payments/stripe-gestion-purchase';
import { planById } from './plans';
let db: DatabaseSync, clock: number, beforeBatch: (() => void) | null;
const owner = {
  userId: 'verified-owner-id',
  email: 'client@example.test',
  displayName: 'Client Zentra',
  fullName: 'Client Zentra',
  emailConfirmed: true,
  provider: 'supabase',
} as ZentraUser;
function prepare(query: string) {
  let args: SQLInputValue[] = [];
  const p = {
    query,
    get args() {
      return args;
    },
    bind(...values: SQLInputValue[]) {
      args = values;
      return p;
    },
    async first() {
      return db.prepare(query).get(...args) || null;
    },
    async all() {
      return { results: db.prepare(query).all(...args) };
    },
    async run() {
      return { success: true, meta: db.prepare(query).run(...args) };
    },
  };
  return p;
}
function d1() {
  return {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      beforeBatch?.();
      beforeBatch = null;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map((s) => ({
          success: true,
          meta: db.prepare(s.query).run(...s.args),
        }));
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}
beforeEach(() => {
  clock = Math.floor(Date.now() / 1000);
  beforeBatch = null;
  db = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL('../drizzle/' + f, import.meta.url), 'utf8'));
  db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,checkout_session_id,customer_name,price_id,plan_id,entitlement_plan_id,status,current_period_end,entitlement_valid_until,livemode,updated_at,seat_limit,last_paid_invoice_id,last_paid_at)
 VALUES('sub_one','cus_one','cs_one','Entreprise','price_start_fixture',?,?,'active',?,?,0,?,3,'in_paid',?)`).run(
    planById('start')!.licensePlan,
    planById('start')!.licensePlan,
    clock + 3600,
    clock + 3600,
    clock,
    clock,
  );
  db.prepare(
    'INSERT INTO checkout_attempts(claim_hash,checkout_session_id,created_at,expires_at,account_user_id,account_email,account_name) VALUES(?,?,?,?,?,?,?)',
  ).run(
    'fixture-hash',
    'cs_one',
    clock,
    clock + 86400,
    owner.userId,
    owner.email,
    owner.displayName,
  );
  runtime.database.mockReturnValue(d1());
});
afterEach(() => db.close());
async function bound(target?: string) {
  const configuration = {
    secretKey: 'sk_test_synthetic_not_real',
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
  } as ReturnType<typeof import('./runtime').stripeConfiguration>;
  const transport = {
    create: vi.fn(
      async (r, p) =>
        ({
          id: 'cs_test_bound',
          url: 'https://checkout.stripe.com/synthetic',
          mode: 'subscription',
          status: 'open',
          livemode: false,
          client_reference_id: r.claim_hash,
          expires_at: r.expires_at,
          metadata: { ...p.metadata },
        }) as Stripe.Checkout.Session,
    ),
    retrieve: vi.fn(),
    list: vi.fn(),
    expire: vi.fn(),
  };
  const result = await new D1StripeGestionPurchase(
    d1(),
    configuration,
    transport,
    () => clock,
  ).checkout(
    {
      user: owner,
      planId: 'start',
      origin: 'https://zentraapp.ch',
      organizationId: target,
    },
    async () => null,
  );
  if (typeof result.sessionId !== 'string')
    throw new Error('Unexpected cancel');
  db.prepare(
    'UPDATE subscriptions SET checkout_session_id=? WHERE subscription_id=?',
  ).run(result.sessionId, 'sub_one');
  return db.prepare('SELECT * FROM gestion_purchase_requests').get()!;
}
function trial(id = 'org_trial') {
  db.prepare(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at,seat_limit) VALUES('trial_one','trial_one','free_trial','trialing',?,?,0,?,3)",
  ).run(clock + 1000, clock + 1000, clock);
  db.prepare(
    'INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)',
  ).run(id, 'Trial company', 'trial_one', owner.userId, clock, clock);
  db.prepare(
    "INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at) VALUES(?,?,?,?,?,'owner',?)",
  ).run(
    'member-trial',
    id,
    owner.userId,
    owner.email,
    owner.displayName,
    clock,
  );
  db.prepare(
    'INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at) VALUES(?,?,?,?,?,?)',
  ).run(
    owner.userId,
    'fixture-email-hash',
    id,
    'trial_one',
    clock,
    clock + 1000,
  );
  db.prepare(
    'INSERT INTO company_copies(organization_id,backup_id,published_by,published_at) VALUES(?,?,?,?)',
  ).run(
    id,
    'backup-of-invoices-and-projects',
    owner.userId,
    new Date().toISOString(),
  );
}
function planChange(company: string) {
  db.prepare(`INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at)
 VALUES(?,'change-after-handoff',?,'sub_one','pro',?,'preparing','{"live":false}',?,?)`).run(
    company,
    owner.userId,
    clock + 10000,
    clock,
    clock,
  );
}
describe('account subscription activation legacy unchanged', () => {
  it('automatically links paid checkout to authenticated owner once across concurrent retries', async () => {
    const [a, b] = await Promise.all([
      linkPaidCheckoutAccount('sub_one'),
      linkPaidCheckoutAccount('sub_one'),
    ]);
    expect(a).toEqual(b);
    expect(a?.name).toBe('Entreprise');
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM organizations').get()?.count,
    ).toBe(1);
    expect(
      db.prepare('SELECT user_id,email,role FROM organization_members').get(),
    ).toMatchObject({
      user_id: owner.userId,
      email: owner.email,
      role: 'owner',
    });
  });
  it('does not activate unpaid expired or unbound legacy checkout', async () => {
    db.exec('UPDATE subscriptions SET last_paid_invoice_id=NULL');
    expect(await linkPaidCheckoutAccount('sub_one')).toBeNull();
    db.exec(
      "UPDATE subscriptions SET last_paid_invoice_id='in_paid',entitlement_valid_until=1",
    );
    expect(await linkPaidCheckoutAccount('sub_one')).toBeNull();
    db.exec(
      `UPDATE subscriptions SET entitlement_valid_until=${clock + 1000}; DELETE FROM checkout_attempts;`,
    );
    expect(await linkPaidCheckoutAccount('sub_one')).toBeNull();
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM organizations').get()?.count,
    ).toBe(0);
  });
  it('never takes ownership on an identical email', async () => {
    await linkPaidCheckoutAccount('sub_one');
    await expect(
      linkPaidCompany('sub_one', { ...owner, userId: 'another-id' }),
    ).rejects.toThrow('autre compte');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM organization_members').get()?.n,
    ).toBe(1);
  });
  it('preserves legacy paid subscriptions without seat limit', async () => {
    db.exec('UPDATE subscriptions SET seat_limit=NULL');
    expect(await linkPaidCompany('sub_one', owner)).toMatchObject({
      name: 'Entreprise',
    });
  });
  it('handles invoice-paid first and does not restore revoked legacy access', async () => {
    db.exec('UPDATE subscriptions SET checkout_session_id=NULL');
    expect(await linkPaidCheckoutAccount('sub_one')).toBeNull();
    db.exec("UPDATE subscriptions SET checkout_session_id='cs_one'");
    await linkPaidCheckoutAccount('sub_one');
    db.exec('UPDATE organization_members SET revoked_at=123');
    await linkPaidCheckoutAccount('sub_one');
    expect(
      db.prepare('SELECT revoked_at FROM organization_members').get()
        ?.revoked_at,
    ).toBe(123);
  });
});
describe('frozen Gestion paid projection and atomic reservation handoff', () => {
  it('projects exactly the before-payment draft with one paid proof and releases for changePlan', async () => {
    const r = await bound();
    expect(() => planChange(String(r.organization_id))).toThrow(
      'purchase_change',
    );
    const [a, b] = await Promise.all([
      linkPaidCheckoutAccount('sub_one'),
      linkPaidCompany('sub_one', owner),
    ]);
    expect(a).toEqual(b);
    expect(a?.id).toBe(r.organization_id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM organizations').get()?.n).toBe(
      1,
    );
    expect(
      db
        .prepare('SELECT state,evidence_fingerprint FROM purchase_intents')
        .get(),
    ).toMatchObject({
      state: 'settled',
      evidence_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      db.prepare('SELECT released_at FROM purchase_intent_footprints').get()
        ?.released_at,
    ).toBeGreaterThan(0);
    expect(
      db.prepare('SELECT closed_at FROM gestion_purchase_requests').get()
        ?.closed_at,
    ).toBeGreaterThan(0);
    expect(() => planChange(String(r.organization_id))).not.toThrow();
  });
  it('upgrades the chosen trial without changing company, documents, sync backup or active collaborators', async () => {
    trial();
    const r = await bound();
    const members = db.prepare('SELECT * FROM organization_members').all(),
      backup = db.prepare('SELECT * FROM company_copies').get();
    expect((await linkPaidCheckoutAccount('sub_one'))?.id).toBe('org_trial');
    expect(db.prepare('SELECT * FROM company_copies').get()).toEqual(backup);
    expect(db.prepare('SELECT * FROM organization_members').all()).toEqual(
      members,
    );
    expect(
      db.prepare('SELECT converted_subscription_id FROM account_trials').get()
        ?.converted_subscription_id,
    ).toBe('sub_one');
    expect(r.organization_id).toBe('org_trial');
  });
  it.each([
    'invoice',
    'timestamp',
    'expired',
    'future',
    'price',
    'plan',
    'live',
    'seats',
    'period',
  ])(
    'does not admit/project/release from invalid %s proof or completed status alone',
    async (kind) => {
      const r = await bound();
      const cases: Record<string, string> = {
        invoice: 'last_paid_invoice_id=NULL',
        timestamp: 'last_paid_at=NULL',
        expired: 'entitlement_valid_until=1',
        future: `last_paid_at=${clock + 600}`,
        price: "price_id='price_wrong'",
        plan: "entitlement_plan_id='zentra-pro-monthly-89-chf'",
        live: 'livemode=1',
        seats: 'seat_limit=10',
        period: `current_period_end=${clock}`,
      };
      db.exec(
        'UPDATE subscriptions SET ' +
          cases[kind] +
          " WHERE subscription_id='sub_one'",
      );
      await expect(linkPaidCompany('sub_one', owner)).rejects.toMatchObject({
        status: 402,
      });
      expect(
        db.prepare('SELECT subscription_id FROM organizations').get()
          ?.subscription_id,
      ).toBe(r.previous_subscription_id);
      expect(
        db.prepare('SELECT state FROM purchase_intents').get()?.state,
      ).toBe('dispatched');
      expect(
        db.prepare('SELECT released_at FROM purchase_intent_footprints').get()
          ?.released_at,
      ).toBeNull();
    },
  );
  it('never chooses a later trial/company instead of frozen target', async () => {
    const r = await bound();
    trial('later_trial');
    expect((await linkPaidCheckoutAccount('sub_one'))?.id).toBe(
      r.organization_id,
    );
    expect(
      db
        .prepare(
          "SELECT subscription_id FROM organizations WHERE organization_id='later_trial'",
        )
        .get()?.subscription_id,
    ).toBe('trial_one');
    expect(
      db.prepare('SELECT converted_subscription_id FROM account_trials').get()
        ?.converted_subscription_id,
    ).toBeNull();
  });
  it.each(['creator', 'revoked', 'role', 'reassigned'])(
    'rejects changed %s ownership or target without late fallback',
    async (kind) => {
      const r = await bound();
      if (kind === 'creator')
        db.exec("UPDATE organizations SET created_by_user_id='other'");
      if (kind === 'revoked')
        db.exec('UPDATE organization_members SET revoked_at=1');
      if (kind === 'role')
        db.exec("UPDATE organization_members SET role='member'");
      if (kind === 'reassigned') {
        db.prepare(
          "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at) VALUES('other_draft','other_draft','fixture','incomplete',0,?)",
        ).run(clock);
        db.exec("UPDATE organizations SET subscription_id='other_draft'");
      }
      await expect(linkPaidCompany('sub_one', owner)).rejects.toMatchObject({
        status: 402,
      });
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM organizations').get()?.n,
      ).toBe(1);
      expect(
        db.prepare('SELECT closed_at FROM gestion_purchase_requests').get()
          ?.closed_at,
      ).toBeNull();
      expect(r.organization_id).toBeTruthy();
    },
  );
  it('recovers owner from durable provider binding when receipt batch was lost', async () => {
    const r = await bound();
    db.exec('DELETE FROM checkout_attempts');
    expect((await linkPaidCheckoutAccount('sub_one'))?.id).toBe(
      r.organization_id,
    );
  });
  it('keeps exact original identity instead of matched email or forged caller', async () => {
    await bound();
    await expect(
      linkPaidCompany('sub_one', { ...owner, userId: 'other' }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rolls back whole target projection if handoff persistence fails', async () => {
    const r = await bound();
    db.exec(
      "CREATE TRIGGER fail_handoff BEFORE UPDATE OF state ON purchase_intents WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'synthetic handoff failure'); END;",
    );
    await expect(linkPaidCompany('sub_one', owner)).rejects.toThrow(
      'synthetic handoff failure',
    );
    expect(
      db.prepare('SELECT subscription_id FROM organizations').get()
        ?.subscription_id,
    ).toBe(r.previous_subscription_id);
    expect(
      db.prepare('SELECT released_at FROM purchase_intent_footprints').get()
        ?.released_at,
    ).toBeNull();
  });
  it('rechecks proof at atomic update if it expires/reverses between read and batch', async () => {
    const r = await bound();
    beforeBatch = () =>
      db.exec(
        "UPDATE subscriptions SET entitlement_valid_until=0,last_paid_invoice_id=NULL WHERE subscription_id='sub_one'",
      );
    await expect(linkPaidCompany('sub_one', owner)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      db.prepare('SELECT subscription_id FROM organizations').get()
        ?.subscription_id,
    ).toBe(r.previous_subscription_id);
    expect(
      db.prepare('SELECT released_at FROM purchase_intent_footprints').get()
        ?.released_at,
    ).toBeNull();
  });
  it('refuses direct footprint release without current exact paid projection', async () => {
    const r = await bound();
    db.prepare(
      "UPDATE purchase_intents SET state='settled',finalized_at=?,evidence_fingerprint=? WHERE intent_id=?",
    ).run(clock, 'a'.repeat(64), r.intent_id);
    expect(() =>
      db
        .prepare('UPDATE purchase_intent_footprints SET released_at=?')
        .run(clock),
    ).toThrow('purchase_footprint_immutable');
    expect(
      db.prepare('SELECT subscription_id FROM organizations').get()
        ?.subscription_id,
    ).toBe(r.previous_subscription_id);
  });
  it('does not replay the initial-price proof after a valid handoff and later plan change', async () => {
    const r = await bound();
    await linkPaidCheckoutAccount('sub_one');
    db.prepare(
      "UPDATE subscriptions SET price_id='price_pro_fixture',entitlement_plan_id=?,plan_id=?,seat_limit=10,last_paid_invoice_id='in_renewal' WHERE subscription_id='sub_one'",
    ).run(planById('pro')!.licensePlan, planById('pro')!.licensePlan);
    expect((await linkPaidCheckoutAccount('sub_one'))?.id).toBe(
      r.organization_id,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM organizations').get()?.n).toBe(
      1,
    );
  });
});
