import type { BusinessPendingResolution } from './businessResolutionSession';

export type BusinessHistorySelection = {
  organization_id: string;
  installation_id: string;
  capture_generation: string;
  generation: string;
  bootstrap_transfer_id: string;
};
export type BusinessCycleState =
  | { state: 'waiting_for_connection' | 'history_required' }
  | { state: 'ready'; selection: BusinessHistorySelection; pending_transactions: number; resolution?: BusinessPendingResolution | null };
export type BusinessCycleStatus = {
  state: 'receiving' | 'awaiting_installation' | 'installed' | 'sending'
    | 'awaiting_receipt' | 'idle' | 'conflict' | 'invalid' | 'retry'
    | 'busy' | 'waiting_for_connection' | 'paused';
  selection: BusinessHistorySelection;
  workspace_changed: boolean;
  detail: Record<string, unknown> | null;
  replication_active: false;
};

export function sameBusinessSelection(a: BusinessHistorySelection, b: BusinessHistorySelection) {
  return a && b && a.organization_id === b.organization_id
    && a.installation_id === b.installation_id && a.generation === b.generation
    && a.capture_generation === b.capture_generation
    && a.bootstrap_transfer_id === b.bootstrap_transfer_id;
}

// The caller must explicitly select a native installed history. This module
// does not discover/select accounts or auto-enable itself when the app opens.
export function startBusinessCycleScheduler(options: {
  selection: BusinessHistorySelection;
  synchronize: (selection: BusinessHistorySelection, installReceived: boolean) => Promise<BusinessCycleStatus>;
  pauseNative: () => Promise<unknown>;
  isOnline: () => boolean;
  canInstall: () => boolean;
  beforePass?: () => Promise<void>;
  onStatus?: (status: BusinessCycleStatus) => void;
  onError?: (reason: unknown) => void;
  // Check the signal after loading and before replacing the visible workspace.
  onWorkspaceChanged: (signal: AbortSignal) => Promise<void>;
}) {
  const selection = Object.freeze({ ...options.selection });
  const controller = new AbortController();
  let active = true;
  let held = false;
  let failures = 0;
  let retryAt = 0;
  let refreshPending = false;
  let wakePending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;

  function schedule(delay: number) {
    clearTimeout(timer);
    if (!active || held) return;
    timer = setTimeout(() => {
      if (running) return;
      running = tick().finally(() => { running = undefined; });
    }, Math.max(delay, retryAt - Date.now()));
  }
  async function refresh() {
    if (refreshPending) {
      await options.onWorkspaceChanged(controller.signal);
      refreshPending = false;
    }
  }
  async function tick() {
    let delay = 60_000;
    try {
      if (!active) return;
      await options.beforePass?.();
      if (!active) return;
      // A refresh that failed after an install must be retried even if the next
      // native pass would be idle, and does not require an internet connection.
      await refresh();
      if (!active || !options.isOnline()) return;
      const status = await options.synchronize(selection, options.canInstall());
      if (!active) return;
      if (!sameBusinessSelection(status.selection, selection)) {
        held = true;
        throw new Error('Le dossier synchronisé a changé. Sélectionnez à nouveau votre entreprise.');
      }
      refreshPending ||= status.workspace_changed;
      await refresh();
      if (!active) return;
      switch (status.state) {
        case 'installed': case 'awaiting_receipt': delay = 500; break;
        case 'receiving': case 'sending': case 'busy': delay = 3_000; break;
        case 'retry': delay = 5_000; break;
        case 'awaiting_installation': case 'idle': case 'waiting_for_connection': break;
        case 'conflict': case 'invalid': case 'paused': held = true; break;
        default:
          held = true;
          throw new Error('Cette version de synchronisation n’est pas reconnue.');
      }
      failures = 0;
      retryAt = 0;
      options.onStatus?.(status);
    } catch (reason) {
      if (active) {
        failures++;
        delay = Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4));
        retryAt = Date.now() + delay;
        options.onError?.(reason);
      }
    } finally {
      schedule(wakePending && failures === 0 ? 500 : delay);
      wakePending = false;
    }
  }
  schedule(300);
  return {
    wake() {
      if (!active || held) return;
      if (running) wakePending = true;
      else schedule(300);
    },
    // Conflict/invalid/history changes stop this instance. Resume only by
    // creating a new instance after checking the selected history and conflict.
    stop(): Promise<void> {
      if (stopped) return stopped;
      active = false;
      controller.abort();
      clearTimeout(timer);
      stopped = (async () => {
        // Drain both requests even if cancellation fails; a new scheduler must
        // not race an installer whose native command is still in flight.
        const results = await Promise.allSettled([
          Promise.resolve().then(options.pauseNative), running,
        ]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return stopped;
    },
  };
}
