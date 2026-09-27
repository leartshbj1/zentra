import { t } from './language';
import type { ProjectMilestone, ProjectPlanningPriority, ProjectPlanningStatus, ProjectTask, Workspace } from './types';
import { isValidIsoCalendarDate } from './payrollImportQuality';
import { errorMessage, formatDate } from './utils';

export type PlanningFormDraft = { projectId: string; title: string; milestoneId: string; employeeId: string; dueDate: string; priority: ProjectPlanningPriority; description: string };
export type PlanningFormIssue = { field: keyof PlanningFormDraft; message: string; suggestedDate?: string };
export type PlanningErrorHandler = (reason: unknown) => void;

const nativePlanningErrors: Record<string, string> = {
  'Un jalon ne peut pas être déplacé vers un autre projet.': 'Cette action reste rattachée à son projet d’origine.',
  'Une tâche ne peut pas être déplacée vers un autre projet.': 'Cette action reste rattachée à son projet d’origine.',
  'Rouvrez le jalon avant de modifier son contenu.': 'Rouvrez d’abord le jalon pour le modifier',
  'Rouvrez la tâche avant de modifier son contenu.': 'Rouvrez d’abord la tâche pour modifier son contenu',
  'Seul un jalon au statut todo peut être supprimé.': 'Seul un jalon à faire peut être supprimé',
  'Seule une tâche au statut todo peut être supprimée.': 'Seule une tâche à faire peut être supprimée',
  'Retirez ou réaffectez les tâches du jalon avant de le supprimer.': 'Déplacez ou supprimez d’abord les tâches liées à ce jalon',
  'Arrêtez ou annulez le chronomètre actif avant de fermer la tâche.': 'Un chronomètre tourne sur cette tâche. Arrêtez-le avant de la terminer ou de l’annuler.',
  'Arrêtez ou annulez le chronomètre actif avant de supprimer la tâche.': 'Arrêtez le chronomètre avant de supprimer cette tâche.',
  'Une tâche liée à des temps saisis ne peut pas être supprimée.': 'Cette tâche possède des heures liées et ne peut plus être supprimée',
  'Le jalon sélectionné appartient à un autre projet.': 'Choisissez une étape ouverte de ce projet, ou « Sans étape ».',
  'Une tâche active ne peut pas être affectée à un jalon terminé ou annulé.': 'Choisissez une étape ouverte de ce projet, ou « Sans étape ».',
  "L'échéance de la tâche ne peut pas dépasser celle du jalon.": 'Choisissez une date antérieure ou égale à celle de l’étape.',
  "L'échéance du jalon ne peut pas précéder celle d'une de ses tâches.": 'Choisissez une date postérieure ou égale à celle de toutes les tâches de cette étape.',
  'Terminez ou annulez toutes les tâches actives avant de fermer le jalon.': 'Terminez ou annulez les tâches ouvertes avant de terminer cette étape.',
};

export function planningSaveError(reason: unknown, fallback: string): string {
  const message = errorMessage(reason, fallback);
  const native = message.replace(/^Champ invalide\s*:\s*/, '');
  // Match only known interface errors. Unrecognised details retain their full wording.
  return t(Object.hasOwn(nativePlanningErrors, native) ? nativePlanningErrors[native] : message);
}

export function initialPlanningDraft(workspace: Workspace, item?: ProjectTask | ProjectMilestone, projectId?: string): PlanningFormDraft {
  const openProjects = workspace.projects.filter(row => row.status !== 'closed');
  return { projectId: item?.projectId || projectId || (openProjects.length === 1 ? openProjects[0].id : ''), title: item?.title || '', milestoneId: item && 'milestoneId' in item ? item.milestoneId || '' : '', employeeId: item?.employeeId || '', dueDate: item?.dueDate || '', priority: item?.priority || 'normal', description: item?.description || '' };
}

