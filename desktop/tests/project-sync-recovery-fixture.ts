// Synthetic transport; the production scheduler and folder UI run unchanged.
// SQLite cache repair and outbound preparation are tested separately in Rust.
import { desktopApi } from '../src/bridge';
import { requestProjectSync, type ProjectSyncStatus } from '../src/projectSync';
import type { Workspace } from '../src/types';

export async function installProjectSyncRecoveryFixture(workspace: () => Workspace) {
  const project = workspace().projects[0].id;
  const original = new File(['Plan original de recette'], 'Plan-original-du-projet-à-conserver.txt', { type: 'text/plain' });
  await desktopApi.addProjectDocument(project, original);
  const broken = workspace().attachments!.at(-1)!;
  await desktopApi.addProjectDocument(project, new File(['Conditions conservées'], 'Conditions.txt', { type: 'text/plain' }));
  const healthy = workspace().attachments!.at(-1)!;
  // Native saved-file reads return base64 from disk, not a browser File read
  // (WebKit's test offline mode can block that synthetic File transport).
  const cached = new Map([[broken.id, await desktopApi.readProjectDocument(broken.id)], [healthy.id, await desktopApi.readProjectDocument(healthy.id)]]);
  let needsRepair = true;
  const control = { calls: 0, repairs: 0, hold: false, release: () => {}, networkError: false, attempts: [] as string[] };
  Object.assign(window, { projectSyncRecovery: control });
  const status = (): ProjectSyncStatus => ({ connected: true, organizationId: 'org_fixture', syncing: false,
    pending: needsRepair ? 1 : 0,
    ...(needsRepair ? { error: 'Un fichier demande une vérification. Les autres envois ont été traités.' } : {}),
    documents: [
      { document_id: broken.id, project_id: project, state: needsRepair ? 'upload' : 'synced', last_error: needsRepair ? 'La copie locale de ce fichier est introuvable ou illisible.' : null },
      { document_id: healthy.id, project_id: project, state: 'synced' },
    ],
  });
  desktopApi.getProjectSyncStatus = async () => status();
  desktopApi.syncProjectDocuments = async () => {
    control.calls++;
    const failReply = control.networkError;
    if (control.hold) await new Promise<void>(resolve => { control.release = resolve; });
    if (failReply) throw new Error('Hors ligne ou service indisponible');
    return status();
  };
  const read = desktopApi.readProjectDocument;
  desktopApi.readProjectDocument = async id => {
    if (id === broken.id && needsRepair) throw new Error('La copie locale est introuvable.');
    return cached.get(id) ?? read(id);
  };
  const add = desktopApi.addProjectDocument;
  desktopApi.addProjectDocument = async (id, file, signal) => {
    control.attempts.push(file.name);
    if (id === project && await file.text() === await original.text()) { needsRepair = false; control.repairs++; }
    else await add(id, file, signal);
    requestProjectSync();
  };
}
