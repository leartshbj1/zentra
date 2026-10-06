import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const runtime = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/runtime', () => ({ database: () => runtime.db, runtimeValue: () => '', stripeConfiguration: () => ({ secretKey: '', siteUrl: 'https://zentra.example.test', siteOriginAliases: '', priceIds: {}, signingKey: '' }) }));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => null }));
vi.mock('@/lib/site-language-server', () => ({ currentSiteLanguage: () => 'fr' }));
import { LEGAL_VERSION } from '@/lib/legal';
import { SUPPORT_LEGAL_VERSION } from '@/lib/support/plans';
import { COMPLETE_TERMS_VERSION } from '@/lib/complete/plans';
import { prepaidCatalog, prepaidProduct } from './prepaid-catalog';
import { prepareInitialPrepaidPurchase, type PrepaidPurchaseConfiguration } from './prepaid-purchase-preparation';
import { D1PrepaidPeriods } from './prepaid-periods';
import { D1PurchaseIntents } from './purchase-intents';
import { D1PostFinanceWebhookInbox } from './postfinance-store';
import { D1PrepaidProvisioning } from './prepaid-provisioning';
import { D1PrepaidReconciliationStore } from './prepaid-reconciliation-store';
import { cancelPrepaidRenewal } from './prepaid-cancellation';
import { ownedPrepaidReceipt, OWNED_PREPAID_RECEIPT_SQL } from './prepaid-receipt';
import { prepaidReceiptPath } from './prepaid-receipt-types';
import { runPostFinanceReceipt } from './postfinance-receipt-route';
import type { ZentraUser } from '@/app/zentra-auth';

