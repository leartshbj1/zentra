import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const runtime = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/runtime', () => ({
  database: () => runtime.db,
  runtimeValue: () => '',
  stripeConfiguration: () => ({
    secretKey: '',
    siteUrl: 'https://zentra.example.test',
    siteOriginAliases: '',
    priceIds: {},
    signingKey: '',
  }),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => null }));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
import { LEGAL_VERSION } from '@/lib/legal';
import { SUPPORT_LEGAL_VERSION } from '@/lib/support/plans';
import { COMPLETE_TERMS_VERSION } from '@/lib/complete/plans';
import { prepaidCatalog, prepaidProduct } from '@/lib/payments/prepaid-catalog';
import {
  prepareInitialPrepaidPurchase,
  type PrepaidPurchaseConfiguration,
} from '@/lib/payments/prepaid-purchase-preparation';
import { D1PrepaidPeriods } from '@/lib/payments/prepaid-periods';
import { D1PurchaseIntents } from '@/lib/payments/purchase-intents';
import { D1PostFinanceWebhookInbox } from '@/lib/payments/postfinance-store';
import { D1PrepaidProvisioning } from '@/lib/payments/prepaid-provisioning';
import { D1PrepaidReconciliationStore } from '@/lib/payments/prepaid-reconciliation-store';

import { ownedPrepaidReceipt } from '@/lib/payments/prepaid-receipt';
import { prepaidReceiptPath } from '@/lib/payments/prepaid-receipt-types';

import type { ZentraUser } from '@/app/zentra-auth';
import {
  listOwnedPendingPrepaidReceipts,
  PendingPrepaidReceiptCursorError,
  OWNED_PENDING_PREPAID_CANDIDATES_SQL,
} from './pending-prepaid-receipts';

let sql: DatabaseSync, clock: number, network: ReturnType<typeof vi.spyOn>;
const user: ZentraUser = {
  userId: 'receipt-owner',
  email: 'owner@example.test',
  emailConfirmed: true,
  provider: 'supabase',
  displayName: 'Fixture Owner',
  fullName: null,
};
const site = 'https://zentra.example.test',
  origin = 'https://checkout.postfinance.ch';
function d1(readOnly = false) {
  return {
    prepare(query: string) {
      if (readOnly && !/^\s*SELECT\b/i.test(query))
        throw Error('Receipt must remain SELECT-only.');
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...items: SQLInputValue[]) {
          values = items;
          return statement;
        },
        execute() {
          if (readOnly) throw Error('No receipt writes.');
          return { success: true, meta: sql.prepare(query).run(...values) };
        },
        async run() {
          return statement.execute();
        },
        async first() {
          return sql.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { success: true, results: sql.prepare(query).all(...values) };
        },
      };
      return statement;
    },
    async batch(statements: { execute(): unknown }[]) {
      if (readOnly) throw Error('No receipt batch.');
      sql.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}
