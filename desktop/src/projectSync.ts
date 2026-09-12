import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { desktopApi } from './bridge';
import { errorMessage } from './utils';
import type { Workspace } from './types';
import { startProjectSyncScheduler } from './projectSyncScheduler';

export type ProjectSyncStatus = {
  mode?: 'legacy' | 'preparing' | 'business';
  busy?: boolean;
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
  window.dispatchEvent(new CustomEvent('zentra-project-documents-changed', { detail: { userRequested: true } }));
}

export function useProjectSyncBackground(
  onWorkspace: (workspace: Workspace) => void,
  accountScope = 'local',
) {
  const onWorkspaceRef = useRef(onWorkspace);
  useLayoutEffect(() => {
    onWorkspaceRef.current = onWorkspace;
  }, [onWorkspace]);
  useLayoutEffect(() => {
    publish(initial);
    const scheduler = startProjectSyncScheduler({
      local: desktopApi.getProjectSyncStatus,
      synchronize: desktopApi.syncProjectDocuments,
      isOnline: () => navigator.onLine !== false,
      onStatus: publish,
      onRunning: syncing => publish({ ...snapshot, syncing }),
      onError: reason => publish({ ...snapshot, syncing: false,
        error: errorMessage(reason, 'La synchronisation reprendra automatiquement. Les fichiers locaux sont conservés.') }),
      onWorkspaceChanged: async signal => {
        const workspace = await desktopApi.loadWorkspace();
        if (!signal.aborted) onWorkspaceRef.current(workspace);
      },
    });
    const wake = (event?: Event) => scheduler.wake(event?.type === 'online' || (event instanceof CustomEvent && event.detail?.userRequested === true));
    const visible = () => { if (document.visibilityState === 'visible') wake(); };
    const events = ['online', 'offline', 'focus', 'zentra-project-documents-changed'];
    events.forEach(event => window.addEventListener(event, wake));
    document.addEventListener('visibilitychange', visible);
    return () => {
      scheduler.stop();
      events.forEach(event => window.removeEventListener(event, wake));
      document.removeEventListener('visibilitychange', visible);
    };
  }, [accountScope]);
}
