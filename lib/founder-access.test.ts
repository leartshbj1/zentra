import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const stubs = vi.hoisted(() => ({
  database: vi.fn(),
  value: vi.fn(),
  user: vi.fn(),
  signingKey: '',
  stripe: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: stubs.database,
  runtimeValue: stubs.value,
  stripeConfiguration: () => ({ signingKey: stubs.signingKey }),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: stubs.user }));
vi.mock('@/lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  retrieveSubscription: stubs.stripe,
  retrieveInvoice: stubs.stripe,
}));
import { POST as admin } from '../app/api/founder/access/route';
import { POST as start } from '../app/api/account/device/start/route';
import { POST as approve } from '../app/api/account/device/approve/route';
import { POST as poll } from '../app/api/account/device/poll/route';
import {
  registerAccessIdentity,
  readGrant,
  offeredLicenseEntitlement,
  effectiveAccountUntil,
  type changeAccess,
} from './founder-access';
import {
  accessExpiry,
  FOUNDER_DOMAIN,
  parseAction,
  type FounderAction,
} from './founder-access-policy';
import { refreshLicense } from './license-token';
import { requireDeviceSession } from './account';
import { teamSeats } from './team-seats';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'jwk' }).x!;
const fixed = new Date('2026-09-15T12:00:00Z');
const email = 'person@example.invalid';
const person = {
  userId: 'test-person',
  email,
  displayName: 'Person',
  provider: 'supabase',
  emailConfirmed: true,
};
let db: DatabaseSync;
type Value = string | number | null;
function prepared(sql: string) {
  const statement = db.prepare(sql);
  let args: Value[] = [];
  const p = {
    bind: (...values: Value[]) => {
      args = values;
      return p;
    },
    first: async () => statement.get(...args) ?? null,
    all: async () => ({ results: statement.all(...args) }),
    run: async () => ({
      success: true,
      meta: { changes: Number(statement.run(...args).changes) },
    }),
  };
  return p;
}
function signed(action: unknown, changes: Record<string, unknown> = {}) {
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: crypto.randomUUID(),
      action,
      ...changes,
    }),
  ).toString('base64url');
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(FOUNDER_DOMAIN + payload),
      keys.privateKey,
    ).toString('base64url'),
  };
}
function request(path: string, body: unknown, origin?: string) {
  return new Request('https://zentra.example' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
}
async function command(action: unknown) {
  const r = await admin(request('/api/founder/access', signed(action)));
  return {
    status: r.status,
    body: (await r.json()) as Awaited<ReturnType<typeof changeAccess>>,
  };
}
const write = (
  revision = 0,
  operation = 'grant',
  extra: Record<string, unknown> = {},
) => ({
  operation,
  email,
  duration: '14_days',
  note: 'Test',
  expectedRevision: revision,
  operationId: crypto.randomUUID(),
  ...extra,
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fixed);
  vi.clearAllMocks();
  stubs.value.mockImplementation((name: string) =>
    name === 'FOUNDER_ADMIN_PUBLIC_KEY_B64URL' ? publicKey : '',
  );
  stubs.signingKey = keys.privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64url');
  stubs.user.mockResolvedValue(person);
  stubs.stripe.mockRejectedValue(
    new Error('Stripe must not be contacted for an offered account'),
  );
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(folder)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    for (const sql of readFileSync(new URL(name, folder), 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim()) db.exec(sql);
  stubs.database.mockReturnValue({
    prepare: prepared,
    batch: async (statements: ReturnType<typeof prepared>[]) => {
      db.exec('BEGIN');
      try {
        const result = [];
        for (const s of statements) result.push(await s.run());
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  });
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe('Founder command authentication', () => {
  it('requires the personal signature, fresh time, correct path and a unique nonce', async () => {
    const envelope = signed({ operation: 'list' });
    expect((await admin(request('/api/founder/access', envelope))).status).toBe(
      200,
    );
    expect((await admin(request('/api/founder/access', envelope))).status).toBe(
      409,
    );
    expect(
      (
        await admin(
          request('/api/founder/access', {
            ...envelope,
            payload: envelope.payload + 'a',
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await admin(
          request(
            '/api/founder/access',
            signed({ operation: 'list' }, { timestamp: 1 }),
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await admin(
          request(
            '/api/founder/access',
            signed({ operation: 'list' }),
            'https://zentra.example',
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (await admin(request('/api/other', signed({ operation: 'list' }))))
        .status,
    ).toBe(403);
    expect(
      (await admin(request('/api/founder/access', { operation: 'list' })))
        .status,
    ).toBe(401);
  });
  it('rejects unknown command fields and invalid addresses before creating any grant', async () => {
    expect((await command({ ...write(), email: 'broken' })).status).toBe(400);
    expect((await command({ ...write(), admin: true })).status).toBe(400);
    expect((await command({ ...write(), expectedRevision: -1 })).status).toBe(
      400,
    );
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM founder_access_grants').get()
        ?.count,
    ).toBe(0);
  });
});
describe('Offered account lifecycle', () => {
  it('creates a pending grant, binds only a verified identity and gives an individual workspace without paid invoices', async () => {
    const result = await command({
      ...write(),
      email: ' Person@Example.Invalid ',
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.record).toMatchObject({
      email,
      status: 'pending',
      revision: 1,
      accountLinked: false,
    });
    await registerAccessIdentity({ ...person, emailConfirmed: false });
    expect((await readGrant(email))?.user_id).toBeNull();
    await registerAccessIdentity(person);
    const grant = (await readGrant(email))!;
    expect(grant.user_id).toBe(person.userId);
    expect(grant.organization_id).toBeTruthy();
    const subscription = db
      .prepare(
        'SELECT s.* FROM subscriptions s JOIN organizations o ON o.subscription_id=s.subscription_id WHERE o.organization_id=?',
      )
      .get(grant.organization_id!)!;
    expect(subscription).toMatchObject({
      status: 'manual',
      last_paid_invoice_id: null,
      entitlement_valid_until: 0,
      seat_limit: 1,
    });
    expect(await teamSeats(grant.organization_id!)).toMatchObject({
      planName: 'Accès offert',
      priceChfCents: 0,
      limit: 1,
      available: 0,
      subscriptionActive: true,
    });
    await registerAccessIdentity({ ...person, userId: 'someone-else' });
    expect((await readGrant(email))?.user_id).toBe(person.userId);
    expect(() =>
      db
        .prepare('UPDATE founder_access_grants SET user_id=? WHERE email=?')
        .run('hijack', email),
    ).toThrow(/immutable/);
    expect(stubs.stripe).not.toHaveBeenCalled();
  });
  it('extends once after an uncertain response, rejects stale edits, revokes and regrants from today', async () => {
    await registerAccessIdentity(person);
    const first = write();
    expect((await command(first)).body.record!.status).toBe('active');
    const expiry = (await readGrant(email))!.valid_until;
    expect((await command(first)).body.replayed).toBe(true);
    expect((await readGrant(email))!.valid_until).toBe(expiry);
    expect((await command(write())).status).toBe(409);
    expect((await command({ ...first, note: 'Different' })).status).toBe(409);
    expect((await command(write(1))).status).toBe(200);
    expect((await readGrant(email))!.valid_until).toBe(expiry + 14 * 86400);
    expect((await command(write(2, 'revoke'))).body.record!.status).toBe(
      'revoked',
    );
    expect((await command(write(3))).body.record!.status).toBe('active');
    expect((await readGrant(email))!.valid_until).toBe(expiry);
  });
  it('activates a desktop session, signs and refreshes a compatible license, then blocks it immediately after removal', async () => {
    await command(write());
    await registerAccessIdentity(person);
    const grant = (await readGrant(email))!;
    const started = await start(
      request('/api/account/device/start', {
        installationId: crypto.randomUUID(),
      }),
    );
    expect(started.status).toBe(201);
    const codes = (await started.json()) as {
      deviceCode: string;
      userCode: string;
    };
    const approved = await approve(
      request(
        '/api/account/device/approve',
        { organizationId: grant.organization_id, userCode: codes.userCode },
        'https://zentra.example',
      ),
    );
    expect(approved.status, await approved.clone().text()).toBe(200);
    const response = await poll(
      request('/api/account/device/poll', { deviceCode: codes.deviceCode }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const result = (await response.json()) as {
      license: Awaited<ReturnType<typeof refreshLicense>>;
      sessionToken: string;
    };
    expect(result.license.payload).toMatchObject({
      account_user_id: person.userId,
      plan: 'zentra-solo-monthly-49-chf',
      valid_until: '2026-09-16',
    });
    const refreshed = await refreshLicense(result.license.token);
    expect(refreshed.payload.license_id).toBe(
      result.license.payload.license_id,
    );
    const deviceRequest = new Request(
      'https://zentra.example/api/account/workspace',
      { headers: { Authorization: 'Bearer ' + result.sessionToken } },
    );
    expect((await requireDeviceSession(deviceRequest)).userId).toBe(
      person.userId,
    );
    await command(write(1, 'revoke'));
    await expect(refreshLicense(result.license.token)).rejects.toMatchObject({
      status: 402,
    });
    await expect(requireDeviceSession(deviceRequest)).rejects.toMatchObject({
      status: 402,
    });
    expect(stubs.stripe).not.toHaveBeenCalled();
  });
  it('reuses an existing owned company, preserves paid seats and never grants the offer to teammates', async () => {
    const end = Math.floor(Date.now() / 1000) + 86400;
    db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,entitlement_valid_until,entitlement_plan_id,seat_limit,last_paid_invoice_id)
      VALUES('sub_existing','cus_test','price_start','active',?,0,1,?,'zentra-start-monthly-59-chf',3,'in_paid')`).run(
      end,
      end,
    );
    db.exec(`INSERT INTO organizations VALUES('org_existing','Existing','sub_existing','test-person',1,1);
      INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('mem_owner','org_existing','test-person','person@example.invalid','owner',1),('mem_team','org_existing','teammate','team@example.invalid','member',2);`);
    const before = db.prepare('SELECT * FROM subscriptions').get();
    await command(write());
    await registerAccessIdentity(person);
    expect((await readGrant(email))?.organization_id).toBe('org_existing');
    expect(
      await offeredLicenseEntitlement('sub_existing', person.userId),
    ).toMatchObject({
      seat_limit: 3,
      entitlement_plan_id: 'zentra-start-monthly-59-chf',
    });
    expect(
      await offeredLicenseEntitlement('sub_existing', 'teammate'),
    ).toBeNull();
    vi.setSystemTime(new Date(fixed.getTime() + 2 * 86400000));
    expect(
      await offeredLicenseEntitlement('sub_existing', person.userId),
    ).toMatchObject({ seat_limit: 1 });
    expect(await effectiveAccountUntil('sub_existing', 'teammate', end)).toBe(
      end,
    );
    await command(write(1, 'revoke'));
    expect(db.prepare('SELECT * FROM subscriptions').get()).toEqual(before);
  });
  it('expires exactly and never restores an old offer to a different account with the same address', async () => {
    await command(write());
    await registerAccessIdentity(person);
    const grant = (await readGrant(email))!;
    const sub = db
      .prepare(
        'SELECT subscription_id FROM organizations WHERE organization_id=?',
      )
      .get(grant.organization_id!)!.subscription_id as string;
    vi.setSystemTime(new Date(grant.valid_until * 1000));
    expect(await offeredLicenseEntitlement(sub, person.userId)).toBeNull();
    expect(
      (await command({ operation: 'lookup', email })).body.record!.status,
    ).toBe('expired');
    await command(write(1));
    await registerAccessIdentity({ ...person, userId: 'other' });
    expect(await offeredLicenseEntitlement(sub, 'other')).toBeNull();
  });
});
describe('Duration rules', () => {
  it('clamps a month at month end and handles Swiss winter and summer dates', () => {
    expect(
      new Date(
        accessExpiry(
          'one_month',
          '',
          Date.parse('2028-01-31T12:00:00Z') / 1000,
        ) * 1000,
      ).toISOString(),
    ).toBe('2028-02-29T12:00:00.000Z');
    expect(
      new Date(
        accessExpiry('custom', '2026-12-31', fixed.getTime() / 1000) * 1000,
      ).toISOString(),
    ).toBe('2026-12-31T22:59:59.000Z');
    expect(
      new Date(
        accessExpiry('custom', '2026-09-20', fixed.getTime() / 1000) * 1000,
      ).toISOString(),
    ).toBe('2026-09-20T21:59:59.000Z');
    expect(() =>
      accessExpiry('custom', '2026-02-30', fixed.getTime() / 1000),
    ).toThrow();
    expect(() =>
      accessExpiry('custom', '2026-09-14', fixed.getTime() / 1000),
    ).toThrow();
    expect(parseAction(write()) as FounderAction).toMatchObject({
      duration: '14_days',
    });
  });
});
