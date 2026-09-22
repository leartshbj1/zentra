import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ db: null as unknown, decide: vi.fn() }));
vi.mock('@/lib/runtime', () => ({
  database: () => mocks.db,
  runtimeValue: (key: string) =>
    key === 'STRIPE_SECRET_KEY'
      ? 'sk_live_fixture'
      : key === 'TYPESAFE_API_KEY'
        ? 'fixture'
        : '',
}));
vi.mock('./provider', () => ({
  JevDecisionProvider: class {
    decide = mocks.decide;
  },
}));
import {
  saveWorkflow,
  dispatchMailWorkflows,
  workflowAction,
  workflowCentre,
  previewWorkflow,
  runDueWorkflows,
} from './workflows';
import { workflowDefinition, WORKFLOW_TEMPLATES } from './workflow-definition';
import { workflowDaily } from './workflow-activity';
let db: DatabaseSync;
const owner = {
  organizationId: 'a',
  userId: 'owner',
  role: 'owner',
  founder: false,
};
const base = () => structuredClone(WORKFLOW_TEMPLATES[0].definition);
beforeEach(() => {
  vi.clearAllMocks();
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL('../../drizzle/' + f, import.meta.url), 'utf8'),
    );
  function prepare(q: string) {
    let args: SQLInputValue[] = [];
    return {
      bind(...v: SQLInputValue[]) {
        args = v;
        return this;
      },
      async first() {
        return db.prepare(q).get(...args) || null;
      },
      async all() {
        return { results: db.prepare(q).all(...args) };
      },
      async run() {
        return { meta: db.prepare(q).run(...args) };
      },
    };
  }
  mocks.db = {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) => {
      db.exec('BEGIN');
      try {
        const result = [];
        for (const s of statements) result.push(await s.run());
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  db.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at) VALUES('base','cus','price','active',2000000000,2000000000,1,1),('base_b','cus','price','active',2000000000,2000000000,1,1);
 INSERT INTO organizations VALUES('a','A','base','owner',1,1),('b','B','base_b','owner',1,1);
 INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('ma','a','owner','owner@example.test','owner',1),('mb','b','owner','owner@example.test','owner',1),('mc','a','member','member@example.test','member',1);
 INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,livemode,updated_at) VALUES('a','addon','cus','active',1,2000000000,1,1);
 INSERT INTO automation_platform VALUES('features','["email_classification"]','owner',1);
 INSERT INTO automation_settings(organization_id,enabled,mode,flags,medium_threshold,high_threshold,consent_version,updated_at) VALUES('a',1,'suggest','["email_classification"]',.75,.95,'automation-2026-09-20',1);
 INSERT INTO support_workspaces(id,owner_id,name,mode,created_at,updated_at) VALUES('support','owner','Support','automatic',1,1);
 INSERT INTO support_gestion_links VALUES('support','a',1,1,'owner',1);
 INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at) VALUES('conn','support','infomaniak','Mail','','','','','{}','{}',1);`);
  const source = {
    mail: { sender: 'customer@example.test', attachments: [] },
    subject: 'Réparation machine',
    body: 'La machine est en panne.',
  };
  db.prepare(
    "INSERT INTO support_tickets(id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,state,decision_json,created_at,updated_at) VALUES('ticket','support','conn','ext',?,?,?,'v1','routed',?,1,1)",
  ).run(
    source.subject,
    source.body,
    JSON.stringify(source),
    JSON.stringify({
      category: 'after_sales',
      priority: 'normal',
      confidence: 0.99,
    }),
  );
  mocks.decide.mockResolvedValue({
    answers: {
      branch: {
        choice: 'yes',
        confidence: 0.99,
        probabilities: { yes: 0.99, no: 0.01, uncertain: 0 },
      },
    },
  });
});
afterEach(() => db.close());
async function add(mode = 'automatic') {
  const d = base();
  d.mode = mode as typeof d.mode;
  return saveWorkflow(owner, {
    name: 'Suivi SAV',
    enabled: true,
    definition: d,
  });
}
async function centre() {
  return workflowCentre(owner);
}
it('creates exactly one task for repeated delivery and shows it to the same company team', async () => {
  await add();
  await Promise.all([
    dispatchMailWorkflows('support', 'ticket'),
    dispatchMailWorkflows('support', 'ticket'),
  ]);
  await dispatchMailWorkflows('support', 'ticket');
  const result = await centre();
  expect(result.items).toHaveLength(1);
  expect(result.runs[0].state).toBe('completed');
  expect(result.items[0].title).toBe('SAV · Réparation machine');
  expect(
    (await workflowCentre({ ...owner, userId: 'member', role: 'owner' }))
      .canManage,
  ).toBe(false);
  await expect(
    workflowCentre({ ...owner, organizationId: 'b' }),
  ).rejects.toMatchObject({ status: 402 });
});
it('never executes or calls the provider without the add-on', async () => {
  await add();
  db.exec("UPDATE automation_subscriptions SET status='unpaid'");
  await dispatchMailWorkflows('support', 'ticket');
  expect(
    db.prepare('SELECT count(*) n FROM automation_workflow_runs').get()?.n,
  ).toBe(0);
  expect(mocks.decide).not.toHaveBeenCalled();
});
it('keeps shadow mode free of business changes and human confirmation creates the intended task', async () => {
  await add('shadow');
  await dispatchMailWorkflows('support', 'ticket');
  expect((await centre()).runs[0].state).toBe('observed');
  expect((await centre()).items).toHaveLength(0);
  await add('suggest');
  await dispatchMailWorkflows('support', 'ticket');
  const run = (await centre()).runs.find((r) => r.state === 'review')!;
  await workflowAction(owner, {
    action: 'workflow_confirm',
    id: run.id,
    revision: run.revision,
  });
  expect((await centre()).items).toHaveLength(1);
});
it('does not execute low-confidence events and cannot bypass a revoked member with an old role', async () => {
  await add();
  db.exec(
    `UPDATE support_tickets SET decision_json='{"category":"after_sales","priority":"normal","confidence":0.6}'`,
  );
  await dispatchMailWorkflows('support', 'ticket');
  expect((await centre()).runs[0].state).toBe('review');
  expect((await centre()).items).toHaveLength(0);
  db.exec(
    "UPDATE organization_members SET revoked_at=1 WHERE user_id='member'",
  );
  await expect(
    saveWorkflow(
      { ...owner, userId: 'member' },
      { name: 'Bad', enabled: true, definition: base() },
    ),
  ).rejects.toMatchObject({ status: 403 });
});
it('refuses a changed source and a cross-company or stale confirmation', async () => {
  await add('suggest');
  await dispatchMailWorkflows('support', 'ticket');
  const run = (await centre()).runs[0];
  await expect(
    workflowAction(
      { ...owner, organizationId: 'b' },
      { action: 'workflow_confirm', id: run.id, revision: run.revision },
    ),
  ).rejects.toMatchObject({ status: 402 });
  await expect(
    workflowAction(owner, {
      action: 'workflow_confirm',
      id: run.id,
      revision: run.revision + 1,
    }),
  ).rejects.toMatchObject({ status: 409 });
  db.exec("UPDATE support_tickets SET fingerprint='v2'");
  await expect(
    workflowAction(owner, {
      action: 'workflow_confirm',
      id: run.id,
      revision: run.revision,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await centre()).items).toHaveLength(0);
});
it('honours deferred actions and a subscription cancelled while they wait', async () => {
  const d = base();
  d.mode = 'automatic';
  d.actions[0].delayHours = 24;
  await saveWorkflow(owner, { name: 'Later', enabled: true, definition: d });
  await dispatchMailWorkflows('support', 'ticket');
  expect((await centre()).runs[0].state).toBe('waiting');
  db.exec(
    'UPDATE automation_workflow_runs SET created_at=created_at-90000,due_at=1',
  );
  db.exec("UPDATE automation_subscriptions SET status='canceled'");
  await runDueWorkflows();
  expect(
    db.prepare('SELECT count(*) n FROM automation_work_items').get()?.n,
  ).toBe(0);
  db.exec(
    "UPDATE automation_subscriptions SET status='active'; UPDATE automation_workflow_runs SET due_at=1",
  );
  await runDueWorkflows();
  expect((await centre()).items).toHaveLength(1);
});
it('undoes unused work and prevents undo after a collaborator has acted', async () => {
  await add();
  await dispatchMailWorkflows('support', 'ticket');
  let c = await centre();
  const run = c.runs[0];
  await workflowAction(owner, {
    action: 'workflow_undo',
    id: run.id,
    revision: run.revision,
  });
  expect((await centre()).items[0].state).toBe('dismissed');
  await add();
  await dispatchMailWorkflows('support', 'ticket');
  c = await centre();
  const open = c.items.find((i) => i.state === 'open')!;
  await workflowAction(owner, {
    action: 'work_item_update',
    id: open.id,
    revision: open.revision,
    state: 'done',
  });
  const next = c.runs.find((r) => r.state === 'completed')!;
  await expect(
    workflowAction(owner, {
      action: 'workflow_undo',
      id: next.id,
      revision: next.revision,
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it('makes a bounded Jev decision and follows only its matching branch', async () => {
  const d = base();
  d.mode = 'automatic';
  d.decision = {
    question: 'Le message demande-t-il une réparation ?',
    yes: 'Demande explicite de réparation',
    no: 'Autre demande',
  };
  d.actions[0].branch = 'yes';
  await saveWorkflow(owner, { name: 'Decision', enabled: true, definition: d });
  await dispatchMailWorkflows('support', 'ticket');
  expect(mocks.decide).toHaveBeenCalledTimes(1);
  expect((await centre()).items).toHaveLength(1);
});
it('rechecks entitlement after Jev and before any side effect', async () => {
  const d = base();
  d.mode = 'automatic';
  d.decision = { question: 'Réparation ?', yes: 'Oui', no: 'Non' };
  await saveWorkflow(owner, { name: 'Revoke', enabled: true, definition: d });
  mocks.decide.mockImplementationOnce(async () => {
    db.exec("UPDATE automation_subscriptions SET status='unpaid'");
    return { answers: { branch: { choice: 'yes', confidence: 0.99 } } };
  });
  await dispatchMailWorkflows('support', 'ticket');
  expect(
    db.prepare('SELECT count(*) n FROM automation_work_items').get()?.n,
  ).toBe(0);
});
it('does not expose HR workflow results or tasks to ordinary members', async () => {
  const d = base();
  d.mode = 'automatic';
  d.conditions.category = 'human_resources';
  await saveWorkflow(owner, { name: 'RH', enabled: true, definition: d });
  db.exec(
    `UPDATE support_tickets SET decision_json='{"category":"human_resources","priority":"normal","confidence":0.99}'`,
  );
  await dispatchMailWorkflows('support', 'ticket');
  expect((await centre()).runs[0].state).toBe('review');
  const view = await workflowCentre({
    ...owner,
    userId: 'member',
    role: 'member',
  });
  expect(view.runs).toHaveLength(0);
  expect(view.items).toHaveLength(0);
});
it('simulates literal templates without invoking Jev or sending a message', async () => {
  const result = await previewWorkflow(owner, {
    definition: base(),
    sample: {
      subject: 'Ma demande',
      sender: 'a@example.test',
      category: 'after_sales',
      priority: 'normal',
      attachments: [],
    },
  });
  expect(result.matched).toBe(true);
  expect(result.actions[0].title).toBe('SAV · Ma demande');
  expect(mocks.decide).not.toHaveBeenCalled();
  expect((await centre()).items).toHaveLength(0);
});
it('rejects arbitrary action code, invalid delay/threshold, foreign assignments and stale rule updates', async () => {
  const d = base();
  d.actions[0].type = 'execute_code' as 'task';
  expect(() => workflowDefinition(d)).toThrow();
  d.actions[0].type = 'task';
  d.actions[0].delayHours = -1;
  expect(() => workflowDefinition(d)).toThrow();
  d.actions[0].delayHours = 0;
  d.threshold = NaN;
  expect(() => workflowDefinition(d)).toThrow();
  d.threshold = 0.95;
  d.actions[0].assignedTo = 'foreign';
  await expect(
    saveWorkflow(owner, { name: 'Bad', enabled: true, definition: d }),
  ).rejects.toThrow();
  const created = await add();
  await expect(
    saveWorkflow(owner, {
      id: created.id,
      revision: 9,
      name: 'Bad',
      enabled: true,
      definition: base(),
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it('requires a human branch choice when the model cannot decide', async () => {
  const d = base();
  d.mode = 'automatic';
  d.decision = {
    question: 'Urgent ?',
    yes: 'Urgence explicite',
    no: 'Aucune urgence',
  };
  d.actions[0].branch = 'yes';
  mocks.decide.mockResolvedValueOnce({
    answers: { branch: { choice: 'uncertain', confidence: 0.4 } },
  });
  await saveWorkflow(owner, { name: 'Urgence', enabled: true, definition: d });
  await dispatchMailWorkflows('support', 'ticket');
  const r = (await centre()).runs[0];
  await expect(
    workflowAction(owner, {
      action: 'workflow_confirm',
      id: r.id,
      revision: r.revision,
    }),
  ).rejects.toThrow('Choisissez');
  await workflowAction(owner, {
    action: 'workflow_confirm',
    id: r.id,
    revision: r.revision,
    choice: 'yes',
  });
  expect((await centre()).items).toHaveLength(1);
  expect((await centre()).runs[0].result.approvedChoice).toBe('yes');
});
it('saves reply edits for the team and refuses stale and read-only edits', async () => {
  const d = structuredClone(
    WORKFLOW_TEMPLATES.find((t) => t.id === 'acknowledgement')!.definition,
  );
  d.mode = 'automatic';
  await saveWorkflow(owner, { name: 'Réponse', enabled: true, definition: d });
  await dispatchMailWorkflows('support', 'ticket');
  const item = (await centre()).items[0];
  await workflowAction(
    { ...owner, userId: 'member' },
    {
      action: 'work_item_update',
      id: item.id,
      revision: item.revision,
      body: 'Bonjour, voici notre réponse vérifiée.',
    },
  );
  expect((await centre()).items[0].body).toContain('réponse vérifiée');
  await expect(
    workflowAction(owner, {
      action: 'work_item_update',
      id: item.id,
      revision: item.revision,
      body: 'Ancienne version',
    }),
  ).rejects.toMatchObject({ status: 409 });
  db.exec(
    "UPDATE organization_members SET role='read_only' WHERE user_id='member'",
  );
  await expect(
    workflowAction(
      { ...owner, userId: 'member' },
      { action: 'work_item_update', id: item.id, revision: 2, state: 'done' },
    ),
  ).rejects.toMatchObject({ status: 403 });
});
it('recovers a crashed lease without duplicating the already-created item', async () => {
  await add();
  await dispatchMailWorkflows('support', 'ticket');
  db.exec(
    "UPDATE automation_workflow_runs SET state='running',lease='abandoned',lease_until=1,result='{}'",
  );
  await runDueWorkflows();
  const run = (await centre()).runs[0];
  expect(run.state).toBe('failed');
  await workflowAction(owner, {
    action: 'workflow_retry',
    id: run.id,
    revision: run.revision,
  });
  expect((await centre()).items).toHaveLength(1);
  expect((await centre()).runs[0].state).toBe('completed');
});
it('queues excess workflows and completes them through the scheduler', async () => {
  for (let i = 0; i < 5; i++) await add();
  await dispatchMailWorkflows('support', 'ticket');
  expect((await centre()).items).toHaveLength(2);
  await runDueWorkflows();
  expect((await centre()).items).toHaveLength(5);
});
it('records an exact factual summary and a completion notification without a model call', async () => {
  const d = structuredClone(
    WORKFLOW_TEMPLATES.find((t) => t.id === 'summary')!.definition,
  );
  d.mode = 'notify';
  await saveWorkflow(owner, { name: 'Résumé', enabled: true, definition: d });
  await dispatchMailWorkflows('support', 'ticket');
  const c = await centre();
  expect(c.items).toHaveLength(2);
  expect(c.items.find((i) => i.kind === 'summary')?.body).toContain(
    'La machine est en panne.',
  );
  expect(c.runs[0].result.summary?.excerpts[0].text).toBe(
    'La machine est en panne.',
  );
  expect(mocks.decide).not.toHaveBeenCalled();
});
it('advances only the authenticated company queue and recovers only its expired leases', async () => {
  for (let i = 0; i < 5; i++) await add();
  await dispatchMailWorkflows('support', 'ticket');
  expect((await centre()).items).toHaveLength(2);
  db.exec("UPDATE automation_workflow_runs SET state='running',lease='expired',lease_until=1 WHERE id=(SELECT id FROM automation_workflow_runs WHERE state='queued' LIMIT 1)");
  await runDueWorkflows('b');
  expect((await centre()).items).toHaveLength(2);
  expect((await centre()).runs.some(r => r.state === 'running')).toBe(true);
  await runDueWorkflows('a');
  expect((await centre()).items).toHaveLength(4);
  expect((await centre()).runs.some(r => r.state === 'failed')).toBe(true);
});
it('rechecks the human approver before a deferred action and honours the global observation mode', async () => {
  const d = base();
  d.actions[0].delayHours = 1;
  await saveWorkflow(owner, {
    name: 'Validation différée',
    enabled: true,
    definition: d,
  });
  await dispatchMailWorkflows('support', 'ticket');
  let run = (await centre()).runs[0];
  db.exec(
    "UPDATE organization_members SET role='admin' WHERE user_id='member'",
  );
  await workflowAction(
    { ...owner, userId: 'member' },
    { action: 'workflow_confirm', id: run.id, revision: run.revision },
  );
  db.exec(
    "UPDATE automation_workflow_runs SET created_at=created_at-7200,due_at=1; UPDATE organization_members SET revoked_at=1 WHERE user_id='member'",
  );
  await runDueWorkflows();
  expect((await centre()).items).toHaveLength(0);
  db.exec("UPDATE automation_settings SET mode='shadow'");
  await add();
  await dispatchMailWorkflows('support', 'ticket');
  expect((await centre()).runs.some((r) => r.state === 'observed')).toBe(true);
  expect((await centre()).items).toHaveLength(0);
});
it('counts only this company’s real work and excludes undone items from the daily brief', async () => {
  await add();
  await dispatchMailWorkflows('support', 'ticket');
  const c = await centre();
  expect(await workflowDaily(owner, 0, 2000000000)).toMatchObject({
    tasks: 1,
    drafts: 0,
    open: 1,
    review: 0,
  });
  expect(
    await workflowDaily({ ...owner, organizationId: 'b' }, 0, 2000000000),
  ).toMatchObject({ tasks: 0, open: 0 });
  await workflowAction(owner, {
    action: 'workflow_undo',
    id: c.runs[0].id,
    revision: c.runs[0].revision,
  });
  expect(await workflowDaily(owner, 0, 2000000000)).toMatchObject({
    tasks: 0,
    open: 0,
  });
});
