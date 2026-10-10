import { canonicalErpJson } from './erp-contract';
import { creationUuid } from './workspace-creation';
import { parseUsSubscriptionAuthority, UsAuthorityError, type UsSaasPolicy } from './saas-authority';
import { d1UsAuthorityStore, parseUsSaasPolicy } from './saas-authority-d1';
import { usTeamDependencies } from './us-team-bindings';
import { UsTeamError, type UsTeamContext } from './us-team-contract';
import { UsDeviceError } from './us-device-contract';
import { d1UsSupportWorkspaceStore } from './us-support-workspace-d1';
import { createUsSupportWorkspaceHandlers } from './us-support-workspace-server';
import { UsSupportWorkspaceError, sameUsSupportWorkspaceContext, validateUsSupportWorkspaceContext, type UsSupportWorkspaceContext } from './us-support-workspace-contract';

type Db = Pick<D1Database, 'prepare' | 'batch'>;
type Flags = Record<string, string | undefined>;
const now = () => Math.floor(Date.now() / 1000);
async function flags(): Promise<Flags> { try { return (await import('cloudflare:workers')).env as unknown as Flags; } catch { return {}; } }
export async function usSupportWorkspacesEnabled(): Promise<boolean> {
  const f = await flags();
  return ['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_ERP_ENABLED','INTERNATIONAL_US_SUPPORT_WORKSPACES_ENABLED'].every(key => f[key] === 'true');
}
interface Source { organization_id: string; owner_user_id: string; authority_json: string; seat_limit: number; role: UsSupportWorkspaceContext['role']; checked_at: number }
/** Scoped to a current member before parsing the private effective authority.
 * Both module checks refer to the SAME current invoice and paid period. */