const configuration = (
  environment: 'TEST' | 'PRODUCTION',
): PrepaidPurchaseConfiguration => ({
  enabled: true,
  settlementEvidenceVerified: true,
  connectorConfigurations: { postfinance_pay: 92 },
  connection: {
    enabled: true,
    merchantApproved: true,
    prepaidFeatureEnabled: true,
    chargeFlowEnabled: true,
    postfinancePayTokenEnabled: true,
    prepaidEnvironment: environment,
    apiOrigin: origin,
    spaceId: 405,
    applicationUserId: '512',
    authenticationKeyBase64: Buffer.alloc(32, 0x5a).toString('base64'),
    returnOrigin: site,
    prepaidProducts: Object.fromEntries(
      prepaidCatalog().map((product) => [
        product.productKey,
        {
          currency: 'CHF',
          billingPeriod: 'P1M',
          priceChfMinor: product.priceChfMinor,
          reference: product.catalogVersion,
          name: product.name,
          methodConfigurations: { postfinance_pay: 91 },
        },
      ]),
    ),
  },
});
async function prepare(
  key = 'gestion:solo',
  environment: 'TEST' | 'PRODUCTION' = 'PRODUCTION',
  options: {
    organizationId?: string;
    workspaceId?: string;
    requestId?: string;
  } = {},
) {
  const product = prepaidProduct(key)!;
  const result = await prepareInitialPrepaidPurchase(
    configuration(environment),
    {
      user,
      requestId: options.requestId ?? '11111111-1111-4111-8111-111111111111',
      productKey: key,
      organizationId:
        product.productKind === 'support'
          ? undefined
          : (options.organizationId ?? 'company-b'),
      workspaceId: product.support
        ? (options.workspaceId ?? 'workspace-b')
        : undefined,
      method: 'postfinance_pay',
      acceptTerms: true,
      legalVersion:
        product.productKind === 'gestion'
          ? LEGAL_VERSION
          : product.productKind === 'support'
            ? SUPPORT_LEGAL_VERSION
            : COMPLETE_TERMS_VERSION,
    },
    { database: () => d1(), now: () => clock },
  );
  if (result.state !== 'prepared') throw Error('Missing fixture purchase.');
  return result;
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
let transactionCounter = 70;
async function bound(prepared: Prepared) {
  const transactionId = ++transactionCounter;
  const journal = new D1PurchaseIntents(d1(), () => clock);
  await journal.markDispatched(prepared.intent);
  await new D1PrepaidPeriods(d1(), () => clock).bindTransaction(
    prepared.period.periodId,
    transactionId,
  );
  await journal.bindProviderReference(prepared.intent, String(transactionId));
  const inbox = new D1PostFinanceWebhookInbox(
    d1(),
    {
      apiOrigin: origin,
      spaceId: 405,
      listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }],
    },
    () => clock,
  );
  await inbox.acceptOnce(`${origin}|405|10|${transactionId}`, {
    eventId: transactionId,
    entityId: transactionId,
    spaceId: 405,
    webhookListenerId: 10,
    listenerEntityId: 20,
    listenerEntityTechnicalName: 'Transaction',
    timestamp: new Date(clock * 1000).toISOString(),
  });
  const work = await inbox.claimNext();
  if (!work) throw Error('Missing fixture lease.');
  const proof = {
    periodId: prepared.period.periodId,
    transactionId,
    invoiceId: transactionId + 100,
    apiOrigin: origin,
    spaceId: 405,
    environment: prepared.contract.environment,
    ownerId: user.userId,
    organizationId: prepared.contract.organizationId,
    workspaceId: prepared.contract.workspaceId,
    startsAt: prepared.period.startsAt,
    endsAt: prepared.period.endsAt,
    currency: 'CHF' as const,
    priceChfMinor: prepared.period.priceChfMinor,
    catalogVersion: prepared.period.catalogVersion,
    evidenceFingerprint: 'a'.repeat(64),
  };
  return { proof, work };
}
async function paid(prepared: Prepared) {
  const { proof, work } = await bound(prepared);
  await new D1PrepaidProvisioning(d1(), () => clock).provision(proof, work);
}
const snapshot = () =>
  JSON.stringify(
    sql
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => {
        if (typeof name !== 'string')
          throw Error('Invalid fixture table name.');
        return [
          name,
          sql.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
        ];
      }),
  );
async function read(
  prepared: Prepared,
  actor = user,
  extra: Parameters<typeof ownedPrepaidReceipt>[2] = {},
) {
  const before = snapshot();
  runtime.db = d1(true);
  const result = await ownedPrepaidReceipt(actor, prepared.intent.intentId, {
    database: () => d1(true),
    now: () => clock,
    ...extra,
  });
  expect(snapshot()).toBe(before);
  runtime.db = d1();
  return result;
}
beforeEach(() => {
  transactionCounter = 70;
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = Date.parse('2026-10-06T10:11:12Z') / 1000;
  vi.setSystemTime(clock * 1000);
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => clock);
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  for (const id of ['a', 'b']) {
    sql
      .prepare(
        "INSERT INTO subscriptions(subscription_id,customer_id,price_id,plan_id,status,current_period_end,entitlement_valid_until,livemode,updated_at) VALUES(?,?,?,'zentra-solo-monthly-49-chf','incomplete',0,0,1,?)",
      )
      .run(`old-${id}`, `customer-${id}`, 'price-fixture', clock);
    sql
      .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
      .run(
        `company-${id}`,
        `Entreprise ${id.toUpperCase()}`,
        `old-${id}`,
        user.userId,
        clock,
        clock,
      );
    sql
      .prepare(
        "INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at) VALUES(?,?,?,?,?,'owner',?)",
      )
      .run(
        `owner-${id}`,
        `company-${id}`,
        user.userId,
        user.email,
        user.displayName,
        clock,
      );
  }
  sql
    .prepare(
      'INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',
    )
    .run('workspace-b', user.userId, 'Support B', clock, clock);
  runtime.db = d1();
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('No receipt transport.');
  });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
  sql.close();
  vi.useRealTimers();
});

