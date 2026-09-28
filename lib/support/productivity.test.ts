import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  db: null as unknown,
  actor: vi.fn(),
  entitlement: vi.fn(),
  seat: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => mocks.db,
  runtimeValue: () => '',
}));
vi.mock('@/lib/automation/access', () => ({ automationActor: mocks.actor }));
vi.mock('@/lib/automation/entitlement', () => ({
  requireAutomationEntitlement: async (a: unknown) => a,
  automationEntitlement: mocks.entitlement,
}));
vi.mock('@/lib/team-seats', () => ({ requireMemberSeat: mocks.seat }));
import {
  senderAddress,
  policyInput,
  applySenderPolicies,
  saveSenderPolicy,
  deleteSenderPolicy,
  senderPolicies,
  protectTicket,
} from './sender-policies';
import {
  createFollowup,
  followups,
  completeFollowup,
  followupInput,
} from './followups';
import { productivityState } from './productivity';
import { solicitationBatch } from './batch';
import {
  SupportError,
  type Decision,
  type SourceTicket,
  type Ticket,
  type Workspace,
} from './types';
import { automationDay } from '@/lib/automation/activity';
let db: DatabaseSync, ticket: Ticket;
const source: SourceTicket = {
  externalId: '1',
  subject: 'Offre équipe',
  body: 'Une offre',
  mail: { sender: 'Agence <sales@example.test>', attachments: [] },
  version: '1',
  groupId: null,
  agentId: null,
  closed: false,
};
const decision = {
  category: 'solicitation',
  priority: 'low',
  confidence: 0.99,
  categoryConfidence: 0.99,
  priorityConfidence: 0.99,
  probabilities: {},
  model: 'model',
  inputTokens: 1,
  destination: null,
} as Decision;
const request = new Request('https://zentraapp.ch/api/support', {
    method: 'POST',
  }),
  actor = { email: 'owner@example.test', userId: 'owner' };
