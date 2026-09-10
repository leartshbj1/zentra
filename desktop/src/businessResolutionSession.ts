import type { BusinessInstallationLock, BusinessInstallationRequest } from './businessCycleSession';
import { sameBusinessSelection, type BusinessHistorySelection } from './businessCycleScheduler';

export type BusinessResolutionTarget = { transaction_id: string; resolution_id: string };
export type BusinessPendingResolution = BusinessResolutionTarget & { accepted: boolean; cancellation_requested: boolean; can_apply: boolean };
export type BusinessResolutionResult = BusinessResolutionTarget & {
  state: 'resolution_installed' | 'resolution_cancelled'; selection: BusinessHistorySelection; workspace_changed: boolean;
  installed?: boolean; cancelled?: boolean; cancellation_superseded?: boolean;
};
export type BusinessResolutionAction = 'apply' | 'cancel';

export function validateBusinessResolutionResult(result: BusinessResolutionResult, target: BusinessResolutionTarget) {
  const installed = result.state === 'resolution_installed' && result.installed === true && result.cancelled !== true && result.workspace_changed === true;
  const cancelled = result.state === 'resolution_cancelled' && result.cancelled === true && result.installed !== true && result.workspace_changed === false;
  if (result.transaction_id !== target.transaction_id || result.resolution_id !== target.resolution_id || (!installed && !cancelled))
    throw new Error('La confirmation de résolution est incohérente. Actualisez le dossier avant de reprendre.');
}

/** An explicit operation holds one barrier across both native permissions and
 * reload. A failed reload retries reads only, never the native mutation. */
export function startBusinessResolutionSession(options: {
  selection: BusinessHistorySelection;
  invoke: (permission: { requestId: string; onRequest: (request: BusinessInstallationRequest) => void }) => Promise<BusinessResolutionResult>;
  respond: (id: string, allow: boolean) => Promise<boolean>;
  pause: (id: string) => Promise<unknown>;
  isCurrent: () => boolean;
  canInstall: () => boolean;
  acquire: () => BusinessInstallationLock;
  refresh: () => Promise<void>;
  createRequestId?: () => string;
}) {
  if (!options.isCurrent() || !options.canInstall()) throw new Error('Terminez vos saisies, puis reprenez cette résolution depuis l’accueil ou une liste.');
  let active = true, open = true, needsRefresh = true;
  let lock: BusinessInstallationLock | undefined = options.acquire();
  let refreshing: Promise<void> | undefined;
  const requestId = options.createRequestId?.() ?? crypto.randomUUID();
  const permissionIds = new Set<string>();
  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    if (!needsRefresh) return Promise.resolve();
    refreshing = Promise.resolve().then(options.refresh).then(() => {
      needsRefresh = false; lock?.release(); lock = undefined;
    }).catch(reason => { lock?.failed(reason, refresh); throw reason; })
      .finally(() => { refreshing = undefined; });
    return refreshing;
  }
  const done = (async () => {
    try {
      return await options.invoke({ requestId, onRequest: request => {
        const allow = active && open && Boolean(lock) && options.isCurrent()
          && sameBusinessSelection(request.selection, options.selection) && !permissionIds.has(request.request_id);
        permissionIds.add(request.request_id);
        // Missing/failed replies also expire closed in the native handshake.
        void options.respond(request.request_id, allow).catch(() => {});
      } });
    } finally { open = false; await refresh(); }
  })();
  return { done, refresh, async stop() {
    active = false;
    await Promise.allSettled([open ? options.pause(requestId) : Promise.resolve(), done]);
    if (!options.isCurrent()) { lock?.release(); lock = undefined; }
  } };
}
