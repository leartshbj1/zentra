import { desktopApi } from '../src/bridge';
import { WorkspaceRefreshAfterMutationError } from '../src/workspaceMutation';

// Development-only failures around real form/preview components; never uses user data.
export function installProjectRecoveryFixture() {
  const state = recoveryState();
  window.projectRecovery = state;
  const add = desktopApi.addProjectDocument, remove = desktopApi.deleteProjectDocument;
  const load = desktopApi.loadWorkspace, save = desktopApi.saveProject;
  desktopApi.addProjectDocument = async (project, file) => {
    state.uploads.push(file.name);
    if (state.holdUpload) await new Promise<void>(resolve => { state.releaseUpload = () => { state.holdUpload = false; resolve(); }; });
    if (state.uploadFailures[file.name] > 0) {
      state.uploadFailures[file.name]--;
      throw new Error('Cette copie du fichier est illisible. Sélectionnez une autre copie ou réessayez.');
    }
    return add(project, file);
  };
  desktopApi.loadWorkspace = async () => {
    state.reads++;
    if (state.readsFail > 0) { state.readsFail--; throw new Error('Lecture locale interrompue pendant la recette.'); }
    return load();
  };
  desktopApi.deleteProjectDocument = async id => {
    state.deletes.push(id);
    if (state.deleteFailures > 0) { state.deleteFailures--; throw new Error('Le fichier est encore utilisé. Fermez son aperçu puis réessayez.'); }
    const workspace = await remove(id);
    if (state.deleteReadFailures > 0) { state.deleteReadFailures--; throw new WorkspaceRefreshAfterMutationError(new Error('Lecture après suppression interrompue.')); }
    return workspace;
  };
  desktopApi.saveProject = async (data, id) => {
    state.saves.push({ id, name: data.name });
    if (state.projectFailures > 0) { state.projectFailures--; throw new Error('Vérifiez le nom du projet avant de réessayer.'); }
    const savedId = await save(data, id);
    state.savedIds.push(savedId);
    return savedId;
  };
}
declare global { interface Window { projectRecovery: ReturnType<typeof recoveryState> } }
// Local controls for deterministic interruption scenarios.
function recoveryState() {
  return { uploadFailures: {} as Record<string, number>, readsFail: 0, deleteFailures: 0,
    deleteReadFailures: 0, projectFailures: 0, holdUpload: false, releaseUpload: () => {},
    uploads: [] as string[], deletes: [] as string[], saves: [] as { id?: string; name: unknown }[],
    savedIds: [] as string[], reads: 0 };
}
