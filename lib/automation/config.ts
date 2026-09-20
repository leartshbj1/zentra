import { database, runtimeValue } from '@/lib/runtime';
import { encryptSecret, decryptSecret } from '@/lib/support/crypto';
import { verifyPlatformApiKey } from '@/lib/support/jev';
import {
  FEATURES,
  DEFAULT_THRESHOLDS,
  thresholds,
  type Feature,
  type Mode,
} from './types';
import { AccountPublicError } from '@/lib/account-security';

export const AUTOMATION_CONSENT_VERSION = 'automation-2026-09-20';
export type Settings = {
  enabled: boolean;
  mode: Mode;
  flags: Feature[];
  thresholds: { medium: number; high: number };
  consent: boolean;
};
export async function decisionApiKey() {
  const row = await database()
    .prepare("SELECT secret FROM support_platform_secrets WHERE id='typesafe'")
    .first<{ secret: string }>();
  return row
    ? decryptSecret(
        runtimeValue('SUPPORT_ENCRYPTION_KEY'),
        row.secret,
        'platform:typesafe',
      )
    : runtimeValue('TYPESAFE_API_KEY');
}
export async function saveDecisionApiKey(input: unknown, actor: string) {
  const key = await verifyPlatformApiKey(input);
  const secret = await encryptSecret(
    runtimeValue('SUPPORT_ENCRYPTION_KEY'),
    key,
    'platform:typesafe',
  );
  await database()
    .prepare(
      "INSERT INTO support_platform_secrets(id,secret,updated_by,updated_at) VALUES('typesafe',?,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
    )
    .bind(secret, actor, Math.floor(Date.now() / 1000))
    .run();
  return { configured: true };
}
export async function globalFlags(): Promise<Feature[]> {
  const row = await database()
    .prepare("SELECT value FROM automation_platform WHERE id='features'")
    .first<{ value: string }>();
  if (!row) return [];
  try {
    const flags: unknown = JSON.parse(row.value);
    return Array.isArray(flags)
      ? FEATURES.filter((f) => flags.includes(f))
      : [];
  } catch {
    return [];
  }
}
export async function setGlobalFlags(raw: unknown, actor: string) {
  if (!Array.isArray(raw) || raw.some((v) => !FEATURES.includes(v)))
    throw new AccountPublicError('Choisissez des fonctions valides.');
  await database()
    .prepare(
      "INSERT INTO automation_platform(id,value,updated_by,updated_at) VALUES('features',?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
    )
    .bind(
      JSON.stringify([...new Set(raw)]),
      actor,
      Math.floor(Date.now() / 1000),
    )
    .run();
}
export async function settingsFor(organizationId: string): Promise<Settings> {
  const row = await database()
    .prepare('SELECT * FROM automation_settings WHERE organization_id=?')
    .bind(organizationId)
    .first<{
      enabled: number;
      mode: string;
      flags: string;
      medium_threshold: number;
      high_threshold: number;
      consent_version: string | null;
    }>();
  if (!row)
    return {
      enabled: false,
      mode: 'shadow',
      flags: [],
      thresholds: DEFAULT_THRESHOLDS,
      consent: false,
    };
  let flags: unknown = [];
  try {
    flags = JSON.parse(row.flags);
  } catch {
    /* Disabled if corrupt. */
  }
  return {
    enabled: row.enabled === 1,
    mode: row.mode === 'suggest' ? 'suggest' : 'shadow',
    flags: Array.isArray(flags)
      ? FEATURES.filter((f) => flags.includes(f))
      : [],
    thresholds: thresholds({
      medium: row.medium_threshold,
      high: row.high_threshold,
    }),
    consent: row.consent_version === AUTOMATION_CONSENT_VERSION,
  };
}
export async function saveSettings(
  organizationId: string,
  actor: string,
  raw: Record<string, unknown>,
) {
  const limits = thresholds(raw.thresholds);
  if (
    typeof raw.enabled !== 'boolean' ||
    !['shadow', 'suggest'].includes(String(raw.mode)) ||
    !Array.isArray(raw.flags) ||
    raw.flags.some((f) => !FEATURES.includes(f))
  )
    throw new AccountPublicError('Vérifiez les réglages Automation.');
  const old = await settingsFor(organizationId);
  if (
    raw.enabled &&
    !old.consent &&
    raw.consentVersion !== AUTOMATION_CONSENT_VERSION
  )
    throw new AccountPublicError(
      'Acceptez l’analyse des extraits nécessaires avant d’activer Automation.',
    );
  const now = Math.floor(Date.now() / 1000);
  await database()
    .prepare(
      `INSERT INTO automation_settings(organization_id,enabled,mode,flags,medium_threshold,high_threshold,consent_version,consent_by,consent_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET enabled=excluded.enabled,mode=excluded.mode,flags=excluded.flags,medium_threshold=excluded.medium_threshold,high_threshold=excluded.high_threshold,consent_version=COALESCE(excluded.consent_version,automation_settings.consent_version),consent_by=COALESCE(excluded.consent_by,automation_settings.consent_by),consent_at=COALESCE(excluded.consent_at,automation_settings.consent_at),updated_at=excluded.updated_at`,
    )
    .bind(
      organizationId,
      raw.enabled ? 1 : 0,
      raw.mode,
      JSON.stringify([...new Set(raw.flags)]),
      limits.medium,
      limits.high,
      raw.consentVersion === AUTOMATION_CONSENT_VERSION
        ? AUTOMATION_CONSENT_VERSION
        : null,
      raw.consentVersion === AUTOMATION_CONSENT_VERSION ? actor : null,
      raw.consentVersion === AUTOMATION_CONSENT_VERSION ? now : null,
      now,
    )
    .run();
  return settingsFor(organizationId);
}
