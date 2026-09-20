import { database } from '@/lib/runtime';
import type { Resources, Candidate } from './policies';
import { AccountPublicError } from '@/lib/account-security';

// The current native collaboration store is SQLite, replicated as a complete
// snapshot in Supabase. Its Rust backend supplies a bounded projection, built
// from the connected local company (never from WebView-supplied IDs). Web
// sessions cannot use this path. The native backend rechecks IDs on receipt,
// and normal draft-save commands validate them again before any write.
export function nativeResources(
  raw: unknown,
  organizationId: string,
): Resources {
  const data = raw as {
    organizationId?: unknown;
    suppliers?: unknown;
    projects?: unknown;
    expenseCategories?: unknown;
  } | null;
  if (!data || data.organizationId !== organizationId)
    throw new AccountPublicError(
      'Les ressources ne correspondent pas à cette entreprise.',
      403,
    );
  const list = (rawList: unknown): Candidate[] => {
    if (!Array.isArray(rawList) || rawList.length > 100)
      throw new AccountPublicError('Liste de ressources invalide.');
    const ids = new Set<string>();
    return rawList.map((value) => {
      if (
        !value ||
        typeof value.id !== 'string' ||
        !value.id ||
        value.id.length > 160 ||
        typeof value.label !== 'string' ||
        !value.label.trim() ||
        value.label.length > 160 ||
        ids.has(value.id)
      )
        throw new AccountPublicError('Ressource invalide.');
      ids.add(value.id);
      return { id: value.id, label: value.label };
    });
  };
  return {
    suppliers: list(data.suppliers),
    projects: list(data.projects),
    expenseCategories: list(data.expenseCategories),
  };
}

// Use a fully committed current snapshot only. Never include another tenant,
// an unvalidated upload, a removed resource, or an old generation.
export const RESOURCE_SQL = `SELECT v.table_name,v.row_json FROM business_sync_versions v
 JOIN business_sync_transfers t ON t.transfer_id=v.transfer_id AND t.organization_id=v.organization_id
 JOIN business_sync_spaces s ON s.organization_id=t.organization_id AND s.generation=t.generation AND s.head_revision=t.revision
 WHERE v.organization_id=? AND s.state='ready' AND t.state='committed' AND v.row_json IS NOT NULL
 AND v.table_name IN ('suppliers','projects') ORDER BY v.table_name,v.row_key_json LIMIT 202`;
export async function authorizedResources(
  organizationId: string,
): Promise<Resources> {
  const rows = await database()
    .prepare(RESOURCE_SQL)
    .bind(organizationId)
    .all<{ table_name: string; row_json: string }>();
  const resources: Resources = {
    suppliers: [],
    projects: [],
    expenseCategories: [],
  };
  for (const row of rows.results) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.row_json);
    } catch {
      continue;
    }
    if (
      typeof data.id !== 'string' ||
      data.deleted_at ||
      data.archived_at ||
      data.active === 0
    )
      continue;
    const label =
      row.table_name === 'suppliers'
        ? data.company_name || data.name
        : data.name;
    if (typeof label !== 'string' || !label.trim()) continue;
    const target: Candidate[] =
      row.table_name === 'suppliers' ? resources.suppliers : resources.projects;
    if (target.length < 100)
      target.push({ id: data.id, label: label.slice(0, 160) });
  }
  return resources;
}
