import { AccountPublicError, requireAccountSameOrigin } from '@/lib/account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '@/lib/request-body';
import { createOrResumeUsWorkspace, creationUuid, publicWorkspaceCreation, validateWorkspaceCreationRequest, WorkspaceCreationError, type WorkspaceCreationIntent, type WorkspaceCreationPorts, type WorkspaceCreationStore } from './workspace-creation';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { SupabaseServerError } from '@/lib/supabase-server';

interface CreationDependencies {
  enabled(this: void): boolean | Promise<boolean>;
  user(this: void): Promise<{ userId: string } | null>;
  rateLimit(this: void, request: Request, userId: string, operation: 'read' | 'create'): Promise<void>;
  store(this: void): WorkspaceCreationStore | Promise<WorkspaceCreationStore>;
  allocateId(this: void): string;
  now(this: void): string;
  fingerprint(this: void, value: string): Promise<string>;
  admit(this: void, intent: WorkspaceCreationIntent): Promise<unknown>;
  diagnostic(this: void, event: { operation: 'read' | 'create'; code: string; status: number }): void;
}
const headers = { 'Cache-Control':'no-store, max-age=0', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
class CreationBoundaryError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
export function createWorkspaceCreationHandlers(dependencies: CreationDependencies) {
  async function user(request: Request) {
    // A device tied to a CH company never acquires authority to create a US one.
    if (request.headers.has('Authorization')) throw new CreationBoundaryError('browser_session_required', 401);
    const result = await dependencies.user();
    if (!result) throw new CreationBoundaryError('unauthorized', 401);
    try { creationUuid(result.userId); } catch { throw new CreationBoundaryError('unauthorized', 401); }
    return result;
  }
  async function revalidate(request: Request, actorUserId: string) {
    if (!(await dependencies.enabled())) throw new CreationBoundaryError('feature_unavailable', 404);
    const fresh = await user(request);
    if (fresh.userId !== actorUserId) throw new CreationBoundaryError('session_changed', 401);
  }
  function failure(error: unknown, operation: 'read' | 'create') {
    let code = 'service_unavailable', status = 503;
    if (error instanceof CreationBoundaryError || error instanceof WorkspaceCreationError) { code = error.code; status = error.status; }
    else if (error instanceof RequestBodyError) { code = 'invalid_request'; status = error.status; }
    else if (error instanceof AccountPublicError) { status = error.status; code = status === 401 ? 'unauthorized' : status === 429 ? 'rate_limited' : 'forbidden'; }
    // No submitted fields, tax identifiers, tokens, configuration or raw upstream error.
    try { dependencies.diagnostic({ operation, code, status }); } catch { /* diagnostics do not change the authorization result */ }
    return json({ error: code }, status);
  }
  return {
    async POST(this: void, request: Request) {
      try {
        if (!(await dependencies.enabled())) return json({ error:'feature_unavailable' }, 404);
        requireAccountSameOrigin(request);
        const actor = await user(request);
        await dependencies.rateLimit(request, actor.userId, 'create');
        const input = validateWorkspaceCreationRequest(await readJsonObjectWithinLimit(request, 16_384));
        const ports: WorkspaceCreationPorts = { store: await dependencies.store(), allocateId: () => dependencies.allocateId(), now: () => dependencies.now(), fingerprint: value => dependencies.fingerprint(value), admit: intent => dependencies.admit(intent), revalidate: () => revalidate(request, actor.userId) };
        const intent = await createOrResumeUsWorkspace(actor.userId, input, ports);
        return json(publicWorkspaceCreation(intent), 202);
      } catch (error) { return failure(error, 'create'); }
    },
    async GET(this: void, request: Request) {
      try {
        if (!(await dependencies.enabled())) return json({ error:'feature_unavailable' }, 404);
        const actor = await user(request);
        const requestId = creationUuid(new URL(request.url).searchParams.get('requestId'));
        await dependencies.rateLimit(request, actor.userId, 'read');
        const intent = await (await dependencies.store()).find(actor.userId, requestId);
        await revalidate(request, actor.userId);
        if (!intent) return json({ error:'not_found' }, 404);
        if (intent.actorUserId !== actor.userId || intent.requestId !== requestId) throw new WorkspaceCreationError('service_unavailable', 503);
        return json(publicWorkspaceCreation(intent));
      } catch (error) { return failure(error, 'read'); }
    },
  };
}
export const workspaceCreationDependencies: CreationDependencies = {
  async enabled() {
    if (!(await (await import('./workspace-server')).internationalCoreEnabled())) return false;
    try { const { env } = await import('cloudflare:workers'); return (env as unknown as { INTERNATIONAL_US_CREATION_ENABLED?: string }).INTERNATIONAL_US_CREATION_ENABLED === 'true'; }
    catch { return false; }
  },
  async user() { return (await import('@/app/zentra-auth')).getZentraUser({ offerAccess:false }); },
  async rateLimit(request, userId, operation) { await (await import('@/lib/account')).enforceAccountRateLimit(request, 'international-creation-' + operation, userId, operation === 'read' ? 120 : 10); },
  async store() { return d1WorkspaceCreationStore((await import('@/lib/runtime')).database()); },
  allocateId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
  async fingerprint(value) { return (await import('@/lib/account-security')).sha256Hex(value); },
  async admit(intent) {
    try {
      const { supabaseServerClient } = await import('@/lib/supabase-server-runtime');
      return await supabaseServerClient().rpc('zentra_admit_new_us_workspace_v1', {
        p_organization_id:intent.organizationId, p_creation_id:intent.creationId, p_actor_user_id:intent.actorUserId, p_request_id:intent.requestId, p_configuration:intent.configuration, p_fingerprint:intent.fingerprint,
      });
    } catch (error) {
      if (error instanceof SupabaseServerError && error.code === 'PA002') throw new WorkspaceCreationError('request_id_conflict', 409);
      if (error instanceof SupabaseServerError && error.code === 'PA003') throw new WorkspaceCreationError('workspace_not_new', 409);
      throw new WorkspaceCreationError('service_unavailable', 503);
    }
  },
  diagnostic(event) { console.warn('[zentra-us-workspace-creation]', JSON.stringify(event)); },
};
export const workspaceCreationHandlers = createWorkspaceCreationHandlers(workspaceCreationDependencies);
