import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  database: null as unknown,
  signingKey: '',
  runtimeValue: vi.fn(() => ''),
  offered: vi.fn(), trial: vi.fn(), transition: vi.fn(),
  paid: vi.fn(), retrieveSubscription: vi.fn(), retrieveInvoice: vi.fn(),
  upsertSubscription: vi.fn(), validateSubscription: vi.fn(), validateInvoice: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => stubs.database,
  runtimeValue: stubs.runtimeValue,
  stripeConfiguration: () => ({signingKey: stubs.signingKey}),
}));
vi.mock('@/lib/complete/bridge', () => ({
  transitionLicense: stubs.transition, transitionAccess: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/account-trial', () => ({trialLicenseEntitlement: stubs.trial}));
vi.mock('@/lib/founder-access', async (original) => ({
  ...(await original<object>()), offeredLicenseEntitlement: stubs.offered,
}));
vi.mock('@/lib/stripe', () => {
  class PublicError extends Error {
    constructor(message: string, public readonly status = 400) { super(message); }
  }
  return {
    PublicError,
    base64Url: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url'),
    fromBase64Url: (value: string) => new Uint8Array(Buffer.from(value, 'base64url')),
    paidEntitlementForSubscription: stubs.paid,
    retrieveSubscription: stubs.retrieveSubscription,
    retrieveInvoice: stubs.retrieveInvoice,
    referenceId: (value: unknown) => typeof value === 'string' ? value : '',
    upsertSubscription: stubs.upsertSubscription,
    validateActiveZentraSubscription: stubs.validateSubscription,
    validatePaidZentraInvoice: stubs.validateInvoice,
  };
});

import { issueLicense, refreshLicense } from '@/lib/license-token';
import { effectiveAccountUntil } from '@/lib/founder-access';
import * as seats from '@/lib/team-seats';
import { D1PrepaidPeriods, type PrepaidContractInput } from './prepaid-periods';
import { POST as pollDevice } from '../../app/api/account/device/poll/route';
import { AccountPublicError, hashOpaqueToken } from '@/lib/account-security';

const ANCHOR = Date.parse('2026-01-31T09:17:23Z') / 1000;
const CONTRACT = 'pfp_00000000-0000-4000-8000-000000000001';
const ORGANIZATION = 'company-prepaid-test';
const OWNER = 'owner-prepaid-test';
const USER = 'accountant-prepaid-test';
const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const SESSION = 'dss_22222222-2222-4222-8222-222222222222';
let db: DatabaseSync, clock: number, signingKeys: CryptoKeyPair;

function d1() {
  return {
    prepare(query: string) {
      const sql = db.prepare(query);
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) { values = args; return statement; },
        async first() { return sql.get(...values) ?? null; },
        async all() { return {success: true, results: sql.all(...values)}; },
        async run() { return {success: true, meta: sql.run(...values)}; },
      };
      return statement;
    },
    async batch(statements: {run(): Promise<unknown>}[]) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
}
function setNow(seconds: number) {
  clock = seconds;
  vi.setSystemTime(new Date(seconds * 1000));
}
function member(userId: string, role: string, joinedAt: number) {
  db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES(?,?,?,?,?,?)`).run(`mem-${userId}`, ORGANIZATION, userId, `${userId}@example.invalid`, role, joinedAt);
}
async function fixture(options: {paid?: boolean; environment?: 'PRODUCTION' | 'TEST'; productKey?: string; session?: boolean} = {}) {
  const input: PrepaidContractInput = {contractId: CONTRACT, ownerId: OWNER,
    organizationId: ORGANIZATION, workspaceId: null, apiOrigin: 'https://checkout.postfinance.ch',
    spaceId: 405, environment: options.environment ?? 'PRODUCTION', productKey: options.productKey ?? 'complet:team'};
  const store = new D1PrepaidPeriods(d1(), () => clock);
  await store.createContract(input);
  // The legacy projection is deliberately misleading. It is not evidence.
  db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,customer_name,price_id,status,
    current_period_end,entitlement_plan_id,seat_limit,entitlement_valid_until,last_paid_invoice_id,livemode,updated_at)
    VALUES(?,?,'Nom du cache','stale-price','active',?,'zentra-pro-monthly-89-chf',NULL,?,'stale-invoice',1,?)`)
    .run(CONTRACT, CONTRACT, clock + 99999999, clock + 99999999, clock);
  db.prepare(`INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)
    VALUES(?,'Entreprise prouvée',?,?,?,?)`).run(ORGANIZATION, CONTRACT, OWNER, clock, clock);
  // Bootstrap owner before evidence; no device or additional member yet.
  member(OWNER, 'owner', clock);
  const period = await store.reservePeriod(CONTRACT, 0);
  await store.bindTransaction(period.periodId, 123);
  if (options.paid !== false) {
    await store.recordReconciledSettlement({periodId: period.periodId, transactionId: 123, invoiceId: 456,
      apiOrigin: input.apiOrigin, spaceId: input.spaceId, environment: input.environment,
      ownerId: OWNER, organizationId: ORGANIZATION, workspaceId: null,
      startsAt: period.startsAt, endsAt: period.endsAt, currency: 'CHF', priceChfMinor: period.priceChfMinor,
      catalogVersion: period.catalogVersion, evidenceFingerprint: 'a'.repeat(64)});
    if (input.environment === 'PRODUCTION') {
      member(USER, 'accountant', clock + 1);
      if (options.session !== false) db.prepare(`INSERT INTO device_sessions(session_id,token_hash,organization_id,user_id,installation_id,
        created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(SESSION, 'fixture-session-hash', ORGANIZATION, USER, INSTALLATION, clock, clock, period.endsAt + 86400);
    }
  }
  return {store, period};
}
function licenseInput() {
  return {subscriptionId: CONTRACT, installationId: INSTALLATION,
    customerName: 'Nom proposé par le client', periodEnd: clock + 99999999,
    channel: 'account' as const, accountUserId: USER, accountSessionId: SESSION,
    accessRole: 'owner' as const};
}
function noFallback() {
  for (const spy of [stubs.paid, stubs.retrieveSubscription, stubs.retrieveInvoice,
    stubs.upsertSubscription, stubs.validateSubscription, stubs.validateInvoice,
    stubs.offered, stubs.trial, stubs.transition]) expect(spy).not.toHaveBeenCalled();
}
async function signed(payload: object) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = await crypto.subtle.sign('Ed25519', signingKeys.privateKey, new TextEncoder().encode(encoded));
  return `${encoded}.${Buffer.from(signature).toString('base64url')}`;
}
function activationCount() {
  return (db.prepare('SELECT COUNT(*) AS count FROM license_activations').get() as {count: number}).count;
}

beforeAll(async () => {
  signingKeys = await crypto.subtle.generateKey({name: 'Ed25519'}, true, ['sign', 'verify']) as CryptoKeyPair;
  stubs.signingKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', signingKeys.privateKey)).toString('base64url');
});
beforeEach(() => {
  vi.useFakeTimers(); setNow(ANCHOR); vi.clearAllMocks();
  for (const spy of [stubs.offered, stubs.trial, stubs.transition]) spy.mockResolvedValue(null);
  stubs.runtimeValue.mockReturnValue('');
  db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  // SQL triggers and JavaScript readers must observe the same fixture clock.
  db.function('unixepoch', () => clock);
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url)).filter(file => file.endsWith('.sql')).sort())
    db.exec(readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'));
  stubs.database = d1();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); vi.useRealTimers(); });

describe('prepaid license consumers use recorded proof and bound account access', () => {
  it('signs the Gestion component of Complet, actual company/role/session and exact period without Stripe or grace', async () => {
    const {period} = await fixture();
    const issued = await issueLicense(licenseInput());
    expect(issued.payload).toMatchObject({customer_name: 'Entreprise prouvée', access_role: 'accountant',
      account_user_id: USER, account_session_id: SESSION, plan: 'zentra-start-monthly-59-chf',
      price_chf_cents: 5900, valid_from: '2026-01-31', valid_until: '2026-02-28'});
    expect(period.priceChfMinor).toBe(9900);
    const [encoded, signature] = issued.token.split('.');
    expect(await crypto.subtle.verify('Ed25519', signingKeys.publicKey, Buffer.from(signature, 'base64url'),
      new TextEncoder().encode(encoded))).toBe(true);
    expect(await effectiveAccountUntil(CONTRACT, USER, clock + 99999999)).toBe(period.endsAt);
    noFallback();
  });

  it('refreshes from current paid proof and real role rather than an old token role or the cache seat limit', async () => {
    await fixture();
    const issued = await issueLicense(licenseInput());
    db.prepare('UPDATE organization_members SET role=\'read_only\' WHERE user_id=?').run(USER);
    db.prepare('UPDATE subscriptions SET seat_limit=1 WHERE subscription_id=?').run(CONTRACT);
    const refreshed = await refreshLicense(issued.token);
    expect(refreshed.payload).toMatchObject({access_role: 'read_only', account_user_id: USER,
      account_session_id: SESSION, price_chf_cents: 5900, valid_until: '2026-02-28'});
    expect(refreshed.payload.license_id).toBe(issued.payload.license_id);
    noFallback();
  });

  it.each(['unpaid', 'TEST', 'malformed'] as const)('refuses %s despite misleading paid cache and available fallback grants', async (kind) => {
    if (kind !== 'malformed') await fixture({paid: kind !== 'unpaid', environment: kind === 'TEST' ? 'TEST' : 'PRODUCTION'});
    const subscriptionId = kind === 'malformed' ? 'pfp_trial_fallback' : CONTRACT;
    stubs.offered.mockResolvedValue({customer_name: 'Offert', entitlement_valid_until: clock + 99999999,
      entitlement_plan_id: 'zentra-start-monthly-59-chf', seat_limit: 3});
    expect(await effectiveAccountUntil(subscriptionId, USER, clock + 99999999)).toBe(0);
    await expect(issueLicense({...licenseInput(), subscriptionId})).rejects.toMatchObject({status: 402});
    expect(activationCount()).toBe(0); noFallback();
  });

  it('requires active membership for account expiry, independently of a far-future paid cache', async () => {
    await fixture();
    expect(await effectiveAccountUntil(CONTRACT, 'outsider', clock + 99999999)).toBe(0);
    db.prepare('UPDATE organization_members SET revoked_at=? WHERE user_id=?').run(clock, USER);
    expect(await effectiveAccountUntil(CONTRACT, USER, clock + 99999999)).toBe(0);
    await expect(issueLicense(licenseInput())).rejects.toMatchObject({status: 403});
    expect(activationCount()).toBe(0); noFallback();
  });

  it('rejects anonymous checkout and a signed refresh token with no account/session binding', async () => {
    await fixture();
    await expect(issueLicense({...licenseInput(), channel: 'checkout', accountUserId: null,
      accountSessionId: null})).rejects.toMatchObject({status: 403});
    expect(activationCount()).toBe(0);
    const issued = await issueLicense(licenseInput());
    const anonymous = await signed({...issued.payload, account_user_id: null, account_session_id: null});
    await expect(refreshLicense(anonymous)).rejects.toMatchObject({status: 403});
    noFallback();
  });

  it('requires the seat consumer before creating an activation', async () => {
    await fixture();
    const seat = vi.spyOn(seats, 'requireMemberSeat').mockRejectedValueOnce(new Error('fixture seat unavailable'));
    await expect(issueLicense(licenseInput())).rejects.toMatchObject({status: 403});
    expect(seat).toHaveBeenCalledWith(ORGANIZATION, USER);
    expect(activationCount()).toBe(0); noFallback();
  });

  it.each(['expired', 'proof-revoked', 'owner-revoked', 'member-revoked', 'session-revoked',
    'session-expired', 'session-user', 'session-installation', 'activation-revoked'] as const)
  ('refuses refresh after %s without entering Stripe or restoring another entitlement', async (kind) => {
    const {store, period} = await fixture();
    const issued = await issueLicense(licenseInput());
    let refreshToken = issued.token;
    if (kind === 'expired') setNow(period.endsAt);
    if (kind === 'proof-revoked') await store.revokeReconciledPeriod(period.periodId, 'b'.repeat(64));
    if (kind === 'owner-revoked' || kind === 'member-revoked')
      db.prepare('UPDATE organization_members SET revoked_at=? WHERE user_id=?').run(clock, kind === 'owner-revoked' ? OWNER : USER);
    if (kind === 'session-revoked') db.prepare('UPDATE device_sessions SET revoked_at=? WHERE session_id=?').run(clock, SESSION);
    if (kind === 'session-expired') db.prepare('UPDATE device_sessions SET expires_at=? WHERE session_id=?').run(clock - 1, SESSION);
    if (kind === 'session-user') {
      // The real migration already blocks rewriting a session to a non-member.
      expect(() => db.prepare('UPDATE device_sessions SET user_id=\'outsider\' WHERE session_id=?').run(SESSION))
        .toThrow('zentra account access revoked');
      refreshToken = await signed({...issued.payload, account_user_id: 'outsider'});
    }
    if (kind === 'session-installation') db.prepare('UPDATE device_sessions SET installation_id=\'33333333-3333-4333-8333-333333333333\' WHERE session_id=?').run(SESSION);
    if (kind === 'activation-revoked') db.prepare('UPDATE license_activations SET revoked_at=? WHERE license_id=?').run(clock, issued.payload.license_id);
    await expect(refreshLicense(refreshToken)).rejects.toMatchObject({status: ['expired', 'proof-revoked', 'owner-revoked'].includes(kind) ? 402 : 403});
    noFallback();
  });

  it('keeps paid rights after cancellation and refuses them exactly at the covered end', async () => {
    const {store, period} = await fixture();
    await store.cancelRenewal(CONTRACT);
    expect(await effectiveAccountUntil(CONTRACT, USER, 0)).toBe(period.endsAt);
    const issued = await issueLicense(licenseInput());
    expect(issued.payload.valid_until).toBe('2026-02-28');
    setNow(period.endsAt);
    expect(await effectiveAccountUntil(CONTRACT, USER, clock + 99999999)).toBe(0);
    await expect(refreshLicense(issued.token)).rejects.toMatchObject({status: 402});
    noFallback();
  });
});

describe('prepaid device poll exchanges a real claimed authorization before inserting its session', () => {
  const deviceCode = `zdv_${'A'.repeat(43)}`;
  async function authorization(status = 'approved', expiresAt = clock + 300) {
    const hash = await hashOpaqueToken('device-code', deviceCode);
    db.prepare(`INSERT INTO device_authorizations(device_code_hash,user_code,installation_id,status,
      organization_id,approved_by_user_id,created_at,expires_at,approved_at)
      VALUES(?,'AAAA-AAAA',?,?,?,?,?,?,?)`)
      .run(hash, INSTALLATION, status, ORGANIZATION, USER, clock, expiresAt, clock);
    return hash;
  }
  function request(extra: Record<string, unknown> = {}) {
    return new Request('https://zentra.example/api/account/device/poll', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({deviceCode, ...extra}),
    });
  }
  function sessionCount() {
    return (db.prepare('SELECT COUNT(*) AS count FROM device_sessions').get() as {count: number}).count;
  }

  it('links a new device, persists the returned session, consumes the authorization and supports normal refresh', async () => {
    await fixture({session: false});
    const hash = await authorization();
    expect(sessionCount()).toBe(0);
    const response = await pollDevice(request({deviceAuthorizationHash: 'f'.repeat(64),
      installationId: '33333333-3333-4333-8333-333333333333', accessRole: 'owner'}));
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json() as {status: string; sessionToken: string;
      license: Awaited<ReturnType<typeof issueLicense>>};
    expect(result.status).toBe('approved');
    expect(result.license.payload).toMatchObject({installation_id: INSTALLATION,
      account_user_id: USER, access_role: 'accountant', customer_name: 'Entreprise prouvée',
      plan: 'zentra-start-monthly-59-chf', price_chf_cents: 5900, valid_until: '2026-02-28'});
    expect(db.prepare('SELECT session_id,user_id,installation_id,token_hash FROM device_sessions').get())
      .toMatchObject({session_id: result.license.payload.account_session_id, user_id: USER,
        installation_id: INSTALLATION, token_hash: await hashOpaqueToken('device-session', result.sessionToken)});
    expect(db.prepare('SELECT status FROM device_authorizations WHERE device_code_hash=?').get(hash))
      .toMatchObject({status: 'consumed'});
    const refreshed = await refreshLicense(result.license.token);
    expect(refreshed.payload.account_session_id).toBe(result.license.payload.account_session_id);
    expect(sessionCount()).toBe(1);
    expect(JSON.stringify(result)).not.toContain(hash);
    noFallback();
  });

  it.each(['authorization-expired', 'period-expired', 'owner-revoked', 'seat-unavailable'] as const)
  ('refuses %s without creating an activation or session', async (kind) => {
    const {period} = await fixture({session: false});
    await authorization('approved', kind === 'authorization-expired' ? clock - 1 : period.endsAt + 300);
    if (kind === 'period-expired') setNow(period.endsAt);
    if (kind === 'owner-revoked') db.prepare('UPDATE organization_members SET revoked_at=? WHERE user_id=?').run(clock, OWNER);
    if (kind === 'seat-unavailable') vi.spyOn(seats, 'requireMemberSeat')
      .mockRejectedValueOnce(new AccountPublicError('fixture unavailable seat', 403));
    const response = await pollDevice(request());
    expect(response.status).toBe(kind === 'authorization-expired' ? 410 : kind === 'seat-unavailable' ? 403 : 402);
    expect(sessionCount()).toBe(0); expect(activationCount()).toBe(0); noFallback();
  });

  it('does not issue another license/session when the device authorization is replayed', async () => {
    await fixture({session: false}); await authorization();
    expect((await pollDevice(request())).status).toBe(200);
    const response = await pollDevice(request());
    expect(response.status).toBe(410);
    expect(sessionCount()).toBe(1); expect(activationCount()).toBe(1); noFallback();
  });

  it('revalidates authorization expiry after the claim and preserves an existing session on failure', async () => {
    await fixture();
    const hash = await authorization();
    const database = stubs.database as D1Database;
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, 'prepare').mockImplementation((query) => {
      if (query.includes('SELECT member.role FROM device_authorizations'))
        db.prepare('UPDATE device_authorizations SET expires_at=? WHERE device_code_hash=?').run(clock - 1, hash);
      return prepare(query);
    });
    const response = await pollDevice(request());
    expect(response.status, await response.clone().text()).toBe(403);
    expect(sessionCount()).toBe(1); expect(activationCount()).toBe(0);
    expect(db.prepare('SELECT revoked_at FROM device_sessions WHERE session_id=?').get(SESSION))
      .toMatchObject({revoked_at: null});
    noFallback();
  });

  it('ignores a client-provided bootstrap hash while the device is still pending', async () => {
    await fixture({session: false});
    const hash = await authorization('pending');
    const response = await pollDevice(request({deviceAuthorizationHash: hash, accountUserId: OWNER}));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({status: 'authorization_pending'});
    expect(sessionCount()).toBe(0); expect(activationCount()).toBe(0); noFallback();
  });
});
