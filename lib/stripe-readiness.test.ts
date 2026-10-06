import { describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import * as ts from 'typescript';

const stubs = vi.hoisted(() => ({
  discriminator: '',
  account: vi.fn(async () => ({
    portalLoginUrl: 'https://billing.stripe.com/p/login/elyko',
  })),
  portal: vi.fn(async () => 'https://billing.stripe.com/p/login/elyko'),
  signer: vi.fn(async () => undefined),
  batch: vi.fn(async () => []),
  proof: {
    endpoint_id: 'we_valid',
    secret_sha256: 'a'.repeat(43),
    livemode: 0,
    api_version: '2026-08-26.dahlia',
    last_verified_event_id: 'evt_canary',
    verified_at: 1_788_000_000,
  },
}));

vi.mock('@/lib/deployment-contract', () => ({ deploymentReadinessDiscriminator: () => stubs.discriminator, isSandboxDeployment: false }));

vi.mock('@/lib/license-token', () => ({
  assertLicenseSignerReady: stubs.signer,
}));

vi.mock('@/lib/runtime', () => ({
  database: () => ({
    prepare: (sql: string) => ({
      sql,
      bind: () => ({ first: async () => stubs.proof }),
    }),
    batch: stubs.batch,
  }),
  stripeConfiguration: () => ({
    secretKey: 'sk_test_valid',
    webhookSecret: 'whsec_valid',
    webhookEndpointId: 'we_valid',
    priceId: 'price_valid',
    priceIds: { solo: 'price_solo', start: 'price_start', pro: 'price_pro' },
    signingKey: 'A'.repeat(40),
    siteUrl: 'https://elyko.example',
  }),
}));

vi.mock('@/lib/stripe', () => {
  class PublicError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    assertConfiguredStripeAccount: stubs.account,
    assertConfiguredStripePortalLoginUrl: stubs.portal,
    PublicError,
    sha256: vi.fn(async (value: string) =>
      value === 'whsec_valid' ? 'a'.repeat(43) : `configuration-fingerprint:${value}`,
    ),
    STRIPE_API_VERSION: '2026-08-26.dahlia',
  };
});

