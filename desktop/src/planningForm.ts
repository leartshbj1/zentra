import type { ProjectMilestone, ProjectPlanningPriority, ProjectPlanningStatus, ProjectTask, Workspace } from './types';
import { isValidIsoCalendarDate } from './payrollImportQuality';
import { formatDate } from './utils';

export type PlanningFormDraft = { projectId: string; title: string; milestoneId: string; employeeId: string; dueDate: string; priority: ProjectPlanningPriority; description: string };
export type PlanningFormIssue = { field: keyof PlanningFormDraft; message: string; suggestedDate?: string };
export type PlanningErrorHandler = (reason: unknown) => void;

export function initialPlanningDraft(workspace: Workspace, item?: ProjectTask | ProjectMilestone, projectId?: string): PlanningFormDraft {
  const openProjects = workspace.projects.filter(row => row.status !== 'closed');
  return { projectId: item?.projectId || projectId || (openProjects.length === 1 ? openProjects[0].id : ''), title: item?.title || '', milestoneId: item && 'milestoneId' in item ? item.milestoneId || '' : '', employeeId: item?.employeeId || '', dueDate: item?.dueDate || '', priority: item?.priority || 'normal', description: item?.description || '' };
}

export function planningFormIssue(draft: PlanningFormDraft, kind: 'task' | 'milestone', workspace: Workspace, item?: ProjectTask | ProjectMilestone): PlanningFormIssue | undefined {
  if (!draft.title.trim() || [...draft.title.trim()].length > 200) return { field: 'title', message: 'Donnez un nom court et précis, de 1 à 200 caractères.' };
  const project = workspace.projects.find(row => row.id === draft.projectId);
  if (!project || (project.status === 'closed' && item?.projectId !== project.id)) return { field: 'projectId', message: 'Choisissez le projet concerné parmi les projets disponibles.' };
  if (item && item.projectId !== draft.projectId) return { field: 'projectId', message: 'Cette action reste rattachée à son projet d’origine.' };
  if (item) {
    const current = (kind === 'task' ? workspace.projectTasks : workspace.projectMilestones).find(row => row.id === item.id);
    if (!current) return { field: 'title', message: 'Cet élément n’existe plus dans le planning. Fermez cette fenêtre et actualisez les projets.' };
    if (['done', 'cancelled'].includes(current.status)) return { field: 'title', message: 'Cet élément est terminé ou annulé. Rouvrez-le dans le planning avant de modifier son contenu.' };
  }
  if (draft.employeeId && !workspace.employees.some(row => row.id === draft.employeeId && (row.active || row.id === item?.employeeId))) return { field: 'employeeId', message: 'Choisissez une personne disponible, ou laissez la tâche non attribuée.' };
  if (draft.dueDate && !isValidIsoCalendarDate(draft.dueDate)) return { field: 'dueDate', message: 'Choisissez une date réelle dans le calendrier, ou laissez l’échéance vide.' };
  if (!['low', 'normal', 'high', 'urgent'].includes(draft.priority)) return { field: 'priority', message: 'Choisissez un niveau de priorité dans la liste.' };
  if ([...draft.description.trim()].length > 20000) return { field: 'description', message: 'Raccourcissez la description à 20 000 caractères au maximum.' };
  if (kind === 'task' && draft.milestoneId) {
    const milestone = workspace.projectMilestones.find(row => row.id === draft.milestoneId && row.projectId === draft.projectId);
    if (!milestone || ['done', 'cancelled'].includes(milestone.status)) return { field: 'milestoneId', message: 'Choisissez une étape ouverte de ce projet, ou « Sans étape ».' };
    if (draft.dueDate && milestone.dueDate && draft.dueDate > milestone.dueDate) return { field: 'dueDate', message: `L’étape « ${milestone.title} » est prévue le ${formatDate(milestone.dueDate)}. Placez cette tâche au plus tard à cette date, ou choisissez une autre étape.`, suggestedDate: milestone.dueDate };
  }
  if (kind === 'milestone' && item && draft.dueDate) {
    const later = workspace.projectTasks.filter(row => row.milestoneId === item.id && row.dueDate && row.dueDate > draft.dueDate).sort((a, b) => b.dueDate.localeCompare(a.dueDate))[0];
    if (later) return { field: 'dueDate', message: `La tâche « ${later.title} » est prévue le ${formatDate(later.dueDate)}. L’étape doit finir à cette date ou après.`, suggestedDate: later.dueDate };
  }
}

export function planningTaskBlock(task: ProjectTask, nextStatus: ProjectPlanningStatus, workspace: Pick<Workspace, 'projectMilestones' | 'activeTimer'>): { message: string; target: 'timer' | 'milestone' } | undefined {
  if (['done', 'cancelled'].includes(nextStatus) && workspace.activeTimer?.taskId === task.id) return { message: 'Un chronomètre tourne sur cette tâche. Arrêtez-le avant de la terminer ou de l’annuler.', target: 'timer' };
  if (['todo', 'in_progress'].includes(nextStatus) && task.milestoneId) {
    const milestone = workspace.projectMilestones.find(row => row.id === task.milestoneId);
    if (milestone && ['done', 'cancelled'].includes(milestone.status)) return { message: `Rouvrez d’abord l’étape « ${milestone.title} », puis cette tâche.`, target: 'milestone' };
  }
}
