import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { D1PrepaidPeriods, type PrepaidContractInput } from './prepaid-periods';
import { prepaidProduct } from './prepaid-catalog';
import { prepaidMonthlyPeriod } from './prepaid-calendar';
import {
  isPrepaidContractId,
  prepaidAutomationAccess,
  prepaidCompanyAccess,
  prepaidSubscriptionAccess,
  prepaidSupportAccess,
} from './prepaid-access';

const fixture = vi.hoisted(() => ({ database: null as unknown }));
vi.mock('@/lib/runtime', () => ({ database: () => fixture.database }));

let db: DatabaseSync, clock: number, counter: number;
let readQueries: string[];
const owner = 'user-owner';
const anchor = Date.parse('2026-01-31T09:17:23Z') / 1000;
function setNow(seconds: number) {
  clock = seconds;
  vi.setSystemTime(new Date(seconds * 1000));
}
function d1() {
  return {
    prepare(query: string) {
      readQueries.push(query);
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          values = args;
          return statement;
        },
        async run() {
          return { success: true, meta: db.prepare(query).run(...values) };
        },
        async first() {
          return db.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { success: true, results: db.prepare(query).all(...values) };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}
function store() {
  return new D1PrepaidPeriods(d1(), () => clock);
}

function projection(subscriptionId: string) {
  db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_plan_id,seat_limit,entitlement_valid_until,last_paid_invoice_id,livemode,updated_at)
    VALUES(?,?,'prepaid_projection','active',?,'zentra-pro-monthly-89-chf',10,?,'cached-not-a-proof',1,?) ON CONFLICT(subscription_id) DO NOTHING`).run(
    subscriptionId,
    subscriptionId,
    clock + 999999,
    clock + 999999,
    clock,
  );
}
function company(
  subscriptionId: string,
  organizationId = 'company-a',
  ownerId = owner,
) {
  projection(subscriptionId);
  db.prepare(`INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)
    VALUES(?,'PME fictive',?,?,?,?) ON CONFLICT(organization_id) DO NOTHING`).run(
    organizationId,
    subscriptionId,
    ownerId,
    clock,
    clock,
  );
  db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES(?,?,?,'owner@example.test','owner',?) ON CONFLICT DO NOTHING`).run(
    `owner-${organizationId}`,
    organizationId,
    ownerId,
    clock,
  );
}
function workspace(workspaceId = 'support-a', ownerId = owner) {
  db.prepare(
    `INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,'Support fictif',?,?) ON CONFLICT(id) DO NOTHING`,
  ).run(workspaceId, ownerId, clock, clock);
}
function link(organizationId = 'company-a', workspaceId = 'support-a') {
  db.prepare(
    `INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at) VALUES(?,?,1,0,?,?) ON CONFLICT DO NOTHING`,
  ).run(workspaceId, organizationId, owner, clock);
}