// Evaluate the actual runtime, profile, signer, readiness and webhook-proof
// sources in one closed realm. Vitest module mocks above are not used here.
// Ed25519 keys are ephemeral in memory; only D1 handles and Stripe SDK effects
// are fixtures. The real runtime validates the compiled profile and its ACK.
type ClosedReadiness = {
  assertStripeCheckoutReady: () => Promise<{ portalLoginUrl: string }>;
  stripeCheckoutReadiness: () => Promise<{ portalLoginUrl: string } | null>;
  stripeCheckoutIsReady: () => Promise<boolean>;
  stripePortalLoginUrl: () => Promise<string | null>;
};
function closedReadinessFixture(sandbox = true, productionSigner?: () => Promise<void>) {
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const selected = generateKeyPairSync('ed25519');
  const foreign = generateKeyPairSync('ed25519');
  const privateValue = (key: typeof selected.privateKey) =>
    (key.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64url');
  const publicKey = (selected.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64url');
  const publicProfile = {
    schemaVersion: 1, kind: 'sandbox', profileId: 'sandbox-readiness-fixture',
    siteOrigin: 'https://sandbox-readiness.example', supabaseOrigin: 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co',
    license: { kid: 'sandbox-readiness-v1', publicKeyB64url: publicKey },
    identifiers: { windows: 'ch.zentra.sandbox.windows', macos: 'ch.zentra.sandbox.macos', mobile: 'ch.zentra.sandbox.mobile' },
    productName: 'Zentra Sandbox', binaryName: 'ZentraSandbox', updater: 'disabled',
  };
  const canonical = (value: unknown): string => value === null || typeof value !== 'object'
    ? JSON.stringify(value)
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  const compiled = { ...publicProfile, sha256: createHash('sha256').update(canonical(publicProfile)).digest('hex') };
  const counts = { dbBindings: 0, prepare: 0, batch: 0, first: 0, account: 0, portal: 0, signer: 0, fingerprint: 0, unexpected: 0 };
  const trace: string[] = [];
  let now = 1_788_000_000_000;
  let proofValid = true;
  const env: Record<string, unknown> = {
    PUBLIC_SITE_URL: sandbox ? compiled.siteOrigin : 'https://zentraapp.ch',
    ...(sandbox ? {
      ZENTRA_DEPLOYMENT_KIND: 'sandbox', ZENTRA_DEPLOYMENT_PROFILE_ID: compiled.profileId,
      ZENTRA_DEPLOYMENT_PROFILE_SHA256: compiled.sha256, SUPABASE_URL: compiled.supabaseOrigin,
    } : {}),
    STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_WEBHOOK_ENDPOINT_ID: 'we_fixture',
    STRIPE_PRICE_SOLO_ID: 'price_fixture', STRIPE_PRICE_START_ID: 'price_start', STRIPE_PRICE_PRO_ID: 'price_pro',
    LICENSE_SIGNING_KEY_PKCS8_B64URL: privateValue(selected.privateKey),
  };
  const statement = {
    bind() { return this; },
    async first() {
      counts.first++; trace.push('d1-first');
      return proofValid ? { endpoint_id: 'we_fixture', secret_sha256: createHash('sha256').update('whsec_fixture').digest('base64url'),
        livemode: 0, api_version: 'fixture-version', last_verified_event_id: 'evt_fixture', verified_at: Math.floor(now / 1000) } : null;
    },
  };
  const db = { prepare() { counts.prepare++; trace.push('d1-prepare'); return statement; }, async batch() { counts.batch++; trace.push('d1-batch'); return []; } };
  Object.defineProperty(env, 'DB', { get() { counts.dbBindings++; trace.push('d1-binding'); return db; } });
  class FixturePublicError extends Error { constructor(message: string, public status = 400) { super(message); } }
  const unexpected = () => { counts.unexpected++; throw Error('UNEXPECTED_FIXTURE_EFFECT'); };
  const external: Record<string, unknown> = {
    'cloudflare:workers': { env },
    '@/lib/stripe': {
      PublicError: FixturePublicError, STRIPE_API_VERSION: 'fixture-version',
      base64Url: (value: Uint8Array) => Buffer.from(value).toString('base64url'),
      fromBase64Url: (value: string) => new Uint8Array(Buffer.from(value, 'base64url')),
      sha256: async (value: string) => { counts.fingerprint++; return createHash('sha256').update(value).digest('base64url'); },
      assertConfiguredStripeAccount: async () => { counts.account++; trace.push('stripe-account'); return { portalLoginUrl: 'https://billing.stripe.com/fixture' }; },
      assertConfiguredStripePortalLoginUrl: async () => { counts.portal++; trace.push('stripe-portal'); return 'https://billing.stripe.com/fixture'; },
      paidEntitlementForSubscription: unexpected, retrieveSubscription: unexpected, retrieveInvoice: unexpected,
      upsertSubscription: unexpected, validateActiveZentraSubscription: unexpected, validatePaidZentraInvoice: unexpected, referenceId: unexpected,
    },
    '@/lib/stripe-event': { stripeSecretKeyLivemode: (key: string) => /^sk_test_/.test(key) ? false : /^sk_live_/.test(key) ? true : null },
    '@/lib/account-security': { isAccountRole: unexpected }, '@/lib/team-seats': { requireMemberSeat: unexpected },
    '@/lib/founder-access': { offeredLicenseEntitlement: unexpected }, '@/lib/account-trial': { trialLicenseEntitlement: unexpected },
    '@/lib/complete/bridge': { transitionLicense: unexpected },
    '@/lib/owner-license-binding': { InvalidOwnerLicenseBindingConfiguration: Error, ownerLicenseBindingMatches: unexpected },
  };
  const permitted = new Set(['lib/deployment-contract.ts', 'lib/runtime.ts', 'lib/license-constants.ts', 'lib/plans.ts',
    'lib/license-token.ts', 'lib/stripe-readiness.ts', 'lib/stripe-webhook-proof.ts',
    // Actual prepaid reader and its pure calendar/catalog dependencies; no provider or mutation client.
    'lib/payments/prepaid-access.ts', 'lib/payments/prepaid-calendar.ts', 'lib/payments/prepaid-catalog.ts',
    'lib/support/plans.ts', 'lib/complete/plans.ts', 'lib/automation/types.ts']);
  const modules = new Map<string, { exports: Record<string, unknown> }>();
  const context = createContext({
    console: { error() {}, log() {} }, process: { env: {} }, crypto: webcrypto,
    URL, Request, Response, TextEncoder, TextDecoder, Uint8Array, Buffer,
    Date: class extends Date { static now() { return now; } },
    fetch: unexpected,
    ...(sandbox ? { __ZENTRA_DEPLOYMENT_PROFILE__: compiled } : {}),
  });
  function load(relative: string): Record<string, unknown> {
    const cached = modules.get(relative); if (cached) return cached.exports;
    if (relative === 'config/deployment-profile.production.json') return JSON.parse(readFileSync(join(sourceRoot, relative), 'utf8'));
    if (!permitted.has(relative)) throw Error('CLOSED_SOURCE_IMPORT_REFUSED');
    const module = { exports: {} as Record<string, unknown> }; modules.set(relative, module);
    const code = ts.transpileModule(readFileSync(join(sourceRoot, relative), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const requireFixture = (specifier: string): unknown => {
      const canonicalPath = specifier.startsWith('.') ? posix.normalize(posix.join(posix.dirname(relative), specifier))
        : specifier.startsWith('@/') ? specifier.slice(2) : specifier;
      if (Object.hasOwn(external, specifier)) return external[specifier];
      if (Object.hasOwn(external, '@/' + canonicalPath)) return external['@/' + canonicalPath];
      return load(/\.(json|ts)$/.test(canonicalPath) ? canonicalPath : canonicalPath + '.ts');
    };
    runInContext('(function(require,module,exports){\n' + code + '\n})', context, { filename: relative })(requireFixture, module, module.exports);
    if (relative === 'lib/license-token.ts') {
      const actual = module.exports.assertLicenseSignerReady as () => Promise<void>;
      module.exports.assertLicenseSignerReady = async () => {
        counts.signer++; trace.push('signer-start');
        try { await (productionSigner ? productionSigner() : actual()); trace.push('signer-accepted'); }
        catch (error) { trace.push('signer-refused'); throw error; }
      };
    }
    return module.exports;
  }
  return {
    readiness: load('lib/stripe-readiness.ts') as unknown as ClosedReadiness, counts, trace, env,
    setSigner(mode: 'selected' | 'foreign' | 'missing') { env.LICENSE_SIGNING_KEY_PKCS8_B64URL = mode === 'missing' ? '' : privateValue(mode === 'selected' ? selected.privateKey : foreign.privateKey); },
    clearEffects() { for (const name of Object.keys(counts) as (keyof typeof counts)[]) counts[name] = 0; trace.length = 0; },
    advance(seconds: number) { now += seconds * 1000; }, invalidateProof() { proofValid = false; },
  };
}
function expectNoReadinessEffects(fixture: ReturnType<typeof closedReadinessFixture>) {
  expect(fixture.counts).toMatchObject({ dbBindings: 0, prepare: 0, batch: 0, first: 0, account: 0, portal: 0, unexpected: 0 });
}

describe('sandbox readiness signer before all effects using actual closed runtime', () => {
  it.each(['foreign', 'missing'] as const)('cold checkout refuses %s signer before D1 or Stripe', async mode => {
    const fixture = closedReadinessFixture(); fixture.setSigner(mode);
    await expect(fixture.readiness.assertStripeCheckoutReady()).rejects.toMatchObject({ status: 503 });
    expectNoReadinessEffects(fixture);
  });
  it.each(['foreign', 'missing'] as const)('warm checkout refuses %s signer after valid cache preparation and clearing setup effects', async mode => {
    const fixture = closedReadinessFixture();
    await expect(fixture.readiness.assertStripeCheckoutReady()).resolves.toEqual({ portalLoginUrl: 'https://billing.stripe.com/fixture' });
    expect(fixture.counts).toMatchObject({ dbBindings: 4, prepare: 7, batch: 1, first: 1, account: 1 });
    fixture.clearEffects(); fixture.setSigner(mode);
    await expect(fixture.readiness.assertStripeCheckoutReady()).rejects.toMatchObject({ status: 503 });
    expectNoReadinessEffects(fixture);
  });
  it('normal sandbox retains its valid cache without repeating D1 or Stripe', async () => {
    const fixture = closedReadinessFixture(); await fixture.readiness.assertStripeCheckoutReady();
    fixture.clearEffects(); await expect(fixture.readiness.assertStripeCheckoutReady()).resolves.toEqual({ portalLoginUrl: 'https://billing.stripe.com/fixture' });
    expectNoReadinessEffects(fixture);
  });
  it.each(['foreign', 'missing'] as const)('checkout wrappers refuse %s signer without effects', async mode => {
    const fixture = closedReadinessFixture(); fixture.setSigner(mode);
    await expect(fixture.readiness.stripeCheckoutReadiness()).resolves.toBeNull(); expectNoReadinessEffects(fixture);
    fixture.clearEffects(); await expect(fixture.readiness.stripeCheckoutIsReady()).resolves.toBe(false); expectNoReadinessEffects(fixture);
  });
  it.each(['foreign', 'missing'] as const)('portal refuses %s signer before its provider fixture', async mode => {
    const fixture = closedReadinessFixture(); fixture.setSigner(mode);
    await expect(fixture.readiness.stripePortalLoginUrl()).resolves.toBeNull(); expectNoReadinessEffects(fixture);
  });
  it('normal sandbox portal remains available with a valid signer even when Checkout proof is down', async () => {
    const fixture = closedReadinessFixture(); fixture.invalidateProof();
    await expect(fixture.readiness.stripeCheckoutReadiness()).resolves.toBeNull(); fixture.clearEffects();
    await expect(fixture.readiness.stripePortalLoginUrl()).resolves.toBe('https://billing.stripe.com/fixture');
    expect(fixture.counts).toMatchObject({ dbBindings: 0, prepare: 0, batch: 0, first: 0, account: 0, portal: 1 });
  });
  it('production keeps parallel checks and its warm-cache hit avoids signer DB and Stripe', async () => {
    let acceptSigner: (() => void) | undefined;
    let markSignerStarted: (() => void) | undefined;
    const pendingSigner = new Promise<void>(resolve => { acceptSigner = resolve; });
    const signerStarted = new Promise<void>(resolve => { markSignerStarted = resolve; });
    const fixture = closedReadinessFixture(false, () => { markSignerStarted!(); return pendingSigner; });
    const ready = fixture.readiness.assertStripeCheckoutReady();
    await signerStarted;
    expect(fixture.counts).toMatchObject({ account: 1, prepare: 7, batch: 1, first: 1, signer: 1 });
    expect(fixture.trace).not.toContain('signer-accepted'); acceptSigner!(); await ready;
    fixture.clearEffects(); await fixture.readiness.assertStripeCheckoutReady(); expectNoReadinessEffects(fixture); expect(fixture.counts.signer).toBe(0);
    fixture.advance(61); await fixture.readiness.assertStripeCheckoutReady();
    expect(fixture.counts).toMatchObject({ account: 1, prepare: 7, batch: 1, first: 1, signer: 1 });
  });
  it('acknowledgement mismatch still fails before the signer or effects', async () => {
    const fixture = closedReadinessFixture(); delete fixture.env.ZENTRA_DEPLOYMENT_PROFILE_SHA256;
    await expect(fixture.readiness.assertStripeCheckoutReady()).rejects.toMatchObject({ status: 503 }); expectNoReadinessEffects(fixture);
  });
});

vi.mock('@/lib/stripe-event', () => ({
  stripeSecretKeyLivemode: vi.fn(() => false),
}));

vi.mock('@/lib/stripe-webhook-proof', () => ({
  SELECT_STRIPE_WEBHOOK_PROOF_SQL:
    'SELECT * FROM stripe_webhook_proofs WHERE endpoint_id=?',
  stripeWebhookProofMatches: (
    row: typeof stubs.proof | null,
    expected: {
      endpointId: string;
      secretSha256: string;
      livemode: boolean;
      apiVersion: string;
      now: number;
    },
  ) =>
    Boolean(
      row &&
      row.endpoint_id === expected.endpointId &&
      row.secret_sha256 === expected.secretSha256 &&
      row.livemode === (expected.livemode ? 1 : 0) &&
      row.api_version === expected.apiVersion &&
      row.verified_at <= expected.now + 300,
    ),
}));

import {
  assertStripeCheckoutReady,
  stripeCheckoutReadiness,
  stripePortalLoginUrl,
} from './stripe-readiness';

describe('Stripe checkout readiness', () => {
  it('retains the exact production cache input and isolates each sandbox hash/key/kid', async () => {
    const stripe = await import('@/lib/stripe'); stubs.discriminator = '';
    await assertStripeCheckoutReady('start'); const initialCalls = stubs.account.mock.calls.length;
    await assertStripeCheckoutReady('start'); expect(stubs.account.mock.calls.length).toBe(initialCalls);
    expect(stripe.sha256).toHaveBeenCalledWith(['sk_test_valid', 'whsec_valid', 'we_valid', 'start', 'price_start', 'A'.repeat(40), 'https://elyko.example', undefined, undefined].join('\u0000'));
    for (const suffix of ['hash-a\u0000sandbox-kid-a\u0000key-a', 'hash-b\u0000sandbox-kid-a\u0000key-a', 'hash-b\u0000sandbox-kid-b\u0000key-b']) {
      stubs.discriminator = suffix; await assertStripeCheckoutReady('start');
      expect(stripe.sha256).toHaveBeenCalledWith(expect.stringContaining(`\u0000${suffix}`));
    }
    expect(stubs.account.mock.calls.length).toBe(initialCalls + 3); stubs.discriminator = ''; vi.clearAllMocks();
  });
  it('keeps the cancellation portal available when Checkout is down', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubs.signer.mockRejectedValueOnce(new Error('signer unavailable'));

    await expect(stripeCheckoutReadiness()).resolves.toBeNull();
    await expect(stripePortalLoginUrl()).resolves.toBe(
      'https://billing.stripe.com/p/login/elyko',
    );
    expect(stubs.portal).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('returns the validated portal result instead of discarding it', async () => {
    const expected = {
      portalLoginUrl: 'https://billing.stripe.com/p/login/elyko',
    };

    await expect(assertStripeCheckoutReady()).resolves.toEqual(expected);
    await expect(stripeCheckoutReadiness()).resolves.toEqual(expected);
    expect(stubs.account).toHaveBeenCalledTimes(2);
  });
});
