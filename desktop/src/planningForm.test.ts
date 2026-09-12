import { describe, expect, it } from 'vitest';
import { initialPlanningDraft, planningFormIssue, planningTaskBlock } from './planningForm';
import type { ProjectTask, Workspace } from './types';
const item = { id: 'task', projectId: 'project', title: 'Mesures', milestoneId: 'stage', employeeId: null, dueDate: '2026-09-20', priority: 'normal', description: '', status: 'todo' } as ProjectTask;
const workspace = { projects: [{ id: 'project', status: 'in_progress' }, { id: 'archived', status: 'closed' }], employees: [{ id: 'active', active: true }, { id: 'inactive', active: false }], projectTasks: [item], projectMilestones: [{ id: 'stage', projectId: 'project', title: 'Livraison', dueDate: '2026-09-30', status: 'todo' }], activeTimer: null } as unknown as Workspace;

describe('préparer une tâche et son étape', () => {
  it('propose le seul projet ouvert sans inventer une date ni un responsable', () => {
    expect(initialPlanningDraft(workspace)).toMatchObject({ projectId: 'project', employeeId: '', dueDate: '', milestoneId: '' });
    expect(initialPlanningDraft({ ...workspace, projects: [...workspace.projects, { id: 'other', status: 'planned' } as Workspace['projects'][number]] }).projectId).toBe('');
  });
  it('permet une tâche avec seulement un titre et un projet', () => {
    expect(planningFormIssue({ ...initialPlanningDraft(workspace), title: 'Préparer la visite' }, 'task', workspace)).toBeUndefined();
  });
  it('explique une date au-delà de l’étape et propose sa date sans changer le brouillon', () => {
    const draft = { ...initialPlanningDraft(workspace, item), dueDate: '2026-10-01' };
    expect(planningFormIssue(draft, 'task', workspace, item)).toMatchObject({ field: 'dueDate', suggestedDate: '2026-09-30' });
    expect(draft.dueDate).toBe('2026-10-01');
    expect(planningFormIssue({ ...draft, dueDate: '2026-09-30' }, 'task', workspace, item)).toBeUndefined();
  });
  it('refuse une étape d’un autre projet ou terminée', () => {
    const draft = initialPlanningDraft(workspace, item);
    expect(planningFormIssue(draft, 'task', { ...workspace, projectMilestones: workspace.projectMilestones.map(row => ({ ...row, projectId: 'other' })) }, item)?.field).toBe('milestoneId');
    expect(planningFormIssue(draft, 'task', { ...workspace, projectMilestones: workspace.projectMilestones.map(row => ({ ...row, status: 'done' })) }, item)?.field).toBe('milestoneId');
  });
  it('garde la borne des tâches liées même lorsqu’elles sont terminées', () => {
    const milestone = workspace.projectMilestones[0];
    const draft = { ...initialPlanningDraft(workspace, milestone), title: 'Livraison', dueDate: '2026-09-19' };
    expect(planningFormIssue(draft, 'milestone', { ...workspace, projectTasks: [{ ...item, status: 'done' }] }, milestone)).toMatchObject({ field: 'dueDate', suggestedDate: '2026-09-20' });
  });
  it('vérifie la date réelle, le titre et les personnes disponibles', () => {
    const draft = initialPlanningDraft(workspace, item);
    expect(planningFormIssue({ ...draft, dueDate: '2026-02-30' }, 'task', workspace, item)?.field).toBe('dueDate');
    expect(planningFormIssue({ ...draft, title: '   ' }, 'task', workspace, item)?.field).toBe('title');
    expect(planningFormIssue({ ...draft, employeeId: 'inactive' }, 'task', workspace, item)?.field).toBe('employeeId');
    const existing = { ...item, employeeId: 'inactive' };
    expect(planningFormIssue(initialPlanningDraft(workspace, existing), 'task', workspace, existing)).toBeUndefined();
  });
  it('oriente vers le chronomètre pour clôturer, vers l’étape pour rouvrir', () => {
    expect(planningTaskBlock(item, 'in_progress', { ...workspace, activeTimer: { taskId: item.id } as NonNullable<Workspace['activeTimer']> })).toBeUndefined();
    expect(planningTaskBlock(item, 'done', { ...workspace, activeTimer: { taskId: item.id } as NonNullable<Workspace['activeTimer']> })?.target).toBe('timer');
    expect(planningTaskBlock({ ...item, status: 'done' }, 'in_progress', { ...workspace, projectMilestones: workspace.projectMilestones.map(row => ({ ...row, status: 'done' })) })?.target).toBe('milestone');
  });
});
