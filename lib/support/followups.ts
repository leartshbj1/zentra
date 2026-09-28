import { database } from '@/lib/runtime';
import { automationActor } from '@/lib/automation/access';
import { requireAutomationEntitlement } from '@/lib/automation/entitlement';
import { SupportError, text, type Ticket } from './types';
import { digest } from './crypto';
import { requireMemberSeat } from '@/lib/team-seats';

export type Followup = {
  id: string;
  ticketId: string;
  title: string;
  assignedTo: string;
  dueAt: number;
  state: string;
  revision: number;
  organizationId: string | null;
  taskId: string | null;
};
export async function followupMembers(workspace: string) {
  return (
    await database()
      .prepare(`SELECT m.email,m.role FROM support_members m WHERE m.workspace_id=? AND m.role<>'read_only'
  UNION SELECT a.email,'owner' FROM support_workspaces w JOIN founder_account_identities a ON a.user_id=w.owner_id WHERE w.id=?
  UNION SELECT m.email,m.role FROM organization_members m JOIN support_gestion_links l ON l.organization_id=m.organization_id JOIN complete_subscriptions s ON s.subscription_id=(SELECT subscription_id FROM organizations WHERE organization_id=m.organization_id) WHERE l.workspace_id=? AND l.enabled=1 AND m.revoked_at IS NULL AND m.role<>'read_only'`)
      .bind(workspace, workspace, workspace)
      .all<{ email: string; role: string }>()
  ).results;
}
export async function followups(workspace: string) {
  return (
    await database()
      .prepare(`SELECT f.id,f.ticket_id AS ticketId,f.title,f.assigned_to AS assignedTo,f.due_at AS dueAt,
    COALESCE(i.state,f.state) AS state,f.revision,f.organization_id AS organizationId,f.task_id AS taskId
    FROM support_followups f LEFT JOIN automation_work_items i ON i.id=f.task_id AND i.organization_id=f.organization_id
    WHERE f.workspace_id=? ORDER BY (COALESCE(i.state,f.state)='open') DESC,f.due_at LIMIT 200`)
      .bind(workspace)
      .all<Followup>()
  ).results;
}
export function followupInput(
  raw: Record<string, unknown>,
  time = Math.floor(Date.now() / 1000),
) {
  const title = text(raw.title, 161),
    assignedTo = text(raw.assignedTo, 254).toLowerCase(),
    dueAt = Number(raw.dueAt);
  if (
    !title ||
    title.length > 160 ||
    !assignedTo ||
    !Number.isSafeInteger(dueAt) ||
    dueAt < time - 60 ||
    dueAt > time + 366 * 86400
  )
    throw new SupportError(
      'Donnez un titre, un responsable et une date de rappel à venir (dans les 12 mois).',
    );
  return { title, assignedTo, dueAt };
}
export async function createFollowup(
  request: Request,
  ticket: Ticket,
  actor: { email: string; userId: string },
  raw: Record<string, unknown>,
) {
  if (Number(raw.revision) !== ticket.revision || ticket.state === 'processing')
    throw new SupportError('Le message a changé. Rechargez-le.', 409);
  if (
    !ticket.decision_json ||
    JSON.parse(ticket.decision_json).category !== 'solicitation'
  )
    throw new SupportError(
      'Ce suivi concerne les propositions commerciales.',
      409,
    );
  const time = Math.floor(Date.now() / 1000),
    { title, assignedTo, dueAt } = followupInput(raw, time),
    db = database();
  const members = await followupMembers(ticket.workspace_id);
  if (
    assignedTo !== actor.email.toLowerCase() &&
    !members.some((m) => m.email.toLowerCase() === assignedTo)
  )
    throw new SupportError(
      'Choisissez un membre actif de cet espace Support.',
      403,
    );
  const key = await digest(
      `${ticket.workspace_id}:${ticket.id}:${ticket.fingerprint}`,
    ),
    id = `sf_${key.slice(0, 40)}`;
  let organizationId: string | null = null,
    taskId: string | null = null,
    assignedUser: string | null = null;
  if (raw.gestion === true) {
    const link = await db
      .prepare(
        'SELECT organization_id FROM support_gestion_links WHERE workspace_id=? AND enabled=1',
      )
      .bind(ticket.workspace_id)
      .first<{ organization_id: string }>();
    if (!link)
      throw new SupportError(
        'Reliez votre entreprise Gestion dans Connexions avant de créer sa tâche.',
      );
    const verified = await requireAutomationEntitlement(
      await automationActor(request, link.organization_id),
    );
    if (verified.role === 'read_only')
      throw new SupportError(
        'Votre accès Gestion ne permet pas de créer une tâche.',
        403,
      );
    const member = await db
      .prepare(
        "SELECT user_id FROM organization_members WHERE organization_id=? AND lower(email)=? AND revoked_at IS NULL AND role<>'read_only'",
      )
      .bind(link.organization_id, assignedTo)
      .first<{ user_id: string }>();
    if (!member)
      throw new SupportError(
        'Ce responsable doit aussi rejoindre l’entreprise Gestion pour y recevoir une tâche.',
      );
    await requireMemberSeat(link.organization_id, member.user_id);
    organizationId = link.organization_id;
    assignedUser = member.user_id;
    taskId = `sft_${key.slice(0, 40)}`;
  }
  const previous = await db
    .prepare(
      'SELECT id FROM support_followups WHERE workspace_id=? AND ticket_id=? AND fingerprint=?',
    )
    .bind(ticket.workspace_id, ticket.id, ticket.fingerprint)
    .first<{ id: string }>();
  if (previous) return { saved: true, replayed: true, id: previous.id };
  const statements = [
    db
      .prepare(`INSERT INTO support_followups(id,workspace_id,ticket_id,fingerprint,title,assigned_to,due_at,organization_id,task_id,created_by,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM support_tickets WHERE id=? AND workspace_id=? AND revision=? AND fingerprint=? AND state<>'processing' AND COALESCE(lease_until,0)<=unixepoch())
    AND (? IS NULL OR EXISTS(SELECT 1 FROM support_gestion_links WHERE workspace_id=? AND organization_id=? AND enabled=1))
    ON CONFLICT(ticket_id,fingerprint) DO NOTHING`)
      .bind(
        id,
        ticket.workspace_id,
        ticket.id,
        ticket.fingerprint,
        title,
        assignedTo,
        dueAt,
        organizationId,
        taskId,
        actor.email,
        time,
        time,
        ticket.id,
        ticket.workspace_id,
        ticket.revision,
        ticket.fingerprint,
        organizationId,
        ticket.workspace_id,
        organizationId,
      ),
  ];
  if (organizationId && taskId) {
    const workflowId = `support-followup:${organizationId}`,
      runId = `sfr_${key.slice(0, 40)}`;
    const definition = JSON.stringify({
      trigger: 'email_classified',
      mode: 'suggest',
      threshold: 1,
      conditions: {
        category: 'solicitation',
        priority: '',
        sender: '',
        attachment: false,
      },
      decision: null,
      actions: [
        {
          type: 'task',
          title,
          body: '',
          delayHours: 0,
          branch: 'always',
          assignedTo: assignedUser,
        },
      ],
    });
    statements.push(
      db
        .prepare(
          'INSERT INTO automation_workflows(id,organization_id,name,definition,enabled,created_by,created_at,updated_at) VALUES(?,?,?,?,0,?,?,?) ON CONFLICT(id) DO NOTHING',
        )
        .bind(
          workflowId,
          organizationId,
          'Suivi des propositions Support',
          definition,
          actor.userId,
          time,
          time,
        ),
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO automation_workflow_runs(id,organization_id,workflow_id,workflow_revision,source_id,source_version,title,definition,state,result,due_at,created_at,updated_at,finished_at) SELECT ?,?,?,1,?,?,?,?,'completed',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM support_followups WHERE id=? AND task_id=? AND organization_id=?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(
          runId,
          organizationId,
          workflowId,
          ticket.id,
          ticket.fingerprint,
          title,
          definition,
          JSON.stringify({
            category: 'solicitation',
            message:
              'Suivi créé explicitement par votre équipe depuis Support.',
          }),
          dueAt,
          time,
          time,
          time,
          id,
          taskId,
          organizationId,
        ),
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO automation_work_items(id,organization_id,run_id,kind,title,body,assigned_to,due_at,created_at,updated_at,updated_by) SELECT ?,?,?,'task',?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM support_followups WHERE id=? AND task_id=? AND organization_id=?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(
          taskId,
          organizationId,
          runId,
          title,
          `Proposition : ${ticket.subject}\nOuvrir dans Support : /support/espace?workspace=${ticket.workspace_id}&ticket=${ticket.id}`,
          assignedUser,
          dueAt,
          time,
          time,
          actor.userId,
          id,
          taskId,
          organizationId,
        ),
    );
  }
  await db.batch(statements);
  if (
    !(await db
      .prepare('SELECT id FROM support_followups WHERE workspace_id=? AND id=?')
      .bind(ticket.workspace_id, id)
      .first())
  )
    throw new SupportError(
      'Le message ou l’entreprise a changé. Rechargez avant de créer ce suivi.',
      409,
    );
  return { saved: true, id };
}
export async function completeFollowup(
  request: Request,
  workspace: string,
  raw: Record<string, unknown>,
) {
  const row = await database()
    .prepare('SELECT * FROM support_followups WHERE workspace_id=? AND id=?')
    .bind(workspace, text(raw.id, 60))
    .first<{
      revision: number;
      task_id: string | null;
      organization_id: string | null;
    }>();
  if (!row || row.revision !== Number(raw.revision))
    throw new SupportError('Ce suivi a changé. Rechargez-le.', 409);
  if (row.task_id && row.organization_id) {
    // The task has a single authority: Gestion. Its permissions and revision are checked there.
    throw new SupportError(
      'Terminez cette tâche dans Automation : son état sera aussi actualisé ici.',
      409,
    );
  }
  const updated = await database()
    .prepare(
      "UPDATE support_followups SET state='done',revision=revision+1,updated_at=unixepoch() WHERE workspace_id=? AND id=? AND revision=? RETURNING id",
    )
    .bind(workspace, text(raw.id, 60), row.revision)
    .first();
  if (!updated) throw new SupportError('Ce suivi a changé. Rechargez-le.', 409);
  return { saved: true };
}
