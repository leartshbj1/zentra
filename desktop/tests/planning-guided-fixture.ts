import { desktopApi } from '../src/bridge';
import { WorkspaceRefreshAfterMutationError } from '../src/workspaceMutation';
import type { ProjectMilestone, ProjectTask, Workspace } from '../src/types';

export function installPlanningGuidedFixture(stored: Workspace) {
  const project = stored.projects[0];
  stored.projects = [{ ...project, id: 'planning-project', name: 'Projet principal de recette', status: 'in_progress' }, { ...project, id: 'planning-other', name: 'Autre projet de recette', status: 'planned' }];
  stored.employees = [{ id: 'planning-person', name: 'Noé de recette', active: true }] as Workspace['employees'];
  const stamp = '2026-09-12T08:00:00Z';
  const milestone = (id: string, title: string, status: ProjectMilestone['status']): ProjectMilestone => ({ id, projectId: 'planning-project', title, status, dueDate: '2026-09-30', priority: 'normal', description: '', employeeId: null, sortOrder: 0, completedAt: null, createdAt: stamp, updatedAt: stamp });
  stored.projectMilestones = [milestone('stage-open', 'Livraison de recette', 'todo'), milestone('stage-closed', 'Étude terminée', 'done')];
  const task = (id: string, title: string, milestoneId: string | null, status: ProjectTask['status']): ProjectTask => ({ ...milestone(id, title, status), milestoneId, dueDate: '2026-09-20' });
  stored.projectTasks = [task('existing-task', 'Vérifier les mesures', 'stage-open', 'todo'), task('finished-task', 'Étude de faisabilité', 'stage-closed', 'done'), task('timed-task', 'Intervention chronométrée', null, 'in_progress')];
  stored.activeTimer = { projectId: 'planning-project', taskId: 'timed-task', employeeId: 'planning-person', startedAt: new Date().toISOString(), note: '' };
  const state = { stored, attempts: [] as Array<{ kind: string; input: any }>, commits: 0, reject: false, hold: false, readAfterWrite: false, readFailures: 0, release: () => {} };
  Object.assign(window, { planningFixture: state });
  desktopApi.loadWorkspace = async () => { if (state.readFailures > 0) { state.readFailures--; throw new Error('Lecture du planning momentanément indisponible.'); } return structuredClone(stored); };
  async function finish() {
    state.commits++;
    if (state.readAfterWrite) { state.readAfterWrite = false; state.readFailures = 2; throw new WorkspaceRefreshAfterMutationError(new Error('Lecture après enregistrement interrompue.')); }
    return structuredClone(stored);
  }
  async function before(kind: string, input: unknown) {
    state.attempts.push({ kind, input: structuredClone(input) });
    if (state.hold) await new Promise<void>(resolve => { state.release = resolve; });
    if (state.reject) throw new Error('Le planning a changé pendant la saisie. Vérifiez la date et réessayez.');
  }
  desktopApi.saveProjectTask = async input => {
    await before('task', input);
    const previous = stored.projectTasks.find(row => row.id === input.id);
    const next = { ...task(input.id || `new-task-${state.commits}`, input.title, input.milestoneId, previous?.status || 'todo'), ...input, id: input.id || `new-task-${state.commits}`, dueDate: input.dueDate || '' };
    stored.projectTasks = [...stored.projectTasks.filter(row => row.id !== next.id), next];
    return finish();
  };
  desktopApi.saveProjectMilestone = async input => {
    await before('milestone', input);
    const next = { ...milestone(input.id || `new-stage-${state.commits}`, input.title, input.status), ...input, id: input.id || `new-stage-${state.commits}`, dueDate: input.dueDate || '' };
    stored.projectMilestones = [...stored.projectMilestones.filter(row => row.id !== next.id), next];
    return finish();
  };
  desktopApi.setProjectTaskStatus = async (id, status) => { await before('status', { id, status }); stored.projectTasks = stored.projectTasks.map(row => row.id === id ? { ...row, status } : row); return finish(); };
  desktopApi.deleteProjectTask = async id => { await before('delete-task', { id }); stored.projectTasks = stored.projectTasks.filter(row => row.id !== id); return finish(); };
  desktopApi.deleteProjectMilestone = async id => { await before('delete-stage', { id }); stored.projectMilestones = stored.projectMilestones.filter(row => row.id !== id); return finish(); };
  desktopApi.stopTimer = async () => { stored.activeTimer = null; return structuredClone(stored); };
}
