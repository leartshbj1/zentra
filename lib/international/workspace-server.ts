import type { AccountRole } from '@/lib/account-security';
import { AccountPublicError, requireAccountSameOrigin } from '@/lib/account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '@/lib/request-body';
import { getWorkspaceCountry, putWorkspaceCountry, validateWorkspaceCountryWrite, WorkspaceCountryError, type WorkspaceCountryActor, type WorkspaceCountryStore } from './workspace-service';

export interface WorkspaceCountryDependencies {
  enabled(): boolean | Promise<boolean>;
  user(): Promise<{ userId: string } | null>;
  membership(userId: string, organizationId: string, roles?: readonly AccountRole[]): Promise<{ organizationId: string; role: AccountRole }>;
  store(): WorkspaceCountryStore | Promise<WorkspaceCountryStore>;
}
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
function failure(error: unknown): Response {
  if (error instanceof WorkspaceCountryError) return json({ error: error.code }, error.status);
  if (error instanceof AccountPublicError) return json({ error: error.status === 401 ? 'unauthorized' : 'forbidden' }, error.status);
  if (error instanceof RequestBodyError) return json({ error: 'invalid_request' }, error.status);
  return json({ error: 'service_unavailable' }, 503);
}

/** Reuse D1 membership + seat authority before opening the Supabase store. */
export function createWorkspaceCountryHandlers(dependencies: WorkspaceCountryDependencies) {
  async function actor(organizationId: string, owner: boolean): Promise<WorkspaceCountryActor> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)) throw new WorkspaceCountryError('invalid_request', 422);
    const user = await dependencies.user();
    if (!user) throw new AccountPublicError('Session required', 401);
    const membership = await dependencies.membership(user.userId, organizationId, owner ? ['owner'] : undefined);
    // Reject an inconsistent authority result instead of trusting a path or body.
    if (membership.organizationId !== organizationId || (owner && membership.role !== 'owner')) throw new WorkspaceCountryError('forbidden', 403);
    return { organizationId: membership.organizationId, userId: user.userId, role: membership.role };
  }
  return {
    async GET(_request: Request, organizationId: string): Promise<Response> {
      try {
        if (!(await dependencies.enabled())) return json({ error: 'feature_unavailable' }, 404);
        const trusted = await actor(organizationId, false);
        return json(await getWorkspaceCountry(await dependencies.store(), trusted));
      } catch (error) { return failure(error); }
    },
    async PUT(request: Request, organizationId: string): Promise<Response> {
      try {
        if (!(await dependencies.enabled())) return json({ error: 'feature_unavailable' }, 404);
        requireAccountSameOrigin(request);
        const trusted = await actor(organizationId, true);
        const body = await readJsonObjectWithinLimit(request, 16_384);
        const write = validateWorkspaceCountryWrite(body, trusted.organizationId);
        return json(await putWorkspaceCountry(await dependencies.store(), trusted, write));
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
export const workspaceCountryHandlers = createWorkspaceCountryHandlers({
  enabled: internationalCoreEnabled,
  async user() { return (await import('@/app/zentra-auth')).getZentraUser(); },
  async membership(userId, organizationId, roles) { return (await import('@/lib/account')).requireBrowserMembership(userId, organizationId, roles); },
  async store() { return (await import('@/lib/supabase-server-runtime')).supabaseServerClient(); },
});
