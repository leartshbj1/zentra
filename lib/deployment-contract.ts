import productionProfile from '../config/deployment-profile.production.json';

export type DeploymentProfile = Readonly<{
  schemaVersion: 1;
  kind: 'production' | 'sandbox';
  profileId: string;
  siteOrigin: string;
  supabaseOrigin: string | null;
  license: Readonly<{ publicKeyB64url: string; kid: string }>;
  identifiers: Readonly<{ windows: string; macos: string; mobile: string }>;
  productName: string;
  binaryName: string;
  updater: 'production' | 'disabled';
  sha256: string;
}>;

// Vite supplies this one public object at compile time. Runtime bindings can
// acknowledge it, but never select another profile, key or origin.
declare const __ZENTRA_DEPLOYMENT_PROFILE__: DeploymentProfile | undefined;
const PRODUCTION_SHA256 = 'ad2a897b8fb1c114c6497bbd71cb2dfb12d1431d63788e560f7956b7a9380c90';

export class DeploymentProfileError extends Error {
  readonly status = 503;
  readonly code = 'deployment_profile_mismatch';
  constructor() { super('ZENTRA_DEPLOYMENT_PROFILE_MISMATCH'); this.name = 'DeploymentProfileError'; }
}
function refuse(): never { throw new DeploymentProfileError(); }
function hasExactKeys(value: unknown, keys: string[]): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
function exactOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      url.origin === value && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}
function selectCompiledProfile(): DeploymentProfile {
  const value = typeof __ZENTRA_DEPLOYMENT_PROFILE__ === 'undefined'
    ? { ...productionProfile, sha256: PRODUCTION_SHA256 }
    : __ZENTRA_DEPLOYMENT_PROFILE__;
  if (!hasExactKeys(value, ['schemaVersion', 'kind', 'profileId', 'siteOrigin', 'supabaseOrigin', 'license', 'identifiers', 'productName', 'binaryName', 'updater', 'sha256']) ||
      !value || value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !hasExactKeys(value.license, ['publicKeyB64url', 'kid']) || !hasExactKeys(value.identifiers, ['windows', 'macos', 'mobile'])) refuse();
  if (value.kind === 'production') {
    if (value.sha256 !== PRODUCTION_SHA256 || value.profileId !== productionProfile.profileId ||
        value.siteOrigin !== productionProfile.siteOrigin || value.supabaseOrigin !== null ||
        value.license.kid !== productionProfile.license.kid || value.license.publicKeyB64url !== productionProfile.license.publicKeyB64url ||
        value.identifiers.windows !== productionProfile.identifiers.windows || value.identifiers.macos !== productionProfile.identifiers.macos ||
        value.identifiers.mobile !== productionProfile.identifiers.mobile || value.productName !== productionProfile.productName ||
        value.binaryName !== productionProfile.binaryName || value.updater !== 'production') refuse();
  } else if (value.kind === 'sandbox') {
    if (typeof value.profileId !== 'string' || value.profileId.length > 48 || !/^sandbox-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.profileId) || !exactOrigin(value.siteOrigin) ||
        !exactOrigin(value.supabaseOrigin) || !/^https:\/\/[a-z]{20}\.supabase\.co$/.test(value.supabaseOrigin) ||
        ['zentraapp.ch', 'www.zentraapp.ch', 'elyko.alb-leart1.chatgpt.site'].includes(new URL(value.siteOrigin).hostname) ||
        ['https://xvfohjdlhlirksrvkiqu.supabase.co', 'https://zgmkzsoxwlgqhjxgvcbo.supabase.co'].includes(value.supabaseOrigin) ||
        typeof value.license.kid !== 'string' || value.license.kid.length > 64 || !/^sandbox-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.license.kid) ||
        !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.license.publicKeyB64url) || value.license.publicKeyB64url === productionProfile.license.publicKeyB64url ||
        value.identifiers.windows !== 'ch.zentra.sandbox.windows' || value.identifiers.macos !== 'ch.zentra.sandbox.macos' ||
        value.identifiers.mobile !== 'ch.zentra.sandbox.mobile' || value.productName !== 'Zentra Sandbox' ||
        value.binaryName !== 'ZentraSandbox' || value.updater !== 'disabled') refuse();
  } else { refuse(); }
  // Copy before freezing: no caller/global input retains a mutable reference.
  const result = JSON.parse(JSON.stringify(value)) as DeploymentProfile;
  Object.freeze(result.license); Object.freeze(result.identifiers); return Object.freeze(result);
}

