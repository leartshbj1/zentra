import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { ZentraUser } from '@/app/zentra-auth';
import { D1PrepaidPeriods, type PrepaidContractInput, type PrepaidPeriod } from './prepaid-periods';
import { prepaidSupportAccess } from './prepaid-access';
import { SUPPORT_WORKSPACES_SQL } from '@/lib/support/workspace-access';
import { selectSupportWorkspace } from '@/lib/support/workspace-selection';
import { billingState, requireSupportSubscription } from '@/lib/support/billing';
import { mutateWorkspace } from '@/lib/support/service';
import { startAccountTrial } from '@/lib/account-trial';

const fixture = vi.hoisted(() => ({database: null as unknown, user: null as ZentraUser | null}));
vi.mock('@/lib/runtime', () => ({
  database: () => fixture.database,
  runtimeValue: () => '',
  stripeConfiguration: () => ({secretKey: '', testMode: '', priceIds: {}, signingKey: ''}),
}));
vi.mock('@/app/zentra-auth', () => ({getZentraUser: async () => fixture.user}));
vi.mock('@/lib/site-language-server', () => ({currentSiteLanguage: () => 'fr'}));
vi.mock('@/lib/site-url', () => ({publicSiteUrl: () => 'https://zentra.example.test'}));

let db: DatabaseSync, clock: number, serial: number;
let network: ReturnType<typeof vi.spyOn>;
const anchor = Date.parse('2026-10-06T10:11:12Z') / 1000;
type Member = {id: string; role?: string; offset?: number};
type Binding = {input: PrepaidContractInput; period: PrepaidPeriod; transactionId: number; invoiceId: number};

function d1() {
  return {prepare(query: string) {
    let values: SQLInputValue[] = [];
    const statement = {
      bind(...args: SQLInputValue[]) { values = args; return statement; },
      async first() { return db.prepare(query).get(...values) ?? null; },
      async all() { return {results: db.prepare(query).all(...values)}; },
      async run() { return {success: true, meta: db.prepare(query).run(...values)}; },
    };
    return statement;
  }, async batch(statements: {run(): Promise<unknown>}[]) {
    db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      db.exec('COMMIT'); return results;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }} as unknown as D1Database;
}
const store = () => new D1PrepaidPeriods(d1(), () => clock);
function at(seconds: number) { clock = seconds; vi.setSystemTime(seconds * 1000); }
function rows(userId: string) {
  return db.prepare(SUPPORT_WORKSPACES_SQL).all(userId, `${userId}@example.test`, userId, userId) as {id: string; role: string}[];
}
const roles = (userId: string) => rows(userId).map(row => ({id: row.id, role: row.role}));
const workspace = (binding: Binding) => ({id: binding.input.workspaceId!, owner_id: binding.input.ownerId});