const followup = () => ({
  revision: 1,
  title: 'Comparer la proposition',
  assignedTo: 'owner@example.test',
  dueAt: Math.floor(Date.now() / 1000) + 86400,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.entitlement.mockResolvedValue(true);
  mocks.actor.mockResolvedValue({
    organizationId: 'a',
    userId: 'owner',
    role: 'owner',
    founder: false,
  });
  mocks.seat.mockResolvedValue(undefined);
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
        const results = [];
        for (const s of statements) results.push(await s.run());
        db.exec('COMMIT');
        return results;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  db.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at) VALUES('s','cus','price','active',2000000000,2000000000,1,1);
    INSERT INTO organizations VALUES('a','Entreprise A','s','owner',1,1);
    INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('m','a','owner','owner@example.test','owner',1);
    INSERT INTO founder_account_identities VALUES('owner','owner@example.test','Owner','supabase',1);
    INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('w','owner','Atelier',1,1),('other','outsider','Other',1,1);
    INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at) VALUES('c','w','infomaniak','Mail','','','','','{}','{}',1);
    INSERT INTO support_gestion_links VALUES('w','a',1,1,'owner',1);`);
  db.prepare(
    "INSERT INTO support_tickets(id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,state,decision_json,created_at,updated_at) VALUES('t','w','c','1','Offre équipe','Une offre',?,'fp','quiet',?,1,1)",
  ).run(JSON.stringify(source), JSON.stringify(decision));
  ticket = db
    .prepare('SELECT * FROM support_tickets WHERE id=?')
    .get('t') as Ticket;
});
afterEach(() => db.close());
it('takes an address only from the connector envelope, not the body', () => {
  expect(senderAddress(source)).toBe('sales@example.test');
  expect(
    senderAddress({
      ...source,
      mail: undefined,
      body: 'From: sales@example.test',
    }),
  ).toBe('');
  expect(
    senderAddress({ ...source, senderEmail: 'a@example.test,b@example.test' }),
  ).toBe('');
  expect(() =>
    policyInput({ sender: '*.example.test', category: 'trusted' }),
  ).toThrow();
});
it('protects trusted senders without treating their content as safe or automatically routing', () => {
  const r = applySenderPolicies(
    decision,
    source,
    [
      {
        id: 'p',
        sender: 'sales@example.test',
        subject: '',
        category: 'trusted',
        enabled: 1,
        revision: 1,
      },
    ],
    {},
  );
  expect(r).toMatchObject({
    category: 'other',
    priority: 'normal',
    confidence: 0,
    destination: null,
  });
});
it('never lets a muted category override an urgent request or trusted sender', () => {
  const rule = {
    id: 'p',
    sender: 'sales@example.test',
    subject: '',
    category: 'solicitation',
    enabled: 1,
    revision: 1,
  };
  expect(
    applySenderPolicies(
      { ...decision, category: 'bug', priority: 'urgent' },
      source,
      [rule],
      {},
    ),
  ).toMatchObject({ category: 'bug', priority: 'urgent', confidence: 0 });
  expect(
    applySenderPolicies(
      { ...decision, category: 'billing', priority: 'normal' },
      source,
      [rule, { ...rule, id: 'trusted', category: 'trusted' }],
      {},
    ).category,
  ).toBe('billing');
});
it('uses explicit subject rules and asks for review on conflicts', () => {
  const rule = {
    id: 'p',
    sender: 'sales@example.test',
    subject: 'offre',
    category: 'quote',
    enabled: 1,
    revision: 1,
  };
  expect(
    applySenderPolicies(decision, source, [rule], {
      quote: { teamId: 'finance' },
    }),
  ).toMatchObject({
    category: 'quote',
    destination: { teamId: 'finance' },
    policyVersion: 'company:p:1',
  });
  expect(
    applySenderPolicies(
      decision,
      source,
      [rule, { ...rule, id: 'b', category: 'billing' }],
      {},
    ),
  ).toMatchObject({ confidence: 0, destination: null });
  expect(
    applySenderPolicies(
      decision,
      { ...source, subject: 'Incident' },
      [rule],
      {},
    ),
  ).toEqual(decision);
});
it('isolates company rules, prevents stale updates and supports disabling and deleting', async () => {
  await saveSenderPolicy('w', actor.email, {
    sender: 'sales@example.test',
    category: 'trusted',
  });
  const [p] = await senderPolicies('w');
  expect(await senderPolicies('other')).toEqual([]);
  await expect(
    deleteSenderPolicy('other', { id: p.id, revision: 1 }),
  ).rejects.toThrow();
  await saveSenderPolicy('w', actor.email, { ...p, enabled: false });
  await expect(
    saveSenderPolicy('w', actor.email, { ...p, enabled: true }),
  ).rejects.toThrow(/changé/);
  expect((await senderPolicies('w'))[0].enabled).toBe(0);
  await deleteSenderPolicy('w', { id: p.id, revision: 2 });
  expect(await senderPolicies('w')).toEqual([]);
});
it('corrects a false solicitation locally and rejects a stale correction', async () => {
  await protectTicket(ticket, 1);
  expect(
    db.prepare('SELECT state,corrected FROM support_tickets').get(),
  ).toMatchObject({ state: 'review', corrected: 1 });
  await expect(protectTicket(ticket, 1)).rejects.toThrow(/changé/);
});
it('creates a follow-up once and shows the same task state from Gestion', async () => {
  const raw = { ...followup(), gestion: true };
  await createFollowup(request, ticket, actor, raw);
  await createFollowup(request, ticket, actor, raw);
  expect(
    db.prepare('SELECT COUNT(*) n FROM automation_work_items').get()?.n,
  ).toBe(1);
  const task = db.prepare('SELECT * FROM automation_work_items').get()!;
  expect(task).toMatchObject({
    kind: 'task',
    organization_id: 'a',
    assigned_to: 'owner',
    due_at: raw.dueAt,
  });
  db.prepare("UPDATE automation_work_items SET state='done' WHERE id=?").run(
    task.id,
  );
  expect((await followups('w'))[0].state).toBe('done');
  expect(await followups('other')).toEqual([]);
});
it('supports a Support-only reminder without requiring a Gestion subscription', async () => {
  db.exec('DELETE FROM support_gestion_links');
  await createFollowup(request, ticket, actor, followup());
  const [f] = await followups('w');
  await completeFollowup(request, 'w', { id: f.id, revision: 1 });
  expect((await followups('w'))[0].state).toBe('done');
  expect(
    db.prepare('SELECT COUNT(*) n FROM automation_work_items').get()?.n,
  ).toBe(0);
});
it('rejects other-company assignees, stale messages and past reminder dates', async () => {
  await expect(
    createFollowup(request, ticket, actor, {
      ...followup(),
      assignedTo: 'outside@example.test',
    }),
  ).rejects.toThrow(/membre/);
  await expect(
    createFollowup(request, ticket, actor, { ...followup(), revision: 2 }),
  ).rejects.toThrow(/changé/);
  expect(() => followupInput({ ...followup(), dueAt: 1 })).toThrow(/date/);
  expect(db.prepare('SELECT COUNT(*) n FROM support_followups').get()?.n).toBe(
    0,
  );
});
it('does not create a Gestion task for a revoked or over-quota member', async () => {
  mocks.seat.mockRejectedValue(new Error('No seat'));
  await expect(
    createFollowup(request, ticket, actor, { ...followup(), gestion: true }),
  ).rejects.toThrow('No seat');
  expect(db.prepare('SELECT COUNT(*) n FROM support_followups').get()?.n).toBe(
    0,
  );
});
it('does not create a task when the message changes during authorization', async () => {
  mocks.actor.mockImplementationOnce(async () => {
    db.exec('UPDATE support_tickets SET revision=2');
    return { organizationId: 'a', userId: 'owner', role: 'owner' };
  });
  await expect(
    createFollowup(request, ticket, actor, { ...followup(), gestion: true }),
  ).rejects.toThrow(/changé/);
  expect(
    db.prepare('SELECT COUNT(*) n FROM automation_work_items').get()?.n,
  ).toBe(0);
});
it('counts unique automatic decisions today and distinguishes receipt from connection verification', async () => {
  const day = automationDay();
  db.prepare(
    "INSERT INTO support_events VALUES('e1','w','t','quiet','Classé','Zentra Support',?),('e2','w','t','quiet','Classé','Zentra Support',?),('old','w','t','quiet','Classé','Zentra Support',?)",
  ).run(day.from + 10, day.from + 20, day.from - 1);
  const state = await productivityState('w', 'owner', true);
  expect(state.daily).toMatchObject({ sorted: 1, quiet: 1 });
  expect(state.health[0]).toMatchObject({ lastReceivedAt: 1, checkedAt: null });
  expect(state.canCreateGestion).toBe(true);
  expect(
    (await productivityState('w', 'outside', false)).daily.gestion,
  ).toBeNull();
});
it('does not expose Gestion figures when its entitlement has expired', async () => {
  mocks.entitlement.mockResolvedValue(false);
  expect(
    (await productivityState('w', 'owner', false)).daily.gestion,
  ).toBeNull();
});
it('handles mixed batch outcomes without claiming all messages succeeded', async () => {
  const invoke = vi
    .fn()
    .mockResolvedValueOnce({ disposition: 'ignored' })
    .mockRejectedValueOnce(new SupportError('Ce message a changé.', 409));
  const result = await solicitationBatch(
    { items: [{ ticketId: 'a' }, { ticketId: 'b' }] },
    'ignoreSolicitationBatch',
    invoke,
    async () => ({}) as Workspace,
  );
  expect(result.results[0]).toHaveProperty('result.disposition', 'ignored');
  expect(result.results[1]).toHaveProperty('error', 'Ce message a changé.');
});
it('requires explicit batch send confirmation, limits batch size and avoids duplicate recipients', async () => {
  const invoke = vi.fn().mockResolvedValue({ reply: { state: 'accepted' } }),
    auth = async () => ({}) as Workspace;
  await expect(
    solicitationBatch(
      { items: [{ ticketId: 'a' }] },
      'sendSolicitationBatch',
      invoke,
      auth,
    ),
  ).rejects.toThrow(/confirmez/);
  await expect(
    solicitationBatch(
      {
        items: Array.from({ length: 21 }, (_, i) => ({ ticketId: String(i) })),
      },
      'ignoreSolicitationBatch',
      invoke,
      auth,
    ),
  ).rejects.toThrow(/20/);
  const r = await solicitationBatch(
    {
      confirm: true,
      items: [
        { ticketId: 'a', target: { recipient: 'same@example.test' } },
        { ticketId: 'b', target: { recipient: 'Same@example.test' } },
      ],
    },
    'sendSolicitationBatch',
    invoke,
    auth,
  );
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(r.results[1]).toHaveProperty('error');
});
it('reauthorizes every batch item and stops acting after access is revoked', async () => {
  const invoke = vi.fn().mockResolvedValue({ saved: true }),
    auth = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValue(new SupportError('Accès retiré.', 403));
  const r = await solicitationBatch(
    { items: [{ ticketId: 'a' }, { ticketId: 'b' }] },
    'ignoreSolicitationBatch',
    invoke,
    auth,
  );
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(r.results[1]).toHaveProperty('error', 'Accès retiré.');
});