async function contract(
  productKey = 'complet:team',
  overrides: Partial<PrepaidContractInput> = {},
  createLink = true,
) {
  const product = prepaidProduct(productKey)!;
  const number = ++counter;
  const input: PrepaidContractInput = {
    contractId: `pfp_00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    ownerId: owner,
    organizationId: product.productKind === 'support' ? null : 'company-a',
    workspaceId:
      product.productKind === 'support' || product.productKind === 'complete'
        ? 'support-a'
        : null,
    apiOrigin: 'https://checkout.postfinance.ch',
    spaceId: 405,
    environment: 'PRODUCTION',
    productKey,
    ...overrides,
  };
  await store().createContract(input);
  if (input.organizationId)
    company(input.contractId, input.organizationId, input.ownerId);
  if (input.workspaceId) workspace(input.workspaceId, input.ownerId);
  if (product.productKind === 'complete' && createLink)
    link(input.organizationId!, input.workspaceId!);
  const period = await store().reservePeriod(input.contractId, 0);
  return { input, period, transactionId: 70 + number, invoiceId: 80 + number };
}
async function paid(
  productKey = 'complet:team',
  overrides: Partial<PrepaidContractInput> = {},
  createLink = true,
) {
  const data = await contract(productKey, overrides, createLink);
  await store().bindTransaction(data.period.periodId, data.transactionId);
  await store().recordReconciledSettlement({
    periodId: data.period.periodId,
    transactionId: data.transactionId,
    invoiceId: data.invoiceId,
    apiOrigin: data.input.apiOrigin,
    spaceId: data.input.spaceId,
    environment: data.input.environment,
    ownerId: data.input.ownerId,
    organizationId: data.input.organizationId,
    workspaceId: data.input.workspaceId,
    startsAt: data.period.startsAt,
    endsAt: data.period.endsAt,
    currency: 'CHF',
    priceChfMinor: data.period.priceChfMinor,
    catalogVersion: data.period.catalogVersion,
    evidenceFingerprint: 'a'.repeat(64),
  });
  return data;
}

/** Deliberately malformed local audit fixtures. Production writers never
 * accept these values; the access reader must still fail closed on them.
 */
function malformedPaid(
  overrides: Partial<{
    contractJson: string;
    periodJson: string;
    catalogVersion: string;
    price: number;
    ordinal: number;
    startsAt: number;
    endsAt: number;
    transactionOrigin: string;
    transactionSpace: number;
    evidence: string;
    reconciledAt: number;
  }> = {},
) {
  const number = ++counter;
  const contractId = `pfp_00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const periodId = `pfperiod_${String(number).padStart(64, '0')}`;
  const catalog = prepaidProduct('complet:team')!;
  const json = JSON.stringify(catalog);
  const dates = prepaidMonthlyPeriod(anchor, 0);
  company(contractId, 'company-b');
  db.prepare(`INSERT INTO prepaid_contracts(contract_id,owner_id,organization_id,workspace_id,api_origin,space_id,environment,product_key,catalog_version,catalog_json,anchor_start,fingerprint,created_at)
    VALUES(?,?,'company-b',NULL,'https://checkout.postfinance.ch',405,'PRODUCTION','complet:team',?,?,?,?,?)`).run(
    contractId,
    owner,
    overrides.catalogVersion ?? catalog.catalogVersion,
    overrides.contractJson ?? json,
    anchor,
    'a'.repeat(64),
    clock,
  );
  db.prepare(`INSERT INTO prepaid_periods(period_id,contract_id,ordinal,starts_at,ends_at,currency,price_chf_minor,catalog_version,catalog_json,created_at)
    VALUES(?,?,?,?,?,'CHF',?,?,?,?)`).run(
    periodId,
    contractId,
    overrides.ordinal ?? 0,
    overrides.startsAt ?? dates.startSeconds,
    overrides.endsAt ?? dates.endSeconds,
    overrides.price ?? catalog.priceChfMinor,
    overrides.catalogVersion ?? catalog.catalogVersion,
    overrides.periodJson ?? json,
    clock,
  );
  db.prepare(
    `INSERT INTO prepaid_transactions(period_id,api_origin,space_id,transaction_id,created_at) VALUES(?,?,?,?,?)`,
  ).run(
    periodId,
    overrides.transactionOrigin ?? 'https://checkout.postfinance.ch',
    overrides.transactionSpace ?? 405,
    1000 + number,
    clock,
  );
  db.prepare(
    `INSERT INTO prepaid_settlement_proofs(period_id,invoice_id,evidence_fingerprint,reconciled_at) VALUES(?,?,?,?)`,
  ).run(
    periodId,
    2000 + number,
    overrides.evidence ?? 'a'.repeat(64),
    overrides.reconciledAt ?? clock,
  );
  return contractId;
}

function conflictingCurrentPeriod(data: Awaited<ReturnType<typeof paid>>) {
  const number = ++counter;
  const periodId = `pfperiod_${String(number).padStart(64, '0')}`;
  const period = data.period;
  db.prepare(`INSERT INTO prepaid_periods(period_id,contract_id,ordinal,starts_at,ends_at,currency,price_chf_minor,catalog_version,catalog_json,created_at)
    VALUES(?,?,1,?,?,'CHF',?,?,?,?)`).run(
    periodId,
    data.input.contractId,
    period.startsAt,
    period.endsAt,
    period.priceChfMinor,
    period.catalogVersion,
    JSON.stringify(prepaidProduct(data.input.productKey)),
    clock,
  );
  db.prepare(
    `INSERT INTO prepaid_transactions(period_id,api_origin,space_id,transaction_id,created_at) VALUES(?,?,?,?,?)`,
  ).run(
    periodId,
    data.input.apiOrigin,
    data.input.spaceId,
    1000 + number,
    clock,
  );
  db.prepare(
    `INSERT INTO prepaid_settlement_proofs(period_id,invoice_id,evidence_fingerprint,reconciled_at) VALUES(?,?,?,?)`,
  ).run(periodId, 2000 + number, 'a'.repeat(64), clock);
  return periodId;
}

beforeEach(() => {
  vi.useFakeTimers();
  setNow(anchor);
  counter = 0;
  readQueries = [];
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.function('unixepoch', () => clock);
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    db.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  }
  fixture.database = d1();
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe('prepaid access reads recorded production proofs, not merchant or legacy caches', () => {
  it('projects Complet into precise licence, seats, quota and Automation from one paid period', async () => {
    const { input, period } = await paid();
    const companyAccess = await prepaidCompanyAccess('company-a');
    expect(companyAccess).toMatchObject({
      contractId: input.contractId,
      ownerId: owner,
      organizationId: 'company-a',
      workspaceId: 'support-a',
      productKind: 'complete',
      periodId: period.periodId,
      paidFrom: period.startsAt,
      paidUntil: period.endsAt,
      cancelAtPeriodEnd: false,
      customerName: 'PME fictive',
      catalog: {
        priceChfMinor: 9900,
        gestion: {
          licensePlan: 'zentra-start-monthly-59-chf',
          licensePriceChfMinor: 5900,
          seats: 3,
          ownerIncluded: true,
        },
        support: { planId: 'team', analyses: 5000 },
        automation: true,
      },
    });
    expect(await prepaidSubscriptionAccess(input.contractId)).toEqual(
      companyAccess,
    );
    expect(await prepaidSupportAccess('support-a')).toEqual(companyAccess);
    expect(await prepaidAutomationAccess('company-a')).toEqual(companyAccess);
    expect(await prepaidCompanyAccess('company-b')).toBeNull();
    expect(await prepaidSupportAccess('support-b')).toBeNull();
    expect(await prepaidAutomationAccess('company-b')).toBeNull();
  });

  it('does not grant rights for a local contract, reserved period or linked transaction alone', async () => {
    const data = await contract();
    for (let stage = 0; stage < 2; stage++) {
      expect(await prepaidSubscriptionAccess(data.input.contractId)).toBeNull();
      expect(await prepaidCompanyAccess('company-a')).toBeNull();
      expect(await prepaidSupportAccess('support-a')).toBeNull();
      expect(await prepaidAutomationAccess('company-a')).toBeNull();
      await store().bindTransaction(data.period.periodId, data.transactionId);
    }
  });

  it('never treats TEST payment, however complete, as production access', async () => {
    const { input } = await paid('complet:team', { environment: 'TEST' });
    expect(await prepaidSubscriptionAccess(input.contractId)).toBeNull();
    expect(await prepaidCompanyAccess('company-a')).toBeNull();
    expect(await prepaidSupportAccess('support-a')).toBeNull();
    expect(await prepaidAutomationAccess('company-a')).toBeNull();
  });

  it('applies the exact paid interval including its start and excluding its end', async () => {
    const { input, period } = await paid();
    setNow(period.startsAt - 1);
    expect(await prepaidSubscriptionAccess(input.contractId)).toBeNull();
    setNow(period.startsAt);
    expect(await prepaidCompanyAccess('company-a')).not.toBeNull();
    setNow(period.endsAt - 1);
    expect(await prepaidSupportAccess('support-a')).not.toBeNull();
    setNow(period.endsAt);
    expect(await prepaidCompanyAccess('company-a')).toBeNull();
    expect(await prepaidSupportAccess('support-a')).toBeNull();
    expect(await prepaidAutomationAccess('company-a')).toBeNull();
  });

  it('preserves paid access after cancellation but never grants the next period', async () => {
    const { period } = await paid();
    setNow(anchor + 20);
    await store().cancelRenewal(period.contractId);
    expect(await prepaidCompanyAccess('company-a')).toMatchObject({
      cancelAtPeriodEnd: true,
      paidUntil: period.endsAt,
    });
    setNow(period.endsAt);
    expect(await prepaidCompanyAccess('company-a')).toBeNull();
  });

  it('revokes all bundled products immediately and ignores delayed paid proof replay', async () => {
    const data = await paid();
    await store().revokeReconciledPeriod(data.period.periodId, 'b'.repeat(64));
    expect(await prepaidSubscriptionAccess(data.input.contractId)).toBeNull();
    expect(await prepaidCompanyAccess('company-a')).toBeNull();
    expect(await prepaidSupportAccess('support-a')).toBeNull();
    expect(await prepaidAutomationAccess('company-a')).toBeNull();
  });

  it('ignores overgenerous or expired legacy projection fields and returns the immutable paid snapshot', async () => {
    await paid('complet:solo');
    db.prepare(
      `UPDATE subscriptions SET status='canceled',entitlement_valid_until=0,current_period_end=0,seat_limit=9999,entitlement_plan_id='zentra-pro-monthly-89-chf'`,
    ).run();
    const value = await prepaidCompanyAccess('company-a');
    expect(value?.catalog).toMatchObject({
      priceChfMinor: 7900,
      gestion: { seats: 1, licensePriceChfMinor: 4900 },
      support: { analyses: 2000 },
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value?.catalog)).toBe(true);
    expect(Object.isFrozen(value?.catalog.gestion)).toBe(true);
    expect(Object.isFrozen(value?.catalog.support)).toBe(true);
    expect(Object.isFrozen(value?.catalog.includedProducts)).toBe(true);
  });

  it('requires the real organization subscription binding, not a same-owner stale company projection', async () => {
    const { input } = await paid();
    projection('sub_existing');
    db.prepare(
      `UPDATE organizations SET subscription_id='sub_existing' WHERE organization_id='company-a'`,
    ).run();
    expect(await prepaidSubscriptionAccess(input.contractId)).toBeNull();
    expect(await prepaidCompanyAccess('company-a')).toBeNull();
    expect(await prepaidSupportAccess('support-a')).toBeNull();
    expect(await prepaidAutomationAccess('company-a')).toBeNull();
  });

  it('requires contract ownership to equal the actual company owner', async () => {
    const { input } = await paid();
    db.prepare(`UPDATE organizations SET created_by_user_id='stranger'`).run();
    expect(await prepaidSubscriptionAccess(input.contractId)).toBeNull();
    expect(await prepaidCompanyAccess('company-a')).toBeNull();
    expect(await prepaidSupportAccess('support-a')).toBeNull();
    expect(await prepaidAutomationAccess('company-a')).toBeNull();
  });

  it('requires contract ownership to equal any explicitly bound workspace owner', async () => {
    const { input } = await paid();
    db.prepare(`UPDATE support_workspaces SET owner_id='stranger'`).run();
    expect(await prepaidSubscriptionAccess(input.contractId)).toBeNull();
    expect(await prepaidCompanyAccess('company-a')).toBeNull();
    expect(await prepaidSupportAccess('support-a')).toBeNull();
    expect(await prepaidAutomationAccess('company-a')).toBeNull();
  });

  it.each(['revoke', 'role', 'missing'])(
    'requires an active owner membership despite paid facts: %s',
    async (mode) => {
      const data = await paid();
      if (mode === 'revoke')
        db.prepare('UPDATE organization_members SET revoked_at=?').run(clock);
      else if (mode === 'role')
        db.prepare("UPDATE organization_members SET role='member'").run();
      else db.prepare('DELETE FROM organization_members').run();
      expect(await prepaidSubscriptionAccess(data.input.contractId)).toBeNull();
      expect(await prepaidCompanyAccess('company-a')).toBeNull();
      expect(await prepaidSupportAccess('support-a')).toBeNull();
      expect(await prepaidAutomationAccess('company-a')).toBeNull();
    },
  );

  it('requires a real Support/Gestion link for bundled Support, without denying the other paid products', async () => {
    await paid('complet:team', {}, false);
    expect(await prepaidCompanyAccess('company-a')).not.toBeNull();
    expect(await prepaidAutomationAccess('company-a')).not.toBeNull();
    expect(await prepaidSupportAccess('support-a')).toBeNull();
  });

  it('resolves bundled Support through an actual same-owner link when the contract has no workspace yet', async () => {
    const data = await paid('complet:team', { workspaceId: null }, false);
    workspace();
    link();
    expect(await prepaidSupportAccess('support-a')).toMatchObject({
      contractId: data.input.contractId,
      workspaceId: 'support-a',
    });
  });

  it('does not transfer a bundle quota through a link to another owner or changed workspace', async () => {
    await paid();
    workspace('foreign-support', 'stranger');
    db.prepare(
      `UPDATE support_gestion_links SET workspace_id='foreign-support'`,
    ).run();
    expect(await prepaidSupportAccess('foreign-support')).toBeNull();
    expect(await prepaidSupportAccess('support-a')).toBeNull();
  });

  it('does not interpret invoice-bridge enabled=0 as cancellation of already-paid Support', async () => {
    await paid();
    db.prepare('UPDATE support_gestion_links SET enabled=0').run();
    expect(await prepaidSupportAccess('support-a')).not.toBeNull();
  });

  it('grants standalone Support only to its workspace owner, with no Gestion or Automation seats', async () => {
    const data = await paid('support:business');
    expect(await prepaidSupportAccess('support-a')).toMatchObject({
      contractId: data.input.contractId,
      organizationId: null,
      customerName: 'Support fictif',
      catalog: {
        gestion: null,
        support: { analyses: 15000 },
        automation: false,
      },
    });
    expect(
      await prepaidSubscriptionAccess(data.input.contractId),
    ).not.toBeNull();
    expect(await prepaidCompanyAccess('company-a')).toBeNull();
    expect(await prepaidAutomationAccess('company-a')).toBeNull();
    db.prepare(`UPDATE support_workspaces SET owner_id='stranger'`).run();
    expect(await prepaidSupportAccess('support-a')).toBeNull();
  });

  it('returns a scoped paid Automation option but does not claim active Gestion', async () => {
    const data = await paid('automation');
    db.prepare('UPDATE subscriptions SET entitlement_valid_until=0').run();
    expect(await prepaidAutomationAccess('company-a')).toMatchObject({
      contractId: data.input.contractId,
      productKind: 'automation',
      catalog: { gestion: null, support: null, automation: true },
    });
    expect(
      await prepaidSubscriptionAccess(data.input.contractId),
    ).not.toBeNull();
    expect(await prepaidCompanyAccess('company-a')).toBeNull();
  });

  it.each(['support:starter', 'automation'])(
    'fails closed for two simultaneous paid %s contracts, without selecting the first',
    async (productKey) => {
      const first = await paid(productKey);
      const second = await paid(productKey);
      const getter =
        productKey === 'automation'
          ? () => prepaidAutomationAccess('company-a')
          : () => prepaidSupportAccess('support-a');
      expect(await getter()).toBeNull();
      expect(
        await prepaidSubscriptionAccess(first.input.contractId),
      ).toBeNull();
      expect(
        await prepaidSubscriptionAccess(second.input.contractId),
      ).toBeNull();
      await store().revokeReconciledPeriod(
        second.period.periodId,
        'b'.repeat(64),
      );
      expect(await getter()).toMatchObject({
        contractId: first.input.contractId,
      });
    },
  );

  it('fails closed for conflicting paid Gestion contracts rather than trusting the first organization projection', async () => {
    const first = await paid('gestion:solo');
    const second = await paid('gestion:pro');
    expect(await prepaidCompanyAccess('company-a')).toBeNull();
    expect(await prepaidSubscriptionAccess(first.input.contractId)).toBeNull();
    expect(await prepaidSubscriptionAccess(second.input.contractId)).toBeNull();
    await store().revokeReconciledPeriod(
      second.period.periodId,
      'b'.repeat(64),
    );
    expect(await prepaidCompanyAccess('company-a')).toMatchObject({
      contractId: first.input.contractId,
    });
  });

  it.each(['gestion:solo', 'support:team', 'automation'])(
    'does not conceal a conflicting raw current proof with an invalid calendar for %s',
    async (productKey) => {
      const data = await paid(productKey);
      const getter =
        productKey === 'automation'
          ? () => prepaidAutomationAccess('company-a')
          : productKey.startsWith('support:')
            ? () => prepaidSupportAccess('support-a')
            : () => prepaidCompanyAccess('company-a');
      expect(await getter()).not.toBeNull();
      const conflict = conflictingCurrentPeriod(data);
      expect(await getter()).toBeNull();
      expect(await prepaidSubscriptionAccess(data.input.contractId)).toBeNull();
      await store().revokeReconciledPeriod(conflict, 'b'.repeat(64));
      expect(await getter()).toMatchObject({
        contractId: data.input.contractId,
      });
    },
  );

  it('does not grant included pack products while its company coverage has conflicting paid facts', async () => {
    const data = await paid();
    const conflicting = await paid('gestion:solo');
    expect(await prepaidCompanyAccess('company-a')).toBeNull();
    expect(await prepaidSupportAccess('support-a')).toBeNull();
    expect(await prepaidAutomationAccess('company-a')).toBeNull();
    await store().revokeReconciledPeriod(
      conflicting.period.periodId,
      'b'.repeat(64),
    );
    expect(await prepaidSupportAccess('support-a')).toMatchObject({
      contractId: data.input.contractId,
    });
    expect(await prepaidAutomationAccess('company-a')).toMatchObject({
      contractId: data.input.contractId,
    });
  });

  it.each([
    { contractJson: '{bad-json' },
    { periodJson: '{bad-json' },
    { periodJson: 'x'.repeat(8193) },
    { catalogVersion: 'unknown-catalogue-v99' },
    { price: 1 },
    {
      periodJson: JSON.stringify({
        ...prepaidProduct('complet:team'),
        gestion: { ...prepaidProduct('complet:team')!.gestion, seats: 9999 },
      }),
    },
    { periodJson: JSON.stringify(prepaidProduct('complet:pro')) },
    {
      contractJson: JSON.stringify({
        ...prepaidProduct('complet:team'),
        unexpected: 'field',
      }),
    },
  ])(
    'denies malformed, unknown or conflicting catalogue facts: %j',
    async (overrides) => {
      const id = malformedPaid(overrides);
      expect(await prepaidSubscriptionAccess(id)).toBeNull();
      expect(await prepaidCompanyAccess('company-b')).toBeNull();
    },
  );

  it.each(['contractJson', 'periodJson'] as const)(
    'denies duplicate catalogue keys even if JSON.parse would keep the correct final value: %s',
    async (field) => {
      const product = prepaidProduct('complet:team')!;
      const duplicated = JSON.stringify(product).replace(
        '"priceChfMinor":9900',
        '"priceChfMinor":1,"priceChfMinor":9900',
      );
      expect(JSON.parse(duplicated)).toEqual(product);
      const id = malformedPaid({ [field]: duplicated });
      expect(await prepaidSubscriptionAccess(id)).toBeNull();
      expect(await prepaidCompanyAccess('company-b')).toBeNull();
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM prepaid_current_company_rights WHERE organization_id='company-b'`,
          )
          .get(),
      ).toMatchObject({ count: 0 });
    },
  );

  it.each([
    { ordinal: 1 },
    { startsAt: anchor - 1 },
    { endsAt: anchor + 86400 },
    { transactionOrigin: 'https://app-wallee.com' },
    { transactionSpace: 406 },
    { evidence: 'not-a-proof-fingerprint' },
    { reconciledAt: anchor + 1 },
  ])('denies malformed period or proof provenance: %j', async (overrides) => {
    const id = malformedPaid(overrides);
    expect(await prepaidSubscriptionAccess(id)).toBeNull();
    expect(await prepaidCompanyAccess('company-b')).toBeNull();
  });

  it.each(['support:starter', 'automation'])(
    'fails closed when a paid pack and paid %s option overlap for the same product',
    async (productKey) => {
      await paid();
      await paid(productKey);
      expect(await prepaidCompanyAccess('company-a')).not.toBeNull();
      if (productKey === 'automation')
        expect(await prepaidAutomationAccess('company-a')).toBeNull();
      else expect(await prepaidSupportAccess('support-a')).toBeNull();
    },
  );

  it('does not allow a TEST duplicate to hide a legitimate production contract', async () => {
    const production = await paid('support:team');
    await paid('support:team', { environment: 'TEST' });
    expect(await prepaidSupportAccess('support-a')).toMatchObject({
      contractId: production.input.contractId,
    });
  });

  it('never queries Stripe, writes state, or trusts a fake Stripe identity', async () => {
    await paid();
    readQueries = [];
    expect(isPrepaidContractId('sub_fictional')).toBe(false);
    expect(await prepaidSubscriptionAccess('sub_fictional')).toBeNull();
    expect(readQueries).toHaveLength(0);
    expect(isPrepaidContractId('pfp_BAD')).toBe(true);
    expect(await prepaidSubscriptionAccess('pfp_BAD')).toBeNull();
    expect(readQueries).toHaveLength(0);
    await prepaidCompanyAccess('company-a');
    await prepaidSupportAccess('support-a');
    await prepaidAutomationAccess('company-a');
    expect(readQueries.every((query) => query.startsWith('SELECT '))).toBe(
      true,
    );
    expect(
      readQueries.every(
        (query) => !query.includes('ORDER BY') && !query.includes('LIMIT 1'),
      ),
    ).toBe(true);
  });

  it.each([
    '',
    'unknown',
    'pfp_BAD',
    'pfp_00000000-0000-4000-8000-000000000000',
    '\u0000bad',
  ])('denies missing or invalid identities %s', async (id) => {
    expect(await prepaidSubscriptionAccess(id)).toBeNull();
    expect(await prepaidCompanyAccess(id)).toBeNull();
    expect(await prepaidSupportAccess(id)).toBeNull();
    expect(await prepaidAutomationAccess(id)).toBeNull();
  });
});
