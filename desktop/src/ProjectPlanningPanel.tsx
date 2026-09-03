import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Ban,
  CalendarCheck2,
  Check,
  Circle,
  Clock3,
  Flag,
  ListChecks,
  Pencil,
  Plus,
  Target,
  Trash2,
  UserRound,
} from 'lucide-react';
import {
  filteredPlanningTasks,
  milestoneCanClose,
  milestoneProgress,
  nextProjectMilestoneStatus,
  nextProjectTaskStatus,
  planningSummary,
  taskDueBucket,
} from './projectPlanning';
import type {
  ProjectMilestone,
  ProjectPlanningPriority,
  ProjectPlanningStatus,
  ProjectTask,
  Workspace,
} from './types';
import { formatDate, searchText, todayIso } from './utils';
import {
  Button,
  EmptyState,
  Field,
  FormActions,
  Modal,
  StatusBadge,
  submitForm,
} from './ui';

export type ProjectTaskDraft = {
  id?: string;
  projectId: string;
  milestoneId: string | null;
  employeeId: string | null;
  title: string;
  description: string;
  dueDate: string | null;
  priority: ProjectPlanningPriority;
  sortOrder: number;
};

export type ProjectMilestoneDraft = {
  id?: string;
  projectId: string;
  employeeId: string | null;
  title: string;
  description: string;
  dueDate: string | null;
  status: ProjectPlanningStatus;
  priority: ProjectPlanningPriority;
  sortOrder: number;
};

type PlanningEditor =
  | { kind: 'task'; item?: ProjectTask; projectId?: string }
  | { kind: 'milestone'; item?: ProjectMilestone; projectId?: string }
  | null;

type PlanningFocusSelection = {
  id: string;
  projectId: string;
  status: ProjectPlanningStatus;
};

export function planningItemDomId(id: string) {
  return `planning-item-${id}`;
}

export function planningFocusSelection(
  workspace: Pick<Workspace, 'projectTasks' | 'projectMilestones'>,
  itemId: string | null,
): PlanningFocusSelection | null {
  if (!itemId) return null;
  const target =
    workspace.projectTasks.find((item) => item.id === itemId) ||
    workspace.projectMilestones.find((item) => item.id === itemId);
  return target
    ? { id: target.id, projectId: target.projectId, status: target.status }
    : null;
}

const statusLabels: Record<ProjectPlanningStatus, string> = {
  todo: 'À faire',
  in_progress: 'En cours',
  done: 'Terminé',
  cancelled: 'Annulée',
};
const priorityLabels: Record<ProjectPlanningPriority, string> = {
  low: 'Basse',
  normal: 'Normale',
  high: 'Haute',
  urgent: 'Urgente',
};

function milestoneDraftWithStatus(
  milestone: ProjectMilestone,
  status: ProjectPlanningStatus,
): ProjectMilestoneDraft {
  return {
    id: milestone.id,
    projectId: milestone.projectId,
    employeeId: milestone.employeeId,
    title: milestone.title,
    description: milestone.description,
    dueDate: milestone.dueDate || null,
    status,
    priority: milestone.priority,
    sortOrder: milestone.sortOrder,
  };
}

