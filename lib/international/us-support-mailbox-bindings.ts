import { usSupportWorkspacesEnabled, createUsSupportWorkspaceMember } from './us-support-workspace-bindings';
import { d1UsSupportWorkspaceStore } from './us-support-workspace-d1';
import { UsSupportWorkspaceError, sameUsSupportWorkspaceContext, validateUsSupportWorkspace, validateUsSupportWorkspaceContext, type UsSupportWorkspaceContext, type UsSupportWorkspaceStore } from './us-support-workspace-contract';
import { UsMailboxError, validateUsMailboxContext } from './us-support-mailbox-contract';
import { d1UsMailboxStore } from './us-support-mailbox-d1';
import { createUsMailboxHandlers } from './us-support-mailbox-server';
import { createUsMailboxProvider } from './us-support-mailbox-provider';
import { usTeamDependencies } from './us-team-bindings';
import { parseUsSaasPolicy } from './saas-authority-d1';

const now = () => Math.floor(Date.now() / 1000);
async function flags(): Promise<Record<string, string | undefined>> { try { return (await import('cloudflare:workers')).env as unknown as Record<string, string | undefined>; } catch { return {}; } }
export async function usSupportMailboxEnabled(): Promise<boolean> {
  return await usSupportWorkspacesEnabled() && (await flags()).INTERNATIONAL_US_SUPPORT_MAILBOX_ENABLED === 'true' && await usSupportWorkspacesEnabled();
}
/** Real H1 registry binding; a UUID or claimed email is never a workspace. */
export function createUsMailboxMember(dependencies: {
  member(this: void, request: Request, org: string): Promise<UsSupportWorkspaceContext>;
  registry(this: void): Promise<UsSupportWorkspaceStore>; now(this: void): number;
}) {
  return async (request: Request, org: string) => {
    let initial: UsSupportWorkspaceContext | undefined;
    try {
    initial = validateUsSupportWorkspaceContext(await dependencies.member(request, org), org, dependencies.now());
    const store = await dependencies.registry();
    const one = await store.read(initial);
    if (!one) throw new UsMailboxError('support_workspace_required', 409);
    const workspace = validateUsSupportWorkspace(one, org);
    if (workspace.ownerUserId !== initial.ownerUserId) throw new UsMailboxError('invalid_mailbox_context', 503);
    const fresh = await dependencies.member(request, org); sameUsSupportWorkspaceContext(initial, fresh);
    const two = await store.read(fresh);
    if (!two || validateUsSupportWorkspace(two, org).workspaceId !== workspace.workspaceId || two.ownerUserId !== fresh.ownerUserId) throw new UsMailboxError('configuration_changed', 409);
    return validateUsMailboxContext({ schemaVersion: 1, authority: fresh, workspaceId: workspace.workspaceId }, org, dependencies.now());
    } catch (error) {
      // This wrapper adds registry awaits after H1 Auth. A logout/account
      // switch there must purge the browser's pending secret even if storage
      // fails before the HTTP handler can capture its admitted context.
      if (initial) {
        try { sameUsSupportWorkspaceContext(initial, await dependencies.member(request, org)); }
        catch (late) { if ((late instanceof UsSupportWorkspaceError || late instanceof UsMailboxError) && [401,402,403].includes(late.status)) throw late; }
      }
      throw error;
    }
  };
}
const member = createUsSupportWorkspaceMember({ member: (request, org) => usTeamDependencies.member(request, org), database: async () => (await import('../runtime')).database(), policy: async () => parseUsSaasPolicy(await flags(), now()), now });
export const usSupportMailboxMember = createUsMailboxMember({ member, registry: async () => d1UsSupportWorkspaceStore((await import('../runtime')).database()), now });
const provider = createUsMailboxProvider();
export const usSupportMailboxHandlers = createUsMailboxHandlers({
  enabled: usSupportMailboxEnabled, now,
  member: usSupportMailboxMember,
  async store() { return d1UsMailboxStore((await import('../runtime')).database()); },
  async encryptionKey() { return (await import('../runtime')).runtimeValue('SUPPORT_ENCRYPTION_KEY'); },
  verify: (email, token, check) => provider.verify(email, token, check),
  messages: (context, connection, token, offset, check) => provider.messages(context, connection, token, offset, check),
  async rateLimit(request, operation, key) { await (await import('../account')).enforceAccountRateLimit(request, 'international-us-support-mailbox-' + operation, key, operation === 'read' ? 600 : operation === 'messages' ? 12 : 30); },
  diagnostic(event) { console.warn('zentra.international.us-support-mailbox', event); },
});
