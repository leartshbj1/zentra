import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  handler: vi.fn(() => new Response('fixture-handler')),
  auth: vi.fn((configuration: unknown) => ({ configuration })),
  server: vi.fn((configuration: unknown) => ({ configuration })),
}));
vi.mock('cloudflare:workers', () => ({ env: stubs.env }));
vi.mock('vinext/server/fetch-handler', () => ({ default: { fetch: stubs.handler } }));
vi.mock('@/lib/supabase-auth', async importOriginal => ({ ...await importOriginal<object>(), createSupabaseAuthClient: stubs.auth }));
vi.mock('@/lib/supabase-server', () => ({ createSupabaseServerClient: stubs.server }));

const publicSandbox = {
  schemaVersion: 1, kind: 'sandbox', profileId: 'sandbox-fixture', siteOrigin: 'https://sandbox.example',
  supabaseOrigin: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', license: { kid: 'sandbox-fixture-v1', publicKeyB64url: 'A'.repeat(43) },
  identifiers: { windows: 'ch.zentra.sandbox.windows', macos: 'ch.zentra.sandbox.macos', mobile: 'ch.zentra.sandbox.mobile' },
  productName: 'Zentra Sandbox', binaryName: 'ZentraSandbox', updater: 'disabled', sha256: 'a'.repeat(64),
};
function configure() {
  vi.stubGlobal('__ZENTRA_DEPLOYMENT_PROFILE__', publicSandbox);
  Object.assign(stubs.env, {
    ZENTRA_DEPLOYMENT_KIND: 'sandbox', ZENTRA_DEPLOYMENT_PROFILE_ID: publicSandbox.profileId,
    ZENTRA_DEPLOYMENT_PROFILE_SHA256: publicSandbox.sha256, PUBLIC_SITE_URL: publicSandbox.siteOrigin,
    SUPABASE_URL: publicSandbox.supabaseOrigin, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'a'.repeat(16),
    SUPABASE_SECRET_KEY: 'fixture-only-not-a-key', STRIPE_SECRET_KEY: 'sk_test_fixture',
    DB: { fixture: 'db' }, FILES: { fixture: 'files' },
  });
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  for (const key of Object.keys(stubs.env)) delete stubs.env[key];
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('closed sandbox runtime effect boundaries', () => {
  it('worker rejects missing acknowledgement before the real handler with a fixed response and no raw logs', async () => {
    configure(); delete stubs.env.ZENTRA_DEPLOYMENT_PROFILE_SHA256;
    stubs.env.SUPABASE_SECRET_KEY = 'sensitive-fixture-sentinel';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { default: worker } = await import('@/worker');
    const response = worker.fetch(new Request(publicSandbox.siteOrigin), stubs.env, {} as ExecutionContext) as Response;
    expect(response.status).toBe(503); expect(await response.text()).toBe('ZENTRA_DEPLOYMENT_PROFILE_MISMATCH');
    expect(stubs.handler).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); log.mockRestore();
  });
  it('worker passes an acknowledged request through the unchanged CSP handler', async () => {
    configure(); const { default: worker } = await import('@/worker');
    const request = new Request(publicSandbox.siteOrigin); const context = {} as ExecutionContext;
    const result = worker.fetch(request, stubs.env, context) as Response;
    expect(await result.text()).toBe('fixture-handler'); expect(stubs.handler).toHaveBeenCalledWith(expect.any(Request), stubs.env, context);
  });
  it('production worker still allows the original handler without metadata or sandbox fixtures', async () => {
    const { default: worker } = await import('@/worker');
    const result = worker.fetch(new Request('https://zentraapp.ch'), stubs.env, {} as ExecutionContext) as Response;
    expect(await result.text()).toBe('fixture-handler'); expect(stubs.handler).toHaveBeenCalledTimes(1);
  });
  it.each(['database', 'fileArchive', 'stripeConfiguration'] as const)('direct %s refuses missing acknowledgement before returning effect handles', async entry => {
    configure(); delete stubs.env.ZENTRA_DEPLOYMENT_KIND;
    const runtime = await import('@/lib/runtime'); expect(() => runtime[entry]()).toThrow('ZENTRA_DEPLOYMENT_PROFILE_MISMATCH');
  });
  it('direct Auth, optional Auth, server and realtime refuse missing acknowledgement before creating any client', async () => {
    configure(); delete stubs.env.ZENTRA_DEPLOYMENT_PROFILE_ID;
    const auth = await import('@/lib/supabase-auth-runtime'); const server = await import('@/lib/supabase-server-runtime');
    expect(() => auth.supabaseAuthConfiguration()).toThrow(); expect(() => auth.supabaseAuthClient()).toThrow();
    expect(auth.optionalSupabaseAuthClient()).toBeNull(); expect(() => auth.supabaseAuthSiteOrigin(new Request(publicSandbox.siteOrigin))).toThrow();
    expect(() => server.supabaseServerClient()).toThrow(); expect(() => server.supabaseRealtimeConfiguration()).toThrow();
    expect(stubs.auth).not.toHaveBeenCalled(); expect(stubs.server).not.toHaveBeenCalled();
  });
  it.each([
    ['SUPABASE_URL', 'https://xvfohjdlhlirksrvkiqu.supabase.co'],
    ['SUPABASE_URL', 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co.evil.test'],
    ['PUBLIC_SITE_URL', 'https://zentraapp.ch'], ['SITE_ORIGIN_ALIASES', 'https://zentraapp.ch'],
    ['STRIPE_SECRET_KEY', 'sk_live_fixture'], ['OWNER_LICENSE_BINDING_SHA256', 'fixture-owner-shortcut'],
    ['STRIPE_WEBHOOK_URL', 'https://zentraapp.ch/api/stripe/webhook'],
  ])('all direct effect entry points refuse %s=%s before provider/DB', async (name, value) => {
    configure(); stubs.env[name] = value;
    const runtime = await import('@/lib/runtime'); const auth = await import('@/lib/supabase-auth-runtime'); const server = await import('@/lib/supabase-server-runtime');
    for (const operation of [runtime.database, runtime.fileArchive, runtime.stripeConfiguration, auth.supabaseAuthClient, server.supabaseServerClient, server.supabaseRealtimeConfiguration]) expect(operation).toThrow();
    expect(stubs.auth).not.toHaveBeenCalled(); expect(stubs.server).not.toHaveBeenCalled();
  });
  it('acknowledged test configuration returns the existing handles and scoped public project', async () => {
    configure(); const runtime = await import('@/lib/runtime'); const auth = await import('@/lib/supabase-auth-runtime'); const server = await import('@/lib/supabase-server-runtime');
    expect(runtime.database()).toBe(stubs.env.DB); expect(runtime.fileArchive()).toBe(stubs.env.FILES);
    expect(runtime.stripeConfiguration()).toMatchObject({ secretKey: 'sk_test_fixture', siteUrl: publicSandbox.siteOrigin });
    expect(auth.supabaseAuthConfiguration()).toEqual({ url: publicSandbox.supabaseOrigin, publishableKey: stubs.env.SUPABASE_PUBLISHABLE_KEY });
    auth.supabaseAuthClient(); const first = server.supabaseServerClient(); expect(server.supabaseServerClient()).toBe(first);
    expect(stubs.server).toHaveBeenCalledTimes(1); expect(server.supabaseRealtimeConfiguration()).toEqual({ url: publicSandbox.supabaseOrigin, secretKey: stubs.env.SUPABASE_SECRET_KEY });
    delete stubs.env.ZENTRA_DEPLOYMENT_PROFILE_SHA256;
    expect(() => server.supabaseServerClient()).toThrow(); expect(stubs.server).toHaveBeenCalledTimes(1);
  });
  it('sandbox links build without service bindings, never fall back, and reject absolute foreign destinations', async () => {
    vi.stubGlobal('__ZENTRA_DEPLOYMENT_PROFILE__', publicSandbox);
    const urls = await import('@/lib/site-url');
    expect(urls.publicSiteUrl()).toBe(publicSandbox.siteOrigin);
    expect(urls.absoluteSiteUrl('/support/espace?section=inbox')).toBe(publicSandbox.siteOrigin + '/support/espace?section=inbox');
    expect(() => urls.absoluteSiteUrl('https://zentraapp.ch/compte')).toThrow();
    expect(() => urls.absoluteSiteUrl('//zentraapp.ch/compte')).toThrow();
    vi.stubEnv('PUBLIC_SITE_URL', 'https://zentraapp.ch'); expect(() => urls.publicSiteUrl()).toThrow();
  });
  it.each([undefined, '', 'bad-url', 'http://local.example', 'https://user:password@example.test',
    'https://custom.example/path?query=yes#fragment', 'https://custom.example/'])('production URL normalization preserves baseline %s', async configured => {
    vi.stubEnv('PUBLIC_SITE_URL', configured); vi.stubEnv('NEXT_PUBLIC_SITE_URL', undefined);
    const urls = await import('@/lib/site-url');
    const expected = configured?.startsWith('https://custom.example') ? 'https://custom.example' : 'https://zentraapp.ch';
    expect(urls.publicSiteUrl()).toBe(expected);
    expect(urls.absoluteSiteUrl('/compte')).toBe(expected + '/compte');
  });
  it('runtime metadata never changes the production key, URL fallback or test access behavior', async () => {
    Object.assign(stubs.env, { ZENTRA_DEPLOYMENT_KIND: 'sandbox' });
    const { LICENSE_KEY_ID, LICENSE_PUBLIC_KEY_B64URL } = await import('@/lib/license-constants');
    const runtime = await import('@/lib/runtime');
    expect(LICENSE_KEY_ID).toBe('hc-prod-v1'); expect(LICENSE_PUBLIC_KEY_B64URL).toBe('FySkIPXpEIfZ9UCBlXuhFAgFx3LpchgBFWTh65Aa040');
    expect(() => runtime.database()).toThrow('ZENTRA_DEPLOYMENT_PROFILE_MISMATCH');
  });
});
