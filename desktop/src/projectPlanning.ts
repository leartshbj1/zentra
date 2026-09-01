import type { ProjectMilestone, ProjectTask } from './types';

export type TaskDueBucket =
  | 'overdue'
  | 'today'
  | 'upcoming'
  | 'no_date'
  | 'closed';

const OPEN_STATUSES = new Set(['todo', 'in_progress']);

export function taskDueBucket(task: ProjectTask, today: string): TaskDueBucket {
  if (!OPEN_STATUSES.has(task.status)) return 'closed';
  if (!task.dueDate) return 'no_date';
  if (task.dueDate < today) return 'overdue';
  if (task.dueDate === today) return 'today';
  return 'upcoming';
}

export function milestoneProgress(
  milestoneId: string,
  tasks: ProjectTask[],
): { completed: number; total: number; percent: number } {
  const relevant = tasks.filter(
    (task) => task.milestoneId === milestoneId && task.status !== 'cancelled',
  );
  const completed = relevant.filter((task) => task.status === 'done').length;
  return {
    completed,
    total: relevant.length,
    percent: relevant.length ? Math.round((completed / relevant.length) * 100) : 0,
  };
}

export function planningSummary(tasks: ProjectTask[], today: string) {
  const open = tasks.filter((task) => OPEN_STATUSES.has(task.status));
  return {
    open: open.length,
    inProgress: open.filter((task) => task.status === 'in_progress').length,
    overdue: open.filter((task) => taskDueBucket(task, today) === 'overdue')
      .length,
    done: tasks.filter((task) => task.status === 'done').length,
  };
}

export function planningTaskSort(a: ProjectTask, b: ProjectTask): number {
  const priority = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
  const dateA = a.dueDate || '9999-12-31';
  const dateB = b.dueDate || '9999-12-31';
  return (
    dateA.localeCompare(dateB) ||
    priority[a.priority] - priority[b.priority] ||
    a.sortOrder - b.sortOrder ||
    a.createdAt.localeCompare(b.createdAt)
  );
}

export function filteredPlanningTasks(input: {
  tasks: ProjectTask[];
  projectId?: string;
  employeeId?: string;
  status?: ProjectTask['status'] | 'open';
  query?: string;
}): ProjectTask[] {
  const query = input.query?.trim().toLocaleLowerCase('fr-CH') ?? '';
  return input.tasks
    .filter((task) => !input.projectId || task.projectId === input.projectId)
    .filter(
      (task) => !input.employeeId || task.employeeId === input.employeeId,
    )
    .filter((task) => {
      if (!input.status) return true;
      if (input.status === 'open') return OPEN_STATUSES.has(task.status);
      return task.status === input.status;
    })
    .filter(
      (task) =>
        !query ||
        `${task.title} ${task.description}`
          .toLocaleLowerCase('fr-CH')
          .includes(query),
    )
    .sort(planningTaskSort);
}

export function milestoneCanClose(
  milestone: ProjectMilestone,
  tasks: ProjectTask[],
): boolean {
  return !tasks.some(
    (task) =>
      task.milestoneId === milestone.id && OPEN_STATUSES.has(task.status),
  );
}

export function nextProjectTaskStatus(
  status: ProjectTask['status'],
): ProjectTask['status'] {
  if (status === 'todo') return 'in_progress';
  if (status === 'in_progress') return 'done';
  if (status === 'done') return 'in_progress';
  return 'todo';
}

export const nextProjectMilestoneStatus = nextProjectTaskStatus;
