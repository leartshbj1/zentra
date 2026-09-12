import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { errorMessage, formatDate, searchText, todayIso } from './utils';
import {
  Button,
  EmptyState,
  ReadOnlyFormScope,
  StatusBadge,
} from './ui';

import { PlanningEditor as GuidedPlanningEditor } from './PlanningEditor';
import { planningTaskBlock, type PlanningErrorHandler } from './planningForm';

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
  onClearSearch,
  onOpenTime,
  onCreateProject,
}: {
  workspace: Workspace;
  query: string;
  busy: boolean;
  readOnly: boolean;
  onSaveTask: (input: ProjectTaskDraft, onError?: PlanningErrorHandler) => Promise<boolean>;
  onSaveMilestone: (input: ProjectMilestoneDraft, onError?: PlanningErrorHandler) => Promise<boolean>;
  onSetTaskStatus: (
    item: ProjectTask,
    status: ProjectPlanningStatus,
    onError?: PlanningErrorHandler,
  ) => Promise<boolean>;
  onDeleteTask: (item: ProjectTask, onError?: PlanningErrorHandler) => Promise<boolean>;
  onDeleteMilestone: (item: ProjectMilestone, onError?: PlanningErrorHandler) => Promise<boolean>;
  focusItemId: string | null;
  onFocusItemHandled: () => void;
  onClearSearch?: () => void;
  onOpenTime?: () => void;
  onCreateProject?: () => void;
}) {
  const initialFocus = planningFocusSelection(workspace, focusItemId);
  const [editor, setEditor] = useState<PlanningEditor>(null);
  const [projectId, setProjectId] = useState(initialFocus?.projectId || '');
  const [employeeId, setEmployeeId] = useState('');
  const [milestoneFilter, setMilestoneFilter] = useState('');
  const [actionError, setActionError] = useState('');
  const actionErrorRef = useRef<HTMLDivElement>(null), actionInFlight = useRef(false);
  useEffect(() => { if (actionError && !busy) { actionErrorRef.current?.focus(); actionErrorRef.current?.scrollIntoView({ block: 'nearest' }); } }, [actionError, busy]);
  async function runAction(action: (onError: PlanningErrorHandler) => Promise<boolean>) {
    if (busy || readOnly || actionInFlight.current) return;
    actionInFlight.current = true; setActionError('');
    try { await action(reason => setActionError(errorMessage(reason, 'Le planning n’a pas pu être mis à jour. Réessayez après vérification.'))); }
    catch (reason) { setActionError(errorMessage(reason, 'Le planning n’a pas pu être mis à jour.')); }
    finally { actionInFlight.current = false; }
  }
  function revealProject(id: string) { setProjectId(id); setEmployeeId(''); setStatus('open'); setMilestoneFilter(''); onClearSearch?.(); }
  function showMilestone(id: string) { const target = workspace.projectMilestones.find(row => row.id === id); if (target) { revealProject(target.projectId); setStatus(target.status); setFocusedItemId(target.id); } }
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
      setMilestoneFilter('');
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
  const milestoneTasks = useMemo(() => milestoneFilter ? searchableTasks.filter(row => row.milestoneId === milestoneFilter) : searchableTasks, [searchableTasks, milestoneFilter]);
  const tasks = useMemo(
    () =>
      filteredPlanningTasks({
        tasks: milestoneTasks,
        projectId: projectId || undefined,
        employeeId: employeeId || undefined,
        status,
      }),
    [employeeId, projectId, milestoneTasks, status],
  );
  const summaryTasks = filteredPlanningTasks({
    tasks: milestoneTasks,
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
        text="Créez le dossier du projet pour y retrouver ses tâches, documents et factures."
        actionLabel={onCreateProject ? "Créer un projet" : undefined} onAction={onCreateProject} disabled={busy || readOnly}
      />
    );

  return (
    <div className="planning-layout">
      {actionError && <div className="planning-form-error planning-action-message" role="alert" tabIndex={-1} ref={actionErrorRef}><strong>Le planning demande une vérification</strong><p>{actionError}</p></div>}
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
            <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setMilestoneFilter(''); }}>
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

      {milestoneFilter && <div className="planning-filter-notice"><span>Tâches de « {workspace.projectMilestones.find(row => row.id === milestoneFilter)?.title || 'Étape indisponible'} »</span><Button variant="ghost" size="small" onClick={() => setMilestoneFilter('')}>Toutes les tâches du projet</Button></div>}
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
                      onOpenTime={onOpenTime}
                      onOpenMilestone={() => task.milestoneId && showMilestone(task.milestoneId)}
                      onAdvance={() => runAction(onError => onSetTaskStatus(task, nextProjectTaskStatus(task.status), onError))}
                      onCancel={() =>
                        void runAction(onError => onSetTaskStatus(task, 'cancelled', onError))
                      }
                      onDelete={() => void runAction(onError => onDeleteTask(task, onError))}
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
              <strong>Étapes du projet</strong>
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
                    {!canClose && <div className="planning-task-help"><p>Terminez ou annulez les tâches ouvertes avant de terminer cette étape.</p><Button variant="secondary" size="small" onClick={() => { revealProject(milestone.projectId); setMilestoneFilter(milestone.id); }}>Voir les tâches à terminer</Button></div>}
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
                            void runAction(onError => onSaveMilestone(milestoneDraftWithStatus(milestone, nextStatus), onError))
                          }
                          aria-label={`Changer l’état du jalon ${milestone.title}`}
                        >
                          {milestone.status === 'done' ? (
                            <Check size={14} />
                          ) : (
                            <Circle size={14} />
                          )}
                          <span>{milestone.status === 'done' || milestone.status === 'cancelled' ? 'Rouvrir' : milestone.status === 'todo' ? 'Commencer' : 'Terminer'}</span>
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
                            void runAction(onError => onSaveMilestone(milestoneDraftWithStatus(milestone, 'cancelled'), onError))
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
                          onClick={() => void runAction(onError => onDeleteMilestone(milestone, onError))}
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

      <ReadOnlyFormScope readOnly={readOnly}>
      {editor?.kind === 'task' ? (
        <GuidedPlanningEditor kind="task" readOnly={readOnly}
          item={editor.item}
          defaultProjectId={editor.projectId}
          workspace={workspace}
          busy={busy}
          onClose={() => setEditor(null)}
          onSave={async (input, onError) => {
            const saved = await onSaveTask(input, onError);
            if (saved) { setEditor(null); revealProject(input.projectId); }
            return saved;
          }}
        />
      ) : null}
      {editor?.kind === 'milestone' ? (
        <GuidedPlanningEditor kind="milestone" readOnly={readOnly}
          item={editor.item}
          defaultProjectId={editor.projectId}
          workspace={workspace}
          busy={busy}
          onClose={() => setEditor(null)}
          onSave={async (input, onError) => {
            const saved = await onSaveMilestone(input, onError);
            if (saved) { setEditor(null); revealProject(input.projectId); }
            return saved;
          }}
        />
      ) : null}
      </ReadOnlyFormScope>
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
  onOpenTime,
  onOpenMilestone,
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
  onOpenTime?: () => void;
  onOpenMilestone: () => void;
}) {
  const project = workspace.projects.find((item) => item.id === task.projectId);
  const employee = workspace.employees.find((item) => item.id === task.employeeId);
  const milestone = workspace.projectMilestones.find(
    (item) => item.id === task.milestoneId,
  );
  const advanceBlock = planningTaskBlock(task, nextProjectTaskStatus(task.status), workspace);
  const cancelBlock = planningTaskBlock(task, 'cancelled', workspace);
  const taskBlock = advanceBlock || cancelBlock;
  const hasActiveTimer = workspace.activeTimer?.taskId === task.id;
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
        disabled={busy || readOnly || Boolean(advanceBlock)}
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
        <span>{task.status === 'done' || task.status === 'cancelled' ? 'Rouvrir' : task.status === 'todo' ? 'Commencer' : 'Terminer'}</span>
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
            task.status === 'cancelled' || Boolean(cancelBlock)
          }
          title={cancelBlock?.message || "Annuler la tâche"}
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
            busy || readOnly || task.status !== 'todo' || hasTimeEntries || hasActiveTimer
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
      {taskBlock && <div className="planning-task-help"><p>{taskBlock.message}</p>{taskBlock.target === 'timer' ? onOpenTime && <Button size="small" variant="secondary" onClick={onOpenTime}>Ouvrir le chronomètre</Button> : <Button size="small" variant="secondary" onClick={onOpenMilestone}>Voir l’étape à rouvrir</Button>}</div>}
    </div>
  );
}
