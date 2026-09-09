import { sameBusinessSelection, startBusinessCycleScheduler, type BusinessCycleStatus, type BusinessHistorySelection } from './businessCycleScheduler';

export type BusinessInstallationRequest = { request_id: string; selection: BusinessHistorySelection };
export type BusinessInstallationLock = { release: () => void; failed: (reason: unknown, retry: () => Promise<void>) => void };

/** Own the native invoke, final permission and refresh as one serialized operation. */
export function startBusinessCycleSession(options: {
  selection: BusinessHistorySelection;
  synchronize: (selection: BusinessHistorySelection, install: boolean, permission: {
    requestId: string; onRequest: (request: BusinessInstallationRequest) => void;
  }) => Promise<BusinessCycleStatus>;
  respond: (requestId: string, allow: boolean) => Promise<boolean>;
  pause: (requestId: string) => Promise<unknown>;
  isOnline: () => boolean;
  isCurrent: () => boolean;
  canInstall: () => boolean;
  acquire: () => BusinessInstallationLock;
  // Commit the refreshed React tree before resolving; skip a detached view.
  refreshWorkspace: () => Promise<void>;
  onStatus: (status: BusinessCycleStatus) => void;
  onError: (reason: unknown) => void;
  createRequestId?: () => string;
}) {
  let active = true;
  let current: { id: string; open: boolean } | undefined;
  let lock: BusinessInstallationLock | undefined;
  let needsRefresh = false;
  let refreshing: Promise<void> | undefined;
  let drain: Promise<void> | undefined;
  const report = (reason: unknown) => { if (options.isCurrent()) options.onError(reason); };
  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    if (!needsRefresh) return Promise.resolve();
    refreshing = (async () => {
      if (options.isCurrent() && !lock) {
        if (!options.canInstall()) throw new Error('Terminez la saisie en cours pour actualiser le dossier.');
        lock = options.acquire();
      }
      await options.refreshWorkspace();
      needsRefresh = false;
      lock?.release();
      lock = undefined;
    })().catch(reason => {
      lock?.failed(reason, refresh);
      throw reason;
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  }
  const scheduler = startBusinessCycleScheduler({
    selection: options.selection,
    isOnline: options.isOnline,
    canInstall: options.canInstall,
    beforePass: refresh,
    synchronize: async (selection, install) => {
      const attempt = { id: options.createRequestId?.() ?? crypto.randomUUID(), open: true };
      current = attempt;
      try {
        const status = await options.synchronize(selection, install, {
          requestId: attempt.id,
          onRequest: request => {
            let allow = false;
            if (active && attempt.open && current === attempt && options.isCurrent()
              && sameBusinessSelection(request.selection, selection) && !lock && options.canInstall()) {
              lock = options.acquire(); // Synchronous: inert + event guard before the reply.
              needsRefresh = true;
              allow = true;
            }
            void options.respond(request.request_id, allow).catch(report);
          },
        });
        needsRefresh ||= status.workspace_changed;
        return status;
      } finally {
        attempt.open = false;
        current = undefined;
        // Even an invoke error may follow a committed database transaction.
        // Hold the barrier until the local workspace has actually been reloaded.
        await refresh();
      }
    },
    pauseNative: () => current ? options.pause(current.id) : Promise.resolve(),
    onWorkspaceChanged: async () => {}, // The session refreshes before returning the status.
    onStatus: status => { if (active && options.isCurrent()) options.onStatus(status); },
    onError: report,
  });
  return {
    wake: scheduler.wake,
    refresh,
    stop(): Promise<void> {
      if (!drain) {
        active = false;
        drain = scheduler.stop().catch(report);
      }
      return drain.then(refresh).finally(() => {
        // A replacement view acquires its own startup lock before awaiting this
        // drain. The detached tree must never hold a failed refresh indefinitely.
        if (!options.isCurrent()) { lock?.release(); lock = undefined; }
      });
    },
  };
}

export const BUSINESS_CYCLE_PREFERENCE = 'zentra.business-cycle.v1';
export function parseBusinessCyclePreference(raw: string | null): BusinessHistorySelection | null {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = ['organization_id', 'installation_id', 'capture_generation', 'generation', 'bootstrap_transfer_id'] as const;
    if (Object.keys(value).length !== keys.length || keys.some(key => typeof (value as Record<string, unknown>)[key] !== 'string' || !(value as Record<string, string>)[key])) return null;
    return value as BusinessHistorySelection;
  } catch { return null; }
}