export const deploymentProfile = selectCompiledProfile();
export const isSandboxDeployment = deploymentProfile.kind === 'sandbox';
export type DeploymentValueReader = (name: string) => string;

export function assertDeploymentRuntime(read: DeploymentValueReader, request?: Request): void {
  const kind = read('ZENTRA_DEPLOYMENT_KIND');
  const id = read('ZENTRA_DEPLOYMENT_PROFILE_ID');
  const hash = read('ZENTRA_DEPLOYMENT_PROFILE_SHA256');
  if (!isSandboxDeployment && !kind && !id && !hash) return;
  if (kind !== deploymentProfile.kind || id !== deploymentProfile.profileId || hash !== deploymentProfile.sha256) refuse();
  if (!isSandboxDeployment) return;
  if (read('PUBLIC_SITE_URL') !== deploymentProfile.siteOrigin || read('SUPABASE_URL') !== deploymentProfile.supabaseOrigin ||
      read('SITE_ORIGIN_ALIASES') || (read('NEXT_PUBLIC_SITE_URL') && read('NEXT_PUBLIC_SITE_URL') !== deploymentProfile.siteOrigin)) refuse();
  const stripeKey = read('STRIPE_SECRET_KEY');
  if (stripeKey && !stripeKey.startsWith('sk_test_')) refuse();
  const webhookUrl = read('STRIPE_WEBHOOK_URL');
  if (webhookUrl && webhookUrl !== `${deploymentProfile.siteOrigin}/api/stripe/webhook`) refuse();
  // Production installation/founder/reset shortcuts must not survive in a
  // sandbox runtime. Ordinary memberships and paid/trial entitlements remain.
  if (read('OWNER_LICENSE_BINDING_SHA256') || read('FOUNDER_ADMIN_PUBLIC_KEY_B64URL') ||
      read('PHASE2_RESET_MODE') || read('PHASE2_RESET_BACKUP_SHA256')) refuse();
  if (request && new URL(request.url).origin !== deploymentProfile.siteOrigin) refuse();
}

export function deploymentBindingReader(bindings: unknown): DeploymentValueReader {
  const values = bindings && typeof bindings === 'object' ? bindings as Record<string, unknown> : {};
  return name => {
    const bound = values[name];
    if (typeof bound === 'string' && bound.trim()) return bound.trim();
    return process.env[name]?.trim() ?? '';
  };
}

// Public metadata also runs during a build, with no runtime service bindings.
// It never chooses an origin from env, and refuses configured contradictions.
export function sandboxPublicSiteUrl(): string {
  if (!isSandboxDeployment) refuse();
  for (const name of ['PUBLIC_SITE_URL', 'NEXT_PUBLIC_SITE_URL']) {
    const value = process.env[name];
    if (value !== undefined && value !== deploymentProfile.siteOrigin) refuse();
  }
  if (process.env.SITE_ORIGIN_ALIASES) refuse();
  return deploymentProfile.siteOrigin;
}

export function deploymentReadinessDiscriminator(): string {
  // Keep the production cache input byte-identical. Sandbox readiness cannot
  // be reused under another public profile, verifier key or kid.
  return isSandboxDeployment ? [deploymentProfile.sha256, deploymentProfile.license.kid, deploymentProfile.license.publicKeyB64url].join('\u0000') : '';
}
