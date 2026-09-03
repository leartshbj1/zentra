import { DatabaseSync } from 'node:sqlite';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const runtimeStubs = vi.hoisted(() => ({
  database: vi.fn(),
  runtimeValue: vi.fn(() => ''),
  signingKey: '',
}));

const stripeStubs = vi.hoisted(() => ({
  paidEntitlementForSubscription: vi.fn(),
  referenceId: vi.fn((value: unknown) =>
    typeof value === 'string' ? value : '',
  ),
  retrieveInvoice: vi.fn(),
  retrieveSubscription: vi.fn(),
  upsertSubscription: vi.fn(),
  validateActiveZentraSubscription: vi.fn(),
  validatePaidZentraInvoice: vi.fn(),
}));

vi.mock('@/lib/runtime', () => ({
  database: runtimeStubs.database,
  runtimeValue: runtimeStubs.runtimeValue,
  stripeConfiguration: () => ({ signingKey: runtimeStubs.signingKey }),
}));

vi.mock('@/lib/stripe', () => {
  class PublicError extends Error {
    constructor(
      message: string,
      public readonly status = 400,
    ) {
      super(message);
    }
  }

  return {
    base64Url: (value: Uint8Array) => Buffer.from(value).toString('base64url'),
    fromBase64Url: (value: string) =>
      Uint8Array.from(Buffer.from(value, 'base64url')),
    paidEntitlementForSubscription: stripeStubs.paidEntitlementForSubscription,
    PublicError,
    referenceId: stripeStubs.referenceId,
    retrieveInvoice: stripeStubs.retrieveInvoice,
    retrieveSubscription: stripeStubs.retrieveSubscription,
    upsertSubscription: stripeStubs.upsertSubscription,
    validateActiveZentraSubscription:
      stripeStubs.validateActiveZentraSubscription,
    validatePaidZentraInvoice: stripeStubs.validatePaidZentraInvoice,
  };
});

import { issueLicense, refreshLicense } from './license-token';

type SqlValue = string | number | bigint | null | Uint8Array;

class FakeD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  readonly preparedSql: string[] = [];

  constructor() {
    this.sqlite.exec(`
      CREATE TABLE license_activations(
        license_id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        activated_at INTEGER NOT NULL,
        last_issued_at INTEGER NOT NULL,
        revoked_at INTEGER,
        UNIQUE(subscription_id, installation_id)
      );
      CREATE TABLE organizations(
        organization_id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE organization_members(
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE device_sessions(
        session_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
    `);
  }

  prepare(sql: string) {
    this.preparedSql.push(sql.replace(/\s+/g, ' ').trim());
    const statement = this.sqlite.prepare(sql);
    let bindings: SqlValue[] = [];
    const prepared = {
      bind: (...values: SqlValue[]) => {
        bindings = values;
        return prepared;
      },
      first: async <T>() =>
        (statement.get(...bindings) as T | undefined) ?? null,
    };
    return prepared;
  }

  activation(subscriptionId: string, installationId: string) {
    return this.sqlite
      .prepare(
        `SELECT license_id,activated_at,last_issued_at,revoked_at
           FROM license_activations
          WHERE subscription_id=? AND installation_id=?`,
      )
      .get(subscriptionId, installationId) as
      | {
          license_id: string;
          activated_at: number;
          last_issued_at: number;
          revoked_at: number | null;
        }
      | undefined;
  }

  revoke(subscriptionId: string, installationId: string, revokedAt: number) {
    this.sqlite
      .prepare(
        `UPDATE license_activations SET revoked_at=?
          WHERE subscription_id=? AND installation_id=?`,
      )
      .run(revokedAt, subscriptionId, installationId);
  }

  removeAllActivations() {
    this.sqlite.exec('DELETE FROM license_activations');
  }

  addAccountAccess(input: {
    organizationId: string;
    subscriptionId: string;
    userId: string;
    sessionId: string;
    installationId: string;
    role: string;
    expiresAt: number;
  }) {
    this.sqlite
      .prepare(
        `INSERT INTO organizations(organization_id,subscription_id)
         VALUES(?,?)`,
      )
      .run(input.organizationId, input.subscriptionId);
    this.sqlite
      .prepare(
        `INSERT INTO organization_members(organization_id,user_id,role,revoked_at)
         VALUES(?,?,?,NULL)`,
      )
      .run(input.organizationId, input.userId, input.role);
    this.sqlite
      .prepare(
        `INSERT INTO device_sessions(
           session_id,organization_id,user_id,installation_id,expires_at,revoked_at
         ) VALUES(?,?,?,?,?,NULL)`,
      )
      .run(
        input.sessionId,
        input.organizationId,
        input.userId,
        input.installationId,
        input.expiresAt,
      );
  }

  close() {
    this.sqlite.close();
  }
}

