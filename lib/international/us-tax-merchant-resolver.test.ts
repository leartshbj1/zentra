import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErpError } from './erp-contract';
import { STRIPE_TAX_API_VERSION } from './stripe-tax-resolved-request';
import type { StripeTaxTestSdkClient } from './stripe-tax-test-gateway';
import { resolveUsTaxTestMerchant, type UsTaxTestMerchantResolverOptions } from './us-tax-merchant-resolver';

const stripeState = vi.hoisted(() => ({ constructed: [] as { key: string; options: unknown }[], httpClient: {}, client: undefined as unknown }));
vi.mock('stripe', () => ({ default: Object.assign(function (key: string, options: unknown) {
  stripeState.constructed.push({ key, options }); return stripeState.client;
}, { createFetchHttpClient: () => stripeState.httpClient }) }));

/** MOCK SDK ONLY: no real key, provider call, Auth, admission or activation. */
const organizationId = 'fictitious-workspace-alpha', accountId = 'acct_FictitiousAlpha';
const key = 'rk_test_FictitiousMerchantAlpha123', otherKey = 'rk_test_FictitiousMerchantBeta456';
const now = '2026-10-10T12:00:00.000Z', seconds = Date.parse(now) / 1_000;
const taxOrigin = { country: 'US' as const, line1: '123 Fictitious Road', city: 'New York', subdivision: 'NY', postalCode: '10001' };
const descriptor = () => ({ organizationId, reference: 'merchant-alpha', revision: 1, accountId });
const otherDescriptor = () => ({ organizationId: 'fictitious-workspace-beta', reference: 'merchant-beta', revision: 2, accountId: 'acct_FictitiousBeta' });
function fixture() {
  const account = { id: accountId, object: 'account' };
  const balance = { object: 'balance', livemode: false };
  const settings = { object: 'tax.settings', livemode: false, status: 'active', defaults: { provider: 'stripe' }, head_office: { address: { country: 'US', line1: taxOrigin.line1, line2: null, city: taxOrigin.city, state: taxOrigin.subdivision, postal_code: taxOrigin.postalCode } } };
  const registration = { id: 'taxreg_FictitiousAlpha', object: 'tax.registration', status: 'active', livemode: false, country: 'US', country_options: { us: { state: 'NY', type: 'state_sales_tax' } }, created: seconds - 20, active_from: seconds - 10, expires_at: null };
  const retrieveCurrent = vi.fn(async () => structuredClone(account)), retrieveBalance = vi.fn(async () => structuredClone(balance));
  const retrieveSettings = vi.fn(async () => structuredClone(settings));
  const listRegistrations = vi.fn(async () => ({ object: 'list', url: '/v1/tax/registrations', has_more: false, data: [structuredClone(registration)] }));
  const createCalculation = vi.fn(async () => { throw new Error('No calculation expected'); });
  const client = { accounts: { retrieveCurrent }, balance: { retrieve: retrieveBalance }, tax: { settings: { retrieve: retrieveSettings }, registrations: { list: listRegistrations }, calculations: { create: createCalculation } }, taxCodes: { retrieve: vi.fn() } } as unknown as StripeTaxTestSdkClient;
  const createClient = vi.fn(() => client);
  const options: UsTaxTestMerchantResolverOptions = { organizationId, configurationJson: JSON.stringify({ schemaVersion: 1, merchants: [descriptor()] }), credentialsJson: JSON.stringify({ 'merchant-alpha': key }), now: () => now, createClient };
  return { options, createClient, client, account, balance, settings, registration, retrieveCurrent, retrieveBalance, retrieveSettings, listRegistrations, createCalculation };
}
async function denied(options: UsTaxTestMerchantResolverOptions, code = 'binding_unavailable', status = 409) {
  const error = await resolveUsTaxTestMerchant(options).then(() => null, value => value as unknown);
  expect(error).toBeInstanceOf(ErpError); expect(error).toMatchObject({ code, message: code, status });
  expect(error).not.toHaveProperty('cause'); expect(JSON.stringify(error)).not.toMatch(/rk_test_|sk_|PRIVATE|Fictitious|merchant-alpha/);
}
afterEach(() => { stripeState.constructed = []; stripeState.client = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('private workspace TEST merchant resolver (mock SDK only)', () => {
  it('resolves a frozen identity and private rotation fence without making a provider call', async () => {
    const f = fixture(), result = await resolveUsTaxTestMerchant(f.options);
    expect(result?.credential).toEqual({ reference: 'merchant-alpha', revision: 1, accountId });
    expect(result?.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result?.credential)).toBe(true);
    expect(Object.keys(result!)).toEqual(['credential', 'configurationFingerprint', 'gateway', 'observe']);
    expect(JSON.stringify(result)).not.toContain(key); expect(f.createClient).toHaveBeenCalledExactlyOnceWith(key);
    expect(f.retrieveCurrent).not.toHaveBeenCalled(); expect(f.createCalculation).not.toHaveBeenCalled();
  });
  it('constructs a separate SDK per resolution with pinned API, Fetch transport and no retries', async () => {
    const f = fixture(); stripeState.client = f.client;
    const { createClient: _factory, ...options } = f.options;
    const first = await resolveUsTaxTestMerchant(options), second = await resolveUsTaxTestMerchant(options);
    expect(first?.gateway).not.toBe(second?.gateway); expect(stripeState.constructed).toHaveLength(2);
    expect(stripeState.constructed[0]).toEqual({ key, options: { apiVersion: STRIPE_TAX_API_VERSION, httpClient: stripeState.httpClient, maxNetworkRetries: 0, timeout: 20_000, typescript: true } });
    expect(f.retrieveCurrent).not.toHaveBeenCalled();
  });
  it.each([
    ['', ''], [' \n ', '\t'], [JSON.stringify({ schemaVersion: 1, merchants: [] }), '{}'],
  ])('returns null for deliberately empty configuration', async (configurationJson, credentialsJson) => {
    const f = fixture(); expect(await resolveUsTaxTestMerchant({ ...f.options, configurationJson, credentialsJson })).toBeNull(); expect(f.createClient).not.toHaveBeenCalled();
  });
  it('returns null for an absent workspace only after validating the whole maps', async () => {
    const f = fixture(); expect(await resolveUsTaxTestMerchant({ ...f.options, organizationId: 'fictitious-unconfigured' })).toBeNull(); expect(f.createClient).not.toHaveBeenCalled();
    await denied({ ...f.options, organizationId: 'fictitious-unconfigured', credentialsJson: '{}' });
  });
  it.each([
    ['configurationJson', ''], ['credentialsJson', ''], ['configurationJson', '{"PRIVATE":'], ['credentialsJson', 'null'],
    ['configurationJson', '{"schemaVersion":2,"merchants":[]}'], ['configurationJson', '{"schemaVersion":1,"merchants":[],"actor":"owner"}'],
    ['configurationJson', '{"schemaVersion":1,"merchants":{}}'], ['credentialsJson', '[]'], ['credentialsJson', '{}'],
  ])('rejects malformed, partial and unsupported maps: %s %s', async (field, value) => {
    const f = fixture(); await denied({ ...f.options, [field]: value }); expect(f.createClient).not.toHaveBeenCalled();
  });
  it.each([
    { organizationId: 'foreign space' }, { reference: '' }, { reference: ' bad' }, { revision: 0 }, { revision: -1 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER },
    { accountId: 'acct_' }, { accountId: 'foreign' }, { accountId: 'acct_With_Underscore' }, { role: 'owner' }, { key },
  ])('rejects an invalid or extended descriptor %j', async changed => {
    const f = fixture(); await denied({ ...f.options, configurationJson: JSON.stringify({ schemaVersion: 1, merchants: [{ ...descriptor(), ...changed }] }) }); expect(f.createClient).not.toHaveBeenCalled();
  });
  it.each(['rk_live_Private', 'sk_test_Private', 'sk_live_Private', 'pk_test_Private', 'rk_test_', ' rk_test_Private', 'rk_test_Private\n', 'rk_test_Private_invalid'])('rejects unsupported credential %s', async badKey => {
    const f = fixture(); await denied({ ...f.options, credentialsJson: JSON.stringify({ 'merchant-alpha': badKey }) }); expect(f.createClient).not.toHaveBeenCalled();
  });
  it('rejects a key equal to any configured SaaS key without constructing an SDK', async () => {
    const f = fixture(); await denied({ ...f.options, forbiddenSaasKeys: ['sk_test_FictitiousSaas', key] }); expect(f.createClient).not.toHaveBeenCalled();
  });
  it('compares the trimmed effective SaaS secret from deployment configuration', async () => {
    const f = fixture(); await denied({ ...f.options, forbiddenSaasKeys: [` \n${key}\t `] }); expect(f.createClient).not.toHaveBeenCalled();
  });
  it.each(['organizationId', 'accountId', 'reference'] as const)('rejects reused %s across descriptors', async field => {
    const f = fixture(), second = { ...otherDescriptor(), [field]: descriptor()[field] };
    await denied({ ...f.options, configurationJson: JSON.stringify({ schemaVersion: 1, merchants: [descriptor(), second] }), credentialsJson: JSON.stringify({ 'merchant-alpha': key, 'merchant-beta': otherKey }) }); expect(f.createClient).not.toHaveBeenCalled();
  });
  it('rejects cross-workspace reuse of the same credential value', async () => {
    const f = fixture(); await denied({ ...f.options, configurationJson: JSON.stringify({ schemaVersion: 1, merchants: [descriptor(), otherDescriptor()] }), credentialsJson: JSON.stringify({ 'merchant-alpha': key, 'merchant-beta': key }) });
  });
  it('rejects orphan credentials and malformed unrelated mappings', async () => {
    const f = fixture(); await denied({ ...f.options, credentialsJson: JSON.stringify({ 'merchant-alpha': key, 'merchant-orphan': otherKey }) });
    await denied({ ...f.options, configurationJson: JSON.stringify({ schemaVersion: 1, merchants: [descriptor(), otherDescriptor()] }), credentialsJson: JSON.stringify({ 'merchant-alpha': key, 'merchant-beta': 'sk_live_PRIVATE' }) });
  });
  it.each([
    ['credentialsJson', `{"merchant-alpha":"${key}","merchant-alpha":"${otherKey}"}`],
    ['credentialsJson', `{"merchant-alpha":"${key}","merchant-\\u0061lpha":"${otherKey}"}`],
    ['configurationJson', `{"schemaVersion":1,"schemaVersion":1,"merchants":[${JSON.stringify(descriptor())}]}`],
    ['configurationJson', `{"schemaVersion":1,"merchants":[{"organizationId":"${organizationId}","reference":"merchant-alpha","revision":1,"revision":2,"accountId":"${accountId}"}]}`],
  ])('rejects duplicate raw JSON members even when escaped: %s', async (field, value) => {
    const f = fixture(); await denied({ ...f.options, [field]: value }); expect(f.createClient).not.toHaveBeenCalled();
  });
  it('bounds map bytes and merchant count before SDK construction', async () => {
    const f = fixture(); await denied({ ...f.options, configurationJson: ' '.repeat(65_536) + f.options.configurationJson });
    await denied({ ...f.options, configurationJson: JSON.stringify({ schemaVersion: 1, merchants: Array.from({ length: 129 }, descriptor) }) }); expect(f.createClient).not.toHaveBeenCalled();
  });
  it('changes its fingerprint for selected mapping or key rotation, but not JSON order or unrelated rotation', async () => {
    const f = fixture(), original = (await resolveUsTaxTestMerchant(f.options))!.configurationFingerprint;
    const reordered = { ...f.options, configurationJson: JSON.stringify({ merchants: [{ accountId, revision: 1, reference: 'merchant-alpha', organizationId }], schemaVersion: 1 }, null, 2) };
    expect((await resolveUsTaxTestMerchant(reordered))!.configurationFingerprint).toBe(original);
    const rotated = await resolveUsTaxTestMerchant({ ...f.options, credentialsJson: JSON.stringify({ 'merchant-alpha': otherKey }) }); expect(rotated!.configurationFingerprint).not.toBe(original);
    for (const changed of [{ revision: 2 }, { accountId: 'acct_FictitiousChanged' }]) expect((await resolveUsTaxTestMerchant({ ...f.options, configurationJson: JSON.stringify({ schemaVersion: 1, merchants: [{ ...descriptor(), ...changed }] }) }))!.configurationFingerprint).not.toBe(original);
    const multiple = { ...f.options, configurationJson: JSON.stringify({ schemaVersion: 1, merchants: [otherDescriptor(), descriptor()] }), credentialsJson: JSON.stringify({ 'merchant-beta': otherKey, 'merchant-alpha': key }) };
    expect((await resolveUsTaxTestMerchant(multiple))!.configurationFingerprint).toBe(original);
    expect((await resolveUsTaxTestMerchant({ ...multiple, credentialsJson: JSON.stringify({ 'merchant-alpha': key, 'merchant-beta': 'rk_test_FictitiousRotatedBeta' }) }))!.configurationFingerprint).toBe(original);
  });
  it('captures its options before the asynchronous digest', async () => {
    const f = fixture(), options = { ...f.options }, originalFactory = f.createClient;
    const operation = resolveUsTaxTestMerchant(options);
    options.organizationId = 'foreign'; options.credentialsJson = '{}'; options.createClient = () => { throw new Error('PRIVATE_LATE_FACTORY'); };
    const result = await operation; expect(result?.credential.accountId).toBe(accountId); expect(originalFactory).toHaveBeenCalledExactlyOnceWith(key);
  });
  it('sanitizes SDK construction failure without retaining a cause', async () => {
    const f = fixture(); await denied({ ...f.options, createClient: () => { throw new Error(`PRIVATE ${key}`); } }, 'service_unavailable', 503);
  });
  it('rejects execution in a browser context', async () => {
    const f = fixture(); vi.stubGlobal('window', {}); await denied(f.options); expect(f.createClient).not.toHaveBeenCalled();
  });
  it('observes authenticated account, TEST mode, tax origin and active registrations through the existing gateway', async () => {
    const f = fixture(), result = (await resolveUsTaxTestMerchant(f.options))!;
    const observation = await result.observe(taxOrigin);
    expect(observation).toMatchObject({ organizationId, accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, observedAt: now, taxOrigin });
    expect(observation.settingsSha256).toMatch(/^[a-f0-9]{64}$/); expect(observation.registrationsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(observation).not.toHaveProperty('revision'); expect(observation).not.toHaveProperty('status'); expect(JSON.stringify(observation)).not.toContain(key);
    expect(f.retrieveCurrent).toHaveBeenCalledExactlyOnceWith({}, { apiVersion: STRIPE_TAX_API_VERSION, maxNetworkRetries: 0, timeout: 20_000 });
    expect(f.listRegistrations).toHaveBeenCalledExactlyOnceWith({ status: 'active', limit: 100 }, { apiVersion: STRIPE_TAX_API_VERSION, maxNetworkRetries: 0, timeout: 20_000 }); expect(f.createCalculation).not.toHaveBeenCalled();
  });
  it.each(['wrong_account', 'live', 'no_us_registration', 'wrong_origin'] as const)('does not treat restricted-key syntax as provider proof: %s', async mismatch => {
    const f = fixture();
    if (mismatch === 'wrong_account') f.account.id = 'acct_FictitiousForeign';
    if (mismatch === 'live') f.balance.livemode = true;
    if (mismatch === 'no_us_registration') f.registration.country = 'DE';
    if (mismatch === 'wrong_origin') f.settings.head_office.address.line1 = 'Foreign origin';
    const result = (await resolveUsTaxTestMerchant(f.options))!;
    const error = await result.observe(taxOrigin).then(() => null, value => value as unknown);
    expect(error).toBeInstanceOf(ErpError); expect(JSON.stringify(error)).not.toContain(key); expect(f.createCalculation).not.toHaveBeenCalled();
  });
  it('keeps provider and clock errors sanitized through observation', async () => {
    const f = fixture(); f.retrieveCurrent.mockRejectedValueOnce(new Error(`PRIVATE ${key}`));
    const result = (await resolveUsTaxTestMerchant(f.options))!;
    await expect(result.observe(taxOrigin)).rejects.toMatchObject({ code: 'service_unavailable', message: 'service_unavailable', status: 503 });
    const badClock = (await resolveUsTaxTestMerchant({ ...f.options, now: () => { throw new Error(`PRIVATE ${key}`); } }))!;
    await expect(badClock.observe(taxOrigin)).rejects.toMatchObject({ code: 'server_clock_unavailable', message: 'server_clock_unavailable', status: 503 });
  });
});
