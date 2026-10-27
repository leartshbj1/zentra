import { describe, expect, it } from 'vitest';
import type { AutopilotActionCard } from './AutopilotActionList';
import type { InboxItem } from './openApi';
import { articleFromDraft, calendarEvents, projectFromDraft, publishableTasks, taskDecision, taskRequest } from './assistantTasks';

const reminder: AutopilotActionCard = {
  key: 'reminder:r1', title: 'Relance 1', detail: 'Dupont SA · F-1', why: 'Échue depuis 12 jours.',
  actions: [{ id: 'send', label: 'Envoyer', primary: true }, { id: 'postpone', label: 'Reporter' }, { id: 'ignore', label: 'Ignorer' }],
};
const request = (taskKey: string, actionId: string): InboxItem => ({
  itemId: 'in_00000000-0000-4000-8000-000000000001', seq: 1, source: 'mcp', kind: 'task_action', createdAt: '2026-10-27T10:00:00.000Z',
  payload: { taskKey, actionId, title: 'Relance 1', actionLabel: 'Reporter' },
});

describe('tâches Autopilote pour un assistant connecté', () => {
  it('publie les cartes avec seulement les actions internes permises', () => {
    const tasks = publishableTasks([reminder, { ...reminder, key: 'clé avec espace' }, { ...reminder, key: 'vide', title: '  ' }], () => 'Relance');
    expect(tasks).toEqual([{ key: 'reminder:r1', kind: 'Relance', title: 'Relance 1', detail: 'Dupont SA · F-1', why: 'Échue depuis 12 jours.',
      actions: [{ id: 'send', label: 'Envoyer' }, { id: 'postpone', label: 'Reporter' }, { id: 'ignore', label: 'Ignorer' }], assistantActions: ['postpone', 'ignore'] }]);
    expect(publishableTasks(Array.from({ length: 120 }, (_, index) => ({ ...reminder, key: `k${index}` })), () => '')).toHaveLength(100);
  });

  it('exécute une demande seulement si la carte et l’action existent et sont permises', () => {
    expect(taskDecision(taskRequest(request('reminder:r1', 'postpone')), [reminder])).toEqual({ run: true });
    expect(taskDecision(taskRequest(request('reminder:r1', 'send')), [reminder])).toEqual({ run: false, reason: 'action-refused' });
    expect(taskDecision(taskRequest(request('reminder:r1', 'close')), [reminder])).toEqual({ run: false, reason: 'action-refused' });
    expect(taskDecision(taskRequest(request('reminder:r9', 'postpone')), [reminder])).toEqual({ run: false, reason: 'task-missing' });
    expect(taskDecision(taskRequest({ ...request('reminder:r1', 'postpone'), payload: { taskKey: 1 } }), [reminder])).toEqual({ run: false, reason: 'invalid' });
    expect(taskRequest({ ...request('x', 'postpone'), kind: 'customer' })).toBeNull();
  });

  it('prépare un article avec le taux par défaut et un projet daté', () => {
    expect(articleFromDraft({ article: { name: 'Pose de parquet', unit: 'm2', unitPriceCents: 4500 } }, 810)).toMatchObject({
      kind: 'service', name: 'Pose de parquet', unit: 'm2', salesPriceCents: 4500, vatBp: 810, trackStock: false, stockQuantityMilli: 0 });
    expect(articleFromDraft({ article: { name: 'Vis', type: 'product', vatBp: 260 } }, 810)).toMatchObject({ kind: 'product', unit: 'pce', vatBp: 260, salesPriceCents: 0 });
    expect(articleFromDraft({ article: {} }, 810)).toBeNull();
    expect(projectFromDraft({ project: { name: 'Cuisine', plannedStart: '2026-11-02', budgetCents: 1200000 }, note: 'Client pressé' }, 'c1', '2026-10-27')).toMatchObject({
      clientId: 'c1', name: 'Cuisine', status: 'planned', plannedStartDate: '2026-11-02', budgetCents: 1200000, notes: 'Client pressé' });
    expect(projectFromDraft({ project: { name: 'Sans date', plannedStart: 'bientôt' } }, null, '2026-10-27')).toMatchObject({ clientId: null, plannedStartDate: '2026-10-27' });
  });
});

describe('agenda d’abonnement', () => {
  const base = { id: 'ag-1', title: 'Visite', startDate: '2026-11-03', endDate: '2026-11-03', allDay: false, startTime: '09:30', endTime: '11:00',
    kind: 'visit' as const, status: 'scheduled' as const, location: 'Vevey', notes: 'privé', projectId: null, employeeId: null, createdAt: '2026-10-01', updatedAt: '2026-10-02' };
  it('garde un an à venir et 30 jours passés, sans les notes', () => {
    const events = calendarEvents([base, { ...base, id: 'old', startDate: '2026-01-01', endDate: '2026-01-01' }, { ...base, id: 'day', allDay: true, startTime: null, endTime: null }], '2026-10-27');
    expect(events.map(event => event.id)).toEqual(['ag-1', 'day']);
    expect(events[0]).toEqual({ id: 'ag-1', title: 'Visite', startDate: '2026-11-03', endDate: '2026-11-03', allDay: false, startTime: '09:30', endTime: '11:00', location: 'Vevey', status: 'scheduled', updatedAt: '2026-10-02' });
    expect(events[1]).toMatchObject({ allDay: true, startTime: null, endTime: null });
    expect(calendarEvents([{ ...base, startTime: 'midi' }], '2026-10-27')[0]).toMatchObject({ allDay: true, startTime: null });
  });
});