const NOW = new Date('2026-09-03T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const SUBSCRIPTION_ID = 'sub_license_test';
const INSTALLATION_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_USER_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_SESSION_ID = 'dss_22222222-2222-4222-8222-222222222222';

let signingKeys: CryptoKeyPair;
let db: FakeD1;

function accountLicenseInput() {
  return {
    subscriptionId: SUBSCRIPTION_ID,
    installationId: INSTALLATION_ID,
    customerName: 'Entreprise de test',
    periodEnd: NOW_SECONDS + 30 * 86_400,
    channel: 'account' as const,
    accessRole: 'accountant' as const,
    accountUserId: ACCOUNT_USER_ID,
    accountSessionId: ACCOUNT_SESSION_ID,
  };
}

function expectNoStripeCall() {
  expect(stripeStubs.retrieveSubscription).not.toHaveBeenCalled();
  expect(stripeStubs.retrieveInvoice).not.toHaveBeenCalled();
  expect(stripeStubs.upsertSubscription).not.toHaveBeenCalled();
  expect(stripeStubs.paidEntitlementForSubscription).not.toHaveBeenCalled();
}

beforeAll(async () => {
  signingKeys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const privateKey = await crypto.subtle.exportKey(
    'pkcs8',
    signingKeys.privateKey,
  );
  runtimeStubs.signingKey = Buffer.from(privateKey).toString('base64url');
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  runtimeStubs.runtimeValue.mockReturnValue('');
  db = new FakeD1();
  runtimeStubs.database.mockReturnValue(db);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe('license-token direct runtime contract', () => {
  it('issues an account-bound license signed by an Ed25519 test key', async () => {
    const result = await issueLicense(accountLicenseInput());
    const [encoded, signature] = result.token.split('.');

    expect(result.payload).toMatchObject({
      license_id: expect.stringMatching(/^lic_[0-9a-f-]{36}$/i),
      installation_id: INSTALLATION_ID,
      customer_name: 'Entreprise de test',
      access_role: 'accountant',
      account_user_id: ACCOUNT_USER_ID,
      account_session_id: ACCOUNT_SESSION_ID,
    });
    expect(
      await crypto.subtle.verify(
        'Ed25519',
        signingKeys.publicKey,
        Buffer.from(signature, 'base64url'),
        new TextEncoder().encode(encoded),
      ),
    ).toBe(true);
    expect(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    ).toEqual(result.payload);
    expect(db.activation(SUBSCRIPTION_ID, INSTALLATION_ID)).toMatchObject({
      license_id: result.payload.license_id,
      revoked_at: null,
    });
  });

  it('rejects an invalid installation before touching D1', async () => {
    await expect(
      issueLicense({
        ...accountLicenseInput(),
        installationId: 'not-an-installation-id',
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Identifiant d’installation invalide'),
    });

    expect(runtimeStubs.database).not.toHaveBeenCalled();
    expect(db.preparedSql).toEqual([]);
  });

  it.each([
    ['missing account pair', null, null],
    ['missing session', ACCOUNT_USER_ID, null],
    ['malformed session', ACCOUNT_USER_ID, 'dss_invalid'],
  ])(
    'rejects an invalid account session: %s',
    async (_label, userId, sessionId) => {
      await expect(
        issueLicense({
          ...accountLicenseInput(),
          accountUserId: userId,
          accountSessionId: sessionId,
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining(
          'liaison entre la licence, le compte et la session est invalide',
        ),
      });

      expect(db.preparedSql).toEqual([]);
    },
  );

  it('reuses and unrevokes the existing activation for the same account device', async () => {
    const first = await issueLicense(accountLicenseInput());
    db.revoke(SUBSCRIPTION_ID, INSTALLATION_ID, NOW_SECONDS + 10);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));

    const resumed = await issueLicense(accountLicenseInput());
    const activation = db.activation(SUBSCRIPTION_ID, INSTALLATION_ID);

    expect(resumed.payload.license_id).toBe(first.payload.license_id);
    expect(activation).toMatchObject({
      license_id: first.payload.license_id,
      activated_at: NOW_SECONDS,
      last_issued_at: NOW_SECONDS + 60,
      revoked_at: null,
    });
  });

  it('refreshes an active account session with the paid Stripe entitlement and current member role', async () => {
    const issued = await issueLicense(accountLicenseInput());
    const organizationId = 'org_44444444-4444-4444-8444-444444444444';
    const paidThrough = NOW_SECONDS + 45 * 86_400;
    const paidAt = NOW_SECONDS - 60;
    const subscription = {
      id: SUBSCRIPTION_ID,
      latest_invoice: 'in_paid_license_test',
    };
    const invoice = {
      id: 'in_paid_license_test',
      status_transitions: { paid_at: paidAt },
    };
    db.addAccountAccess({
      organizationId,
      subscriptionId: SUBSCRIPTION_ID,
      userId: ACCOUNT_USER_ID,
      sessionId: ACCOUNT_SESSION_ID,
      installationId: INSTALLATION_ID,
      role: 'member',
      expiresAt: NOW_SECONDS + 86_400,
    });
    stripeStubs.retrieveSubscription.mockResolvedValue(subscription);
    stripeStubs.retrieveInvoice.mockResolvedValue(invoice);
    stripeStubs.validatePaidZentraInvoice.mockReturnValue(paidThrough);
    stripeStubs.paidEntitlementForSubscription.mockResolvedValue({
      customer_name: 'Entreprise renouvelée',
      entitlement_valid_until: paidThrough,
    });

    const refreshed = await refreshLicense(issued.token);
    const [encoded, signature] = refreshed.token.split('.');

    expect(refreshed.payload).toMatchObject({
      license_id: issued.payload.license_id,
      installation_id: INSTALLATION_ID,
      customer_name: 'Entreprise renouvelée',
      access_role: 'member',
      account_user_id: ACCOUNT_USER_ID,
      account_session_id: ACCOUNT_SESSION_ID,
    });
    expect(refreshed.payload.jti).not.toBe(issued.payload.jti);
    expect(
      await crypto.subtle.verify(
        'Ed25519',
        signingKeys.publicKey,
        Buffer.from(signature, 'base64url'),
        new TextEncoder().encode(encoded),
      ),
    ).toBe(true);
    expect(stripeStubs.retrieveSubscription).toHaveBeenCalledWith(
      SUBSCRIPTION_ID,
    );
    expect(stripeStubs.retrieveInvoice).toHaveBeenCalledWith(invoice.id);
    expect(stripeStubs.upsertSubscription).toHaveBeenCalledWith(
      subscription,
      null,
      {
        paidInvoiceId: invoice.id,
        paidThrough,
        paidAt,
      },
    );
    expect(stripeStubs.paidEntitlementForSubscription).toHaveBeenCalledWith(
      SUBSCRIPTION_ID,
    );
  });

  it('fails closed on a tampered renewal token without consulting D1 or Stripe', async () => {
    const issued = await issueLicense(accountLicenseInput());
    const [encoded, signature] = issued.token.split('.');
    const alteredSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    runtimeStubs.database.mockClear();

    await expect(
      refreshLicense(`${encoded}.${alteredSignature}`),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Jeton de licence invalide.',
    });

    expect(runtimeStubs.database).not.toHaveBeenCalled();
    expectNoStripeCall();
  });

  it('fails closed before Stripe when a valid token has no active D1 activation', async () => {
    const issued = await issueLicense(accountLicenseInput());
    db.removeAllActivations();
    db.preparedSql.length = 0;
    runtimeStubs.database.mockClear();

    await expect(refreshLicense(issued.token)).rejects.toMatchObject({
      status: 403,
      message:
        'Cette activation n’est pas reconnue. Contactez le support Zentra.',
    });

    expect(runtimeStubs.database).toHaveBeenCalledTimes(1);
    expect(db.preparedSql).toHaveLength(1);
    expect(db.preparedSql[0]).toContain('FROM license_activations activation');
    expectNoStripeCall();
  });
});