export function ProjectPlanningPanel({
  workspace,
  query,
  busy,
  readOnly,
  onSaveTask,
  onSaveMilestone,
  onSetTaskStatus,
  onDeleteTask,
  onDeleteMilestone,
  focusItemId,
  onFocusItemHandled,
}: {
  workspace: Workspace;
  query: string;
  busy: boolean;
  readOnly: boolean;
  onSaveTask: (input: ProjectTaskDraft) => Promise<boolean>;
  onSaveMilestone: (input: ProjectMilestoneDraft) => Promise<boolean>;
  onSetTaskStatus: (
    item: ProjectTask,
    status: ProjectPlanningStatus,
  ) => Promise<boolean>;
  onDeleteTask: (item: ProjectTask) => Promise<boolean>;
  onDeleteMilestone: (item: ProjectMilestone) => Promise<boolean>;
  focusItemId: string | null;
  onFocusItemHandled: () => void;
}) {
  const initialFocus = planningFocusSelection(workspace, focusItemId);
  const [editor, setEditor] = useState<PlanningEditor>(null);
  const [projectId, setProjectId] = useState(initialFocus?.projectId || '');
  const [employeeId, setEmployeeId] = useState('');
  const [status, setStatus] = useState<ProjectTask['status'] | 'open'>(
    initialFocus?.status || 'open',
  );
  const [focusedItemId, setFocusedItemId] = useState<string | null>(
    initialFocus?.id || null,
  );
  const today = todayIso();
  useEffect(() => {
    if (!focusItemId) return;
    const target = planningFocusSelection(workspace, focusItemId);
    if (target) {
      setProjectId(target.projectId);
      setEmployeeId('');
      setStatus(target.status);
      setFocusedItemId(target.id);
    }
    onFocusItemHandled();
  }, [
    focusItemId,
    onFocusItemHandled,
    workspace.projectMilestones,
    workspace.projectTasks,
  ]);
  const searchableTasks = useMemo(
    () =>
      workspace.projectTasks.filter((task) => {
        const project = workspace.projects.find(
          (item) => item.id === task.projectId,
        );
        const client = workspace.clients.find(
          (item) => item.id === project?.clientId,
        );
        const employee = workspace.employees.find(
          (item) => item.id === task.employeeId,
        );
        const milestone = workspace.projectMilestones.find(
          (item) => item.id === task.milestoneId,
        );
        return searchText(
          [
            task.title,
            task.description,
            project?.name,
            client?.company,
            client?.name,
            employee?.name,
            milestone?.title,
          ],
          query,
        );
      }),
    [
      query,
      workspace.clients,
      workspace.employees,
      workspace.projectMilestones,
      workspace.projectTasks,
      workspace.projects,
    ],
  );
  const tasks = useMemo(
    () =>
      filteredPlanningTasks({
        tasks: searchableTasks,
        projectId: projectId || undefined,
        employeeId: employeeId || undefined,
        status,
      }),
    [employeeId, projectId, searchableTasks, status],
  );
  const summaryTasks = filteredPlanningTasks({
    tasks: searchableTasks,
    projectId: projectId || undefined,
    employeeId: employeeId || undefined,
  });
  const summary = planningSummary(summaryTasks, today);
  const milestoneMatchesStatus = (item: ProjectMilestone) =>
    status === 'open'
      ? item.status === 'todo' || item.status === 'in_progress'
      : item.status === status;
  const milestones = workspace.projectMilestones
    .filter((item) => !projectId || item.projectId === projectId)
    .filter((item) => !employeeId || item.employeeId === employeeId)
    .filter(milestoneMatchesStatus)
    .filter((item) => {
      const project = workspace.projects.find(
        (candidate) => candidate.id === item.projectId,
      );
      const client = workspace.clients.find(
        (candidate) => candidate.id === project?.clientId,
      );
      const employee = workspace.employees.find(
        (candidate) => candidate.id === item.employeeId,
      );
      return searchText(
        [
          item.title,
          item.description,
          project?.name,
          client?.company,
          client?.name,
          employee?.name,
        ],
        query,
      );
    })
    .sort(
      (a, b) =>
        (a.dueDate || '9999-12-31').localeCompare(
          b.dueDate || '9999-12-31',
        ) || a.sortOrder - b.sortOrder,
    );

  const buckets = [
    {
      id: 'overdue',
      label: 'En retard',
      tone: 'danger',
      tasks: tasks.filter((task) => taskDueBucket(task, today) === 'overdue'),
    },
    {
      id: 'today',
      label: "Aujourd'hui",
      tone: 'warning',
      tasks: tasks.filter((task) => taskDueBucket(task, today) === 'today'),
    },
    {
      id: 'upcoming',
      label: 'À venir',
      tone: 'neutral',
      tasks: tasks.filter((task) => taskDueBucket(task, today) === 'upcoming'),
    },
    {
      id: 'no_date',
      label: 'Sans échéance',
      tone: 'neutral',
      tasks: tasks.filter((task) => taskDueBucket(task, today) === 'no_date'),
    },
    {
      id: 'closed',
      label: 'Closes',
      tone: 'success',
      tasks: tasks.filter((task) => taskDueBucket(task, today) === 'closed'),
    },
  ].filter((bucket) => bucket.tasks.length);

  useEffect(() => {
    if (!focusedItemId) return;
    const frame = window.requestAnimationFrame(() => {
      const node = document.getElementById(planningItemDomId(focusedItemId));
      if (!node) return;
      const reduceMotion = window.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      node.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'center',
      });
      node.focus({ preventScroll: true });
    });
    const clearHighlight = window.setTimeout(
      () => setFocusedItemId(null),
      4_000,
    );
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(clearHighlight);
    };
  }, [focusedItemId, buckets.length, milestones.length]);

  if (!workspace.projects.length)
    return (
      <EmptyState
        icon={<ListChecks />}
        title="Créez d’abord un projet"
        text="Une tâche doit toujours appartenir à un projet réel. Aucun exemple n’est ajouté automatiquement."
      />
    );

  return (
    <div className="planning-layout">
      <section className="planning-overview" aria-label="Résumé des tâches">
        <PlanningMetric label="Ouvertes" value={summary.open} icon={<Circle />} />
        <PlanningMetric
          label="En cours"
          value={summary.inProgress}
          icon={<Clock3 />}
        />
        <PlanningMetric
          label="En retard"
          value={summary.overdue}
          icon={<AlertTriangle />}
          alert={summary.overdue > 0}
        />
        <PlanningMetric label="Terminées" value={summary.done} icon={<Check />} />
      </section>

      <section className="planning-toolbar panel">
        <div className="planning-filters">
          <label>
            <span>Projet</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">Tous les projets</option>
              {workspace.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Responsable</span>
            <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
              <option value="">Toute l’équipe</option>
              {workspace.employees
                .filter((employee) => employee.active)
                .map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>État</span>
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as ProjectTask['status'] | 'open')
              }
            >
              <option value="open">À traiter</option>
              <option value="todo">À faire</option>
              <option value="in_progress">En cours</option>
              <option value="done">Terminées</option>
              <option value="cancelled">Annulées</option>
            </select>
          </label>
        </div>
        <div className="planning-toolbar__actions">
          <Button
            variant="secondary"
            disabled={busy || readOnly}
            onClick={() =>
              setEditor({ kind: 'milestone', projectId: projectId || undefined })
            }
          >
            <Target size={15} /> Nouveau jalon
          </Button>
          <Button
            disabled={busy || readOnly}
            onClick={() =>
              setEditor({ kind: 'task', projectId: projectId || undefined })
            }
          >
            <Plus size={15} /> Nouvelle tâche
          </Button>
        </div>
      </section>

      <div className="planning-columns">
        <section className="planning-task-groups">
          {buckets.length ? (
            buckets.map((bucket) => (
              <article className={`planning-group planning-group--${bucket.tone}`} key={bucket.id}>
                <header>
                  <strong>{bucket.label}</strong>
                  <span>{bucket.tasks.length}</span>
                </header>
                <div>
                  {bucket.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      focused={task.id === focusedItemId}
                      workspace={workspace}
                      busy={busy}
                      readOnly={readOnly}
                      onEdit={() => setEditor({ kind: 'task', item: task })}
                      onAdvance={async () => {
                        await onSetTaskStatus(
                          task,
                          nextProjectTaskStatus(task.status),
                        );
                      }}
                      onCancel={() =>
                        void onSetTaskStatus(task, 'cancelled')
                      }
                      onDelete={() => void onDeleteTask(task)}
                    />
                  ))}
                </div>
              </article>
            ))
          ) : (
            <div className="panel">
              <EmptyState
                icon={<CalendarCheck2 />}
                title="Aucune tâche dans cette vue"
                text="Modifiez les filtres ou créez la prochaine action réelle du projet."
                actionLabel="Créer une tâche"
                onAction={() =>
                  setEditor({ kind: 'task', projectId: projectId || undefined })
                }
                disabled={busy || readOnly}
              />
            </div>
          )}
        </section>

        <aside className="planning-milestones panel">
          <header>
            <div>
              <span>Étapes clés</span>
              <strong>Jalons</strong>
            </div>
            <Target size={18} />
          </header>
          {milestones.length ? (
            <div className="milestone-list">
              {milestones.map((milestone) => {
                const progress = milestoneProgress(
                  milestone.id,
                  workspace.projectTasks,
                );
                const project = workspace.projects.find(
                  (item) => item.id === milestone.projectId,
                );
                const employee = workspace.employees.find(
                  (item) => item.id === milestone.employeeId,
                );
                const hasLinkedTasks = workspace.projectTasks.some(
                  (task) => task.milestoneId === milestone.id,
                );
                const canClose = milestoneCanClose(
                  milestone,
                  workspace.projectTasks,
                );
                const nextStatus = nextProjectMilestoneStatus(
                  milestone.status,
                );
                return (
                  <article
                    key={milestone.id}
                    id={planningItemDomId(milestone.id)}
                    className={
                      milestone.id === focusedItemId ? 'is-agenda-target' : ''
                    }
                    tabIndex={-1}
                    aria-current={
                      milestone.id === focusedItemId ? 'true' : undefined
                    }
                  >
                    <div className="milestone-list__top">
                      <span className={`priority-dot priority-dot--${milestone.priority}`} />
                      <div>
                        <strong>{milestone.title}</strong>
                        <small>{project?.name || 'Projet supprimé'}</small>
                      </div>
                      <StatusBadge
                        status={milestone.status}
                        label={statusLabels[milestone.status]}
                      />
                    </div>
                    <div className="milestone-list__progress">
                      <span>
                        <i style={{ width: `${progress.percent}%` }} />
                      </span>
                      <small>
                        {progress.completed}/{progress.total} tâche
                        {progress.total > 1 ? 's' : ''}
                      </small>
                    </div>
                    <footer>
                      <span>
                        <CalendarCheck2 size={13} />{' '}
                        {milestone.dueDate
                          ? formatDate(milestone.dueDate)
                          : 'Sans échéance'}
                        {employee ? ` · ${employee.name}` : ''}
                      </span>
                      <div>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={
                            busy ||
                            readOnly ||
                            (milestone.status === 'in_progress' && !canClose)
                          }
                          title={
                            milestone.status === 'in_progress' && !canClose
                              ? 'Terminez ou annulez d’abord les tâches actives'
                              : milestone.status === 'done' ||
                                  milestone.status === 'cancelled'
                                ? 'Rouvrir le jalon'
                                : milestone.status === 'todo'
                                  ? 'Démarrer le jalon'
                                  : 'Terminer le jalon'
                          }
                          onClick={() =>
                            void onSaveMilestone(
                              milestoneDraftWithStatus(milestone, nextStatus),
                            )
                          }
                          aria-label={`Changer l’état du jalon ${milestone.title}`}
                        >
                          {milestone.status === 'done' ? (
                            <Check size={14} />
                          ) : (
                            <Circle size={14} />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={
                            busy ||
                            readOnly ||
                            !canClose ||
                            milestone.status === 'done' ||
                            milestone.status === 'cancelled'
                          }
                          title={
                            canClose
                              ? 'Annuler le jalon'
                              : 'Terminez ou annulez d’abord les tâches actives'
                          }
                          onClick={() =>
                            void onSaveMilestone(
                              milestoneDraftWithStatus(milestone, 'cancelled'),
                            )
                          }
                          aria-label={`Annuler le jalon ${milestone.title}`}
                        >
                          <Ban size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={
                            busy ||
                            readOnly ||
                            milestone.status === 'done' ||
                            milestone.status === 'cancelled'
                          }
                          title={
                            milestone.status === 'done' ||
                            milestone.status === 'cancelled'
                              ? 'Rouvrez d’abord le jalon pour le modifier'
                              : 'Modifier le jalon'
                          }
                          onClick={() => setEditor({ kind: 'milestone', item: milestone })}
                          aria-label={`Modifier le jalon ${milestone.title}`}
                        >
                          <Pencil size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={
                            busy ||
                            readOnly ||
                            milestone.status !== 'todo' ||
                            hasLinkedTasks
                          }
                          title={
                            milestone.status !== 'todo'
                              ? 'Seul un jalon à faire peut être supprimé'
                              : hasLinkedTasks
                              ? 'Déplacez ou supprimez d’abord les tâches liées à ce jalon'
                              : 'Supprimer le jalon'
                          }
                          onClick={() => void onDeleteMilestone(milestone)}
                          aria-label={`Supprimer le jalon ${milestone.title}`}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </footer>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="planning-milestones__empty">
              Aucun jalon dans cette vue. Les tâches peuvent aussi rester sans jalon.
            </p>
          )}
        </aside>
      </div>

      {editor?.kind === 'task' ? (
        <TaskEditor
          item={editor.item}
          defaultProjectId={editor.projectId}
          workspace={workspace}
          busy={busy}
          onClose={() => setEditor(null)}
          onSave={async (input) => {
            if (await onSaveTask(input)) setEditor(null);
          }}
        />
      ) : null}
      {editor?.kind === 'milestone' ? (
        <MilestoneEditor
          item={editor.item}
          defaultProjectId={editor.projectId}
          workspace={workspace}
          busy={busy}
          onClose={() => setEditor(null)}
          onSave={async (input) => {
            if (await onSaveMilestone(input)) setEditor(null);
          }}
        />
      ) : null}
    </div>
  );
}

function PlanningMetric({
  label,
  value,
  icon,
  alert = false,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  alert?: boolean;
}) {
  return (
    <article className={alert ? 'is-alert' : ''}>
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </article>
  );
}

function TaskRow({
  task,
  focused,
  workspace,
  busy,
  readOnly,
  onEdit,
  onAdvance,
  onCancel,
  onDelete,
}: {
  task: ProjectTask;
  focused: boolean;
  workspace: Workspace;
  busy: boolean;
  readOnly: boolean;
  onEdit: () => void;
  onAdvance: () => Promise<void>;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const project = workspace.projects.find((item) => item.id === task.projectId);
  const employee = workspace.employees.find((item) => item.id === task.employeeId);
  const milestone = workspace.projectMilestones.find(
    (item) => item.id === task.milestoneId,
  );
  const hasTimeEntries = workspace.timeEntries.some(
    (entry) => entry.taskId === task.id,
  );
  return (
    <div
      id={planningItemDomId(task.id)}
      className={`planning-task planning-task--${task.status}${focused ? ' is-agenda-target' : ''}`}
      tabIndex={-1}
      aria-current={focused ? 'true' : undefined}
    >
      <button
        type="button"
        className="planning-task__check"
        disabled={busy || readOnly}
        onClick={() => void onAdvance()}
        aria-label={
          task.status === 'done'
            ? `Rouvrir ${task.title}`
            : task.status === 'cancelled'
              ? `Rouvrir ${task.title}`
            : task.status === 'in_progress'
              ? `Terminer ${task.title}`
              : `Commencer ${task.title}`
        }
      >
        {task.status === 'done' ? <Check size={15} /> : <Circle size={15} />}
      </button>
      <div className="planning-task__body">
        <div>
          <strong>{task.title}</strong>
          <span className={`priority-label priority-label--${task.priority}`}>
            <Flag size={11} /> {priorityLabels[task.priority]}
          </span>
        </div>
        <p>
          <span>{project?.name || 'Projet supprimé'}</span>
          {milestone ? <span>{milestone.title}</span> : null}
          <span>
            <CalendarCheck2 size={12} />{' '}
            {task.dueDate ? formatDate(task.dueDate) : 'Sans échéance'}
          </span>
          <span>
            <UserRound size={12} /> {employee?.name || 'Non attribuée'}
          </span>
        </p>
      </div>
      <StatusBadge status={task.status} label={statusLabels[task.status]} />
      <div className="planning-task__actions">
        <Button
          variant="ghost"
          size="icon"
          disabled={
            busy ||
            readOnly ||
            task.status === 'done' ||
            task.status === 'cancelled'
          }
          title="Annuler la tâche"
          onClick={onCancel}
          aria-label={`Annuler ${task.title}`}
        >
          <Ban size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={
            busy ||
            readOnly ||
            task.status === 'done' ||
            task.status === 'cancelled'
          }
          title={
            task.status === 'done' || task.status === 'cancelled'
              ? 'Rouvrez d’abord la tâche pour modifier son contenu'
              : 'Modifier la tâche'
          }
          onClick={onEdit}
          aria-label={`Modifier ${task.title}`}
        >
          <Pencil size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={
            busy || readOnly || task.status !== 'todo' || hasTimeEntries
          }
          title={
            task.status !== 'todo'
              ? 'Seule une tâche à faire peut être supprimée'
              : hasTimeEntries
              ? 'Cette tâche possède des heures liées et ne peut plus être supprimée'
              : 'Supprimer la tâche'
          }
          onClick={onDelete}
          aria-label={`Supprimer ${task.title}`}
        >
          <Trash2 size={14} />
        </Button>
      </div>
    </div>
  );
}

function TaskEditor({
  item,
  defaultProjectId,
  workspace,
  busy,
  onClose,
  onSave,
}: {
  item?: ProjectTask;
  defaultProjectId?: string;
  workspace: Workspace;
  busy: boolean;
  onClose: () => void;
  onSave: (input: ProjectTaskDraft) => Promise<void>;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState(
    item?.projectId || defaultProjectId || '',
  );
  const milestones = workspace.projectMilestones.filter(
    (milestone) =>
      milestone.projectId === selectedProjectId &&
      (['todo', 'in_progress'].includes(milestone.status) ||
        milestone.id === item?.milestoneId),
  );
  return (
    <Modal
      title={item ? 'Modifier la tâche' : 'Nouvelle tâche'}
      description="Une prochaine action claire, liée à un seul projet et éventuellement à un jalon."
      onClose={onClose}
      wide
    >
      <form
        onSubmit={submitForm(async (form) =>
          onSave({
            id: item?.id,
            projectId: item?.projectId ?? selectedProjectId,
            milestoneId: String(form.get('milestoneId')) || null,
            employeeId: String(form.get('employeeId')) || null,
            title: String(form.get('title')).trim(),
            description: String(form.get('description')).trim(),
            dueDate: String(form.get('dueDate')) || null,
            priority: String(form.get('priority')) as ProjectPlanningPriority,
            sortOrder: item?.sortOrder ?? 0,
          }),
        )}
      >
        <div className="form-grid">
          <Field label="Tâche" required wide>
            <input name="title" defaultValue={item?.title} maxLength={200} required autoFocus />
          </Field>
          <Field label="Projet" required>
            <select
              name="projectId"
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              disabled={Boolean(item)}
              required
            >
              <option value="">Choisir un projet</option>
              {workspace.projects
                .filter(
                  (project) =>
                    project.status !== 'closed' || project.id === item?.projectId,
                )
                .map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
            </select>
          </Field>
          <Field label="Jalon">
            <select name="milestoneId" defaultValue={item?.milestoneId ?? ''}>
              <option value="">Sans jalon</option>
              {milestones.map((milestone) => (
                <option key={milestone.id} value={milestone.id}>{milestone.title}</option>
              ))}
            </select>
          </Field>
          <Field label="Responsable">
            <select name="employeeId" defaultValue={item?.employeeId ?? ''}>
              <option value="">Non attribuée</option>
              {workspace.employees
                .filter((employee) => employee.active || employee.id === item?.employeeId)
                .map((employee) => (
                  <option key={employee.id} value={employee.id}>{employee.name}</option>
                ))}
            </select>
          </Field>
          <Field label="Échéance">
            <input name="dueDate" type="date" defaultValue={item?.dueDate} />
          </Field>
          <Field label="Priorité" required>
            <select name="priority" defaultValue={item?.priority ?? 'normal'}>
              {Object.entries(priorityLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Field>
          <Field label="Description" wide>
            <textarea name="description" rows={4} maxLength={20000} defaultValue={item?.description} />
          </Field>
        </div>
        <FormActions onCancel={onClose} busy={busy} />
      </form>
    </Modal>
  );
}

function MilestoneEditor({
  item,
  defaultProjectId,
  workspace,
  busy,
  onClose,
  onSave,
}: {
  item?: ProjectMilestone;
  defaultProjectId?: string;
  workspace: Workspace;
  busy: boolean;
  onClose: () => void;
  onSave: (input: ProjectMilestoneDraft) => Promise<void>;
}) {
  return (
    <Modal
      title={item ? 'Modifier le jalon' : 'Nouveau jalon'}
      description="Un jalon représente une étape vérifiable; ses tâches ouvertes doivent être terminées avant sa clôture."
      onClose={onClose}
      wide
    >
      <form
        onSubmit={submitForm(async (form) =>
          onSave({
            id: item?.id,
            projectId:
              item?.projectId ??
              String(form.get('projectId') || defaultProjectId || ''),
            employeeId: String(form.get('employeeId')) || null,
            title: String(form.get('title')).trim(),
            description: String(form.get('description')).trim(),
            dueDate: String(form.get('dueDate')) || null,
            status: item?.status ?? 'todo',
            priority: String(form.get('priority')) as ProjectPlanningPriority,
            sortOrder: item?.sortOrder ?? 0,
          }),
        )}
      >
        <div className="form-grid">
          <Field label="Jalon" required wide>
            <input name="title" defaultValue={item?.title} maxLength={200} required autoFocus />
          </Field>
          <Field label="Projet" required>
            <select name="projectId" defaultValue={item?.projectId || defaultProjectId || ''} disabled={Boolean(item)} required>
              <option value="">Choisir un projet</option>
              {workspace.projects
                .filter(
                  (project) =>
                    project.status !== 'closed' || project.id === item?.projectId,
                )
                .map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
            </select>
          </Field>
          <Field label="Responsable">
            <select name="employeeId" defaultValue={item?.employeeId ?? ''}>
              <option value="">Non attribué</option>
              {workspace.employees
                .filter((employee) => employee.active || employee.id === item?.employeeId)
                .map((employee) => (
                  <option key={employee.id} value={employee.id}>{employee.name}</option>
                ))}
            </select>
          </Field>
          <Field label="Échéance">
            <input name="dueDate" type="date" defaultValue={item?.dueDate} />
          </Field>
          <Field label="Priorité" required>
            <select name="priority" defaultValue={item?.priority ?? 'normal'}>
              {Object.entries(priorityLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Field>
          <Field label="Description" wide>
            <textarea name="description" rows={4} maxLength={20000} defaultValue={item?.description} />
          </Field>
        </div>
        <FormActions onCancel={onClose} busy={busy} />
      </form>
    </Modal>
  );
}