let sql: DatabaseSync, clock: number, network: ReturnType<typeof vi.spyOn>;
const user: ZentraUser = { userId: 'receipt-owner', email: 'owner@example.test', emailConfirmed: true, provider: 'supabase', displayName: 'Fixture Owner', fullName: null };
const site = 'https://zentra.example.test', origin = 'https://checkout.postfinance.ch';
function d1(readOnly = false) {
  return {
    prepare(query: string) {
      if (readOnly && !/^\s*SELECT\b/i.test(query)) throw Error('Receipt must remain SELECT-only.');
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...items: SQLInputValue[]) { values = items; return statement; },
        execute() { if (readOnly) throw Error('No receipt writes.'); return { success: true, meta: sql.prepare(query).run(...values) }; },
        async run() { return statement.execute(); },
        async first() { return sql.prepare(query).get(...values) ?? null; },
        async all() { return { success: true, results: sql.prepare(query).all(...values) }; },
      };
      return statement;
    },
    async batch(statements: { execute(): unknown }[]) {
      if (readOnly) throw Error('No receipt batch.');
      sql.exec('BEGIN'); try { const results = statements.map(statement => statement.execute()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  } as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}
const configuration = (environment: 'TEST' | 'PRODUCTION'): PrepaidPurchaseConfiguration => ({
  enabled: true, settlementEvidenceVerified: true, connectorConfigurations: { postfinance_pay: 92 },
  connection: { enabled: true, merchantApproved: true, prepaidFeatureEnabled: true, chargeFlowEnabled: true, postfinancePayTokenEnabled: true, prepaidEnvironment: environment, apiOrigin: origin, spaceId: 405, applicationUserId: '512', authenticationKeyBase64: Buffer.alloc(32, 0x5a).toString('base64'), returnOrigin: site,
    prepaidProducts: Object.fromEntries(prepaidCatalog().map(product => [product.productKey, { currency: 'CHF', billingPeriod: 'P1M', priceChfMinor: product.priceChfMinor, reference: product.catalogVersion, name: product.name, methodConfigurations: { postfinance_pay: 91 } }])) },
});
async function prepare(key = 'gestion:solo', environment: 'TEST' | 'PRODUCTION' = 'PRODUCTION') {
  const product = prepaidProduct(key)!;
  const result = await prepareInitialPrepaidPurchase(configuration(environment), {
    user, requestId: '11111111-1111-4111-8111-111111111111', productKey: key,
    organizationId: product.productKind === 'support' ? undefined : 'company-b', workspaceId: product.support ? 'workspace-b' : undefined,
    method: 'postfinance_pay', acceptTerms: true, legalVersion: product.productKind === 'gestion' ? LEGAL_VERSION : product.productKind === 'support' ? SUPPORT_LEGAL_VERSION : COMPLETE_TERMS_VERSION,
  }, { database: () => d1(), now: () => clock });
  if (result.state !== 'prepared') throw Error('Missing fixture purchase.');
  return result;
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
async function bound(prepared: Prepared) {
  const journal = new D1PurchaseIntents(d1(), () => clock);
  await journal.markDispatched(prepared.intent);
  await new D1PrepaidPeriods(d1(), () => clock).bindTransaction(prepared.period.periodId, 71);
  await journal.bindProviderReference(prepared.intent, '71');
  const inbox = new D1PostFinanceWebhookInbox(d1(), { apiOrigin: origin, spaceId: 405, listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }] }, () => clock);
  await inbox.acceptOnce(`${origin}|405|10|1`, { eventId: 1, entityId: 71, spaceId: 405, webhookListenerId: 10, listenerEntityId: 20, listenerEntityTechnicalName: 'Transaction', timestamp: new Date(clock * 1000).toISOString() });
  const work = await inbox.claimNext(); if (!work) throw Error('Missing fixture lease.');
  const proof = { periodId: prepared.period.periodId, transactionId: 71, invoiceId: 81, apiOrigin: origin, spaceId: 405, environment: prepared.contract.environment, ownerId: user.userId, organizationId: prepared.contract.organizationId, workspaceId: prepared.contract.workspaceId, startsAt: prepared.period.startsAt, endsAt: prepared.period.endsAt, currency: 'CHF' as const, priceChfMinor: prepared.period.priceChfMinor, catalogVersion: prepared.period.catalogVersion, evidenceFingerprint: 'a'.repeat(64) };
  return { proof, work };
}
async function paid(prepared: Prepared) {
  const { proof, work } = await bound(prepared);
  await new D1PrepaidProvisioning(d1(), () => clock).provision(proof, work);
}
const snapshot = () => JSON.stringify(sql.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
  if (typeof name !== 'string') throw Error('Invalid fixture table name.');
  return [name, sql.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()];
}));
async function read(prepared: Prepared, actor = user, extra: Parameters<typeof ownedPrepaidReceipt>[2] = {}) {
  const before = snapshot(); runtime.db = d1(true);
  const result = await ownedPrepaidReceipt(actor, prepared.intent.intentId, { database: () => d1(true), now: () => clock, ...extra });
  expect(snapshot()).toBe(before); runtime.db = d1(); return result;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); clock = Date.parse('2026-10-06T10:11:12Z') / 1000; vi.setSystemTime(clock * 1000);
  sql = new DatabaseSync(':memory:'); sql.exec('PRAGMA foreign_keys=ON'); sql.function('unixepoch', () => clock);
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'));
  for (const id of ['a', 'b']) {
    sql.prepare("INSERT INTO subscriptions(subscription_id,customer_id,price_id,plan_id,status,current_period_end,entitlement_valid_until,livemode,updated_at) VALUES(?,?,?,'zentra-solo-monthly-49-chf','incomplete',0,0,1,?)").run(`old-${id}`, `customer-${id}`, 'price-fixture', clock);
    sql.prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)').run(`company-${id}`, `Entreprise ${id.toUpperCase()}`, `old-${id}`, user.userId, clock, clock);
    sql.prepare("INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at) VALUES(?,?,?,?,?,'owner',?)").run(`owner-${id}`, `company-${id}`, user.userId, user.email, user.displayName, clock);
  }
  sql.prepare('INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('workspace-b', user.userId, 'Support B', clock, clock);
  runtime.db = d1(); network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('No receipt transport.'); });
});
afterEach(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); sql.close(); vi.useRealTimers(); });

