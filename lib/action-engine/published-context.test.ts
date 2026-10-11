import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sha256Hex } from '@/lib/account-security';

const state = vi.hoisted(() => ({
  db: null as unknown as DatabaseSync,
  bytes: new Uint8Array([1, 2, 3]),
  admissionRevision: 'authority-v1',
  download: null as null | (() => void),
  head: {} as Record<string, unknown>,
  snapshot: {} as Record<string, unknown>,
  sourceId: 'source-one',
  codecFailure: false,
  sessionOrg: 'company-one',
}));
vi.mock('@/lib/runtime', () => ({
  database: () => ({
    prepare: (query: string) => ({
      bind: (...args: SQLInputValue[]) => ({
        first: async () => state.db.prepare(query).get(...args) ?? null,
      }),
    }),
  }),
}));
vi.mock('@/lib/account', () => ({
  requireDeviceSession: async () => ({
    organizationId: state.sessionOrg,
    organizationName: 'Synthetic company',
    subscriptionId: 'sub_synthetic',
    role: 'owner',
    sessionId: 'session-one',
    userId: 'user-one',
    installationId: 'installation-one',
    entitlementValidUntil: 2_000_000_000,
  }),
}));
vi.mock('./production-admission', () => ({
  createDeviceQuoteAuthority: async () => ({
    actor: { organizationId: 'company-one', userId: 'user-one' },
    installationId: 'installation-one',
    preflight: async () => ({
      organizationId: 'company-one',
      userId: 'user-one',
      revision: state.admissionRevision,
      automationActive: true,
      mayPrepareQuote: true,
    }),
  }),
}));
vi.mock('@/lib/company-collaboration', () => ({
  collaborationHead: async () => structuredClone(state.head),
  collaborationSnapshot: async () => structuredClone(state.snapshot),
  downloadCollaborationChunk: async () => {
    state.download?.();
    return new Uint8Array(state.bytes);
  },
}));
vi.mock('./published-resources', () => ({
  readPublishedResourcesPrefix: async (
    _bytes: Uint8Array,
    expected: Record<string, unknown>,
  ) => {
    if (state.codecFailure) throw new Error('synthetic invalid prefix');
    expect(expected).toEqual({
      organizationId: 'company-one',
      snapshotId: '52bbc724-29c0-4760-9a3b-6c4d529050bb',
      baseRevision: 7,
    });
    return {
      resourcesHash: 'a'.repeat(64),
      sidecarSha256: 'b'.repeat(64),
      resources: { company: { country: 'CH', currency: 'CHF' } },
      customers: [],
      articles: [],
    };
  },
}));
import { loadDeviceQuotePlanningContext } from './published-context';
import { connectorSenderName, quoteMailBody } from './source-envelope';

const request = () =>
  new Request('https://zentra.example.test/private-quote', {
    headers: { Authorization: 'Bearer synthetic' },
  });
