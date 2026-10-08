import { isAccountRole, type AccountRole } from './account-security';
import type { OrganizationMembership } from './account';
import { creationUuid } from './international/workspace-creation';

/** Public discovery metadata. Neither this descriptor nor an URL grants access. */
export interface AccountWorkspace {
  readonly organizationId: string;
  readonly name: string;
  readonly edition: 'ch_legacy' | 'us_experimental';
  readonly role: AccountRole;
}

export class AccountWorkspaceDiscoveryError extends Error {
  readonly code = 'service_unavailable';
  readonly status = 503;
  constructor() { super('service_unavailable'); }
}

/** A read-only port: no run/batch, provider, licence or PG operation. */
export interface AccountWorkspaceReadDatabase {
  prepare(this: void, query: string): {
    bind(this: void, ...values: unknown[]): {
      all<T>(this: void): Promise<{ results: T[]; success?: boolean }>;
    };
  };
}

interface WorkspaceRow { organization_id: string; name: string; role: unknown }
interface DiscoveryOptions {
  readonly database?: AccountWorkspaceReadDatabase;
  readonly usEnabled?: boolean;
  /** Only a fresh server-side membershipsForUser result for this same Auth user. */
  readonly legacyMemberships?: readonly OrganizationMembership[];
}

export async function accountWorkspaceDiscoveryEnabled(): Promise<boolean> {
  try {
    const { env } = await import('cloudflare:workers');
    const flags = env as unknown as { INTERNATIONAL_CORE_ENABLED?: string; INTERNATIONAL_US_ERP_ENABLED?: string };
    return flags.INTERNATIONAL_CORE_ENABLED === 'true' && flags.INTERNATIONAL_US_ERP_ENABLED === 'true';
  } catch { return false; }
}

function project(row: WorkspaceRow, edition: AccountWorkspace['edition']): AccountWorkspace {
  if (typeof row.organization_id !== 'string' || !row.organization_id || typeof row.name !== 'string' || !isAccountRole(row.role)) throw new AccountWorkspaceDiscoveryError();
  if (edition === 'us_experimental') {
    creationUuid(row.organization_id);
    if (!row.name || row.name.length > 160) throw new AccountWorkspaceDiscoveryError();
  }
  return { organizationId: row.organization_id, name: row.name, edition, role: row.role };
}

/** Discovery preserves CH ordering and never reads a private US JSON column.
 * An expired/revoked subscription remains discoverable by active members;
 * the destination must check requireUsWorkspaceAccess freshly before opening. */
export async function accountWorkspacesForUser(userId: string, options: DiscoveryOptions = {}): Promise<AccountWorkspace[]> {
  try {
    creationUuid(userId);
    const includeUs = options.usEnabled ?? await accountWorkspaceDiscoveryEnabled();
    let database = options.database;
    const reader = async () => database ??= (await import('./runtime')).database();
    let legacy: AccountWorkspace[];
    if (options.legacyMemberships) {
      legacy = options.legacyMemberships.filter(member => isAccountRole(member.role)).map(member => project({ organization_id: member.organizationId, name: member.organizationName, role: member.role }, 'ch_legacy'));
    } else {
      const result = await (await reader()).prepare(`SELECT member.organization_id,organization.name AS name,member.role
        FROM organization_members member JOIN organizations organization ON organization.organization_id=member.organization_id
        WHERE member.user_id=? AND member.revoked_at IS NULL ORDER BY member.joined_at,member.organization_id`).bind(userId).all<WorkspaceRow>();
      if (result.success === false || !Array.isArray(result.results)) throw new AccountWorkspaceDiscoveryError();
      // Match membershipsForUser: unknown legacy roles are not admitted.
      legacy = result.results.filter(row => isAccountRole(row.role)).map(row => project(row, 'ch_legacy'));
    }
    if (!includeUs) return legacy;
    const result = await (await reader()).prepare(`SELECT caller.organization_id,intent.company_name AS name,caller.role
      FROM international_workspace_members caller
      JOIN international_saas_authorities authority ON authority.organization_id=caller.organization_id
      JOIN international_workspace_creation_intents intent ON intent.creation_id=authority.creation_id AND intent.organization_id=authority.organization_id
      JOIN international_workspace_members owner ON owner.organization_id=authority.organization_id AND owner.user_id=authority.owner_user_id AND owner.role='owner'
      WHERE caller.user_id=? AND caller.revoked_at IS NULL AND owner.revoked_at IS NULL
        AND intent.state='ready' AND intent.country_code='US' AND intent.actor_user_id=authority.owner_user_id
        AND intent.own_subscription_id=authority.subscription_id AND authority.country='US' AND authority.currency='USD'
        AND NOT EXISTS(SELECT 1 FROM organizations legacy WHERE legacy.organization_id=caller.organization_id)
      ORDER BY caller.joined_at,caller.organization_id`).bind(userId).all<WorkspaceRow>();
    if (result.success === false || !Array.isArray(result.results)) throw new AccountWorkspaceDiscoveryError();
    const international = result.results.map(row => project(row, 'us_experimental'));
    const ids = new Set(legacy.map(workspace => workspace.organizationId));
    for (const workspace of international) {
      if (ids.has(workspace.organizationId)) throw new AccountWorkspaceDiscoveryError();
      ids.add(workspace.organizationId);
    }
    // A changing runtime policy cannot return US descriptors after disabling it.
    if (options.usEnabled === undefined && !(await accountWorkspaceDiscoveryEnabled())) return legacy;
    return [...legacy, ...international];
  } catch { throw new AccountWorkspaceDiscoveryError(); }
}
