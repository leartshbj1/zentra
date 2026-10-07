import type { AccountRole } from '@/lib/account-security';
import { AccountPublicError, isAccountRole, requireAccountSameOrigin } from '@/lib/account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '@/lib/request-body';
import { getWorkspaceCountry, putWorkspaceCountry, validateWorkspaceCountryWrite, WorkspaceCountryError, type WorkspaceCountryActor, type WorkspaceCountryState, type WorkspaceCountryStore } from './workspace-service';
import type { CompanyConfiguration } from './types';
import { publicCompanyConfiguration } from './public-projection';

export interface WorkspaceCountryDeviceSession {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: AccountRole;
  readonly sessionId: string;
  readonly installationId: string;
  readonly subscriptionId: string;
}

export interface WorkspaceCountryDependencies {
  enabled(): boolean | Promise<boolean>;
  user(): Promise<{ userId: string } | null>;
  membership(userId: string, organizationId: string, roles?: readonly AccountRole[]): Promise<{ organizationId: string; role: AccountRole }>;
  deviceSession(request: Request, roles?: readonly AccountRole[]): Promise<WorkspaceCountryDeviceSession>;
  /** Effective Gestion access; membership/seat alone is insufficient. */
  management(organizationId: string): Promise<boolean>;
  rateLimit(request: Request, actor: WorkspaceCountryActor, operation: 'read' | 'write'): Promise<void>;
  /** Server attestation only, never a submitted boolean or a missing country row.
   * Must remain closed until explicit US creation and a shared legacy-write lock exist. */
  requireInitialUsAdmission(actor: WorkspaceCountryActor, configuration: CompanyConfiguration, state: WorkspaceCountryState): Promise<void>;
  store(): WorkspaceCountryStore | Promise<WorkspaceCountryStore>;
}
interface CountryAuthority {
  readonly actor: WorkspaceCountryActor;
  readonly mode: 'browser' | 'device';
  readonly device?: WorkspaceCountryDeviceSession;
}
class CountryBoundaryError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
function failure(error: unknown): Response {
  if (error instanceof CountryBoundaryError) return json({ error: error.code }, error.status);
  if (error instanceof WorkspaceCountryError) return json({ error: error.code }, error.status);
  if (error instanceof AccountPublicError) return json({ error: error.status === 401 ? 'unauthorized' : error.status === 402 ? 'management_entitlement_required' : error.status === 429 ? 'rate_limited' : 'forbidden' }, error.status);
  if (error instanceof RequestBodyError) return json({ error: 'invalid_request' }, error.status);
  return json({ error: 'service_unavailable' }, 503);
}

