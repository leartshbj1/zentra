import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertEffectiveSandboxConfig, canonicalOrigin, MAX_PROFILE_BYTES, parseProfileText, profileFingerprint, selectDeploymentProfile, validateProfile } from './deployment-profile.mjs';

// Non-provisioned PUBLIC values only. The all-zero bytes are not a service key
// or usable fixture signer. There is no private/API/SMTP credential in a profile.
const production = JSON.parse(readFileSync(new URL('../config/deployment-profile.production.json', import.meta.url), 'utf8'));
function sandbox() { return {
  ...structuredClone(production), kind: 'sandbox', profileId: 'sandbox-fixture', siteOrigin: 'https://sandbox.example',
  supabaseOrigin: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', license: { kid: 'sandbox-fixture-v1', publicKeyB64url: 'A'.repeat(43) },
  identifiers: { windows: 'ch.zentra.sandbox.windows', macos: 'ch.zentra.sandbox.macos', mobile: 'ch.zentra.sandbox.mobile' },
  productName: 'Zentra Sandbox', binaryName: 'ZentraSandbox', updater: 'disabled'
}; }
const refusal = error => error.message === 'ZENTRA_DEPLOYMENT_PROFILE_INVALID';
const fixtureDir = mkdtempSync(join(tmpdir(), 'zentra-profile-contract-'));
const validPath = join(fixtureDir, 'public-profile.json'); writeFileSync(validPath, JSON.stringify(sandbox()));

