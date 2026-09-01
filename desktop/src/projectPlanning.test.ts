import { describe, expect, it } from 'vitest';
import {
  filteredPlanningTasks,
  milestoneCanClose,
  milestoneProgress,
  nextProjectMilestoneStatus,
  nextProjectTaskStatus,
  planningSummary,
  taskDueBucket,
} from './projectPlanning';
import type { ProjectMilestone, ProjectTask } from './types';

function task(
  id: string,
  patch: Partial<ProjectTask> = {},
): ProjectTask {
  return {
    id,
    projectId: 'project-a',
    milestoneId: 'milestone-a',
    title: `Tâche ${id}`,
    description: '',
    dueDate: '',
    status: 'todo',
    priority: 'normal',
    sortOrder: 0,
    employeeId: null,
    completedAt: null,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
    ...patch,
  };
}

const milestone: ProjectMilestone = {
  id: 'milestone-a',
  projectId: 'project-a',
  title: 'Réception',
  description: '',
  dueDate: '2026-09-30',
  status: 'in_progress',
  priority: 'high',
  sortOrder: 0,
  employeeId: null,
  completedAt: null,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-01T08:00:00Z',
};

describe('planification projet', () => {
  it('distingue les retards, aujourd’hui, à venir et les tâches closes', () => {
    expect(taskDueBucket(task('a', { dueDate: '2026-08-31' }), '2026-09-01'))
      .toBe('overdue');
    expect(taskDueBucket(task('b', { dueDate: '2026-09-01' }), '2026-09-01'))
      .toBe('today');
    expect(taskDueBucket(task('c', { dueDate: '2026-09-02' }), '2026-09-01'))
      .toBe('upcoming');
    expect(taskDueBucket(task('d', { status: 'done' }), '2026-09-01')).toBe(
      'closed',
    );
  });

  it('calcule un avancement sans compter les tâches annulées', () => {
    const result = milestoneProgress('milestone-a', [
      task('a', { status: 'done' }),
      task('b'),
      task('c', { status: 'cancelled' }),
    ]);
    expect(result).toEqual({ completed: 1, total: 2, percent: 50 });
    expect(milestoneCanClose(milestone, [task('a', { status: 'done' })]))
      .toBe(true);
    expect(milestoneCanClose(milestone, [task('b')])).toBe(false);
  });

  it('filtre et trie les actions ouvertes par date puis priorité', () => {
    const result = filteredPlanningTasks({
      tasks: [
        task('later', { dueDate: '2026-09-10', priority: 'urgent' }),
        task('normal', { dueDate: '2026-09-05' }),
        task('urgent', { dueDate: '2026-09-05', priority: 'urgent' }),
        task('closed', { status: 'done', dueDate: '2026-09-01' }),
      ],
      projectId: 'project-a',
      status: 'open',
    });
    expect(result.map((item) => item.id)).toEqual([
      'urgent',
      'normal',
      'later',
    ]);
    expect(planningSummary(result, '2026-09-06')).toEqual({
      open: 3,
      inProgress: 0,
      overdue: 2,
      done: 0,
    });
  });

  it('utilise uniquement les transitions rapides autorisées par le backend', () => {
    expect(nextProjectTaskStatus('todo')).toBe('in_progress');
    expect(nextProjectTaskStatus('in_progress')).toBe('done');
    expect(nextProjectTaskStatus('done')).toBe('in_progress');
    expect(nextProjectTaskStatus('cancelled')).toBe('todo');
    expect(nextProjectMilestoneStatus('done')).toBe('in_progress');
  });
});