function company(index: number) {
  const id = `company-extra-${index}`;
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,plan_id,status,current_period_end,entitlement_valid_until,livemode,updated_at) VALUES(?,?,?,'zentra-solo-monthly-49-chf','incomplete',0,0,1,?)",
    )
    .run(
      `old-extra-${index}`,
      `customer-extra-${index}`,
      'price-fixture',
      clock,
    );
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(
      id,
      `Entreprise ${index}`,
      `old-extra-${index}`,
      user.userId,
      clock,
      clock,
    );
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at) VALUES(?,?,?,?,?,'owner',?)",
    )
    .run(
      `owner-extra-${index}`,
      id,
      user.userId,
      user.email,
      user.displayName,
      clock,
    );
  return id;
}
async function list(cursor?: unknown, actor = user) {
  const before = snapshot();
  runtime.db = d1(true);
  const result = await listOwnedPendingPrepaidReceipts(actor, {
    database: () => d1(true),
    now: () => clock,
    cursor,
  });
  expect(snapshot()).toBe(before);
  runtime.db = d1();
  return result;
}
function corruptIntent(
  prepared: Prepared,
  fields: Record<string, SQLInputValue>,
) {
  // Stage a malformed historical record in this disposable database. Production
  // immutable guards are not relaxed by the module or any migration.
  sql.exec('DROP TRIGGER IF EXISTS purchase_intent_immutable');
  for (const [key, value] of Object.entries(fields))
    sql
      .prepare(`UPDATE purchase_intents SET ${key}=? WHERE intent_id=?`)
      .run(value, prepared.intent.intentId);
}

