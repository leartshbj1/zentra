import { desktopApi } from '../src/bridge';
import { requestProjectSync, type ProjectSyncStatus } from '../src/projectSync';
import type { Workspace } from '../src/types';

// Isolated UI fixture. File durability and HTTP isolation are tested in Rust/server tests.
export function installProjectSyncFixture(workspace: () => Workspace) {
  const documents: ProjectSyncStatus['documents'] = [];
  let uploaded = 0;
  const status = (): ProjectSyncStatus => ({
    organizationId: 'org_ui',
    connected: true,
    syncing: false,
    pending: documents.filter((d) => d.state !== 'synced').length,
    documents: structuredClone(documents),
  });
  desktopApi.getProjectSyncStatus = async () => status();
  desktopApi.syncProjectDocuments = async () => {
    if (!navigator.onLine) throw new Error('Hors ligne');
    for (const document of documents) {
      if (document.state === 'upload') uploaded++;
      document.state = 'synced';
    }
    sessionStorage.setItem('sync-uploaded', String(uploaded));
    return status();
  };
  const add = desktopApi.addProjectDocument;
  desktopApi.addProjectDocument = async (project, file) => {
    await add(project, file);
    const last = workspace().attachments!.at(-1)!;
    documents.push({
      document_id: last.id,
      project_id: project,
      state: 'upload',
    });
    requestProjectSync();
  };
  const remove = desktopApi.deleteProjectDocument;
  desktopApi.deleteProjectDocument = async (id) => {
    const document = documents.find((d) => d.document_id === id);
    if (document) document.state = 'delete';
    const value = await remove(id);
    requestProjectSync();
    return value;
  };
}
