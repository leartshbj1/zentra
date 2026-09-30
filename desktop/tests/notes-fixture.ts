import { desktopApi } from '../src/bridge';
import type { WorkNote, Workspace } from '../src/types';

// Synthetic data only. This entry never ships in the application bundle.
export function installNotesFixture(workspace: Workspace) {
  const projectId = workspace.projects[0]?.id ?? null;
  const note = (id: string, title: string, body: string, pinned = false): WorkNote => ({
    id, title, body, pinned, projectId, authorName: 'Camille Martin', createdByMemberId: 'member-demo',
    createdAt: '2026-09-30T07:00:00Z', updatedAt: '2026-09-30T09:00:00Z',
  });
  workspace.workNotes = [
    note('note-measures', 'Mesures pour la cuisine', 'Mur côté fenêtre : 3,42 m\nHauteur sous plafond : 2,58 m\n\n☐ Confirmer la hauteur avec le client\n☐ Prévoir une prise derrière le four', true),
    note('note-delivery', 'Livraison de vendredi', 'Accès par la cour intérieure.\nPrévenir Camille 30 minutes avant.\nLes clés sont au bureau du rez-de-chaussée.'),
    note('note-meeting', 'Point avec le client', 'Le client préfère le chêne clair.\nPréparer deux variantes de devis pour lundi.'),
  ];
  desktopApi.saveWorkNote = async input => {
    if (new URLSearchParams(location.search).has('notesError')) throw new Error('Le texte a été modifié sur un autre appareil.');
    const previous = workspace.workNotes?.find(item => item.id === input.id);
    if (previous && input.expectedUpdatedAt !== previous.updatedAt) throw new Error('Cette note a été modifiée par un collègue.');
    const now = new Date().toISOString();
    const result: WorkNote = { ...input, authorName: previous?.authorName ?? 'Camille Martin', createdByMemberId: 'member-demo', createdAt: previous?.createdAt ?? now, updatedAt: now };
    workspace.workNotes = [...(workspace.workNotes ?? []).filter(item => item.id !== input.id), result];
    sessionStorage.setItem('notes-fixture-saved', JSON.stringify(result));
    return structuredClone(result);
  };
  desktopApi.deleteWorkNote = async (id, expectedUpdatedAt) => {
    const previous = workspace.workNotes?.find(item => item.id === id);
    if (previous?.updatedAt !== expectedUpdatedAt) throw new Error('Cette note a changé.');
    workspace.workNotes = (workspace.workNotes ?? []).filter(item => item.id !== id);
    return { deleted: true };
  };
}
