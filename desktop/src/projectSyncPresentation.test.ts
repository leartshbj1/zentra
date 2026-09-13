import { describe, expect, it } from 'vitest';
import { projectFileSyncIssue, projectSyncPresentation } from './projectSyncPresentation';
import type { ProjectSyncStatus } from './projectSync';
const status: ProjectSyncStatus = { pending: 0, syncing: false, documents: [], connected: true };
describe('project file sharing status', () => {
  it('offers the legacy action only for files using that feed', () => {
    expect(projectSyncPresentation(status, 1).canSynchronize).toBe(true);
    expect(projectSyncPresentation({ ...status, mode: 'business' }, 1).canSynchronize).toBe(false);
    expect(projectSyncPresentation({ ...status, mode: 'preparing' }, 1).canSynchronize).toBe(false);
  });
  it('distinguishes confirmed files from retained pending changes', () => {
    expect(projectSyncPresentation({ ...status, mode: 'business' }, 2).title).toBe('2 modifications en attente');
    expect(projectSyncPresentation({ ...status, mode: 'business' }, 0).description).toContain('confirmés');
    expect(projectSyncPresentation({ ...status, mode: 'preparing' }, 0).description).not.toContain('confirmés');
  });
  it('keeps network failures visible alongside cached files', () => {
    expect(projectSyncPresentation({ ...status, mode: 'business', error: 'Hors ligne' }, 0).description).toBe('Hors ligne');
    expect(projectSyncPresentation({ ...status, error: 'Connexion interrompue' }, 0).title).toBe('Synchronisation à reprendre');
  });
  it('explains a cache repair without revealing paths or claiming it is available', () => {
    const issue = projectFileSyncIssue('Champ invalide : La copie locale est introuvable.');
    expect(issue.repair).toBe(true);
    expect(issue.title).toBe('Copie locale à réparer');
    expect(issue.explanation).toContain('identique');
    expect(issue.explanation).toContain('séparément');
    expect(projectFileSyncIssue('Erreur de fichier local : C:\\Private\\missing.txt').explanation).not.toContain('Private');
  });
  it('does not ask to replace a file for a network interruption', () => {
    const issue = projectFileSyncIssue('Hors ligne ou service indisponible');
    expect(issue.repair).toBe(false);
    expect(issue.explanation).toContain('automatiquement');
    expect(projectFileSyncIssue('Champ invalide : Cette référence contient déjà un autre document.').explanation).toBe('Cette référence contient déjà un autre document.');
  });
});
