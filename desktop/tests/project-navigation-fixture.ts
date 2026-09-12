import { desktopApi } from '../src/bridge';
import type { Project, Workspace } from '../src/types';
import { installProjectRecoveryFixture } from './project-recovery-fixture';

/** Separate native storage from UI snapshots so a missed refresh cannot appear to succeed. */
export function installProjectNavigationFixture(data: Workspace) {
  data.projects = [
    { id: 'project-navigation-a', clientId: 'client-qa', name: 'Projet A · Plans et documents', status: 'active', address: '', notes: '', plannedMinutes: 0, budgetCents: 0 },
    { id: 'project-navigation-b', clientId: 'client-qa', name: 'Projet B · Photos du dossier', status: 'active', address: '', notes: '', plannedMinutes: 0, budgetCents: 0 },
    { id: 'project-navigation-c', clientId: 'client-qa', name: 'Projet C · Nouveau dossier', status: 'active', address: '', notes: '', plannedMinutes: 0, budgetCents: 0 },
  ] as Project[];
  data.attachments = [];
  const stored = structuredClone(data), files = new Map<string, File>();
  Object.assign(window, { projectNavigation: { stored, publications: 0, uploads: [] as { project: string; name: string }[] } });
  desktopApi.loadWorkspace = async () => structuredClone(stored);
  desktopApi.addProjectDocument = async (project, file) => {
    const id = crypto.randomUUID(); files.set(id, file);
    window.projectNavigation.uploads.push({ project, name: file.name });
    stored.attachments!.push({ id, projectId: project, entityId: project, entityType: 'project', originalName: file.name, sizeBytes: file.size, mimeType: file.type, sha256: 'qa-only', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  };
  desktopApi.deleteProjectDocument = async id => { stored.attachments = stored.attachments!.filter(file => file.id !== id); files.delete(id); return structuredClone(stored); };
  desktopApi.readProjectDocument = async id => btoa(Array.from(new Uint8Array(await files.get(id)!.arrayBuffer()), byte => String.fromCharCode(byte)).join(''));
  installProjectRecoveryFixture();
}
declare global { interface Window { projectNavigation: { stored: Workspace; publications: number; uploads: { project: string; name: string }[] } } }
