import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Connection, SourceTicket, Ticket } from '@/lib/support/types';

const state = vi.hoisted(() => ({
  db: null as unknown as DatabaseSync,
  beforeUpdate: null as null | (() => void),
}));
vi.mock('@/lib/runtime', () => ({
  runtimeValue: () => '',
  database: () => ({
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...bindings: SQLInputValue[]) {
          values = bindings;
          return statement;
        },
        async first() {
          return state.db.prepare(query).get(...values) ?? null;
        },
        async run() {
          if (
            query.startsWith('UPDATE support_tickets') &&
            state.beforeUpdate
          ) {
            const before = state.beforeUpdate;
            state.beforeUpdate = null;
            before();
          }
          return {
            success: true,
            meta: state.db.prepare(query).run(...values),
          };
        },
      };
      return statement;
    },
  }),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => null }));
vi.mock('@/lib/account', () => ({
  membershipsForUser: async () => [],
  enforceAccountRateLimit: async () => {},
  normalizedEmail: (value: string) => value.toLowerCase(),
}));
vi.mock('@/lib/site-url', () => ({
  publicSiteUrl: () => 'https://zentra.example.test',
}));
import { ingest } from '@/lib/support/service';
import { readProviderTicket } from '@/lib/support/connectors';

const connection: Connection = {
  id: 'connection-one',
  workspace_id: 'workspace-one',
  provider: 'zendesk',
  label: 'Synthetic connector',
  domain: 'synthetic.zendesk.com',
  login: '',
  secret: '',
  hook_hash: '',
  directory_json: '{}',
  routes_json: '{}',
  active: 1,
  created_at: 1,
};
function source(overrides: Partial<SourceTicket> = {}): SourceTicket {
  return {
    externalId: 'external-one',
    subject: 'Devis radiateurs',
    body: 'Merci de préparer un devis pour trois radiateurs.',
    senderEmail: 'client@example.test',
    version: 'provider-v1',
    groupId: null,
    agentId: null,
    closed: false,
    ...overrides,
  };
}
function persisted(id: string) {
  return state.db
    .prepare('SELECT * FROM support_tickets WHERE id=?')
    .get(id) as Ticket;
}
function alreadyRouted(id: string) {
  state.db
    .prepare(`UPDATE support_tickets SET state='routed',decision_json='{"category":"quote"}',
    automatic=1,routed_at=123,attempts=1 WHERE id=?`)
    .run(id);
}
beforeEach(() => {
  state.db = new DatabaseSync(':memory:');
  state.beforeUpdate = null;
  state.db.exec(`CREATE TABLE support_tickets(
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    external_id TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
    source_json TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'pending', decision_json TEXT, error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER,
    automatic INTEGER NOT NULL DEFAULT 0, corrected INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, routed_at INTEGER,
    UNIQUE(connection_id,external_id));`);
});
afterEach(() => {
  state.db.close();
  vi.restoreAllMocks();
});

it('persists a newly available connector name on the same ticket and refreshes its source once', async () => {
  const first = await ingest(connection, source());
  alreadyRouted(first.id);
  const named = source({ senderName: 'Camille Martin' });
  const updated = await ingest(connection, named);
  expect(updated.id).toBe(first.id);
  expect(updated.revision).toBe(2);
  expect(JSON.parse(updated.source_json).senderName).toBe('Camille Martin');
  expect(updated.fingerprint).not.toBe(first.fingerprint);
  expect(updated.state).toBe('pending');
  expect(updated.decision_json).toBeNull();
  alreadyRouted(first.id);
  const repeated = await ingest(connection, named);
  expect(repeated.revision).toBe(2);
  expect(repeated.state).toBe('routed');
  expect(repeated.attempts).toBe(1);
  expect(repeated.decision_json).toBe('{"category":"quote"}');
});