export function planningFormIssue(draft: PlanningFormDraft, kind: 'task' | 'milestone', workspace: Workspace, item?: ProjectTask | ProjectMilestone): PlanningFormIssue | undefined {
  if (!draft.title.trim() || [...draft.title.trim()].length > 200) return { field: 'title', message: t("Donnez un nom court et précis, de 1 à 200 caractères.") };
  const project = workspace.projects.find(row => row.id === draft.projectId);
  if (!project || (project.status === 'closed' && item?.projectId !== project.id)) return { field: 'projectId', message: t("Choisissez le projet concerné parmi les projets disponibles.") };
  if (item && item.projectId !== draft.projectId) return { field: 'projectId', message: t("Cette action reste rattachée à son projet d’origine.") };
  if (item) {
    const current = (kind === 'task' ? workspace.projectTasks : workspace.projectMilestones).find(row => row.id === item.id);
    if (!current) return { field: 'title', message: t("Cet élément n’existe plus dans le planning. Fermez cette fenêtre et actualisez les projets.") };
    if (['done', 'cancelled'].includes(current.status)) return { field: 'title', message: t("Cet élément est terminé ou annulé. Rouvrez-le dans le planning avant de modifier son contenu.") };
  }
  if (draft.employeeId && !workspace.employees.some(row => row.id === draft.employeeId && (row.active || row.id === item?.employeeId))) return { field: 'employeeId', message: t("Choisissez une personne disponible, ou laissez la tâche non attribuée.") };
  if (draft.dueDate && !isValidIsoCalendarDate(draft.dueDate)) return { field: 'dueDate', message: t("Choisissez une date réelle dans le calendrier, ou laissez l’échéance vide.") };
  if (!['low', 'normal', 'high', 'urgent'].includes(draft.priority)) return { field: 'priority', message: t("Choisissez un niveau de priorité dans la liste.") };
  if ([...draft.description.trim()].length > 20000) return { field: 'description', message: t("Raccourcissez la description à 20 000 caractères au maximum.") };
  if (kind === 'task' && draft.milestoneId) {
    const milestone = workspace.projectMilestones.find(row => row.id === draft.milestoneId && row.projectId === draft.projectId);
    if (!milestone || ['done', 'cancelled'].includes(milestone.status)) return { field: 'milestoneId', message: t("Choisissez une étape ouverte de ce projet, ou « Sans étape ».") };
    if (draft.dueDate && milestone.dueDate && draft.dueDate > milestone.dueDate) return { field: 'dueDate', message: t("L’étape « {title} » est prévue le {date}. Placez cette tâche au plus tard à cette date, ou choisissez une autre étape.", { title: milestone.title, date: formatDate(milestone.dueDate) }), suggestedDate: milestone.dueDate };
  }
  if (kind === 'milestone' && item && draft.dueDate) {
    const later = workspace.projectTasks.filter(row => row.milestoneId === item.id && row.dueDate && row.dueDate > draft.dueDate).sort((a, b) => b.dueDate.localeCompare(a.dueDate))[0];
    if (later) return { field: 'dueDate', message: t("La tâche « {title} » est prévue le {date}. L’étape doit finir à cette date ou après.", { title: later.title, date: formatDate(later.dueDate) }), suggestedDate: later.dueDate };
  }
}

export function planningTaskBlock(task: ProjectTask, nextStatus: ProjectPlanningStatus, workspace: Pick<Workspace, 'projectMilestones' | 'activeTimer'>): { message: string; target: 'timer' | 'milestone' } | undefined {
  if (['done', 'cancelled'].includes(nextStatus) && workspace.activeTimer?.taskId === task.id) return { message: t("Un chronomètre tourne sur cette tâche. Arrêtez-le avant de la terminer ou de l’annuler."), target: 'timer' };
  if (['todo', 'in_progress'].includes(nextStatus) && task.milestoneId) {
    const milestone = workspace.projectMilestones.find(row => row.id === task.milestoneId);
    if (milestone && ['done', 'cancelled'].includes(milestone.status)) return { message: t("Rouvrez d’abord l’étape « {title} », puis cette tâche.", { title: milestone.title }), target: 'milestone' };
  }
}
