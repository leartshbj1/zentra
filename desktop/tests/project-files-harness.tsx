// Development-only fixture: real file bytes and production preview, no user data.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectFolder } from '../src/ProjectFolder';
import { desktopApi } from '../src/bridge';
import { installProjectRecoveryFixture } from './project-recovery-fixture';
import type { Project, Workspace } from '../src/types';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/experience.css';

const project = { id: 'qa-project', clientId: 'qa-client', name: 'Documents du projet de recette', status: 'active' } as Project;
let workspace = { projects: [project], clients: [{ id: 'qa-client', name: 'Client de recette' }], attachments: [], quotes: [], invoices: [], salesOrders: [], supplierInvoices: [], expenses: [] } as unknown as Workspace;
const files = new Map<string, File>();
desktopApi.addProjectDocument = async (projectId, file) => {
  const id = crypto.randomUUID(); files.set(id, file);
  workspace.attachments!.push({ id, projectId, entityId: projectId, entityType: 'project', originalName: file.name, sizeBytes: file.size, mimeType: file.type, sha256: 'qa-only', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
};
desktopApi.loadWorkspace = async () => structuredClone(workspace);
desktopApi.readProjectDocument = async id => {
  const bytes = new Uint8Array(await files.get(id)!.arrayBuffer());
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
};
desktopApi.deleteProjectDocument = async id => { workspace.attachments = workspace.attachments!.filter(file => file.id !== id); files.delete(id); return structuredClone(workspace); };
let attempts = 0;
if (new URLSearchParams(location.search).has('recovery')) installProjectRecoveryFixture();
desktopApi.openAttachment = async () => {
  attempts++;
  document.documentElement.dataset.openAttempts = String(attempts);
  if (attempts === 1) throw new Error('Application de lecture indisponible. Réessayez.');
};
function Harness() {
  const [data, setData] = useState(() => structuredClone(workspace));
  return <main style={{ maxWidth: 1100, padding: 16, margin: '0 auto' }}><ProjectFolder project={project} workspace={data} busy={false} readOnly={new URLSearchParams(location.search).has('readonly')} onBack={() => {}} onOpenDocument={() => {}} onCreateDocument={() => {}} onWorkspaceChange={value => setData(structuredClone(value))} /></main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