it.each([
  { senderName: 'Autre interlocuteur' },
  { senderEmail: 'different@example.test' },
  { closed: true },
  { senderIdentityAmbiguous: true },
])(
  'refreshes changed identity/closed evidence with unchanged text: %j',
  async (change) => {
    const input = source({ senderName: 'Camille Martin' });
    const first = await ingest(connection, input);
    const updated = await ingest(connection, { ...input, ...change });
    expect(updated.revision).toBe(2);
    expect(updated.body).toBe(first.body);
    expect(updated.fingerprint).not.toBe(first.fingerprint);
    expect(JSON.parse(updated.source_json)).toMatchObject(change);
  },
);

it('normalizes sender addresses but never adds provider update versions to analysis identity', async () => {
  const first = await ingest(
    connection,
    source({ senderName: 'Camille Martin' }),
  );
  alreadyRouted(first.id);
  const repeated = await ingest(
    connection,
    source({
      senderEmail: ' CLIENT@EXAMPLE.TEST ',
      senderName: 'Camille Martin',
      version: 'provider-version-changed-by-routing',
    }),
  );
  expect(repeated.revision).toBe(1);
  expect(repeated.state).toBe('routed');
  expect(repeated.attempts).toBe(1);
  expect(repeated.fingerprint).toBe(first.fingerprint);
  expect(repeated.source_json).toBe(first.source_json);
});

it('uses the bounded literal name, never truncating an invalid display name into a different identity', async () => {
  const first = await ingest(
    connection,
    source({ senderName: 'x'.repeat(201) }),
  );
  alreadyRouted(first.id);
  const repeated = await ingest(
    connection,
    source({ senderName: 'x'.repeat(202) }),
  );
  expect(repeated.fingerprint).toBe(first.fingerprint);
  expect(repeated.revision).toBe(1);
  expect(repeated.state).toBe('routed');
  const valid = await ingest(
    connection,
    source({ senderName: 'Camille Martin' }),
  );
  expect(valid.revision).toBe(2);
  expect(JSON.parse(valid.source_json).senderName).toBe('Camille Martin');
});

it('preserves the existing active lease refusal and never overwrites its source', async () => {
  const first = await ingest(connection, source());
  state.db
    .prepare('UPDATE support_tickets SET lease=?,lease_until=? WHERE id=?')
    .run('other-worker', Math.floor(Date.now() / 1000) + 60, first.id);
  await expect(
    ingest(connection, source({ senderName: 'Camille Martin' })),
  ).rejects.toMatchObject({ status: 503 });
  expect(persisted(first.id).source_json).toBe(first.source_json);
  expect(persisted(first.id).revision).toBe(1);
});

it('preserves the revision CAS when another worker changes identity between read and update', async () => {
  const first = await ingest(connection, source());
  const winning = source({ senderName: 'Concurrent identity' });
  state.beforeUpdate = () => {
    state.db
      .prepare(
        'UPDATE support_tickets SET source_json=?,fingerprint=?,revision=revision+1 WHERE id=?',
      )
      .run(JSON.stringify(winning), 'concurrent-fingerprint', first.id);
  };
  const result = await ingest(
    connection,
    source({ senderName: 'Losing identity' }),
  );
  expect(result.revision).toBe(2);
  expect(result.fingerprint).toBe('concurrent-fingerprint');
  expect(JSON.parse(result.source_json).senderName).toBe('Concurrent identity');
});

it('retains distinct connector/workspace identities for the same external ticket ID', async () => {
  const first = await ingest(connection, source({ senderName: 'Company One' }));
  const other = await ingest(
    { ...connection, id: 'connection-two', workspace_id: 'workspace-two' },
    source({ senderName: 'Company Two' }),
  );
  expect(other.id).not.toBe(first.id);
  expect(other.workspace_id).toBe('workspace-two');
  await ingest(connection, source({ senderName: 'Company One Changed' }));
  expect(JSON.parse(persisted(other.id).source_json).senderName).toBe(
    'Company Two',
  );
  expect(persisted(other.id).revision).toBe(1);
});

