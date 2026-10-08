import { AccountPublicError } from '@/lib/account-security';

export const LEGACY_COUNTRY_GUARD_CODE = 'international_legacy_transport_forbidden';

/** Only identity is needed here. Never select the private configuration/receipt. */
export interface LegacyCountryGuardDatabase {
  prepare(sql: string): {
    bind(...values: string[]): {
      first<T>(): Promise<T | null>;
    };
  };
}

export class LegacyCountryTransportError extends AccountPublicError {
  readonly code = LEGACY_COUNTRY_GUARD_CODE;
  constructor() {
    super('Cette entreprise doit utiliser son transport international dédié.', 409);
  }
}

/**
 * Call before a legacy read, body/upload, reservation or mutation, including
 * retries that would otherwise return an existing receipt without writing SQL.
 * This is an API/storage boundary; the additive D1 triggers remain the atomic
 * write authority. A preflight alone cannot serialize D1 with external storage.
 * No intention preserves legacy behavior; absence is never a CH attestation.
 */
export async function requireLegacyCountryTransport(
  organizationId: string,
  suppliedDatabase?: LegacyCountryGuardDatabase,
): Promise<void> {
  const db = suppliedDatabase ?? (await import('@/lib/runtime')).database();
  const blocked = await db
    .prepare(`SELECT 1 AS blocked FROM international_workspace_creation_intents
      WHERE organization_id=? AND country_code='US' LIMIT 1`)
    .bind(organizationId)
    .first<{ blocked: number }>();
  // All durable states, including reserved and interrupted creations, are US.
  if (blocked) throw new LegacyCountryTransportError();
}