test('default is the exact current public production contract, deeply frozen', () => {
  const selected = selectDeploymentProfile({});
  assert.deepEqual(selected, { ...production, sha256: profileFingerprint(production) });
  assert.equal(selected.license.kid, 'hc-prod-v1'); assert.equal(selected.license.publicKeyB64url, 'FySkIPXpEIfZ9UCBlXuhFAgFx3LpchgBFWTh65Aa040');
  assert.ok(Object.isFrozen(selected) && Object.isFrozen(selected.license) && Object.isFrozen(selected.identifiers));
});
test('strict public schema declares the same closed keys and no credential fields', () => {
  const schema = JSON.parse(readFileSync(new URL('../config/deployment-profile.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.required.slice().sort(), Object.keys(production).sort());
  assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.license.additionalProperties, false);
});
test('valid sandbox has a deterministic canonical hash independent of object key order', () => {
  const selected = selectDeploymentProfile({ ZENTRA_BUILD_KIND: 'sandbox', ZENTRA_BUILD_PROFILE_FILE: validPath });
  assert.equal(selected.kind, 'sandbox'); assert.equal(selected.sha256, profileFingerprint(sandbox()));
  assert.equal(profileFingerprint(Object.fromEntries(Object.entries(sandbox()).reverse())), selected.sha256);
});
test('historical build secrets and endpoints cannot select or contaminate a profile', () => {
  const selected = selectDeploymentProfile({ ZENTRA_BUILD_KIND: 'sandbox', ZENTRA_BUILD_PROFILE_FILE: validPath,
    LICENSE_PUBLIC_KEY_B64URL: production.license.publicKeyB64url, ELYKO_ACCOUNT_SITE: production.siteOrigin,
    ELYKO_UPDATER_PUBLIC_KEY: 'do-not-embed', STRIPE_SECRET_KEY: 'do-not-embed' });
  assert.equal(selected.siteOrigin, sandbox().siteOrigin); assert.ok(!JSON.stringify(selected).includes('do-not-embed'));
});
for (const [label, env] of [
  ['missing file', { ZENTRA_BUILD_KIND: 'sandbox' }], ['missing kind', { ZENTRA_BUILD_PROFILE_FILE: validPath }],
  ['empty kind', { ZENTRA_BUILD_KIND: '', ZENTRA_BUILD_PROFILE_FILE: validPath }],
  ['unknown kind', { ZENTRA_BUILD_KIND: 'preview', ZENTRA_BUILD_PROFILE_FILE: validPath }],
  ['wrong kind', { ZENTRA_BUILD_KIND: 'production', ZENTRA_BUILD_PROFILE_FILE: validPath }],
  ['relative path', { ZENTRA_BUILD_KIND: 'sandbox', ZENTRA_BUILD_PROFILE_FILE: 'public-profile.json' }],
  ['traversal path', { ZENTRA_BUILD_KIND: 'sandbox', ZENTRA_BUILD_PROFILE_FILE: `${fixtureDir}/../profile.json` }],
  ['missing path', { ZENTRA_BUILD_KIND: 'sandbox', ZENTRA_BUILD_PROFILE_FILE: join(fixtureDir, 'missing.json') }],
  ['directory', { ZENTRA_BUILD_KIND: 'sandbox', ZENTRA_BUILD_PROFILE_FILE: fixtureDir }],
]) test(`selection refuses ${label}`, () => assert.throws(() => selectDeploymentProfile(env), refusal));
for (const [label, text] of [
  ['empty', ''], ['malformed', '{'], ['trailing input', '{} {}'], ['root scalar', 'null'],
  ['plain duplicate', '{"kind":"sandbox","kind":"production"}'], ['escaped duplicate', '{"kind":"sandbox","k\\u0069nd":"production"}'],
  ['nested duplicate', '{"license":{"kid":"one","k\\u0069d":"two"}}'],
  ['too deep', '['.repeat(8) + '0' + ']'.repeat(8)], ['too large', ' '.repeat(MAX_PROFILE_BYTES + 1)],
]) test(`parser/shape refuses ${label}`, () => assert.throws(() => validateProfile(parseProfileText(text)), refusal));
for (const [label, mutate] of [
  ['unknown field', p => p.apiKey = 'do-not-embed'], ['private key', p => p.license.privateKey = 'do-not-embed'],
  ['missing license', p => delete p.license], ['array license', p => p.license = []],
  ['wrong version', p => p.schemaVersion = 2], ['invalid id', p => p.profileId = '../sandbox'],
  ['long id', p => p.profileId = 'sandbox-' + 'a'.repeat(50)],
  ['production kid', p => p.license.kid = production.license.kid], ['production public key', p => p.license.publicKeyB64url = production.license.publicKeyB64url],
  ['wrong key length', p => p.license.publicKeyB64url = 'A'.repeat(42)], ['padded key', p => p.license.publicKeyB64url += '='],
  ['noncanonical key', p => p.license.publicKeyB64url = 'A'.repeat(42) + 'B'],
  ['key object', p => p.license.publicKeyB64url = {}], ['empty kid', p => p.license.kid = ''],
  ['wrong platform identity', p => p.identifiers.windows = production.identifiers.windows],
  ['wrong product name', p => p.productName = 'Zentra'], ['wrong binary name', p => p.binaryName = 'Zentra'],
  ['enabled updater', p => p.updater = 'production'], ['absent project', p => p.supabaseOrigin = null],
  ['current production project', p => p.supabaseOrigin = 'https://xvfohjdlhlirksrvkiqu.supabase.co'],
  ['old production project', p => p.supabaseOrigin = 'https://zgmkzsoxwlgqhjxgvcbo.supabase.co'],
  ['production host', p => p.siteOrigin = production.siteOrigin], ['production www host', p => p.siteOrigin = 'https://www.zentraapp.ch'],
  ['historical host', p => p.siteOrigin = 'https://elyko.alb-leart1.chatgpt.site'],
]) test(`closed manifest refuses ${label}`, () => { const p = sandbox(); mutate(p); assert.throws(() => validateProfile(p, 'sandbox'), refusal); });
test('an explicitly selected distinct subdomain is not accepted as a production alias', () => {
  const p=sandbox();p.siteOrigin='https://sandbox.zentraapp.ch';assert.equal(validateProfile(p,'sandbox').siteOrigin,p.siteOrigin);
});
test('file input is bounded and refuses invalid UTF-8', () => {
  const bad=join(fixtureDir,'bad-encoding.json');writeFileSync(bad,Buffer.from([0xff,0xfe]));
  assert.throws(()=>selectDeploymentProfile({ZENTRA_BUILD_KIND:'sandbox',ZENTRA_BUILD_PROFILE_FILE:bad}),refusal);
  const giant=join(fixtureDir,'giant.json');writeFileSync(giant,' '.repeat(MAX_PROFILE_BYTES+1));
  assert.throws(()=>selectDeploymentProfile({ZENTRA_BUILD_KIND:'sandbox',ZENTRA_BUILD_PROFILE_FILE:giant}),refusal);
});
for (const origin of ['http://sandbox.example', 'https://sandbox.example/', 'https://sandbox.example:443', 'https://sandbox.example:8443',
  'https://user@sandbox.example', 'https://sandbox.example/path', 'https://sandbox.example?x=1', 'https://sandbox.example#x',
  'https://%73andbox.example', 'https://SANDBOX.example', ' https://sandbox.example', 'https://sandbox.example..', 'https://localhost']) {
  test(`origin parser refuses ${origin}`, () => assert.throws(() => canonicalOrigin(origin), refusal));
}
test('regular-file selection refuses a reparse junction ancestor', () => {
  const target = join(fixtureDir, 'target'); mkdirSync(target); writeFileSync(join(target, 'profile.json'), JSON.stringify(sandbox()));
  const link = join(fixtureDir, 'link'); symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => selectDeploymentProfile({ ZENTRA_BUILD_KIND: 'sandbox', ZENTRA_BUILD_PROFILE_FILE: join(link, 'profile.json') }), refusal);
});
for (const platform of ['windows', 'macos', 'mobile']) test(`effective ${platform} config is checked after overlays`, () => {
  const p = sandbox(); const config = { identifier: p.identifiers[platform], productName: p.productName, mainBinaryName: p.binaryName,
    plugins: { updater: { active: false } }, bundle: { windows: { nsis: { installerHooks: null } } }, app: { windows: [{ title: p.productName }] } };
  assert.equal(assertEffectiveSandboxConfig(p, config, platform), true);
  assert.throws(() => assertEffectiveSandboxConfig(p, { ...config, identifier: production.identifiers[platform] }, platform), refusal);
  assert.throws(() => assertEffectiveSandboxConfig(p, { ...config, plugins: { updater: { active: true } } }, platform), refusal);
  assert.throws(() => assertEffectiveSandboxConfig(p, { ...config, bundle: { windows: { nsis: { installerHooks: 'legacy.nsh' } } } }, platform), refusal);
});