function gorgiasMessage(
  address: unknown,
  channel = 'email',
  fromAgent = false,
) {
  return {
    from_agent: fromAgent,
    channel,
    body_text: `Message ${typeof address === 'string' ? address : 'unavailable'}`,
    source: { from: { address, name: 'Connector profile name' } },
  };
}
async function gorgias(messages: unknown[]) {
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    (typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.href
        : url.url
    ).includes('/api/messages?')
      ? Response.json({ data: messages, meta: {} })
      : Response.json({ id: 5, subject: 'Quote request', status: 'open' }),
  );
  const result = await readProviderTicket(
    { ...connection, provider: 'gorgias', domain: 'demo.gorgias.com' },
    'synthetic-secret',
    '5',
    fetcher,
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  return result;
}
it('corroborates all Gorgias incoming message identities while preserving the complete triage body', async () => {
  const result = await gorgias([
    gorgiasMessage(' CLIENT@EXAMPLE.TEST '),
    gorgiasMessage('client@example.test'),
    gorgiasMessage('staff@example.test', 'chat', true),
  ]);
  expect(result.senderIdentityAmbiguous).toBeUndefined();
  expect(result.senderName).toBe('Connector profile name');
  expect(result.body).toBe(
    'Message client@example.test\n\nMessage  CLIENT@EXAMPLE.TEST',
  );
});
it.each([
  [
    gorgiasMessage('client@example.test'),
    gorgiasMessage('another@example.test'),
  ],
  [
    gorgiasMessage('client@example.test'),
    gorgiasMessage('client@example.test', 'chat'),
  ],
  [gorgiasMessage('client@example.test'), gorgiasMessage(undefined)],
  [gorgiasMessage('invalid-address')],
  [gorgiasMessage('client@example.test', 'chat')],
])(
  'marks a Gorgias mixed/unverifiable requester without discarding its conversation: %j',
  async (...messages) => {
    const result = await gorgias(messages);
    expect(result.senderIdentityAmbiguous).toBe(true);
    expect(result.body).toContain('Message');
  },
);

async function freshdesk(
  comments: unknown[],
  requesterEmail: string = 'client@example.test',
) {
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    (typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.href
        : url.url
    ).includes('/conversations?')
      ? Response.json(comments)
      : Response.json({
          id: 5,
          subject: 'Quote request',
          status: 2,
          description_text: 'Initial request',
          requester: { email: requesterEmail, name: 'Requester profile' },
        }),
  );
  const result = await readProviderTicket(
    { ...connection, provider: 'freshdesk', domain: 'demo.freshdesk.com' },
    'synthetic-secret',
    '5',
    fetcher,
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  return result;
}
it('accepts a single Freshdesk requester and ignores private/outgoing identities for this check', async () => {
  const result = await freshdesk([
    {
      incoming: true,
      private: false,
      from_email: ' CLIENT@EXAMPLE.TEST ',
      body_text: 'Customer reply',
    },
    {
      incoming: false,
      from_email: 'staff@example.test',
      body_text: 'Staff reply',
    },
    {
      incoming: true,
      private: true,
      from_email: 'private@example.test',
      body_text: 'Private note',
    },
  ]);
  expect(result.senderIdentityAmbiguous).toBeUndefined();
  expect(result.senderName).toBe('Requester profile');
  expect(result.body).toBe('Initial request\n\nCustomer reply');
});
it.each(['another@example.test', '', undefined, 'invalid-address'])(
  'marks a Freshdesk incoming identity that differs from or cannot corroborate the requester: %s',
  async (from_email) => {
    const result = await freshdesk([
      {
        incoming: true,
        private: false,
        from_email,
        body_text: 'Other incoming message',
      },
    ]);
    expect(result.senderIdentityAmbiguous).toBe(true);
    expect(result.body).toBe('Initial request\n\nOther incoming message');
  },
);