describe('owner-scoped read-only PostFinance receipts', () => {
  it('preserves the actual company B, not the owner’s first company A', async () => {
    const prepared = await prepare(); const result = await read(prepared);
    expect(result).toMatchObject({ status: 'pending', organization: { id: 'company-b', name: 'Entreprise B' }, paidUntil: null, canCancel: false, poll: true });
    expect(result?.subscriptionHref).toBe('/compte/abonnement?organizationId=company-b');
  });
  it.each(['other-owner', 'collaborator'])('hides the receipt from %s', async userId => {
    const prepared = await prepare(); expect(await read(prepared, { ...user, userId })).toBeNull();
  });
  it('hides revoked ownership', async () => {
    const prepared = await prepare(); sql.prepare('UPDATE organization_members SET revoked_at=? WHERE membership_id=?').run(clock, 'owner-b'); expect(await read(prepared)).toBeNull();
  });
  it('hides a deleted account even with a formerly verified identity', async () => {
    const prepared = await prepare(); sql.prepare('INSERT INTO account_session_policy(user_id,revoked_before,deleted_at) VALUES(?,?,?)').run(user.userId, clock, clock); expect(await read(prepared)).toBeNull();
  });
  it('hides a Support workspace owned by someone else', async () => {
    const prepared = await prepare('support:starter'); sql.prepare('UPDATE support_workspaces SET owner_id=? WHERE id=?').run('other', 'workspace-b'); expect(await read(prepared)).toBeNull();
  });
  it('keeps an uncertain payment pending beyond its reservation TTL', async () => {
    const prepared = await prepare(); const journal = new D1PurchaseIntents(d1(), () => clock);
    await journal.markDispatched(prepared.intent); await journal.markUncertain(prepared.intent);
    clock += 86400; vi.setSystemTime(clock * 1000); expect(await read(prepared)).toMatchObject({ status: 'verification_required', paidUntil: null, poll: true });
  });
  it('shows an active genuine Gestion entitlement only after closed settlement', async () => {
    const prepared = await prepare(); await paid(prepared);
    expect(await read(prepared)).toMatchObject({ status: 'active', canCancel: true, contractId: prepared.contract.contractId, paidUntil: prepared.period.endsAt, purchasedPeriod: { from: prepared.period.startsAt, until: prepared.period.endsAt }, poll: false });
  });
  it('distinguishes recorded payment from a yet unfinished handoff', async () => {
    const prepared = await prepare(); const { proof, work } = await bound(prepared);
    await new D1PrepaidReconciliationStore(d1(), () => clock).recordPaid(proof, work);
    expect(await read(prepared)).toMatchObject({ status: 'activation_pending', paidUntil: null, canCancel: false, poll: true });
  });
  it('keeps a genuine reversal visible even if old projected paid dates remain', async () => {
    const prepared = await prepare(); await paid(prepared);
    const inbox = new D1PostFinanceWebhookInbox(d1(), { apiOrigin: origin, spaceId: 405, listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }] }, () => clock);
    await inbox.acceptOnce(`${origin}|405|10|2`, { eventId: 2, entityId: 71, spaceId: 405, webhookListenerId: 10, listenerEntityId: 20, listenerEntityTechnicalName: 'Transaction', timestamp: new Date(clock * 1000).toISOString() });
    const work = await inbox.claimNext(); if (!work) throw Error('Missing reversal lease.');
    const records = new D1PrepaidReconciliationStore(d1(), () => clock); const target = await records.target(origin, 405, 71);
    if (!target) throw Error('Missing reversal target.');
    await records.recordReversal(target, 'b'.repeat(64), work);
    expect(await read(prepared)).toMatchObject({ status: 'refunded', paidUntil: null, purchasedPeriod: { until: prepared.period.endsAt }, canCancel: true });
  });
  it('shows genuine Support without inventing a Gestion company', async () => {
    const prepared = await prepare('support:starter'); await paid(prepared);
    expect(await read(prepared)).toMatchObject({ status: 'active', organization: null, workspace: { id: 'workspace-b', name: 'Support B' } });
  });
  it('checks every pack entitlement before calling Complet active', async () => {
    const prepared = await prepare('complet:team'); await paid(prepared);
    expect(await read(prepared)).toMatchObject({ status: 'active' });
    expect(await read(prepared, user, { support: async () => null })).toMatchObject({ status: 'verification_required', paidUntil: null });
    expect(await read(prepared, user, { automation: async () => false })).toMatchObject({ status: 'verification_required', paidUntil: null });
  });
  it('never calls a TEST receipt an active paid account', async () => {
    const prepared = await prepare('gestion:solo', 'TEST');
    const access = vi.fn(); expect(await read(prepared, user, { access })).toMatchObject({ environment: 'TEST', status: 'pending', paidUntil: null, canCancel: false }); expect(access).not.toHaveBeenCalled();
  });
  it('does not relabel an expired paid period as an unpaid purchase', async () => {
    const prepared = await prepare(); await paid(prepared); clock = prepared.period.endsAt; vi.setSystemTime(clock * 1000);
    expect(await read(prepared)).toMatchObject({ status: 'ended', paidUntil: null, purchasedPeriod: { until: prepared.period.endsAt }, canCancel: true });
  });
  it('stopping renewal preserves current paid access', async () => {
    const prepared = await prepare(); await paid(prepared); await cancelPrepaidRenewal(d1(), user, prepared.contract.contractId, clock);
    expect(await read(prepared)).toMatchObject({ status: 'active', cancelAtPeriodEnd: true, canCancel: false, paidUntil: prepared.period.endsAt });
  });
  it('refuses a new mismatched company link instead of retargeting the receipt', async () => {
    const prepared = await prepare('support:starter'); await paid(prepared);
    sql.prepare('INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at) VALUES(?,?,?,?)').run('workspace-b', 'company-a', user.userId, clock);
    expect(await read(prepared)).toBeNull();
  });
  it('does not expose internal parameters, merchant IDs, e-mails or fingerprints', async () => {
    const prepared = await prepare(); await paid(prepared); const result = JSON.stringify(await read(prepared));
    for (const value of [user.email, 'evidence_fingerprint', 'provider_scope', 'customerReference', 'authenticationKeyBase64', origin]) expect(result).not.toContain(value);
  });
  it('uses an indexed intent lookup on the complete schema', async () => {
    const prepared = await prepare(); const plan = sql.prepare(`EXPLAIN QUERY PLAN ${OWNED_PREPAID_RECEIPT_SQL}`).all(prepared.intent.intentId, user.userId);
    expect(JSON.stringify(plan)).toMatch(/SEARCH i USING INDEX/);
  });
});

