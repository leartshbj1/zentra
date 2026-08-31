import { describe, expect, it } from 'vitest';
import { creationBlockReason, timerBlockReason, type WorkspacePrerequisites } from './workflowGuards';

const ready: WorkspacePrerequisites = { clients: 1, projects: 1, trackableProjects: 1, activeEmployees: 1, costCategories: 1 };

describe('prérequis des actions de création', () => {
  it('empêche les fenêtres sans choix possible et explique le prérequis manquant', () => {
    const empty: WorkspacePrerequisites = { clients: 0, projects: 0, trackableProjects: 0, activeEmployees: 0, costCategories: 0 };
    expect(creationBlockReason('projects', empty)).toBe('Ajoutez d’abord un client.');
    expect(creationBlockReason('quotes', empty)).toBe('Ajoutez d’abord un client.');
    expect(creationBlockReason('time', empty)).toBe('Ajoutez d’abord un projet non clôturé et un collaborateur actif.');
    expect(creationBlockReason('expenses', empty)).toBe('Ajoutez d’abord un projet.');
  });

  it('autorise les parcours complets et bloque un second chronomètre', () => {
    for (const view of ['projects', 'quotes', 'invoices', 'time', 'team', 'expenses'] as const) {
      expect(creationBlockReason(view, ready)).toBe('');
    }
    expect(timerBlockReason(ready, false)).toBe('');
    expect(timerBlockReason(ready, true)).toBe('Un pointage est déjà en cours.');
  });

  it('détecte une configuration de dépenses sans catégorie', () => {
    expect(creationBlockReason('expenses', { ...ready, costCategories: 0 }))
      .toBe('Ajoutez d’abord une catégorie de coûts dans Paramètres.');
  });

  it('refuse le temps si tous les projets sont clôturés ou tous les collaborateurs inactifs', () => {
    expect(creationBlockReason('time', { ...ready, trackableProjects: 0 }))
      .toBe('Ajoutez ou rouvrez d’abord un projet non clôturé.');
    expect(creationBlockReason('time', { ...ready, activeEmployees: 0 }))
      .toBe('Ajoutez d’abord un collaborateur actif.');
  });
});