export async function readUsSupportWorkspaceAuthority(database: Db, member: UsTeamContext, policy: UsSaasPolicy): Promise<UsSupportWorkspaceContext> {
  async function source(): Promise<Source> {
    const row = await database.prepare(`SELECT a.organization_id,a.owner_user_id,a.authority_json,a.seat_limit,m.role,unixepoch() AS checked_at
      FROM international_effective_saas_authorities a
      JOIN international_workspace_creation_intents i ON i.creation_id=a.creation_id AND i.organization_id=a.organization_id AND i.own_subscription_id=a.subscription_id
      JOIN international_workspace_members m ON m.organization_id=a.organization_id AND m.user_id=? AND m.revoked_at IS NULL
      JOIN international_workspace_members owner ON owner.organization_id=a.organization_id AND owner.user_id=a.owner_user_id AND owner.role='owner' AND owner.revoked_at IS NULL
      WHERE a.organization_id=? AND i.state='ready' AND a.country='US' AND a.currency='USD' AND a.revoked_at IS NULL`).bind(member.user.userId, member.organizationId).first<Source>();
    if (!row) throw new UsSupportWorkspaceError('forbidden', 403);
    return row;
  }
  try {
    const first = await source(), authority = parseUsSubscriptionAuthority(JSON.parse(first.authority_json));
    if (!authority.evidence || authority.evidence.kind !== 'verified_payment') throw new UsSupportWorkspaceError('subscription_required', 402);
    const store = d1UsAuthorityStore(database);
    const currentPolicy = { ...policy, now: Math.max(policy.now, first.checked_at) };
    const gestion = await store.access(member.organizationId, member.user.userId, currentPolicy, 'gestion', authority);
    const support = await store.access(member.organizationId, member.user.userId, currentPolicy, 'support', authority);
    if (canonicalErpJson(gestion) !== canonicalErpJson(support) || gestion.role !== member.role || gestion.role !== first.role || gestion.subscriptionId !== member.subscriptionId || !member.credential) throw new UsSupportWorkspaceError('configuration_changed', 409);
    const last = await source();
    if (canonicalErpJson({ ...last, checked_at: 0 }) !== canonicalErpJson({ ...first, checked_at: 0 })) throw new UsSupportWorkspaceError('configuration_changed', 409);
    const checkedAt = Math.max(currentPolicy.now, last.checked_at);
    return validateUsSupportWorkspaceContext({ schemaVersion: 1, organizationId: member.organizationId, userId: member.user.userId,
      role: gestion.role, ownerUserId: first.owner_user_id, subscriptionId: gestion.subscriptionId,
      environment: authority.offer.environment, catalogVersion: authority.offer.catalogVersion, priceId: authority.offer.priceId,
      authorityReference: authority.evidence.referenceId, validStartsAt: authority.evidence.startsAt, validEndsAt: authority.evidence.endsAt,
      seatLimit: gestion.seatLimit, checkedAt, credential: member.credential }, member.organizationId, checkedAt);
  } catch (error) { return mapped(error); }
}
function mapped(error: unknown): never {
  if (error instanceof UsSupportWorkspaceError) throw error;
  if (error instanceof UsAuthorityError || error instanceof UsTeamError || error instanceof UsDeviceError) {
    const status = [401,402,403].includes(error.status) ? error.status : 503;
    throw new UsSupportWorkspaceError(status === 401 ? 'unauthorized' : status === 402 ? 'subscription_required' : status === 403 ? 'forbidden' : 'service_unavailable', status);
  }
  throw new UsSupportWorkspaceError('service_unavailable', 503);
}
export function createUsSupportWorkspaceMember(dependencies: {
  member(request: Request, organizationId: string): Promise<UsTeamContext>;
  database(): Promise<Db>; policy(): Promise<UsSaasPolicy>; now(): number;
}) {
  return async (request: Request, organizationId: string): Promise<UsSupportWorkspaceContext> => {
    let captured: UsTeamContext | undefined;
    try {
      const org = creationUuid(organizationId), member = await dependencies.member(request, org); captured = member;
      const result = await readUsSupportWorkspaceAuthority(await dependencies.database(), member, await dependencies.policy());
      const fresh = await dependencies.member(request, org);
      if (fresh.user.userId !== member.user.userId || canonicalErpJson(fresh.credential) !== canonicalErpJson(member.credential)) throw new UsSupportWorkspaceError('session_changed', 401);
      if (fresh.organizationId !== org || fresh.role !== member.role || fresh.subscriptionId !== member.subscriptionId) throw new UsSupportWorkspaceError('forbidden', 403);
      // Auth itself awaits D1. Do not return the pre-Auth invoice/period if a
      // renewal or revocation occurred during that last identity read.
      const final = await readUsSupportWorkspaceAuthority(await dependencies.database(), fresh, await dependencies.policy());
      sameUsSupportWorkspaceContext(result, final);
      return validateUsSupportWorkspaceContext(final, org, dependencies.now());
    } catch (error) {
      // A delayed storage/catalogue error must not hide a logout/account switch.
      if (captured) { try {
        const fresh = await dependencies.member(request, organizationId);
        if (fresh.user.userId !== captured.user.userId || canonicalErpJson(fresh.credential) !== canonicalErpJson(captured.credential)) throw new UsSupportWorkspaceError('session_changed', 401);
      } catch (delayed) { if (delayed instanceof UsSupportWorkspaceError && delayed.status === 401) throw delayed; if (delayed instanceof UsAuthorityError || delayed instanceof UsTeamError || delayed instanceof UsDeviceError) { if ([401,402,403].includes(delayed.status)) return mapped(delayed); } } }
      return mapped(error);
    }
  };
}
export const usSupportWorkspaceHandlers = createUsSupportWorkspaceHandlers({
  enabled: usSupportWorkspacesEnabled, now,
  member: createUsSupportWorkspaceMember({ member: (request, org) => usTeamDependencies.member(request, org), database: async () => (await import('../runtime')).database(), policy: async () => parseUsSaasPolicy(await flags(), now()), now }),
  async store() { return d1UsSupportWorkspaceStore((await import('../runtime')).database()); },
  async rateLimit(request, operation, key) { await (await import('../account')).enforceAccountRateLimit(request, 'international-us-support-workspace-' + operation, key, operation === 'read' ? 600 : 60); },
  diagnostic(event) { console.warn('zentra.international.us-support-workspace', event); },
});
