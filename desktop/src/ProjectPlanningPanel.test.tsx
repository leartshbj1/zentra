import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  planningFocusSelection,
  planningItemDomId,
  ProjectPlanningPanel,
} from './ProjectPlanningPanel';
import type { ProjectMilestone, ProjectTask, Workspace } from './types';

const task = (id: string, status: ProjectTask['status']): ProjectTask => ({
  id,
  projectId: 'project-a',
  milestoneId: null,
  employeeId: null,
  title: `Tâche ${id}`,
  description: '',
  dueDate: '2026-09-30',
  status,
  priority: 'normal',
  sortOrder: 0,
  completedAt: null,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-01T08:00:00Z',
});

const milestone: ProjectMilestone = {
  id: 'milestone-a',
  projectId: 'project-a',
  employeeId: null,
  title: 'Réception finale',
  description: '',
  dueDate: '2026-09-30',
  status: 'in_progress',
  priority: 'high',
  sortOrder: 0,
  completedAt: null,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-01T08:00:00Z',
};

const workspace = {
  projects: [
    {
      id: 'project-a',
      name: 'Projet A',
      clientId: null,
      address: '',
    },
  ],
  clients: [],
  employees: [],
  projectTasks: [task('task-a', 'todo'), task('task-b', 'done')],
  projectMilestones: [milestone],
  timeEntries: [],
} as unknown as Workspace;

function renderFocused(itemId: string) {
  return renderToStaticMarkup(
    <ProjectPlanningPanel
      workspace={workspace}
      query=""
      busy={false}
      readOnly={false}
      onSaveTask={async () => true}
      onSaveMilestone={async () => true}
      onSetTaskStatus={async () => true}
      onDeleteTask={async () => true}
      onDeleteMilestone={async () => true}
      focusItemId={itemId}
      onFocusItemHandled={vi.fn()}
    />,
  );
}

describe('focus exact depuis l’agenda', () => {
  it('sélectionne les filtres de la tâche exacte, même si elle est close', () => {
    expect(planningFocusSelection(workspace, 'task-b')).toEqual({
      id: 'task-b',
      projectId: 'project-a',
      status: 'done',
    });

    const markup = renderFocused('task-b');
    expect(markup).toContain(
      `id="${planningItemDomId('task-b')}" class="planning-task planning-task--done is-agenda-target"`,
    );
    expect(markup).toContain('aria-current="true"');
    expect(markup).not.toContain(
      `id="${planningItemDomId('task-a')}" class="planning-task`,
    );
  });

  it('met en évidence le jalon exact sans cibler une tâche voisine', () => {
    const markup = renderFocused('milestone-a');
    expect(markup).toContain(
      `id="${planningItemDomId('milestone-a')}" class="is-agenda-target"`,
    );
    expect(markup.match(/is-agenda-target/g)).toHaveLength(1);
  });
});
