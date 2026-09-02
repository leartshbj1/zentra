import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformPath = path.join(
  root,
  'supabase/migrations/20260902000100_zentra_platform.sql',
);
const storagePath = path.join(
  root,
  'supabase/migrations/20260902000200_zentra_archive_storage.sql',
);
const retentionCorrectionPath = path.join(
  root,
  'supabase/migrations/20260902000300_zentra_archive_retention.sql',
);
const configPath = path.join(root, 'supabase/config.toml');
const documentationPath = path.join(root, 'docs/SUPABASE-MIGRATION.md');
const rlsTestPath = path.join(
  root,
  'supabase/tests/database/zentra_rls.test.sql',
);

const [
  platform,
  storage,
  retentionCorrection,
  config,
  documentation,
  rlsTests,
] = await Promise.all([
  readFile(platformPath, 'utf8'),
  readFile(storagePath, 'utf8'),
  readFile(retentionCorrectionPath, 'utf8'),
  readFile(configPath, 'utf8'),
  readFile(documentationPath, 'utf8'),
  readFile(rlsTestPath, 'utf8'),
]);

const tables = [
  'profiles',
  'subscriptions',
  'organizations',
  'organization_members',
  'organization_invitations',
  'license_activations',
  'device_authorizations',
  'device_sessions',
  'invoice_archives',
  'organization_domains',
  'checkout_attempts',
  'stripe_events',
  'stripe_webhook_proofs',
  'rate_limit_counters',
  'security_audit_events',
];

for (const table of tables) {
  assert.match(
    platform,
    new RegExp(`create table public\\.${table}\\s*\\(`, 'i'),
    `${table} must be created`,
  );
  assert.match(
    platform,
    new RegExp(`alter table public\\.${table} enable row level security`, 'i'),
    `${table} must enable RLS`,
  );
  assert.match(
    platform,
    new RegExp(`revoke all on public\\.${table} from anon, authenticated`, 'i'),
    `${table} must revoke permissive default grants`,
  );
}

assert.match(platform, /security definer\s+set search_path = ''/gi);
const definerCount = (platform.match(/security definer/gi) ?? []).length;
const pinnedCount = (
  platform.match(/security definer\s+set search_path = ''/gi) ?? []
).length;
assert.equal(
  pinnedCount,
  definerCount,
  'every SECURITY DEFINER function must pin an empty search_path',
);

assert.match(platform, /organization_members_last_owner_guard/i);
assert.match(platform, /invoice_archives_revision_guard/i);
assert.match(platform, /invoice_archives_immutable_update_guard/i);
assert.match(platform, /invoice_archives_immutable_delete_guard/i);
assert.match(platform, /security_audit_events_append_only/i);
assert.match(platform, /fiscal_year_end date not null/i);
assert.match(platform, /invoice_archives_fiscal_year_end/i);
assert.match(
  platform,
  /retention_until\s*=\s*\(fiscal_year_end\s*\+\s*interval\s*'10 years'\)::date/i,
);
assert.match(platform, /migration\.legacy_identity_links/i);
assert.match(platform, /migration\.legacy_entity_map/i);
assert.match(platform, /organization_domains_hostname_canonical/i);

assert.match(storage, /'zentra-invoice-archives'/);
assert.match(storage, /false,\s*12582912,/s);
assert.match(storage, /array\['application\/pdf'\]::text\[\]/);
assert.match(storage, /for select\s+to authenticated/i);
assert.doesNotMatch(
  storage,
  /for\s+(insert|update|delete)\s+to authenticated/i,
);
assert.match(
  storage,
  /\(storage\.foldername\(name\)\)\[1\]\s*=\s*'organizations'/i,
);
assert.match(
  storage,
  /is_organization_member\(\(storage\.foldername\(name\)\)\[2\]\)/i,
);

assert.match(
  retentionCorrection,
  /add column if not exists fiscal_year_end date/i,
);
assert.match(
  retentionCorrection,
  /disable trigger invoice_archives_immutable_update_guard/i,
);
assert.match(
  retentionCorrection,
  /set fiscal_year_end\s*=\s*\(retention_until\s*-\s*interval\s*'10 years'\)::date/i,
);
assert.match(
  retentionCorrection,
  /enable trigger invoice_archives_immutable_update_guard/i,
);
assert.match(
  retentionCorrection,
  /drop constraint if exists invoice_archives_retention_minimum/i,
);
assert.match(
  retentionCorrection,
  /validate constraint invoice_archives_fiscal_year_end/i,
);
assert.match(
  retentionCorrection,
  /validate constraint invoice_archives_retention_exact/i,
);
assert.doesNotMatch(
  retentionCorrection,
  /update\s+public\.invoice_archives\s+set\s+retention_until/i,
  'the live correction must preserve retention_until and archive chain hashes',
);
assert.doesNotMatch(
  retentionCorrection,
  /update\s+public\.invoice_archives\s+set\s+(?:previous_)?chain_sha256/i,
  'the live correction must never rewrite archive chain hashes',
);

assert.match(rlsTests, /select plan\(44\)/i);
assert.match(rlsTests, /'accountant@zentra\.test',\s*'accountant'/i);
assert.match(rlsTests, /'member@zentra\.test',\s*'member'/i);
assert.match(rlsTests, /org_20000000-0000-4000-8000-000000000002/i);
assert.match(rlsTests, /from storage\.objects/i);
assert.match(rlsTests, /member cannot write directly to archive storage/i);
assert.match(
  rlsTests,
  /ten years after issue date instead of fiscal year end/i,
);

assert.match(config, /enable_refresh_token_rotation = true/);
assert.match(config, /enable_confirmations = true/);
assert.match(config, /minimum_password_length = 12/);
assert.doesNotMatch(config, /https:\/\/[^\s"]+\.chatgpt\.site/);

assert.match(
  documentation,
  /données de compte et d'archives continuent d'utiliser D1\/R2 jusqu'au basculement contrôlé/i,
);
assert.match(
  documentation,
  /n'est toutefois pas une certification WORM\/Olico/i,
);
assert.match(documentation, /retour arrière/i);

const combined = `${platform}\n${storage}\n${retentionCorrection}\n${config}\n${documentation}\n${rlsTests}`;
assert.doesNotMatch(combined, /sk_(?:test|live)_[A-Za-z0-9]{16,}/);
assert.doesNotMatch(combined, /whsec_[A-Za-z0-9]{16,}/);
assert.doesNotMatch(combined, /sb_secret_[A-Za-z0-9]{16,}/);
assert.doesNotMatch(combined, /service_role\s*=\s*[A-Za-z0-9._-]{20,}/i);
assert.doesNotMatch(combined, /demo@example|fake|simulation/i);

console.log(
  `Supabase contract OK: ${tables.length} tables RLS, tenant-isolated private PDF bucket, fiscal-year retention, immutable archive guards, no embedded secrets.`,
);