async function company(members: Member[] = [{id: 'admin', role: 'admin'}, {id: 'accountant', role: 'accountant'}, {id: 'overflow'}],
  options: {owner?: string; organization?: string; workspace?: string; product?: string; environment?: 'TEST' | 'PRODUCTION'; freezeWorkspace?: boolean} = {}) {
  const number = ++serial, owner = options.owner ?? `owner-${number}`;
  const organizationId = options.organization ?? `company-${number}`, workspaceId = options.workspace ?? `workspace-${number}`;
  const contractId = `pfp_00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  // Existing company members may outnumber a later purchased plan. Build that
  // legitimate history before switching the projection, without dropping guards.
  db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at)
    VALUES(?,?,'fixture-local','incomplete',0,1,?)`).run(`sub_seed_${number}`, `sub_seed_${number}`, clock);
  db.prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)').run(organizationId, `Company ${number}`, `sub_seed_${number}`, owner, clock, clock);
  [{id: owner, role: 'owner', offset: 999}, ...members].forEach((member, index) => {
    db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
      VALUES(?,?,?,?,?,?)`).run(`member-${number}-${index}`, organizationId, member.id,
      `${member.id}@example.test`, member.role ?? 'member', clock + (member.offset ?? index));
  });
  db.prepare(`INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)`)
    .run(workspaceId, owner, `Workspace ${number}`, clock + number, clock);
  db.prepare('INSERT INTO support_gestion_links VALUES(?,?,1,0,?,?)').run(workspaceId, organizationId, owner, clock);
  db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,seat_limit,
    entitlement_valid_until,last_paid_invoice_id,livemode,updated_at)
    VALUES(?,?,'fixture-local','active',?,NULL,?,'misleading-cache',1,?)`).run(contractId, contractId, clock + 999999, clock + 999999, clock);
  db.prepare('UPDATE organizations SET subscription_id=? WHERE organization_id=?').run(contractId, organizationId);
  const input: PrepaidContractInput = {contractId, ownerId: owner, organizationId,
    workspaceId: options.freezeWorkspace === false ? null : workspaceId,
    apiOrigin: 'https://checkout.postfinance.ch', spaceId: 405, environment: options.environment ?? 'PRODUCTION', productKey: options.product ?? 'complet:team'};
  await store().createContract(input);
  const period = await store().reservePeriod(contractId, 0);
  await store().bindTransaction(period.periodId, 70 + number);
  return {input, period, transactionId: 70 + number, invoiceId: 80 + number} satisfies Binding;
}
async function settle(binding: Binding) {
  await store().recordReconciledSettlement({periodId: binding.period.periodId, transactionId: binding.transactionId,
    invoiceId: binding.invoiceId, apiOrigin: binding.input.apiOrigin, spaceId: binding.input.spaceId,
    environment: binding.input.environment, ownerId: binding.input.ownerId,
    organizationId: binding.input.organizationId, workspaceId: binding.input.workspaceId,
    startsAt: binding.period.startsAt, endsAt: binding.period.endsAt, currency: 'CHF',
    priceChfMinor: binding.period.priceChfMinor, catalogVersion: binding.period.catalogVersion,
    evidenceFingerprint: 'a'.repeat(64)});
}
function legacyCompleteProjection(binding: Binding) {
  db.prepare(`INSERT INTO complete_subscriptions(subscription_id,plan_id,paid_plan_id,paid_from,paid_until,last_paid_invoice_id)
    VALUES(?,'pro','pro',?,?,'misleading-cache')`).run(binding.input.contractId, clock, clock + 999999);
}
async function settings(binding: Binding, userId: string, name: string) {
  fixture.user = {userId, email: `${userId}@example.test`, displayName: userId, fullName: userId, emailConfirmed: true, provider: 'supabase'};
  return mutateWorkspace(new Request('https://zentra.example.test/api/support', {method: 'POST',
    headers: {'Origin': 'https://zentra.example.test', 'Content-Type': 'application/json'},
    body: JSON.stringify({action: 'settings', workspaceId: binding.input.workspaceId, name,
      mode: 'review', threshold: 85, baselineSeconds: 60})}));
}

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']}); at(anchor); serial = 0;
  db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); db.function('unixepoch', () => clock);
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url)).filter(file => file.endsWith('.sql')).sort())
    db.exec(readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'));
  fixture.database = d1(); fixture.user = null;
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {throw new Error('No merchant or external HTTP allowed.');});
});
afterEach(() => {expect(network).not.toHaveBeenCalled(); network.mockRestore(); db.close(); vi.useRealTimers();});

