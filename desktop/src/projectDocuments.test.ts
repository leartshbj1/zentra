import { describe, expect, it } from 'vitest';
import { isProjectFile, projectDocuments, projectFileError, PROJECT_FILE_MAX_BYTES } from './projectDocuments';
import type { Attachment, Workspace } from './types';
import { projectTerminology } from './terminology';

describe('dossiers des projets', () => {
  it('réunit les documents existants et les pièces liées sans mélanger les projets', () => {
    const workspace = {
      attachments: [{ id: 'a', projectId: 'p1', entityType: 'project', entityId: 'p1' }, { id: 'b', projectId: 'p2' }, { id: 'c', projectId: 'p1', entityType: 'supplier_invoice' }],
      quotes: [{ id: 'q1', projectId: 'p1' }, { id: 'q2', projectId: null }],
      invoices: [{ id: 'i1', projectId: 'p1' }, { id: 'i2', projectId: 'p2' }],
      salesOrders: [], supplierInvoices: [],
    } as unknown as Workspace;
    const folder = projectDocuments(workspace, 'p1');
    expect(folder.files.map((file) => file.id)).toEqual(['a', 'c']);
    expect(folder.quotes.map((file) => file.id)).toEqual(['q1']);
    expect(folder.invoices.map((file) => file.id)).toEqual(['i1']);
    expect(isProjectFile(folder.files[0])).toBe(true);
    expect(isProjectFile(folder.files[1])).toBe(false);
  });
  it('refuse les fichiers vides, trop gros et les exécutables avant lecture', () => {
    expect(projectFileError({ name: 'plan.pdf', size: 0 })).toContain('vide');
    expect(projectFileError({ name: 'plan.pdf', size: PROJECT_FILE_MAX_BYTES + 1 })).toContain('25 Mo');
    expect(projectFileError({ name: 'photo.jpg.exe', size: 100 })).toContain('pas pris en charge');
    expect(projectFileError({ name: 'Photo.HEIC', size: 100 })).toBeNull();
  });
  it('n’autorise pas la suppression d’une pièce fournisseur ou étrangère au projet', () => {
    expect(isProjectFile({ projectId: 'a', entityId: 'b', entityType: 'project' } as Attachment)).toBe(false);
  });
  it('utilise le mot projet dans tous les secteurs', () => {
    for (const section of ['F', 'M', 'Q', ''] as const) expect(projectTerminology(section).pluralTitle).toBe('Projets');
  });
});
