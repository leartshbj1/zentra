import { afterEach, describe, expect, it, vi } from 'vitest';

const publicSandbox = {
  schemaVersion: 1, kind: 'sandbox', profileId: 'sandbox-fixture', siteOrigin: 'https://sandbox.example',
  supabaseOrigin: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', license: { kid: 'sandbox-fixture-v1', publicKeyB64url: 'A'.repeat(43) },
  identifiers: { windows: 'ch.zentra.sandbox.windows', macos: 'ch.zentra.sandbox.macos', mobile: 'ch.zentra.sandbox.mobile' },
  productName: 'Zentra Sandbox', binaryName: 'ZentraSandbox', updater: 'disabled', sha256: 'a'.repeat(64),
};
function matchingBindings() { return {
  ZENTRA_DEPLOYMENT_KIND: 'sandbox', ZENTRA_DEPLOYMENT_PROFILE_ID: publicSandbox.profileId,
  ZENTRA_DEPLOYMENT_PROFILE_SHA256: publicSandbox.sha256, PUBLIC_SITE_URL: publicSandbox.siteOrigin,
  SUPABASE_URL: publicSandbox.supabaseOrigin, STRIPE_SECRET_KEY: 'sk_test_fixture',
}; }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
async function selected(value: unknown = publicSandbox) {
  vi.resetModules(); vi.stubGlobal('__ZENTRA_DEPLOYMENT_PROFILE__', value); return import('@/lib/deployment-contract');
}
describe('immutable compiled deployment contract', () => {
  it('defaults to the existing production kid/key and no readiness discriminator', async () => {
    const m = await import('@/lib/deployment-contract');
    expect(m.deploymentProfile).toMatchObject({ kind: 'production', license: { kid: 'hc-prod-v1', publicKeyB64url: 'FySkIPXpEIfZ9UCBlXuhFAgFx3LpchgBFWTh65Aa040' } });
    expect(m.deploymentReadinessDiscriminator()).toBe('');
    expect(() => m.assertDeploymentRuntime(() => '')).not.toThrow();
  });
  it('copies/fixes the public selected contract, independent of later env or input mutation', async () => {
    const input = structuredClone(publicSandbox); const m = await selected(input);
    input.siteOrigin = 'https://zentraapp.ch'; input.license.kid = 'hc-prod-v1';
    vi.stubEnv('ZENTRA_BUILD_KIND', 'production');
    expect(m.deploymentProfile.siteOrigin).toBe(publicSandbox.siteOrigin);
    expect(m.deploymentProfile.license.kid).toBe(publicSandbox.license.kid);
    expect(Object.isFrozen(m.deploymentProfile.license)).toBe(true);
  });
  it.each([
    { ...publicSandbox, kind: 'other' }, { ...publicSandbox, sha256: '' },
    { ...publicSandbox, secret: 'must-not-embed' }, { ...publicSandbox, siteOrigin: 'https://zentraapp.ch' },
    { ...publicSandbox, siteOrigin: 'https://sandbox.example/path' }, { ...publicSandbox, supabaseOrigin: 'https://xvfohjdlhlirksrvkiqu.supabase.co' },
    { ...publicSandbox, license: { ...publicSandbox.license, kid: 'hc-prod-v1' } },
    { ...publicSandbox, license: { ...publicSandbox.license, publicKeyB64url: 'A'.repeat(42) + 'B' } },
  ])('refuses an incoherent compiled contract before use (%#)', async input => {
    await expect(selected(input)).rejects.toMatchObject({ status: 503, message: 'ZENTRA_DEPLOYMENT_PROFILE_MISMATCH' });
  });
  it('refuses runtime selection of sandbox in a production artifact', async () => {
    const m = await import('@/lib/deployment-contract');
    expect(() => m.assertDeploymentRuntime(name => (matchingBindings() as Record<string, string>)[name] ?? '')).toThrow();
  });
  it('accepts only matching runtime acknowledgement and origin', async () => {
    const m = await selected(); const bindings = matchingBindings();
    expect(() => m.assertDeploymentRuntime(name => (bindings as Record<string, string>)[name] ?? '', new Request(publicSandbox.siteOrigin))).not.toThrow();
  });
  it.each([
    ['ZENTRA_DEPLOYMENT_KIND', ''], ['ZENTRA_DEPLOYMENT_PROFILE_ID', ''], ['ZENTRA_DEPLOYMENT_PROFILE_SHA256', ''],
    ['ZENTRA_DEPLOYMENT_KIND', 'production'], ['ZENTRA_DEPLOYMENT_PROFILE_SHA256', 'b'.repeat(64)],
    ['PUBLIC_SITE_URL', ''], ['PUBLIC_SITE_URL', 'https://zentraapp.ch'], ['PUBLIC_SITE_URL', publicSandbox.siteOrigin + '/'],
    ['SUPABASE_URL', ''], ['SUPABASE_URL', 'https://zgmkzsoxwlgqhjxgvcbo.supabase.co'],
    ['SITE_ORIGIN_ALIASES', 'https://zentraapp.ch'], ['NEXT_PUBLIC_SITE_URL', 'https://zentraapp.ch'],
    ['STRIPE_SECRET_KEY', 'sk_live_fixture'], ['OWNER_LICENSE_BINDING_SHA256', 'do-not-log'],
    ['STRIPE_WEBHOOK_URL', 'https://zentraapp.ch/api/stripe/webhook'], ['STRIPE_WEBHOOK_URL', 'https://sandbox.example/wrong'],
    ['FOUNDER_ADMIN_PUBLIC_KEY_B64URL', 'do-not-log'], ['PHASE2_RESET_MODE', 'enabled'],
  ])('refuses sandbox runtime contradiction %s', async (key, value) => {
    const m = await selected(); const bindings = { ...matchingBindings(), [key]: value };
    expect(() => m.assertDeploymentRuntime(name => (bindings as Record<string, string>)[name] ?? '')).toThrow('ZENTRA_DEPLOYMENT_PROFILE_MISMATCH');
  });
  it.each(['https://zentraapp.ch', 'https://sandbox.example.evil.test', 'http://sandbox.example', 'https://sandbox.example:8443'])('refuses request origin %s', async origin => {
    const m = await selected(); const bindings = matchingBindings();
    expect(() => m.assertDeploymentRuntime(name => (bindings as Record<string, string>)[name] ?? '', new Request(origin))).toThrow();
  });
  it('readiness discriminator includes the fixed profile hash, kid and public key', async () => {
    const m = await selected(); expect(m.deploymentReadinessDiscriminator()).toBe([publicSandbox.sha256, publicSandbox.license.kid, publicSandbox.license.publicKeyB64url].join('\u0000'));
  });
});