describe('SELECT-only durable pending-payment discovery', () => {
  it('returns the same owned company and canonical receipt on two independent devices', async () => {
    const prepared = await prepare();
    const first = await list(),
      second = await list();
    expect(first).toEqual(second);
    expect(first).toEqual({
      items: [
        {
          intentId: prepared.intent.intentId,
          name: 'Zentra Gestion Solo',
          targetName: 'Entreprise B',
          status: 'pending',
          receiptHref: prepaidReceiptPath(prepared.intent.intentId),
        },
      ],
      nextCursor: null,
    });
  });
  it.each([
    { userId: '', emailConfirmed: true },
    { userId: user.userId, emailConfirmed: false },
  ])(
    'does no database work before confirmed authentication (%j)',
    async (actor) => {
      const database = vi.fn(() => d1(true));
      expect(
        await listOwnedPendingPrepaidReceipts(actor, { database }),
      ).toEqual({ items: [], nextCursor: null });
      expect(database).not.toHaveBeenCalled();
    },
  );
  it.each(['other-owner', 'collaborator'])(
    'does not expose the owner’s attempts to %s',
    async (userId) => {
      await prepare();
      expect(await list(undefined, { ...user, userId })).toEqual({
        items: [],
        nextCursor: null,
      });
    },
  );
  it.each(['revoked', 'member', 'deleted', 'creator'])(
    'rechecks current authority: %s',
    async (change) => {
      await prepare();
      if (change === 'revoked')
        sql
          .prepare(
            'UPDATE organization_members SET revoked_at=? WHERE membership_id=?',
          )
          .run(clock, 'owner-b');
      if (change === 'member')
        sql
          .prepare(
            "UPDATE organization_members SET role='member' WHERE membership_id=?",
          )
          .run('owner-b');
      if (change === 'deleted')
        sql
          .prepare(
            'INSERT INTO account_session_policy(user_id,revoked_before,deleted_at) VALUES(?,?,?)',
          )
          .run(user.userId, clock, clock);
      if (change === 'creator')
        sql
          .prepare(
            'UPDATE organizations SET created_by_user_id=? WHERE organization_id=?',
          )
          .run('someone-else', 'company-b');
      expect((await list()).items).toEqual([]);
    },
  );
  it('keeps standalone Support’s workspace instead of inventing a company', async () => {
    const prepared = await prepare('support:starter');
    expect((await list()).items).toEqual([
      {
        intentId: prepared.intent.intentId,
        name: 'Zentra Support Starter',
        targetName: 'Support B',
        status: 'pending',
        receiptHref: prepaidReceiptPath(prepared.intent.intentId),
      },
    ]);
  });
  it.each(['owner', 'link'])(
    'hides a Support receipt after its %s changes',
    async (change) => {
      await prepare('support:starter');
      if (change === 'owner')
        sql
          .prepare('UPDATE support_workspaces SET owner_id=? WHERE id=?')
          .run('other-owner', 'workspace-b');
      else
        sql
          .prepare(
            'INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at) VALUES(?,?,?,?)',
          )
          .run('workspace-b', 'company-a', user.userId, clock);
      expect((await list()).items).toEqual([]);
    },
  );
  it('keeps uncertain payments after both reservation and purchased-period expiry', async () => {
    const prepared = await prepare();
    const intents = new D1PurchaseIntents(d1(), () => clock);
    await intents.markDispatched(prepared.intent);
    await intents.markUncertain(prepared.intent);
    clock = prepared.period.endsAt + 86400;
    vi.setSystemTime(clock * 1000);
    expect((await list()).items).toMatchObject([
      { intentId: prepared.intent.intentId, status: 'verification_required' },
    ]);
  });
  it('excludes an expired reservation only when no request ever dispatched', async () => {
    const prepared = await prepare();
    clock = prepared.intent.expiresAt;
    vi.setSystemTime(clock * 1000);
    expect((await list()).items).toEqual([]);
    expect(await read(prepared)).toMatchObject({ status: 'pending' });
  });
  it('excludes an explicitly released undispatched reservation', async () => {
    const prepared = await prepare();
    await new D1PurchaseIntents(d1(), () => clock).releaseUndispatched(
      prepared.intent,
    );
    expect(await read(prepared)).toMatchObject({ status: 'not_completed' });
    expect((await list()).items).toEqual([]);
  });
  it('includes payment recorded but not yet projected without granting access', async () => {
    const prepared = await prepare();
    const { proof, work } = await bound(prepared);
    await new D1PrepaidReconciliationStore(d1(), () => clock).recordPaid(
      proof,
      work,
    );
    expect((await list()).items).toMatchObject([
      { intentId: prepared.intent.intentId, status: 'activation_pending' },
    ]);
    expect(await read(prepared)).toMatchObject({
      paidUntil: null,
      canCancel: false,
    });
  });
  it.each(['gestion:solo', 'support:starter', 'complet:team'])(
    'excludes genuinely active %s after exact paid handoff',
    async (key) => {
      const prepared = await prepare(key);
      await paid(prepared);
      expect(await read(prepared)).toMatchObject({ status: 'active' });
      expect((await list()).items).toEqual([]);
    },
  );
  it('retains a settled pack whose current component access is incomplete', async () => {
    const prepared = await prepare('complet:team');
    await paid(prepared);
    // The immutable paid receipt remains valid, while its current company
    // projection no longer points to that pack. No paid access is inferred.
    sql
      .prepare(
        'UPDATE organizations SET subscription_id=? WHERE organization_id=?',
      )
      .run('old-b', 'company-b');
    expect((await list()).items).toMatchObject([
      { status: 'verification_required' },
    ]);
  });
  it('excludes an ended paid period', async () => {
    const prepared = await prepare();
    await paid(prepared);
    clock = prepared.period.endsAt;
    vi.setSystemTime(clock * 1000);
    expect(await read(prepared)).toMatchObject({ status: 'ended' });
    expect((await list()).items).toEqual([]);
  });
  it('excludes a refund despite stale projected paid dates', async () => {
    const prepared = await prepare();
    await paid(prepared);
    const inbox = new D1PostFinanceWebhookInbox(
      d1(),
      {
        apiOrigin: origin,
        spaceId: 405,
        listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }],
      },
      () => clock,
    );
    await inbox.acceptOnce(`${origin}|405|10|999`, {
      eventId: 999,
      entityId: 71,
      spaceId: 405,
      webhookListenerId: 10,
      listenerEntityId: 20,
      listenerEntityTechnicalName: 'Transaction',
      timestamp: new Date(clock * 1000).toISOString(),
    });
    const work = await inbox.claimNext();
    if (!work) throw Error('Missing fixture reversal.');
    const records = new D1PrepaidReconciliationStore(d1(), () => clock),
      target = await records.target(origin, 405, 71);
    if (!target) throw Error('Missing fixture target.');
    await records.recordReversal(target, 'b'.repeat(64), work);
    expect(await read(prepared)).toMatchObject({ status: 'refunded' });
    expect((await list()).items).toEqual([]);
  });
  it('shows TEST pending but does not list a confirmed TEST as active or still waiting', async () => {
    const prepared = await prepare('gestion:solo', 'TEST');
    expect((await list()).items).toMatchObject([{ status: 'pending' }]);
    const { proof, work } = await bound(prepared);
    await new D1PrepaidReconciliationStore(d1(), () => clock).recordPaid(
      proof,
      work,
    );
    expect(await read(prepared)).toMatchObject({ status: 'test_confirmed' });
    expect((await list()).items).toEqual([]);
  });
  it.each([
    'bad-json',
    'duplicate-key',
    'wrong-catalog',
    'wrong-scope',
    'oversize-json',
    'future-date',
    'invalid-id',
  ])('skips malformed historical candidate %s', async (variant) => {
    const prepared = await prepare();
    if (variant === 'bad-json') {
      sql.exec('PRAGMA ignore_check_constraints=ON');
      corruptIntent(prepared, { parameters: '{invalid' });
      sql.exec('PRAGMA ignore_check_constraints=OFF');
    }
    if (variant === 'duplicate-key')
      corruptIntent(prepared, {
        parameters: prepared.intent.parameters
          ? JSON.stringify(prepared.intent.parameters).replace(
              '{',
              '{"method":"twint",',
            )
          : '{}',
      });
    if (variant === 'wrong-catalog')
      corruptIntent(prepared, {
        parameters: JSON.stringify({
          ...prepared.intent.parameters,
          catalogVersion: 'future-unknown',
        }),
      });
    if (variant === 'wrong-scope')
      corruptIntent(prepared, { provider_scope: `${origin}|999` });
    if (variant === 'oversize-json')
      corruptIntent(prepared, {
        parameters: JSON.stringify({
          ...prepared.intent.parameters,
          extra: 'x'.repeat(17000),
        }),
      });
    if (variant === 'future-date') {
      sql.exec('DROP TRIGGER purchase_intent_immutable');
      sql
        .prepare(
          'UPDATE purchase_intents SET created_at=?,accepted_at=?,expires_at=? WHERE intent_id=?',
        )
        .run(clock + 1, clock + 1, clock + 600, prepared.intent.intentId);
    }
    if (variant === 'invalid-id') {
      sql.exec('PRAGMA foreign_keys=OFF');
      corruptIntent(prepared, {
        intent_id: 'purchase_------------------------------------',
      });
    }
    expect((await list()).items).toEqual([]);
  });
  it('does not return merchant data, e-mail, customer, evidence or private target IDs', async () => {
    await prepare();
    const output = JSON.stringify(await list());
    for (const secret of [
      user.email,
      origin,
      'company-b',
      'workspace-b',
      'provider_scope',
      'authenticationKeyBase64',
      'evidence_fingerprint',
      'customerReference',
    ])
      expect(output).not.toContain(secret);
  });
  it('rechecks ownership between candidate selection and receipt read', async () => {
    await prepare();
    const before = snapshot(),
      real = d1(true);
    let moved = false;
    const db = {
      prepare(query: string) {
        if (
          !moved &&
          query.includes('FROM purchase_intents i') &&
          query !== OWNED_PENDING_PREPAID_CANDIDATES_SQL
        ) {
          moved = true;
          sql
            .prepare(
              'UPDATE organization_members SET revoked_at=? WHERE membership_id=?',
            )
            .run(clock, 'owner-b');
        }
        return real.prepare(query);
      },
    } as Pick<D1Database, 'prepare'>;
    const result = await listOwnedPendingPrepaidReceipts(user, {
      database: () => db,
      now: () => clock,
    });
    expect(moved).toBe(true);
    expect(result.items).toEqual([]);
    expect(snapshot()).not.toBe(before);
  });
  it('uses the owner/created index and explicit bounded SQL', () => {
    const plan = sql
      .prepare(`EXPLAIN QUERY PLAN ${OWNED_PENDING_PREPAID_CANDIDATES_SQL}`)
      .all(user.userId, clock, clock, null, null, null, null);
    expect(JSON.stringify(plan)).toContain('purchase_intents_owner_created');
    expect(OWNED_PENDING_PREPAID_CANDIDATES_SQL).toMatch(/LIMIT 5/);
  });
});

