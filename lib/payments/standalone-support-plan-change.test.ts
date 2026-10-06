import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import {
  D1PurchaseIntents,
  type PurchaseEnvironment,
  type PurchaseProvider,
} from './purchase-intents';
import { D1StripeSupportPurchase } from './stripe-support-purchase';
import { SUPPORT_LEGAL_VERSION } from '@/lib/support/plans';
import { digest } from '@/lib/support/crypto';
import { POST } from '@/app/api/support/checkout/route';

const state = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  key: 'sk_live_synthetic_standalone_not_a_real_key',
  user: null as ZentraUser | null,
  price: vi.fn(),
  create: vi.fn(),
  retrieve: vi.fn(),
  list: vi.fn(),
  expire: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => state.db,
  runtimeValue: (key: string) => (key === 'STRIPE_SECRET_KEY' ? state.key : ''),
  stripeConfiguration: () => ({
    secretKey: state.key,
    siteUrl: 'https://zentraapp.ch',
    siteOriginAliases: '',
  }),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => state.user }));
vi.mock('@/lib/account', () => ({ enforceAccountRateLimit: vi.fn() }));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
vi.mock('@/lib/support/billing', () => ({
  billingState: async () => ({
    hasSubscription: false,
    ownerAccess: false,
    active: false,
  }),
  refreshSupportPayment: vi.fn(),
}));
vi.mock('stripe', () => ({
  default: class {
    static createFetchHttpClient() {
      return {};
    }
    prices = { retrieve: state.price };
    checkout = {
      sessions: {
        create: state.create,
        retrieve: state.retrieve,
        list: state.list,
        expire: state.expire,
      },
    };
  },
}));

let sql: DatabaseSync, clock: number;
let beforeRun: ((query: string) => void) | null;
let failBatch: boolean;
let lastSqlFailure: string | null;
const owner = 'standalone-owner',
  company = 'standalone-company',
  workspace = 'standalone-workspace';
const user = {
  userId: owner,
  email: 'fictional@example.test',
  emailConfirmed: true,
} as ZentraUser;
function db() {
  function prepare(query: string) {
    let args: SQLInputValue[] = [];
    const statement = {
      query,
      get args() {
        return args;
      },
      bind(...values: SQLInputValue[]) {
        args = values;
        return statement;
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
    };
    return statement;
  }
  return {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      if (failBatch) {
        failBatch = false;
        throw new Error('Synthetic lost reservation');
      }
      sql.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((s) => ({
          success: true,
          meta: sql.prepare(s.query).run(...s.args),
        }));
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        lastSqlFailure = String(error);
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}
function seedCompany(id = company, userId = owner) {
  sql
    .prepare(
      `INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,livemode,current_period_end,entitlement_valid_until,last_paid_invoice_id,seat_limit,updated_at) VALUES(?,?,?,'active',1,?,?,?,3,?)`,
    )
    .run(
      'sub_' + id,
      'cus_' + id,
      'price_' + id,
      clock + 864000,
      clock + 864000,
      'in_' + id,
      clock,
    );
  sql
    .prepare(
      `INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,'Fictional company',?,?,?,?)`,
    )
    .run(id, 'sub_' + id, userId, clock, clock);
  sql
    .prepare(
      `INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,'fictional@example.test','owner',?)`,
    )
    .run('member_' + id, id, userId, clock);
}
function change(stateValue = 'preparing', live: boolean | null = true) {
  sql
    .prepare(
      `INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at) VALUES(?,'standalone-operation',?,?,'team',?,?,?,?,?)`,
    )
    .run(
      company,
      owner,
      'sub_' + company,
      clock + 864000,
      stateValue,
      JSON.stringify(live === null ? {} : { live }),
      clock,
      clock,
    );
}
function reserve(
  environment: PurchaseEnvironment = 'PRODUCTION',
  provider: PurchaseProvider = 'stripe',
  who = owner,
  ws = workspace,
) {
  return new D1PurchaseIntents(db(), () => clock).reserve({
    ownerId: who,
    environment,
    provider,
    providerScope:
      provider === 'stripe'
        ? 'synthetic-scope'
        : 'https://checkout.postfinance.ch|405',
    product: 'support',
    organizationId: null,
    workspaceId: ws,
    planId: 'team',
    parameters: {},
    terms: {
      version: 'synthetic',
      consentVersion: null,
      origin: 'https://zentraapp.ch',
    },
  });
}
const controller = () =>
  new D1StripeSupportPurchase(
    db(),
    {
      secretKey: state.key,
      livemode: true,
      productId: 'prod_synthetic_support',
      prices: {
        starter: 'price_starter',
        team: 'price_team',
        business: 'price_business',
      },
    },
    {
      price: state.price,
      create: state.create,
      retrieve: state.retrieve,
      list: state.list,
      expire: state.expire,
    },
    () => clock,
  );
const checkout = () =>
  controller().checkout({
    user,
    workspaceId: workspace,
    planId: 'team',
    origin: 'https://zentraapp.ch',
    legalVersion: SUPPORT_LEGAL_VERSION,
  });
beforeEach(async () => {
  vi.resetAllMocks();
  beforeRun = null;
  failBatch = false;
  lastSqlFailure = null;
  clock = Math.floor(Date.now() / 1000);
  sql = new DatabaseSync(':memory:');
  sql.function('unixepoch', () => clock);
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'),
    );
  state.db = db();
  state.user = user;
  seedCompany();
  sql
    .prepare(
      `INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,'Fictional Support',?,?)`,
    )
    .run(workspace, owner, clock, clock);
  state.price.mockResolvedValue({
    id: 'price_team',
    active: true,
    livemode: true,
    currency: 'chf',
    unit_amount: 4900,
    type: 'recurring',
    recurring: { interval: 'month', interval_count: 1 },
    tax_behavior: 'inclusive',
    metadata: { service: 'zentra-support', plan: 'team' },
    product: { id: 'prod_synthetic_support', active: true },
  });
  state.create.mockImplementation(
    async (p: Stripe.Checkout.SessionCreateParams) => ({
      id: 'cs_live_synthetic',
      url: 'https://checkout.stripe.com/synthetic',
      mode: 'subscription',
      status: 'open',
      livemode: true,
      client_reference_id: p.client_reference_id,
      metadata: p.metadata,
      expires_at: p.expires_at,
    }),
  );
  state.list.mockResolvedValue({ data: [], has_more: false });
  sql
    .prepare(
      `INSERT INTO support_billing_config(id,configuration,updated_at) VALUES('stripe',?,?)`,
    )
    .run(
      JSON.stringify({
        productId: 'prod_synthetic_support',
        prices: {
          starter: 'price_starter',
          team: 'price_team',
          business: 'price_business',
        },
        livemode: true,
        keyBinding: await digest(state.key),
      }),
      clock,
    );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('External transport is forbidden');
    }),
  );
});
afterEach(() => {
  sql.close();
  vi.unstubAllGlobals();
});

