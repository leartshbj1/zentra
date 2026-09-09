import type { ProjectSyncStatus } from './projectSync';

export function startProjectSyncScheduler(options: {
  local: () => Promise<ProjectSyncStatus>;
  synchronize: () => Promise<ProjectSyncStatus>;
  isOnline: () => boolean;
  onStatus: (status: ProjectSyncStatus) => void;
  onError: (reason: unknown) => void;
  onRunning?: (running: boolean) => void;
  onWorkspaceChanged: (signal: AbortSignal) => Promise<void>;
}) {
  const controller = new AbortController();
  let active = true, running = false, wakePending = false, failures = 0, retryAt = 0;
  let refreshPending = false, initial = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule(delay: number) {
    clearTimeout(timer);
    if (active) timer = setTimeout(() => void tick(), Math.max(delay, retryAt - Date.now()));
  }
  async function refresh() {
    if (refreshPending) {
      await options.onWorkspaceChanged(controller.signal);
      refreshPending = false;
    }
  }
  async function tick() {
    if (!active || running) return;
    running = true;
    let delay = 60_000;
    try {
      await refresh();
      if (!active) return;
      const online = options.isOnline();
      if (initial || !online) {
        const local = await options.local();
        if (!active) return;
        initial = false;
        options.onStatus(online ? local : { ...local, syncing: false,
          error: 'Hors ligne. Les fichiers présents sur cet appareil restent disponibles. La synchronisation reprendra au retour du réseau.' });
        if (!online) return;
      }
      if (!options.isOnline()) return;
      options.onRunning?.(true);
      const status = await options.synchronize();
      if (!active) return;
      refreshPending ||= Boolean(status.changed);
      await refresh();
      if (!active) return;
      options.onStatus(status);
      if (status.error) {
        failures++;
        delay = Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4));
        retryAt = Date.now() + delay;
      } else {
        failures = 0; retryAt = 0;
        delay = status.busy ? 3_000 : status.mode === 'legacy' || !status.mode
          ? status.connected && status.pending ? 5_000 : 60_000 : 60_000;
      }
    } catch (reason) {
      failures++;
      delay = Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4));
      retryAt = Date.now() + delay;
      if (active) options.onError(reason);
    } finally {
      running = false;
      if (active) options.onRunning?.(false);
      schedule(wakePending && failures === 0 ? 300 : delay);
      wakePending = false;
    }
  }
  schedule(300);
  return {
    wake() { if (!active) return; if (running) wakePending = true; else schedule(300); },
    stop() { active = false; controller.abort(); clearTimeout(timer); },
  };
}
