import { useEffect, useRef, useSyncExternalStore } from 'react';
import { desktopApi } from './bridge';
import { errorMessage } from './utils';
import type { Workspace } from './types';

export type ProjectSyncStatus = {
  organizationId?: string | null;
  lastSyncedAt?: string | null;
  pending: number;
  connected?: boolean;
  syncing: boolean;
  changed?: boolean;
  error?: string;
  documents: {
    document_id: string;
    project_id: string;
    state: 'upload' | 'delete' | 'synced';
    last_error?: string | null;
  }[];
};
const initial: ProjectSyncStatus = {
  pending: 0,
  syncing: false,
  documents: [],
};
let snapshot = initial;
const listeners = new Set<() => void>();
function publish(value: ProjectSyncStatus) {
  snapshot = value;
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useProjectSyncStatus() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => initial,
  );
}
export function requestProjectSync() {
  window.dispatchEvent(new Event('zentra-project-documents-changed'));
}

export function useProjectSyncBackground(
  onWorkspace: (workspace: Workspace) => void,
) {
  const onWorkspaceRef = useRef(onWorkspace);
  useEffect(() => {
    onWorkspaceRef.current = onWorkspace;
  }, [onWorkspace]);
  useEffect(() => {
    let active = true,
      running = false,
      again = false,
      failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (active) timer = setTimeout(() => void synchronize(), delay);
    };
    async function synchronize() {
      if (!active) return;
      if (running) {
        again = true;
        return;
      }
      if (navigator.onLine === false) {
        const local = await desktopApi
          .getProjectSyncStatus()
          .catch(() => snapshot);
        if (active)
          publish({
            ...local,
            syncing: false,
            error:
              'Hors ligne. Vos fichiers sont disponibles sur cet appareil. Les envois reprendront au retour du réseau.',
          });
        schedule(60_000);
        return;
      }
      running = true;
      publish({ ...snapshot, syncing: true, error: undefined });
      try {
        const status = await desktopApi.syncProjectDocuments();
        if (active) {
          publish(status);
          if (status.changed) {
            const workspace = await desktopApi.loadWorkspace();
            if (active) onWorkspaceRef.current(workspace);
          }
        }
        failures = status.error ? failures + 1 : 0;
      } catch (reason) {
        failures++;
        if (active)
          publish({
            ...snapshot,
            syncing: false,
            error: errorMessage(
              reason,
              'La synchronisation reprendra automatiquement. Les fichiers locaux sont conservés.',
            ),
          });
      } finally {
        running = false;
        schedule(
          again
            ? 500
            : failures
              ? Math.min(300_000, 30_000 * 2 ** Math.min(failures, 4))
              : snapshot.connected && snapshot.pending
                ? 5_000
                : 60_000,
        );
        again = false;
      }
    }
    const wake = () => schedule(300);
    const visible = () => {
      if (document.visibilityState === 'visible') wake();
    };
    window.addEventListener('online', wake);
    window.addEventListener('offline', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('zentra-project-documents-changed', wake);
    document.addEventListener('visibilitychange', visible);
    void desktopApi
      .getProjectSyncStatus()
      .then((local) => {
        if (active) publish(local);
      })
      .catch(() => {});
    schedule(1500);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('zentra-project-documents-changed', wake);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
}
