import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { isAbsolute, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_PROFILE_BYTES = 8192;
const PRODUCTION_PATH = fileURLToPath(new URL('../config/deployment-profile.production.json', import.meta.url));
const PRODUCTION_HOSTS = new Set(['zentraapp.ch', 'www.zentraapp.ch', 'elyko.alb-leart1.chatgpt.site']);
const PRODUCTION_PROJECTS = new Set(['xvfohjdlhlirksrvkiqu.supabase.co', 'zgmkzsoxwlgqhjxgvcbo.supabase.co']);

// Error text is deliberately fixed: input paths, JSON values and credentials are
// never interpolated into build diagnostics or the public compiled contract.
function refuse() { throw new Error('ZENTRA_DEPLOYMENT_PROFILE_INVALID'); }
function objectKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) refuse();
}

// JSON.parse alone erases duplicate keys. This grammar pass checks decoded key
// names (including escaped-equivalent names) before parsing the same bytes.
export function parseProfileText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_PROFILE_BYTES) refuse();
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') { i++; continue; }
      if (c === '"') {
        try { return JSON.parse(text.slice(start, i)); } catch { refuse(); }
      }
    }
    refuse();
  }
  function value(depth) {
    if (depth > 6) refuse();
    ws();
    if (text[i] === '{') {
      i++; ws(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws(); if (text[i] !== '"') refuse();
        const key = string(); if (keys.has(key)) refuse(); keys.add(key);
        ws(); if (text[i++] !== ':') refuse(); value(depth + 1); ws();
        const delimiter = text[i++]; if (delimiter === '}') return;
        if (delimiter !== ',') refuse();
      }
    }
    if (text[i] === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      for (;;) { value(depth + 1); ws(); const delimiter = text[i++];
        if (delimiter === ']') return; if (delimiter !== ',') refuse(); }
    }
    if (text[i] === '"') { string(); return; }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!match) refuse(); i += match[0].length;
  }
  try { value(0); ws(); if (i !== text.length) refuse(); return JSON.parse(text); }
  catch { refuse(); }
}

export function canonicalOrigin(value) {
  if (typeof value !== 'string' || value.length > 253) refuse();
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port ||
        u.pathname !== '/' || u.search || u.hash || u.origin !== value ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(u.hostname) ||
        !u.hostname.includes('.') || u.hostname.includes('..')) refuse();
    return value;
  } catch { refuse(); }
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}
export function profileFingerprint(profile) { return createHash('sha256').update(stable(profile)).digest('hex'); }
function freeze(value) { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); }

export function validateProfile(profile, requestedKind) {
  objectKeys(profile, ['schemaVersion', 'kind', 'profileId', 'siteOrigin', 'supabaseOrigin', 'license', 'identifiers', 'productName', 'binaryName', 'updater']);
  objectKeys(profile.license, ['publicKeyB64url', 'kid']); objectKeys(profile.identifiers, ['windows', 'macos', 'mobile']);
  if (profile.schemaVersion !== 1 || !['production', 'sandbox'].includes(profile.kind) ||
      (requestedKind && requestedKind !== profile.kind)) refuse();
  const production = parseProfileText(readFileSync(PRODUCTION_PATH, 'utf8'));
  const key = profile.license.publicKeyB64url;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key) ||
      Buffer.from(key, 'base64url').length !== 32 || Buffer.from(key, 'base64url').toString('base64url') !== key) refuse();
  if (profile.kind === 'production') {
    if (stable(profile) !== stable(production)) refuse();
  } else {
    if (typeof profile.profileId !== 'string' || profile.profileId.length > 48 ||
        !/^sandbox-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.profileId)) refuse();
    canonicalOrigin(profile.siteOrigin); canonicalOrigin(profile.supabaseOrigin);
    const site = new URL(profile.siteOrigin).hostname;
    const supabase = new URL(profile.supabaseOrigin).hostname;
    if (PRODUCTION_HOSTS.has(site) ||
        !/^[a-z]{20}\.supabase\.co$/.test(supabase) || PRODUCTION_PROJECTS.has(supabase) ||
        profile.siteOrigin === profile.supabaseOrigin) refuse();
    if (typeof profile.license.kid !== 'string' || profile.license.kid.length > 64 ||
        !/^sandbox-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.license.kid) ||
        key === production.license.publicKeyB64url ||
        profile.productName !== 'Zentra Sandbox' || profile.binaryName !== 'ZentraSandbox' || profile.updater !== 'disabled' ||
        profile.identifiers.windows !== 'ch.zentra.sandbox.windows' ||
        profile.identifiers.macos !== 'ch.zentra.sandbox.macos' || profile.identifiers.mobile !== 'ch.zentra.sandbox.mobile') refuse();
  }
  return freeze(JSON.parse(stable(profile)));
}

function regularPath(path) {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep)) {
    if (!part) continue;
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) refuse();
  }
  const s = lstatSync(path); if (!s.isFile()) refuse(); return s;
}
function readProfileFile(input) {
  if (typeof input !== 'string' || !isAbsolute(input) || /(?:^|[\\/])\.\.?([\\/]|$)/.test(input)) refuse();
  const path = resolve(input); let fd;
  try {
    const before = regularPath(path); if (before.size > MAX_PROFILE_BYTES) refuse();
    fd = openSync(path, 'r'); const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) refuse();
    const bytes = Buffer.alloc(MAX_PROFILE_BYTES + 1); let count = 0;
    while (count < bytes.length) { const length = readSync(fd, bytes, count, bytes.length - count, null); if (!length) break; count += length; }
    if (count > MAX_PROFILE_BYTES) refuse();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    const after = fstatSync(fd); const final = regularPath(path);
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || final.dev !== after.dev || final.ino !== after.ino || final.size !== after.size || final.mtimeMs !== after.mtimeMs) refuse();
    return parseProfileText(text);
  } catch { refuse(); } finally { if (fd !== undefined) closeSync(fd); }
}

export function selectDeploymentProfile(environment = process.env) {
  const kind = environment.ZENTRA_BUILD_KIND;
  const file = environment.ZENTRA_BUILD_PROFILE_FILE;
  if (kind === undefined && file === undefined) {
    const profile = validateProfile(parseProfileText(readFileSync(PRODUCTION_PATH, 'utf8')), 'production');
    return freeze({ ...profile, sha256: profileFingerprint(profile) });
  }
  if (!['production', 'sandbox'].includes(kind) || !file) refuse();
  const profile = validateProfile(readProfileFile(file), kind);
  return freeze({ ...profile, sha256: profileFingerprint(profile) });
}

// Used by a future package wrapper only after all platform overlays have been
// merged. This does not build, install, generate an overlay, or mutate a config.
export function assertEffectiveSandboxConfig(profile, config, platform) {
  validateProfile(profile, 'sandbox');
  if (!['windows', 'macos', 'mobile'].includes(platform) || !config ||
      config.identifier !== profile.identifiers[platform] || config.productName !== profile.productName ||
      config.mainBinaryName !== profile.binaryName ||
      config.plugins?.updater?.active !== false || config.bundle?.windows?.nsis?.installerHooks != null ||
      !Array.isArray(config.app?.windows) || !config.app.windows.length || config.app.windows.length > 10 ||
      config.app.windows.some(w => !w || typeof w !== 'object' || w.title !== profile.productName)) refuse();
  return true;
}