function envelope(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'external-one',
    subject: 'Devis radiateurs',
    body: 'Veuillez préparer un devis pour trois radiateurs.',
    senderEmail: ' Customer@Example.test ',
    senderName: 'Synthetic Customer',
    version: '1',
    groupId: null,
    agentId: null,
    closed: false,
    ...overrides,
  };
}
function updateEnvelope(overrides: Record<string, unknown>) {
  state.db
    .prepare('UPDATE support_tickets SET source_json=?')
    .run(JSON.stringify(envelope(overrides)));
}
beforeEach(async () => {
  state.db = new DatabaseSync(':memory:');
  state.admissionRevision = 'authority-v1';
  state.download = null;
  state.codecFailure = false;
  state.sessionOrg = 'company-one';
  state.bytes = new Uint8Array([1, 2, 3]);
  state.db
    .exec(`CREATE TABLE support_tickets(id TEXT,workspace_id TEXT,connection_id TEXT,external_id TEXT,subject TEXT,body TEXT,source_json TEXT,fingerprint TEXT,revision INTEGER);
    CREATE TABLE support_connections(id TEXT,workspace_id TEXT,active INTEGER,created_at INTEGER,provider TEXT);
    CREATE TABLE support_gestion_links(workspace_id TEXT,organization_id TEXT,enabled INTEGER,connected_by TEXT,created_at INTEGER);
    CREATE TABLE support_workspaces(id TEXT,owner_id TEXT);
    CREATE TABLE organization_members(organization_id TEXT,user_id TEXT,revoked_at INTEGER,role TEXT,email TEXT);
    CREATE TABLE support_members(workspace_id TEXT,email TEXT,role TEXT);
    INSERT INTO support_connections VALUES('connection-one','support-one',1,1,'infomaniak');
    INSERT INTO support_gestion_links VALUES('support-one','company-one',1,'user-one',1);
    INSERT INTO support_workspaces VALUES('support-one','user-one');
    INSERT INTO organization_members VALUES('company-one','user-one',NULL,'owner','owner@example.test');`);
  const input = envelope();
  state.db
    .prepare('INSERT INTO support_tickets VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      'source-one',
      'support-one',
      'connection-one',
      'external-one',
      String(input.subject),
      String(input.body),
      JSON.stringify(input),
      'fingerprint-one',
      1,
    );
  const manifest = {
    format: 'zentra-cloud-backup',
    version: 1,
    app_version: '1.90.15',
    sha256: 'c'.repeat(64),
    size_bytes: 3,
    chunks: [{ sha256: await sha256Hex(state.bytes), size_bytes: 3 }],
  };
  state.head = {
    organizationId: 'company-one',
    enabled: true,
    revision: 8,
    snapshotId: '52bbc724-29c0-4760-9a3b-6c4d529050bb',
    manifest,
  };
  state.snapshot = {
    id: state.head.snapshotId,
    organization_id: 'company-one',
    revision: 8,
    base_revision: 7,
    manifest,
  };
});
afterEach(() => state.db.close());