describe('bounded keyset pagination over scanned rows', () => {
  it('returns at most four and traverses tied dates exactly once without browser state', async () => {
    const expected: string[] = [];
    for (let i = 0; i < 21; i++)
      expected.push(
        (
          await prepare('gestion:solo', 'PRODUCTION', {
            organizationId: company(i),
          })
        ).intent.intentId,
      );
    expected.sort().reverse();
    const found: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await list(cursor);
      expect(page.items.length).toBeLessThanOrEqual(4);
      found.push(...page.items.map((item) => item.intentId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(found).toEqual(expected);
    expect(new Set(found).size).toBe(21);
  });
  it('advances through more than 48 invalid newer rows, with only four scanned on each empty page', async () => {
    const older = await prepare();
    clock += 1;
    vi.setSystemTime(clock * 1000);
    for (let i = 0; i < 49; i++) {
      const id = company(i);
      await prepare('gestion:solo', 'PRODUCTION', { organizationId: id });
      sql
        .prepare(
          'UPDATE organization_members SET revoked_at=? WHERE organization_id=?',
        )
        .run(clock, id);
    }
    const readOnly = d1(true);
    let pointerQueries = 0,
      receiptQueries = 0;
    const counted = {
      prepare(query: string) {
        if (query === OWNED_PENDING_PREPAID_CANDIDATES_SQL) pointerQueries++;
        else receiptQueries++;
        return readOnly.prepare(query);
      },
    } as Pick<D1Database, 'prepare'>;
    const before = snapshot();
    const page = await listOwnedPendingPrepaidReceipts(user, {
      database: () => counted,
      now: () => clock,
    });
    expect(snapshot()).toBe(before);
    expect(pointerQueries).toBe(1);
    expect(receiptQueries).toBe(4);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).not.toBeNull();
    let cursor = page.nextCursor;
    const found: string[] = [];
    let pages = 1;
    while (cursor) {
      const next = await list(cursor);
      found.push(...next.items.map((item) => item.intentId));
      cursor = next.nextCursor;
      pages++;
      expect(pages).toBeLessThanOrEqual(13);
    }
    expect(found).toEqual([older.intent.intentId]);
    expect(pages).toBe(13);
  });
  it('keeps a keyset stable when a new newer purchase appears between pages', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++)
      ids.push(
        (
          await prepare('gestion:solo', 'PRODUCTION', {
            organizationId: company(i),
          })
        ).intent.intentId,
      );
    const first = await list();
    clock += 1;
    vi.setSystemTime(clock * 1000);
    const newest = await prepare('gestion:solo', 'PRODUCTION', {
      organizationId: company(99),
    });
    const following: string[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await list(cursor);
      following.push(...page.items.map((item) => item.intentId));
      cursor = page.nextCursor;
    }
    expect([...first.items.map((item) => item.intentId), ...following]).toEqual(
      ids.sort().reverse(),
    );
    expect(following).not.toContain(newest.intent.intentId);
  });
  it('never treats another owner’s cursor as authorization', async () => {
    for (let i = 0; i < 9; i++)
      await prepare('gestion:solo', 'PRODUCTION', {
        organizationId: company(i),
      });
    const page = await list();
    expect(page.nextCursor).not.toBeNull();
    expect(
      await list(page.nextCursor, { ...user, userId: 'other-owner' }),
    ).toEqual({ items: [], nextCursor: null });
  });
  it.each(
    ['', 'bad', 'https://evil.test', 'e30', 12, ['one'], 'x'.repeat(161)].map(
      (cursor) => ({ cursor }),
    ),
  )('rejects malformed cursor %j before database work', async ({ cursor }) => {
    const database = vi.fn(() => d1(true));
    await expect(
      listOwnedPendingPrepaidReceipts(user, {
        database,
        now: () => clock,
        cursor,
      }),
    ).rejects.toBeInstanceOf(PendingPrepaidReceiptCursorError);
    expect(database).not.toHaveBeenCalled();
  });
  it.each(
    [
      [2, 1, 'purchase_11111111-1111-4111-8111-111111111111'],
      [1, 1.5, 'purchase_11111111-1111-4111-8111-111111111111'],
      [1, 9999999999, 'purchase_11111111-1111-4111-8111-111111111111'],
      [1, 1, 'bad'],
      [1, 1, 'purchase_11111111-1111-4111-8111-111111111111', 'extra'],
    ].map((content) => ({ content })),
  )('rejects noncanonical cursor content %j', async ({ content }) => {
    const cursor = btoa(JSON.stringify(content))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    await expect(list(cursor)).rejects.toBeInstanceOf(
      PendingPrepaidReceiptCursorError,
    );
  });
});