describe('Support discovery from current PF Complet proof and paid company seats', () => {
  it('keeps owner billing navigation before payment but grants neither collaborators nor commercial access', async () => {
    const binding = await company();
    expect(roles(binding.input.ownerId)).toEqual([{id: binding.input.workspaceId, role: 'owner'}]);
    expect(rows('admin')).toEqual([]);
    expect(await prepaidSupportAccess(binding.input.workspaceId!)).toBeNull();
    expect(await billingState(workspace(binding))).toMatchObject({active: false, ready: false});
    await expect(requireSupportSubscription(workspace(binding))).rejects.toMatchObject({status: 402});
    expect(db.prepare('SELECT COUNT(*) AS n FROM complete_subscriptions').get()?.n).toBe(0);
  });
  it('discovers paid admin and accountant using snapshot seats without any legacy Complete projection', async () => {
    const binding = await company(); await settle(binding);
    expect(roles('admin')).toEqual([{id: binding.input.workspaceId, role: 'admin'}]);
    expect(roles('accountant')).toEqual([{id: binding.input.workspaceId, role: 'member'}]);
    expect(rows('overflow')).toEqual([]);
    db.prepare('UPDATE subscriptions SET seat_limit=999999 WHERE subscription_id=?').run(binding.input.contractId);
    expect(rows('overflow')).toEqual([]);
    db.prepare('UPDATE subscriptions SET seat_limit=0 WHERE subscription_id=?').run(binding.input.contractId);
    expect(roles('admin')).toEqual([{id: binding.input.workspaceId, role: 'admin'}]);
    expect(await prepaidSupportAccess(binding.input.workspaceId!)).not.toBeNull();
    await expect(requireSupportSubscription(workspace(binding))).resolves.toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM complete_subscriptions').get()?.n).toBe(0);
  });
  it('counts read-only and unknown roles before assigning seats and gives the actual owner first place', async () => {
    const binding = await company([{id: 'reader', role: 'read_only'}, {id: 'custom', role: 'historical_custom'}, {id: 'admin', role: 'admin'}]);
    await settle(binding);
    for (const id of ['reader','custom','admin']) expect(rows(id)).toEqual([]);
    expect(roles(binding.input.ownerId)).toEqual([{id: binding.input.workspaceId, role: 'owner'}]);
  });
  it.each(['absent','TEST','expired','reversed','owner-revoked','owner-changed','workspace-owner-changed','link-missing','Gestion-only'])(
    'a misleading legacy Complete row cannot expose PF company members when proof is %s', async mode => {
      const binding = await company(undefined, {environment: mode === 'TEST' ? 'TEST' : 'PRODUCTION', product: mode === 'Gestion-only' ? 'gestion:start' : 'complet:team'});
      if (mode !== 'absent') await settle(binding);
      legacyCompleteProjection(binding);
      if (mode === 'expired') at(binding.period.endsAt);
      if (mode === 'reversed') db.prepare('INSERT INTO prepaid_provider_reversals VALUES(?,?,?)').run(binding.period.periodId, 'b'.repeat(64), clock);
      if (mode === 'owner-revoked') db.prepare('UPDATE organization_members SET revoked_at=? WHERE organization_id=? AND user_id=?').run(clock, binding.input.organizationId, binding.input.ownerId);
      if (mode === 'owner-changed') db.prepare('UPDATE organizations SET created_by_user_id=? WHERE organization_id=?').run('another-owner', binding.input.organizationId);
      if (mode === 'workspace-owner-changed') db.prepare('UPDATE support_workspaces SET owner_id=? WHERE id=?').run('another-owner', binding.input.workspaceId);
      if (mode === 'link-missing') db.prepare('DELETE FROM support_gestion_links WHERE workspace_id=?').run(binding.input.workspaceId);
      expect(rows('admin')).toEqual([]); expect(rows('accountant')).toEqual([]);
    },
  );
  it.each(['fingerprint','future-proof','ambiguous-period'])('rejects malformed or ambiguous %s with real immutable audit tables', async mode => {
    const binding = await company();
    if (mode === 'ambiguous-period') {
      await settle(binding);
      const periodId = `pfperiod_${'f'.repeat(64)}`;
      db.prepare(`INSERT INTO prepaid_periods VALUES(?,?,1,?,?,'CHF',?,?,?,?)`).run(periodId, binding.input.contractId,
        binding.period.startsAt, binding.period.endsAt, binding.period.priceChfMinor, binding.period.catalogVersion,
        JSON.stringify(binding.period.catalog), clock);
      db.prepare('INSERT INTO prepaid_transactions VALUES(?,?,?,?,?)').run(periodId, binding.input.apiOrigin, 405, 999, clock);
      db.prepare('INSERT INTO prepaid_settlement_proofs VALUES(?,?,?,?)').run(periodId, 998, 'c'.repeat(64), clock);
    } else {
      db.prepare('INSERT INTO prepaid_settlement_proofs VALUES(?,?,?,?)').run(binding.period.periodId, binding.invoiceId,
        mode === 'fingerprint' ? 'not-a-payment-proof' : 'c'.repeat(64), mode === 'future-proof' ? clock + 1 : clock);
    }
    legacyCompleteProjection(binding);
    expect(rows('admin')).toEqual([]);
    expect(await prepaidSupportAccess(binding.input.workspaceId!)).toBeNull();
  });
  it('allows a correctly owned linked workspace when the immutable contract has no explicit workspace ID', async () => {
    const binding = await company(undefined, {freezeWorkspace: false}); await settle(binding);
    expect(roles('admin')).toEqual([{id: 'workspace-1', role: 'admin'}]);
    expect(await prepaidSupportAccess('workspace-1')).not.toBeNull();
  });
  it.each(['refund','expiry'])('real service access closes on %s instead of accepting the earlier discovered role', async mode => {
    const binding = await company(); await settle(binding);
    expect((await settings(binding, 'admin', 'Before revocation')).status).toBe(200);
    if (mode === 'refund') db.prepare('INSERT INTO prepaid_provider_reversals VALUES(?,?,?)').run(binding.period.periodId, 'b'.repeat(64), clock);
    else at(binding.period.endsAt);
    await expect(settings(binding, 'admin', 'Must not be saved')).rejects.toMatchObject({status: 404});
    expect(db.prepare('SELECT name FROM support_workspaces WHERE id=?').get(binding.input.workspaceId!)?.name).toBe('Before revocation');
  });
  it('excludes revoked collaborator membership and does not promote a paid member to admin', async () => {
    const binding = await company([{id: 'member'}, {id: 'admin', role: 'admin'}]); await settle(binding);
    expect(roles('member')).toEqual([{id: binding.input.workspaceId, role: 'member'}]);
    await expect(settings(binding, 'member', 'Forbidden')).rejects.toMatchObject({status: 403});
    db.prepare('UPDATE organization_members SET revoked_at=? WHERE organization_id=? AND user_id=?').run(clock, binding.input.organizationId, 'admin');
    expect(rows('admin')).toEqual([]);
  });
  it('preserves workspace choices and never substitutes another paid company for an inaccessible target', async () => {
    const first = await company([{id: 'shared', role: 'admin'}]); await settle(first);
    const second = await company([{id: 'shared', role: 'member'}]); await settle(second);
    const unpaid = await company([{id: 'shared', role: 'admin'}]);
    expect(roles('shared')).toEqual([{id: first.input.workspaceId, role: 'admin'}, {id: second.input.workspaceId, role: 'member'}]);
    const available = rows('shared');
    expect(selectSupportWorkspace(available, second.input.workspaceId, second.input.organizationId, [{workspace_id: second.input.workspaceId!}])?.id).toBe(second.input.workspaceId);
    expect(selectSupportWorkspace(available, null, unpaid.input.organizationId, [{workspace_id: unpaid.input.workspaceId!}])).toBeUndefined();
    expect(selectSupportWorkspace(available, first.input.workspaceId, second.input.organizationId, [{workspace_id: second.input.workspaceId!}])).toBeUndefined();
    expect(rows('stranger')).toEqual([]);
  });
  it('preserves explicit Support roles and owner discovery independently of company payment', async () => {
    const binding = await company();
    db.prepare('INSERT INTO support_members VALUES(?,?,?,?,?)').run('direct-access', binding.input.workspaceId, 'direct@example.test', 'read_only', clock);
    expect(roles('direct')).toEqual([{id: binding.input.workspaceId, role: 'read_only'}]);
    expect(roles(binding.input.ownerId)).toEqual([{id: binding.input.workspaceId, role: 'owner'}]);
    await expect(requireSupportSubscription(workspace(binding))).rejects.toMatchObject({status: 402});
  });
  it('preserves the existing Complete trial path with the real trial provisioning and expiry', async () => {
    const trial = await startAccountTrial({userId: 'trial-owner', email: 'trial-owner@example.test', displayName: 'Trial'}, 'Trial company', true);
    const linked = db.prepare('SELECT workspace_id FROM support_gestion_links WHERE organization_id=?').get(trial.organization_id)!;
    db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
      VALUES('trial-admin-member',?,'trial-admin','trial-admin@example.test','admin',?)`).run(trial.organization_id, clock + 1);
    expect(roles('trial-admin')).toEqual([{id: linked.workspace_id, role: 'admin'}]);
    const target = {id: String(linked.workspace_id), owner_id: 'trial-owner'};
    await expect(requireSupportSubscription(target)).resolves.toBeUndefined();
    at(trial.ends_at);
    expect(rows('trial-admin')).toEqual([]);
    await expect(requireSupportSubscription(target)).rejects.toMatchObject({status: 402});
  });
  it('preserves a standalone founder Support offer and its owner navigation without any PF projection', async () => {
    db.prepare('INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run('founder-workspace', 'founder-user', 'Offered Support', clock, clock);
    db.prepare(`INSERT INTO founder_support_grants(email,grant_id,user_id,workspace_id,plan_id,valid_from,valid_until,
      revoked_at,revision,note,created_at,updated_at,last_operation_id) VALUES(?,?,?,?,?,?,?,NULL,1,'',?,?,?)`)
      .run('founder-user@example.test','fixture-offer','founder-user','founder-workspace','team',clock,clock + 86400,clock,clock,'fixture-operation');
    const target = {id: 'founder-workspace', owner_id: 'founder-user'};
    expect(roles('founder-user')).toEqual([{id: target.id, role: 'owner'}]);
    expect(await billingState(target)).toMatchObject({active: true, offeredAccess: true});
    await expect(requireSupportSubscription(target)).resolves.toBeUndefined();
    at(clock + 86400);
    expect(roles('founder-user')).toEqual([{id: target.id, role: 'owner'}]);
    await expect(requireSupportSubscription(target)).rejects.toMatchObject({status: 402});
  });
});
