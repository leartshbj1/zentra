import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { Workspace, Connection, Ticket } from './types';
const state = vi.hoisted(() => ({
  db: null as unknown,
  prepare: vi.fn(),
  resolve: vi.fn(),
  submit: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({ database: () => state.db }));
vi.mock('./reply-transport', () => ({
  resolveReplyTarget: state.resolve,
  prepareReplyTransport: state.prepare,
}));
import { solicitationAction } from './solicitation-service';
let sql: DatabaseSync, w: Workspace, c: Connection, t: Ticket;
const target = {
  recipient: 'vendor@example.test',
  from: 'team@example.test',
  name: 'Atelier',
  sourceVersion: '1',
};
const body = {
  revision: 1,
  intent: 'stop',
  subject: 'Re: Offre',
  body: 'Merci de ne plus nous contacter.',
  target,
  fingerprint: 'fp',
  confirm: true,
};
const call = (
  action: string,
  raw: Record<string, unknown> = body,
  reauthorize = async () => w,
) =>
  solicitationAction({
    action,
    raw,
    workspace: w,
    connection: c,
    ticket: t,
    actor: 'member@example.test',
    secret: async () => 'fixture-not-secret',
    reauthorize,
  });
beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'),
    );
  state.db = {
    prepare(query: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...v: unknown[]) {
          args = v;
          return statement;
        },
        async first() {
          return sql.prepare(query).get(...(args as any[])) || null;
        },
        async all() {
          return { results: sql.prepare(query).all(...(args as any[])) };
        },
        async run() {
          return { meta: sql.prepare(query).run(...(args as any[])) };
        },
      };
      return statement;
    },
  };
  sql.exec(
    "INSERT INTO support_workspaces(id,owner_id,name,replies_enabled,created_at,updated_at) VALUES('w','owner','Atelier',1,1,1);INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at) VALUES('c','w','infomaniak','Mail','mail.infomaniak.com','team@example.test','encrypted','', '{}','{}',1)",
  );
  sql
    .prepare(
      "INSERT INTO support_tickets(id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,state,decision_json,created_at,updated_at) VALUES('t','w','c','10','Offre','Proposition',?,'fp','quiet',?,1,1)",
    )
    .run(
      JSON.stringify({
        externalId: '10',
        subject: 'Offre',
        body: 'Proposition',
        version: '1',
        mail: { sender: 'vendor@example.test', attachments: [] },
      }),
      JSON.stringify({
        category: 'solicitation',
        priority: 'low',
        confidence: 0.99,
      }),
    );
  w = sql.prepare('SELECT * FROM support_workspaces').get() as Workspace;
  c = sql.prepare('SELECT * FROM support_connections').get() as Connection;
  t = sql.prepare('SELECT * FROM support_tickets').get() as Ticket;
  vi.clearAllMocks();
  state.resolve.mockResolvedValue(target);
  state.submit.mockResolvedValue(undefined);
  state.prepare.mockResolvedValue({ submit: state.submit, close: state.close });
});
afterEach(() => sql.close());
it('empêche une ancienne préparation suspendue de reprendre après une nouvelle tentative', async () => {
  let release!: () => void, started!: () => void;
  const paused = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      started = r;
    });
  state.prepare.mockImplementationOnce(async () => {
    started();
    await paused;
    return { submit: state.submit, close: state.close };
  });
  const old = call('sendSolicitationReply').catch((e) => e);
  await ready;
  sql.exec('UPDATE support_solicitation_replies SET updated_at=1');
  expect(await call('sendSolicitationReply')).toHaveProperty(
    'reply.state',
    'accepted',
  );
  release();
  expect(await old).toBeInstanceOf(Error);
  expect(state.submit).toHaveBeenCalledTimes(1);
  expect(
    sql.prepare('SELECT state FROM support_solicitation_replies').get()?.state,
  ).toBe('accepted');
});
it('prépare sans envoyer ni écrire dans la messagerie', async () => {
  const r = await call('previewSolicitationReply');
  expect(r).toHaveProperty('draft.target.recipient', target.recipient);
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.submit).not.toHaveBeenCalled();
});
it('ignore et rétablit sans suppression ni appel externe', async () => {
  await call('ignoreSolicitation');
  expect(
    sql.prepare('SELECT state FROM support_solicitation_replies').get()?.state,
  ).toBe('ignored');
  await call('restoreSolicitation');
  expect(sql.prepare('SELECT COUNT(*) n FROM support_tickets').get()?.n).toBe(
    1,
  );
  expect(
    sql.prepare('SELECT COUNT(*) n FROM support_solicitation_replies').get()?.n,
  ).toBe(0);
  expect(state.resolve).not.toHaveBeenCalled();
});
it('envoie une seule fois malgré deux clics concurrents et une répétition', async () => {
  const results = await Promise.all([
    call('sendSolicitationReply'),
    call('sendSolicitationReply'),
  ]);
  expect(state.submit).toHaveBeenCalledTimes(1);
  expect(
    results.some((r) => 'reply' in r && r.reply?.state === 'accepted'),
  ).toBe(true);
  await call('sendSolicitationReply');
  expect(state.submit).toHaveBeenCalledTimes(1);
});
it('interdit une deuxième intention après un envoi accepté', async () => {
  await call('sendSolicitationReply');
  await expect(
    call('sendSolicitationReply', { ...body, intent: 'interested' }),
  ).rejects.toMatchObject({ status: 409 });
  expect(state.submit).toHaveBeenCalledTimes(1);
});
it('conserve l’incertitude et ne renvoie jamais après une panne réseau', async () => {
  state.submit.mockRejectedValue(new Error('timeout'));
  expect(await call('sendSolicitationReply')).toHaveProperty(
    'reply.state',
    'uncertain',
  );
  await call('sendSolicitationReply');
  expect(state.submit).toHaveBeenCalledTimes(1);
});
it('permet de reprendre un échec AVANT soumission', async () => {
  state.prepare.mockRejectedValueOnce(new Error('prepare'));
  await expect(call('sendSolicitationReply')).rejects.toThrow('Aucun envoi');
  expect(state.submit).not.toHaveBeenCalled();
  expect(await call('sendSolicitationReply')).toHaveProperty(
    'reply.state',
    'accepted',
  );
});
it.each([
  { confirm: false },
  { target: { ...target, recipient: 'attacker@example.test' } },
  { target: { ...target, from: 'other@example.test' } },
  { fingerprint: 'other' },
  { revision: 2 },
  { subject: 'Hello\r\nBcc: attacker@example.test' },
])('refuse les paramètres non confirmés ou falsifiés %j', async (change) => {
  await expect(
    call('sendSolicitationReply', { ...body, ...change }),
  ).rejects.toThrow();
  expect(state.submit).not.toHaveBeenCalled();
});
it('refuse si un administrateur désactive les réponses pendant la préparation', async () => {
  await expect(
    call('sendSolicitationReply', body, async () => ({
      ...w,
      replies_enabled: 0,
    })),
  ).rejects.toThrow('désactivé');
  expect(state.submit).not.toHaveBeenCalled();
});
it('refuse si les droits sont révoqués avant l’envoi', async () => {
  await expect(
    call('sendSolicitationReply', body, async () => {
      throw new Error('access revoked');
    }),
  ).rejects.toThrow();
  expect(state.submit).not.toHaveBeenCalled();
});
it('refuse une connexion remplacée en cours de préparation', async () => {
  state.prepare.mockImplementationOnce(async () => {
    sql.exec("UPDATE support_connections SET secret='new-secret'");
    return { submit: state.submit, close: state.close };
  });
  await expect(call('sendSolicitationReply')).rejects.toThrow(
    'connexion a changé',
  );
  expect(state.submit).not.toHaveBeenCalled();
});
it('refuse un ticket modifié en cours de préparation', async () => {
  state.prepare.mockImplementationOnce(async () => {
    sql.exec('UPDATE support_tickets SET revision=2');
    return { submit: state.submit, close: state.close };
  });
  await expect(call('sendSolicitationReply')).rejects.toThrow(
    'message ou la connexion',
  );
  expect(state.submit).not.toHaveBeenCalled();
});
it('refuse les actions pour une autre catégorie', async () => {
  t.decision_json = JSON.stringify({ category: 'billing' });
  await expect(call('ignoreSolicitation')).rejects.toThrow('réservées');
});
it('refuse les actions pendant l’analyse', async () => {
  t.state = 'processing';
  await expect(call('ignoreSolicitation')).rejects.toThrow('changé');
});
