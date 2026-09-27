import './languageTestPacks';
import { afterEach, expect, it } from 'vitest';
import { setAppLanguage } from './language';
import { initialPlanningDraft, planningFormIssue, planningSaveError } from './planningForm';
import { planningTranslations } from './translationsPlanning';
import type { Workspace } from './types';

afterEach(() => setAppLanguage('fr'));

it('keeps all template variables in the three translations', () => {
  const variables = (text: string) => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(m => m[1]).sort();
  for (const [source, values] of Object.entries(planningTranslations)) {
    expect(values).toHaveLength(3);
    for (const text of values) { expect(text.trim()).not.toBe(''); expect(variables(text), source).toEqual(variables(source)); }
  }
});

it('explains a native status error without exposing the internal todo value', async () => {
  const native = new Error('Champ invalide : Seule une tâche au statut todo peut être supprimée.');
  for (const [language, expected] of [
    ['fr', 'Seule une tâche à faire peut être supprimée'],
    ['de', 'Nur eine noch nicht begonnene Aufgabe kann gelöscht werden'],
    ['it', 'Si può eliminare solo un’attività da iniziare'],
    ['en', 'Only a task that has not started can be deleted'],
  ] as const) {
    await setAppLanguage(language);
    expect(planningSaveError(native, 'Failed')).toBe(expected);
  }
  expect(native.message).toContain('statut todo');
});

it('preserves unknown diagnostics instead of replacing them with a generic success', async () => {
  await setAppLanguage('de');
  const detail = 'Champ invalide : Conflit sur le projet « Nouvelle tâche » — référence ZT-456';
  expect(planningSaveError(detail, 'Failed')).toBe(detail);
});

it('keeps business names and the suggested ISO date while translating date guidance', async () => {
  const workspace = { projects: [{ id: 'p', status: 'in_progress' }], employees: [], projectTasks: [], projectMilestones: [{ id: 'm', projectId: 'p', title: 'Nouvelle tâche', dueDate: '2026-09-30', status: 'todo' }] } as unknown as Workspace;
  const draft = { ...initialPlanningDraft(workspace), title: 'Notes du client', milestoneId: 'm', dueDate: '2026-10-01' };
  for (const language of ['de', 'it', 'en'] as const) {
    await setAppLanguage(language);
    const issue = planningFormIssue(draft, 'task', workspace);
    expect(issue).toMatchObject({ field: 'dueDate', suggestedDate: '2026-09-30' });
    expect(issue?.message).toContain('Nouvelle tâche');
    expect(issue?.message.startsWith('L’étape')).toBe(false);
    expect(issue?.message).not.toContain('{title}');
  }
  expect(draft.dueDate).toBe('2026-10-01');
  expect(workspace.projectMilestones[0].title).toBe('Nouvelle tâche');
});