it('binds a real persisted delegated source to a published archive and detaches the context', async () => {
  const result = await loadDeviceQuotePlanningContext(request(), 'source-one');
  expect(result.context.source.senderEmail).toBe('customer@example.test');
  expect(result.context.source.senderName).toBe('Synthetic Customer');
  expect(result.context.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(result.context.source.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(result.publication.revision).toBe(8);
  expect(result.publication.resourcesHash).toBe('a'.repeat(64));
  expect(Object.isFrozen(result.context.source)).toBe(true);
});
for (const mutation of [
  'UPDATE support_gestion_links SET enabled=0',
  "UPDATE support_gestion_links SET organization_id='another-company'",
  'UPDATE support_connections SET active=0',
  "UPDATE support_connections SET workspace_id='another-support'",
  'UPDATE organization_members SET revoked_at=1',
  "UPDATE organization_members SET role='member'",
  "UPDATE support_workspaces SET owner_id='another-owner'",
])
  it(`refuses missing/current invalid delegation: ${mutation}`, async () => {
    state.db.exec(mutation);
    await expect(
      loadDeviceQuotePlanningContext(request(), 'source-one'),
    ).rejects.toMatchObject({ code: 'invalid_context' });
  });
for (const mutation of [
  "UPDATE support_tickets SET body='Changed actual request'",
  'UPDATE support_tickets SET revision=revision+1',
  'UPDATE support_gestion_links SET created_at=2',
  'UPDATE support_connections SET created_at=2',
  'UPDATE support_gestion_links SET enabled=0',
])
  it(`rejects a source/delegation change during download: ${mutation}`, async () => {
    state.download = () => state.db.exec(mutation);
    await expect(
      loadDeviceQuotePlanningContext(request(), 'source-one'),
    ).rejects.toBeDefined();
  });
for (const input of [
  { closed: true },
  { incomplete: true },
  { senderIdentityAmbiguous: true },
  { subject: 'Other subject' },
  { externalId: 'wrong-ticket' },
  { mail: { bodyIncomplete: true } },
])
  it(`refuses incomplete or mismatched connector evidence ${JSON.stringify(input)}`, async () => {
    updateEnvelope(input);
    await expect(
      loadDeviceQuotePlanningContext(request(), 'source-one'),
    ).rejects.toMatchObject({ code: 'invalid_context' });
  });
it('does not invent the new customer name from the message body', async () => {
  const input = envelope({ senderName: undefined });
  state.db
    .prepare('UPDATE support_tickets SET source_json=?')
    .run(JSON.stringify(input));
  const result = await loadDeviceQuotePlanningContext(request(), 'source-one');
  expect(result.context.source.senderName).toBe('');
});
it('refuses an unpublished snapshot even if readable by its uploader', async () => {
  state.snapshot.revision = null;
  await expect(
    loadDeviceQuotePlanningContext(request(), 'source-one'),
  ).rejects.toMatchObject({ code: 'stale_plan' });
});
it('refuses a foreign archive identity', async () => {
  state.snapshot.organization_id = 'foreign-company';
  await expect(
    loadDeviceQuotePlanningContext(request(), 'source-one'),
  ).rejects.toMatchObject({ code: 'stale_plan' });
});
it('refuses a changed head during the bounded download', async () => {
  state.download = () => {
    state.head.revision = 9;
  };
  await expect(
    loadDeviceQuotePlanningContext(request(), 'source-one'),
  ).rejects.toMatchObject({ code: 'stale_plan' });
});
it('refuses changed admission during the download', async () => {
  state.download = () => {
    state.admissionRevision = 'authority-v2';
  };
  await expect(
    loadDeviceQuotePlanningContext(request(), 'source-one'),
  ).rejects.toMatchObject({ code: 'stale_plan' });
});
it('refuses session/authority identities from different companies', async () => {
  state.sessionOrg = 'foreign-company';
  await expect(
    loadDeviceQuotePlanningContext(request(), 'source-one'),
  ).rejects.toMatchObject({ code: 'forbidden' });
});
it('verifies downloaded chunk bytes independently before parsing resources', async () => {
  state.download = () => {
    state.bytes = new Uint8Array([9, 9, 9]);
  };
  await expect(
    loadDeviceQuotePlanningContext(request(), 'source-one'),
  ).rejects.toMatchObject({ code: 'invalid_context' });
});
it('has no fallback catalogue when the positional projection is absent/corrupt', async () => {
  state.codecFailure = true;
  await expect(
    loadDeviceQuotePlanningContext(request(), 'source-one'),
  ).rejects.toThrow('synthetic invalid prefix');
});
it('only accepts a bounded literal connector display name', () => {
  expect(connectorSenderName('Équipe 🚀')).toBe('Équipe 🚀');
  for (const raw of [null, {}, '', ' ', 'x'.repeat(201), 'Hello\nInjected'])
    expect(connectorSenderName(raw)).toBeUndefined();
});
it('strips the known connector metadata only after envelope address corroboration', () => {
  const body = 'Please prepare a quote for 3 radiators.';
  expect(
    quoteMailBody(
      `De : Client <customer@example.test>\n\n${body}`,
      'customer@example.test',
      'infomaniak',
      true,
    ),
  ).toBe(body);
  expect(
    quoteMailBody(
      `De : customer@example.test\n\n${body}`,
      'customer@example.test',
      'imap',
      true,
    ),
  ).toBe(body);
  for (const [email, provider, mail] of [
    ['other@example.test', 'imap', true],
    ['customer@example.test', 'zendesk', true],
    ['customer@example.test', 'imap', false],
  ] as const) {
    const raw = `De : customer@example.test\n\n${body}`;
    expect(quoteMailBody(raw, email, provider, mail)).toBe(raw);
  }
});
it('loads the actual prefixed IMAP body without turning the sender metadata into a requested article', async () => {
  const body =
    'De : customer@example.test\n\nVeuillez préparer un devis pour trois radiateurs.';
  const raw = envelope({
    body,
    mail: { sender: 'customer@example.test', attachments: [] },
  });
  state.db
    .prepare('UPDATE support_tickets SET body=?,source_json=?')
    .run(body, JSON.stringify(raw));
  state.db.exec("UPDATE support_connections SET provider='imap'");
  const result = await loadDeviceQuotePlanningContext(request(), 'source-one');
  expect(result.context.source.body).toBe(
    'Veuillez préparer un devis pour trois radiateurs.',
  );
});