/** Reuse D1 membership + seat authority before opening the Supabase store. */
export function createWorkspaceCountryHandlers(dependencies: WorkspaceCountryDependencies) {
  async function authority(request: Request, organizationId: string, owner: boolean): Promise<CountryAuthority> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)) throw new WorkspaceCountryError('invalid_request', 422);
    let result: CountryAuthority;
    // An Authorization header selects only native auth, including malformed ones.
    // Invalid/revoked device credentials can never fall back to browser cookies.
    if (request.headers.has('Authorization')) {
      const device = await dependencies.deviceSession(request, owner ? ['owner'] : undefined);
      if (device.organizationId !== organizationId || !isAccountRole(device.role) || (owner && device.role !== 'owner')) throw new WorkspaceCountryError('forbidden', 403);
      if ([device.userId, device.sessionId, device.installationId, device.subscriptionId].some(value => typeof value !== 'string' || !value || value.length > 256)) throw new CountryBoundaryError('unauthorized', 401);
      result = { mode: 'device', actor: { organizationId, userId: device.userId, role: device.role }, device };
    } else {
      const user = await dependencies.user();
      if (!user || typeof user.userId !== 'string' || !user.userId || user.userId.length > 256) throw new AccountPublicError('Session required', 401);
      const membership = await dependencies.membership(user.userId, organizationId, owner ? ['owner'] : undefined);
      if (membership.organizationId !== organizationId || !isAccountRole(membership.role) || (owner && membership.role !== 'owner')) throw new WorkspaceCountryError('forbidden', 403);
      result = { mode: 'browser', actor: { organizationId, userId: user.userId, role: membership.role } };
    }
    if (!(await dependencies.management(organizationId))) throw new CountryBoundaryError('management_entitlement_required', 402);
    return result;
  }
  async function revalidate(request: Request, organizationId: string, owner: boolean, trusted: CountryAuthority): Promise<WorkspaceCountryActor> {
    const fresh = await authority(request, organizationId, owner);
    if (fresh.mode !== trusted.mode || fresh.actor.userId !== trusted.actor.userId || fresh.device?.sessionId !== trusted.device?.sessionId || fresh.device?.installationId !== trusted.device?.installationId || fresh.device?.subscriptionId !== trusted.device?.subscriptionId) throw new CountryBoundaryError('session_changed', 401);
    if (fresh.actor.role !== trusted.actor.role) throw new CountryBoundaryError('forbidden', 403);
    return fresh.actor;
  }
  function publicState<T extends WorkspaceCountryState>(state: T) {
    return state.status === 'configured' ? { ...state, configuration: publicCompanyConfiguration(state.configuration) } : state;
  }
  return {
    async GET(request: Request, organizationId: string): Promise<Response> {
      try {
        if (!(await dependencies.enabled())) return json({ error: 'feature_unavailable' }, 404);
        const trusted = await authority(request, organizationId, false);
        await dependencies.rateLimit(request, trusted.actor, 'read');
        const state = await getWorkspaceCountry(await dependencies.store(), trusted.actor);
        if (!(await dependencies.enabled())) return json({ error: 'feature_unavailable' }, 404);
        await revalidate(request, organizationId, false, trusted);
        return json(publicState(state));
      } catch (error) { return failure(error); }
    },
    async PUT(request: Request, organizationId: string): Promise<Response> {
      try {
        if (!(await dependencies.enabled())) return json({ error: 'feature_unavailable' }, 404);
        if (!request.headers.has('Authorization')) requireAccountSameOrigin(request);
        const trusted = await authority(request, organizationId, true);
        await dependencies.rateLimit(request, trusted.actor, 'write');
        const body = await readJsonObjectWithinLimit(request, 16_384);
        const write = validateWorkspaceCountryWrite(body, trusted.actor.organizationId);
        const store = await dependencies.store();
        const initial = await getWorkspaceCountry(store, trusted.actor);
        if (initial.status === 'unconfigured' && write.configuration.country === 'US') await dependencies.requireInitialUsAdmission(trusted.actor, write.configuration, initial);
        const current = await getWorkspaceCountry(store, trusted.actor);
        if (JSON.stringify(current) !== JSON.stringify(initial)) throw new CountryBoundaryError('configuration_changed', 409);
        // Do not reject a stale expectedRevision here: the PostgreSQL RPC must
        // still return an exact durable receipt on a retry after newer writes.
        const receipt = await putWorkspaceCountry(store, trusted.actor, write, async () => {
          if (!(await dependencies.enabled())) throw new CountryBoundaryError('feature_unavailable', 404);
          await revalidate(request, organizationId, true, trusted);
        });
        return json(publicState(receipt));
      } catch (error) { return failure(error); }
    },
  };
}

/** A missing binding is false. This feature has no automatic country fallback. */
export async function internationalCoreEnabled(): Promise<boolean> {
  try {
    const { env } = await import('cloudflare:workers');
    return (env as unknown as { INTERNATIONAL_CORE_ENABLED?: string }).INTERNATIONAL_CORE_ENABLED === 'true';
  } catch { return false; }
}
export const workspaceCountryDependencies: WorkspaceCountryDependencies = {
  enabled: internationalCoreEnabled,
  async user() { return (await import('@/app/zentra-auth')).getZentraUser({ offerAccess: false }); },
  async membership(userId, organizationId, roles) { return (await import('@/lib/account')).requireBrowserMembership(userId, organizationId, roles); },
  async deviceSession(request, roles) { return (await import('@/lib/account')).requireDeviceSession(request, roles); },
  async management(organizationId) { return (await (await import('@/lib/team-seats')).teamSeats(organizationId)).subscriptionActive === true; },
  async rateLimit(request, actor, operation) { await (await import('@/lib/account')).enforceAccountRateLimit(request, 'international-country-' + operation, actor.organizationId + ':' + actor.userId, operation === 'read' ? 3600 : 120); },
  async requireInitialUsAdmission() { throw new CountryBoundaryError('legacy_review_required', 409); },
  async store() { return (await import('@/lib/supabase-server-runtime')).supabaseServerClient(); },
};
export const workspaceCountryHandlers = createWorkspaceCountryHandlers(workspaceCountryDependencies);