describe('receipt HTTP and return admission', () => {
  it('requires an authenticated confirmed browser identity, independently of purchase flags', async () => {
    const receipt = vi.fn(); const result = await runPostFinanceReceipt(new Request(site + '/api/payments/postfinance/receipt?achat=none'), { user: async () => null, receipt });
    expect(result.status).toBe(401); expect(receipt).not.toHaveBeenCalled(); expect(result.headers.get('Cache-Control')).toContain('no-store');
  });
  it.each(['?achat=bad', '?achat=purchase_11111111-1111-4111-8111-111111111111&achat=x', '?achat=purchase_11111111-1111-4111-8111-111111111111&organizationId=company-a'])('rejects ambiguous or forged pointers %s', async search => {
    const receipt = vi.fn(); const response = await runPostFinanceReceipt(new Request(site + '/api/payments/postfinance/receipt' + search), { user: async () => user, receipt });
    expect(response.status).toBe(404); expect(receipt).not.toHaveBeenCalled();
  });
  it('serves a genuine owned receipt with private/no-store headers', async () => {
    const prepared = await prepare(); await paid(prepared); runtime.db = d1(true); const before = snapshot();
    const result = await runPostFinanceReceipt(new Request(site + '/api/payments/postfinance/receipt?achat=' + prepared.intent.intentId), { user: async () => user });
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ status: 'active', organization: { id: 'company-b' } }); expect(result.headers.get('Vary')).toBe('Cookie'); expect(snapshot()).toBe(before);
  });
  it('preserves the exact purchase in the sign-in return, without outcome or target overrides', () => {
    expect(prepaidReceiptPath('purchase_11111111-1111-4111-8111-111111111111')).toBe('/compte/paiement?achat=purchase_11111111-1111-4111-8111-111111111111');
    for (const input of ['https://evil.test', ['valid', 'other'], undefined]) expect(prepaidReceiptPath(input)).toBe('/compte/paiement');
  });
});