describe('atomic standalone Support versus pending pack change', () => {
  it.each(['preparing', 'scheduled'])(
    'change first (%s) rejects both providers and the actual authenticated HTTP checkout before merchant POST',
    async (status) => {
      change(status);
      for (const provider of ['stripe', 'postfinance'] as const)
        await expect(reserve('PRODUCTION', provider)).rejects.toThrow(
          /purchase_intent_conflict/,
        );
      const response = await POST(
        new Request('https://zentraapp.ch/api/support/checkout', {
          method: 'POST',
          headers: {
            Origin: 'https://zentraapp.ch',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            workspaceId: workspace,
            plan: 'team',
            acceptTerms: true,
            legalVersion: SUPPORT_LEGAL_VERSION,
          }),
        }),
      );
      expect(response.status).toBe(409);
      expect(state.create).not.toHaveBeenCalled();
      expect(
        sql.prepare('SELECT COUNT(*) n FROM purchase_intents').get()?.n,
      ).toBe(0);
      expect(
        sql
          .prepare('SELECT COUNT(*) n FROM stripe_support_purchase_requests')
          .get()?.n,
      ).toBe(0);
    },
  );
  it.each(['stripe', 'postfinance'] as const)(
    'reservation first (%s) rejects both initial insertion and reactivation of a pack change atomically',
    async (provider) => {
      await reserve('PRODUCTION', provider);
      expect(() => change()).toThrow(/purchase_change_standalone_support/);
      change('completed');
      expect(() =>
        sql.prepare("UPDATE complete_plan_changes SET state='preparing'").run(),
      ).toThrow(/purchase_change_standalone_support/);
      expect(
        sql.prepare('SELECT state FROM complete_plan_changes').get()?.state,
      ).toBe('completed');
      expect(
        sql.prepare('SELECT released_at FROM purchase_intent_footprints').get()
          ?.released_at,
      ).toBeNull();
    },
  );
  it('an interrupted prepared Support request blocks the plan change before the common intent exists', async () => {
    failBatch = true;
    await expect(checkout()).rejects.toThrow('Synthetic lost reservation');
    // The request is durable even when no linkage/receipt was committed.
    expect(
      sql
        .prepare('SELECT intent_id FROM stripe_support_purchase_requests')
        .get()?.intent_id,
    ).toBeNull();
    expect(
      sql.prepare('SELECT COUNT(*) n FROM purchase_intents').get()?.n,
    ).toBe(0);
    expect(() => change()).toThrow(/purchase_change/);
    expect(state.create).not.toHaveBeenCalled();
  });
  it('environment and exact owner isolation preserve unrelated purchases', async () => {
    change('preparing', true);
    await expect(reserve('TEST')).resolves.toMatchObject({
      environment: 'TEST',
    });
    sql
      .prepare(
        `INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('foreign-workspace','foreign-owner','Other',?,?)`,
      )
      .run(clock, clock);
    await expect(
      reserve('PRODUCTION', 'stripe', 'foreign-owner', 'foreign-workspace'),
    ).resolves.toMatchObject({ ownerId: 'foreign-owner' });
  });
  it('an ambiguous plan-change environment refuses both environments', async () => {
    change('preparing', null);
    await expect(reserve('TEST')).rejects.toThrow(/purchase_intent_conflict/);
    await expect(reserve('PRODUCTION')).rejects.toThrow(
      /purchase_intent_conflict/,
    );
  });
  it('a genuine Support link to another owned company remains scoped to that company', async () => {
    seedCompany('other-owned');
    sql
      .prepare(
        `INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at) VALUES(?,'other-owned',?,?)`,
      )
      .run(workspace, owner, clock);
    change();
    await expect(
      new D1PurchaseIntents(db(), () => clock).reserve({
        ownerId: owner,
        environment: 'PRODUCTION',
        provider: 'stripe',
        providerScope: 'synthetic',
        product: 'support',
        organizationId: 'other-owned',
        workspaceId: workspace,
        planId: 'team',
        parameters: {},
        terms: {
          version: 'synthetic',
          consentVersion: null,
          origin: 'https://zentraapp.ch',
        },
      }),
    ).resolves.toMatchObject({ organizationId: 'other-owned' });
  });
  it('another coherently owned company ID cannot disguise an unlinked workspace from either the controller or SQL admission', async () => {
    seedCompany('other-owned');
    change();
    const input = {
      ownerId: owner,
      environment: 'PRODUCTION' as const,
      provider: 'postfinance' as const,
      providerScope: 'https://checkout.postfinance.ch|405',
      product: 'support' as const,
      organizationId: 'other-owned',
      workspaceId: workspace,
      planId: 'team',
      parameters: {},
      terms: {
        version: 'synthetic',
        consentVersion: null,
        origin: 'https://zentraapp.ch',
      },
    };
    await expect(
      new D1PurchaseIntents(db(), () => clock).reserve(input),
    ).rejects.toThrow(/purchase_intent_conflict/);
    const id = 'purchase_' + crypto.randomUUID();
    await expect(
      db().batch([
        db()
          .prepare(
            `INSERT INTO purchase_intents(intent_id,fingerprint,owner_id,environment,provider,provider_scope,product,organization_id,workspace_id,plan_id,parameters,terms_version,origin,accepted_at,created_at,expires_at) VALUES(?,?,?,'PRODUCTION','postfinance',?,'support','other-owned',?,'team','{}','synthetic','https://zentraapp.ch',?,?,?)`,
          )
          .bind(
            id,
            'f'.repeat(64),
            owner,
            input.providerScope,
            workspace,
            clock,
            clock,
            clock + 3600,
          ),
        db()
          .prepare(
            `INSERT INTO purchase_intent_footprints(intent_id,environment,scope_kind,scope_id,entitlement) VALUES(?,'PRODUCTION','workspace',?,'support')`,
          )
          .bind(id, workspace),
      ]),
    ).rejects.toThrow(/purchase_target/);
    expect(
      sql.prepare('SELECT COUNT(*) n FROM purchase_intents').get()?.n,
    ).toBe(0);
    expect(state.create).not.toHaveBeenCalled();
  });
  it('a revoked company owner cannot leave a stale operation that blocks an independently owned Support workspace', async () => {
    change();
    sql
      .prepare(
        'UPDATE organization_members SET revoked_at=? WHERE organization_id=?',
      )
      .run(clock, company);
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) n FROM purchase_standalone_support_pending_owners',
        )
        .get()?.n,
    ).toBe(0);
    await expect(reserve()).resolves.toMatchObject({ workspaceId: workspace });
  });
  it('a deleted account remains refused by the existing deleted-owner guard without blocking a different owner', async () => {
    change();
    sql
      .prepare(
        'INSERT INTO account_session_policy(user_id,deleted_at) VALUES(?,?)',
      )
      .run(owner, clock);
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) n FROM purchase_standalone_support_pending_owners',
        )
        .get()?.n,
    ).toBe(0);
    await expect(reserve()).rejects.toThrow(/purchase_intent_conflict/);
    expect(lastSqlFailure).toContain('purchase_target_deleted');
    sql
      .prepare(
        `INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('independent-workspace','independent-owner','Other',?,?)`,
      )
      .run(clock, clock);
    await expect(
      reserve(
        'PRODUCTION',
        'stripe',
        'independent-owner',
        'independent-workspace',
      ),
    ).resolves.toMatchObject({ ownerId: 'independent-owner' });
  });
  it('a historical plan-change row claiming a foreign owner does not reserve that owner’s workspace', async () => {
    change();
    sql
      .prepare("UPDATE complete_plan_changes SET user_id='unrelated-owner'")
      .run();
    sql
      .prepare(
        `INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('unrelated-workspace','unrelated-owner','Other',?,?)`,
      )
      .run(clock, clock);
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) n FROM purchase_standalone_support_pending_owners',
        )
        .get()?.n,
    ).toBe(0);
    await expect(
      reserve('PRODUCTION', 'stripe', 'unrelated-owner', 'unrelated-workspace'),
    ).resolves.toMatchObject({ ownerId: 'unrelated-owner' });
  });
  it.each(['reserved', 'dispatched', 'uncertain'] as const)(
    'migration closes an existing historical overlap at %s without losing its receipt or uncertainty',
    async (status) => {
      sql.close();
      sql = new DatabaseSync(':memory:');
      sql.function('unixepoch', () => clock);
      for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
        .filter((f) => f.endsWith('.sql') && !f.startsWith('0080'))
        .sort())
        sql.exec(
          readFileSync(
            new URL('../../drizzle/' + file, import.meta.url),
            'utf8',
          ),
        );
      seedCompany();
      sql
        .prepare(
          `INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,'Historical Support',?,?)`,
        )
        .run(workspace, owner, clock, clock);
      const intents = new D1PurchaseIntents(db(), () => clock);
      let intent = await reserve();
      if (status !== 'reserved') intent = await intents.markDispatched(intent);
      if (status === 'uncertain') intent = await intents.markUncertain(intent);
      change();
      sql.exec(
        readFileSync(
          new URL(
            '../../drizzle/0080_standalone_support_plan_change.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      await expect(intents.markDispatched(intent)).rejects.toThrow(
        /purchase_change/,
      );
      if (status === 'dispatched') {
        intent = await intents.markUncertain(intent);
        expect(intent.state).toBe('uncertain');
        await expect(intents.markDispatched(intent)).rejects.toThrow(
          /purchase_change/,
        );
      }
      expect(
        sql.prepare('SELECT state FROM purchase_intents').get()?.state,
      ).toBe(status === 'dispatched' ? 'uncertain' : status);
      expect(
        sql.prepare('SELECT released_at FROM purchase_intent_footprints').get()
          ?.released_at,
      ).toBeNull();
    },
  );
  it('legacy receipt recovery remains GET-only and preserves the original history', async () => {
    change();
    sql
      .prepare(
        `INSERT INTO support_checkouts(workspace_id,nonce,plan_id,session_id,expires_at,owner_id,accepted_version,accepted_at) VALUES(?,'old-nonce','team','cs_live_legacy',?,?,?,?)`,
      )
      .run(workspace, clock - 1, owner, 'original-terms', clock - 3600);
    state.retrieve.mockResolvedValue({
      id: 'cs_live_legacy',
      mode: 'subscription',
      livemode: true,
      status: 'complete',
      client_reference_id: workspace,
      metadata: {
        service: 'zentra-support',
        workspace_id: workspace,
        owner_id: owner,
        plan: 'team',
      },
    });
    await expect(checkout()).resolves.toMatchObject({
      legacySessionId: 'cs_live_legacy',
    });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.expire).not.toHaveBeenCalled();
    expect(
      sql.prepare('SELECT accepted_version FROM support_checkouts').get()
        ?.accepted_version,
    ).toBe('original-terms');
  });
});
