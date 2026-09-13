import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectSyncIssues } from './ProjectSyncIssues';
import type { ProjectSyncStatus } from './projectSync';
import type { Attachment } from './types';
const sync: ProjectSyncStatus = { pending: 3, syncing: false, documents: [
  { document_id: 'broken', project_id: 'p', state: 'upload', last_error: 'Copie locale illisible' },
  { document_id: 'sent', project_id: 'p', state: 'synced', last_error: 'ancienne erreur' },
  { document_id: 'other', project_id: 'q', state: 'upload', last_error: 'autre projet' },
  { document_id: 'removed', project_id: 'p', state: 'delete', last_error: 'Hors ligne' },
] };
const props = { sync, projectId: 'p', files: [{ id: 'broken', originalName: 'Plan original.txt' } as Attachment], busy: false, readOnly: false, onRepair: () => {} };
describe('project synchronization recovery instructions', () => {
  it('only shows unresolved files from this project, including removed documents', () => {
    const html = renderToStaticMarkup(<ProjectSyncIssues {...props} />);
    expect(html).toContain('2 documents à vérifier'); expect(html).toContain('Plan original.txt');
    expect(html).toContain('Suppression à transmettre'); expect(html).toContain('Ajouter le fichier original');
    expect(html).not.toContain('autre projet'); expect(html).not.toContain('ancienne erreur');
  });
  it('keeps instructions in read-only mode without offering a mutation', () => {
    const html = renderToStaticMarkup(<ProjectSyncIssues {...props} readOnly />);
    expect(html).toContain('personne autorisée'); expect(html).not.toContain('<button');
  });
  it('disables repair during an operation without describing a permissions problem', () => {
    const html = renderToStaticMarkup(<ProjectSyncIssues {...props} busy />);
    expect(html).toContain('disabled=""'); expect(html).not.toContain('personne autorisée');
  });
  it('disappears once this project has no unresolved files', () => {
    expect(renderToStaticMarkup(<ProjectSyncIssues {...props} sync={{ ...sync, documents: sync.documents.filter(row => row.project_id !== 'p') }} />)).toBe('');
  });
});
