import type { Workspace } from './types';
import { errorMessage } from './utils';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

export type ProjectFileState = {
  files: File[]; saving: boolean; error: string; progress: string; notice: string;
  refreshPending: boolean; uploadFailures: { file: File; message: string }[];
};
const emptyState = (): ProjectFileState => ({ files: [], saving: false, error: '', progress: '', notice: '', refreshPending: false, uploadFailures: [] });
type Api = {
  add: (projectId: string, file: File, signal: AbortSignal) => Promise<unknown>;
  remove: (id: string) => Promise<Workspace>;
  load: () => Promise<Workspace>;
};
export type ProjectFileActivity = { projectId: string; state: ProjectFileState };

/** File selections belong to the open workspace, independently of the current page. */
export function createProjectFileSessions(api: Api, onWorkspace: (workspace: Workspace) => void) {
  let active = true, writable = true, epoch = 0, latestRead = 0;
  let controller = new AbortController();
  let activity: ProjectFileActivity[] = [];
  const listeners = new Set<() => void>();
  const sessions = new Map<string, ReturnType<typeof createSession>>();
  function publish() {
    activity = [...sessions].map(([projectId, session]) => ({ projectId, state: session.getSnapshot() }))
      .filter(({ state }) => state.files.length || state.saving || state.refreshPending);
    listeners.forEach(listener => listener());
  }
  function createSession(projectId: string) {
    let state = emptyState();
    const subscribers = new Set<() => void>();
    const update = (patch: Partial<ProjectFileState>) => {
      if (!active) return;
      state = { ...state, ...patch };
      subscribers.forEach(listener => listener());
      publish();
    };
    const current = (token: number) => active && token === epoch;
    async function refresh(token: number) {
      if (!current(token)) return;
      update({ progress: 'Actualisation de la liste…' });
      const read = ++latestRead;
      try {
        const workspace = await api.load();
        if (!current(token)) return;
        if (read === latestRead) onWorkspace(workspace);
        update({ refreshPending: false, error: '' });
      } catch (reason) {
        if (current(token)) update({ refreshPending: true, error: errorMessage(reason, 'La liste des documents ne peut pas être actualisée pour le moment.') });
      }
    }
    return {
      projectId,
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
      setFiles(files: File[]) { if (!state.saving && !state.refreshPending && writable) update({ files, error: '', notice: '', uploadFailures: state.uploadFailures.filter(item => files.includes(item.file)) }); },
      setError(error: string) { update({ error }); },
      reset() { state = emptyState(); },
      async refresh() {
        if (!active || state.saving) return;
        const token = epoch;
        update({ saving: true });
        try { await refresh(token); }
        finally { if (current(token)) update({ saving: false, progress: '' }); }
      },
      async upload() {
        if (!active || !writable || state.saving || state.refreshPending || !state.files.length) return;
        const token = epoch, selected = [...state.files];
        const remaining = [...selected], failures: ProjectFileState['uploadFailures'] = [];
        let added = 0;
        update({ saving: true, error: '', notice: '', uploadFailures: [] });
        try {
          for (const [index, file] of selected.entries()) {
            if (!current(token) || !writable) break;
            update({ progress: `Ajout ${index + 1}/${selected.length} · ${file.name}` });
            try {
              await api.add(projectId, file, controller.signal);
              if (!current(token)) return;
              remaining.splice(remaining.indexOf(file), 1); added++;
            } catch (reason) {
              if (!current(token)) return;
              if (writable || !(reason instanceof DOMException && reason.name === 'AbortError')) {
                failures.push({ file, message: errorMessage(reason, 'Ajout impossible. Réessayez ou choisissez une autre copie du fichier.') });
              }
            }
            update({ files: [...remaining], uploadFailures: [...failures] });
          }
          if (!current(token)) return;
          const result = added ? `${added} fichier${added > 1 ? 's' : ''} enregistré${added > 1 ? 's' : ''} sur cet appareil.${remaining.length ? ' Seuls les fichiers ci-dessous restent à ajouter.' : ''}` : 'Les fichiers sélectionnés restent à ajouter.';
          update({ notice: !writable && remaining.length ? `${result} L’ajout est en pause tant que l’application est en lecture seule.` : result });
          await refresh(token);
        } finally { if (current(token)) update({ saving: false, progress: '' }); }
      },
      async remove(id: string): Promise<boolean> {
        if (!active || !writable || state.saving || state.refreshPending) return false;
        const token = epoch;
        const read = ++latestRead;
        update({ saving: true, error: '', notice: '', progress: 'Suppression du document…' });
        try {
          const workspace = await api.remove(id);
          if (!current(token)) return false;
          update({ notice: 'Le document a été supprimé de ce projet.' });
          // This receipt includes a write. A read begun elsewhere while the write
          // was pending may predate it, so reconcile again instead of discarding it.
          if (read === latestRead) onWorkspace(workspace);
          else await refresh(token);
          return true;
        } catch (reason) {
          if (!current(token)) return false;
          if (reason instanceof WorkspaceRefreshAfterMutationError) {
            update({ refreshPending: true, notice: 'Le document a été supprimé de ce projet.', error: errorMessage(reason.refreshCause, 'La liste des documents doit être actualisée.') });
            return true;
          }
          update({ error: errorMessage(reason, 'Le document n’a pas pu être supprimé. Réessayez.') });
          return false;
        } finally { if (current(token)) update({ saving: false, progress: '' }); }
      },
    };
  }
  return {
    forProject(projectId: string) {
      let session = sessions.get(projectId);
      if (!session) { session = createSession(projectId); sessions.set(projectId, session); }
      return session;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getActivity: () => activity,
    moveSelection(fromId: string, toId: string) {
      if (!active || !writable || !toId || fromId === toId) return false;
      const from = sessions.get(fromId), to = sessions.get(toId) ?? createSession(toId);
      if (!from) return false;
      const source = from.getSnapshot(), target = to.getSnapshot();
      if (!source.files.length || source.saving || source.refreshPending || target.saving || target.refreshPending) return false;
      sessions.set(toId, to);
      // Different File objects may hold different bytes even with identical
      // names and sizes. Preserve them; native storage deduplicates by hash.
      to.setFiles([...new Set([...target.files, ...source.files])]);
      from.setFiles([]);
      return true;
    },
    setWritable(value: boolean) {
      writable = value;
      if (!value) controller.abort();
      else if (active && controller.signal.aborted) controller = new AbortController();
    },
    start() { if (controller.signal.aborted) controller = new AbortController(); active = true; },
    stop() { active = false; epoch++; controller.abort(); sessions.forEach(session => session.reset()); activity = []; },
  };
}
export type ProjectFileSessions = ReturnType<typeof createProjectFileSessions>;
export type ProjectFileSession = ReturnType<ProjectFileSessions['forProject']>;
