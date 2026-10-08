import { getZentraUser } from '@/app/zentra-auth';
import { accountWorkspacesForUser, accountWorkspaceDiscoveryEnabled, AccountWorkspaceDiscoveryError } from '@/lib/account-workspaces';
import { AuthPublicError, authNoStoreHeaders, requireAuthSameOrigin } from '@/lib/supabase-auth-http';

export const dynamic = 'force-dynamic';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: authNoStoreHeaders() });

export async function GET(request: Request): Promise<Response> {
  try {
    // Device credentials are tenant-bound; discovery uses only the browser Auth account.
    if (request.headers.has('Authorization')) return json({ error: 'browser_session_required' }, 401);
    requireAuthSameOrigin(request);
    const actor = await getZentraUser({ offerAccess: false });
    if (!actor) return json({ error: 'unauthorized' }, 401);
    const workspaces = await accountWorkspacesForUser(actor.userId);
    const fresh = await getZentraUser({ offerAccess: false });
    if (!fresh || fresh.userId !== actor.userId) return json({ error: 'session_changed' }, 401);
    const includeUs = await accountWorkspaceDiscoveryEnabled();
    const publicWorkspaces = workspaces.filter(workspace => includeUs || workspace.edition === 'ch_legacy')
      .map(({ organizationId, name, edition, role }) => ({ organizationId, name, edition, role }));
    return json({ workspaces: publicWorkspaces });
  } catch (error) {
    // Never disclose submitted identifiers, private authority JSON or upstream errors.
    if (error instanceof AuthPublicError && error.status === 403) return json({ error: 'forbidden' }, 403);
    if (error instanceof AccountWorkspaceDiscoveryError) return json({ error: error.code }, error.status);
    return json({ error: 'service_unavailable' }, 503);
  }
}
