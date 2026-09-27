import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const mock = vi.hoisted(() => ({
  db: null as unknown,
  key: '',
  user: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => mock.db,
  runtimeValue: (key: string) =>
    key === 'SUPPORT_ENCRYPTION_KEY' ? mock.key : '',
  stripeConfiguration: () => ({
    siteUrl: 'https://zentraapp.ch',
    siteOriginAliases: '',
  }),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: mock.user }));
import {
  connectSharedMail,
  disconnectSharedMail,
  sendSharedMail,
  sharedMailState,
  sharedMailReceipt,
  type MailActor,
} from './service';
import { AccountPublicError, hashOpaqueToken } from '@/lib/account-security';
import { InfomaniakSender } from './provider';
import { GET, POST } from '@/app/api/company-mail/route';
let db: DatabaseSync;
const owner: MailActor = {
  organizationId: 'org-a',
  userId: 'owner',
  role: 'owner',
};
const token = 'synthetic-only-provider-key';
const authorize = async () => owner;
const requestId = 'aaaaaaaa-1111-4111-8111-111111111111';
const documentId = 'dddddddd-1111-4111-8111-111111111111';
const logoDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB3sAAAAASUVORK5CYII=';
const connectionIds = new Map<string, string>();
const input = (org = 'org-a') => ({
  action: 'send',
  organizationId: org,
  connectionId: String(
    db
      .prepare(
        'SELECT connection_id FROM company_mail_connections WHERE organization_id=?',
      )
      .get(org)?.connection_id ??
      connectionIds.get(org) ??
      'bbbbbbbb-1111-4111-8111-111111111111',
  ),
  requestId,
  confirmed: true,
  entity: 'invoices',
  documentId,
  sourceRevision: 'a'.repeat(64),
  recipient: 'client@example.ch',
  subject: 'Facture 42',
  body: 'Bonjour <script>unsafe</script>\nMerci.',
  attachmentName: 'Facture-42.pdf',
  pdfBase64: Buffer.from('%PDF-1.7\nSynthetic fixture\n%%EOF').toString(
    'base64',
  ),
});
const calls: Array<{ url: string; init: RequestInit }> = [];
let sendMode: 'ok' | 'timeout' | 'reject' | 'malformed' | 'server-error' = 'ok';
let beforeSubmit: (() => Promise<void>) | undefined;
let afterDraft: (() => Promise<void>) | undefined;
const ok = (data: unknown) => Response.json({ result: 'success', data });
beforeEach(() => {
  connectionIds.clear();
  calls.length = 0;
  sendMode = 'ok';
  beforeSubmit = undefined;
  afterDraft = undefined;
  mock.key = Buffer.alloc(32, 19).toString('base64');
  mock.user.mockReset().mockResolvedValue({
    userId: 'owner',
    email: 'owner@example.ch',
    provider: 'supabase',
    emailConfirmed: true,
    displayName: 'Owner',
  });
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((x) => x.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'),
    );
  db.exec(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub-a','cus-a','price','active',2000000000,1,1),('sub-b','cus-b','price','active',2000000000,1,1);INSERT INTO organizations VALUES('org-a','A','sub-a','owner',1,1),('org-b','B','sub-b','owner-b',1,1)",
  );
  db.exec(
    "UPDATE subscriptions SET entitlement_valid_until=2000000000,seat_limit=3; INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('member-owner','org-a','owner','owner@example.ch','owner',1),('member-colleague','org-a','colleague','colleague@example.ch','member',2),('member-b','org-b','owner-b','owner-b@example.ch','owner',1)",
  );
  mock.db = {
    prepare: (sql: string) => {
      let args: SQLInputValue[] = [];
      const statement = {
        bind: (...values: SQLInputValue[]) => {
          args = values;
          return statement;
        },
        first: async () => db.prepare(sql).get(...args) || null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => ({
          meta: { changes: Number(db.prepare(sql).run(...args).changes) },
        }),
      };
      return statement;
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.includes('/mailbox?'))
        return ok([
          {
            uuid: 'mailbox-a',
            email: 'office@example.ch',
            hosting_id: 123,
            mailbox: 'office',
          },
          {
            uuid: 'mailbox-b',
            email: 'second@example.ch',
            hosting_id: 456,
            mailbox: 'second',
          },
        ]);
      if (url.endsWith('/signatures'))
        return ok({
          signatures: [
            {
              id: 'identity-a',
              sender: 'office@example.ch',
              full_name: 'Entreprise',
              is_default: true,
            },
            {
              id: 'identity-b',
              sender: 'second@example.ch',
              full_name: 'Entreprise',
              is_default: true,
            },
          ],
        });
      if (url.endsWith('/draft/attachment'))
        return ok(
          new Headers(init.headers).get('x-ws-attachment-disposition') ===
            'inline'
            ? { uuid: 'logo-a', content_id: 'logo-1@example.ch' }
            : { uuid: 'attachment-a' },
        );
      if (url.endsWith('/draft')) {
        await afterDraft?.();
        return ok({ uuid: 'draft-a', uid: 'draft-uid' });
      }
      if (init.method === 'PUT') {
        await beforeSubmit?.();
        if (sendMode === 'timeout') throw new Error('provider-secret-leak');
        if (sendMode === 'reject')
          return new Response('provider-secret-leak', { status: 403 });
        if (sendMode === 'server-error')
          return new Response('provider-secret-leak', { status: 500 });
        if (sendMode === 'malformed') return new Response('not-json');
        return ok({});
      }
      throw new Error('Unexpected provider request');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});
async function connect(actor = owner, email = 'office@example.ch') {
  const result = await connectSharedMail(
    actor,
    { token, fromEmail: email, fromName: 'Entreprise' },
    async () => actor,
  );
  connectionIds.set(
    actor.organizationId,
    String(result.connection.connectionId),
  );
  return result;
}
const submissions = () =>
  db.prepare('SELECT * FROM company_mail_submissions').all();
const sendCalls = () => calls.filter((c) => c.init.method === 'PUT');

describe('company-owned outbound mail', () => {
  it('rejects a replacement connection after preview without uploading or sending', async () => {
    await connect();
    const old = input();
    await connect();
    await expect(sendSharedMail(owner, old, authorize)).rejects.toThrow();
    expect(sendCalls()).toHaveLength(0);
    expect(
      db.prepare('SELECT count(*) AS n FROM company_mail_submissions').get()?.n,
    ).toBe(0);
  });
  it('recovers a receipt after disconnect without exposing body or other company data', async () => {
    await connect();
    await sendSharedMail(owner, input(), authorize);
    await disconnectSharedMail(owner);
    const receipt = await sharedMailReceipt(owner, requestId.toUpperCase());
    expect(receipt).toMatchObject({
      requestId,
      documentId,
      status: 'accepted',
      entity: 'invoices',
      recipient: 'client@example.ch',
    });
    expect(receipt).not.toHaveProperty('body');
    expect(receipt).not.toHaveProperty('pdfBase64');
    expect(
      await sharedMailReceipt({ ...owner, organizationId: 'org-b' }, requestId),
    ).toBeNull();
    await expect(sharedMailReceipt(owner, 'not-a-uuid')).rejects.toThrow();
    expect(sendCalls()).toHaveLength(1);
  });
  it('includes the selected logo in the message identity and rejects a changed replay', async () => {
    await connect();
    await sendSharedMail(
      owner,
      { ...input(), signatureLogoDataUrl: logoDataUrl },
      authorize,
    );
    await expect(sendSharedMail(owner, input(), authorize)).rejects.toThrow(
      'autre message',
    );
    expect(sendCalls()).toHaveLength(1);
    const draft = JSON.parse(
      calls.find((c) => c.url.endsWith('/draft'))!.init.body as string,
    );
    expect(draft.attachments).toEqual(['attachment-a', 'logo-a']);
  });
  it('encrypts credentials, exposes no secret and never repurposes the read-only Support connection', async () => {
    const state = await connect();
    const row = db.prepare('SELECT * FROM company_mail_connections').get()!;
    expect(row.secret_ciphertext).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(state)).not.toMatch(/secret|token|mailboxId/);
    expect(state.connection).toMatchObject({
      fromEmail: 'office@example.ch',
      connected: true,
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM support_connections').get()!.n,
    ).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.init.method === undefined)).toBe(true);
  });
  it('shares the connection and accepted receipt with another device while issuing one provider send', async () => {
    await connect();
    const body = input();
    expect(await sendSharedMail(owner, body, authorize)).toEqual({
      status: 'accepted',
      replayed: false,
    });
    expect(
      await sendSharedMail(
        { ...owner, userId: 'colleague', role: 'member' },
        body,
        async () => ({ ...owner, userId: 'colleague', role: 'member' }),
      ),
    ).toEqual({ status: 'accepted', replayed: true });
    expect(sendCalls()).toHaveLength(1);
    const state = await sharedMailState(
      { ...owner, userId: 'colleague', role: 'member' },
      { entity: 'invoices', id: documentId },
    );
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({
      status: 'accepted',
      actorId: 'owner',
    });
    expect(JSON.stringify(submissions())).not.toContain(body.body);
    expect(JSON.stringify(submissions())).not.toContain(body.pdfBase64);
    const draft = JSON.parse(
      calls.find((c) => c.url.endsWith('/draft'))!.init.body as string,
    );
    expect(draft.attachments).toEqual(['attachment-a']);
    expect(draft.body).toContain('&lt;script&gt;');
    expect(draft.body).not.toContain('<script>');
    expect(draft.from.email).toBe('office@example.ch');
    expect(draft.identity_id).toBe('identity-a');
  });
  it('holds a concurrent second device before the only send is acknowledged', async () => {
    await connect();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    beforeSubmit = async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const first = sendSharedMail(owner, input(), authorize);
    await ready;
    expect(await sendSharedMail(owner, input(), authorize)).toEqual({
      status: 'pending',
      replayed: true,
    });
    release();
    await first;
    expect(sendCalls()).toHaveLength(1);
  });
  it.each(['timeout', 'malformed', 'server-error'] as const)(
    'never resends after ambiguous %s',
    async (mode) => {
      await connect();
      sendMode = mode;
      await expect(sendSharedMail(owner, input(), authorize)).rejects.toThrow(
        'confirmation certaine',
      );
      expect(submissions()[0].state).toBe('uncertain');
      expect(await sendSharedMail(owner, input(), authorize)).toEqual({
        status: 'uncertain',
        replayed: true,
      });
      expect(sendCalls()).toHaveLength(1);
      expect(JSON.stringify(await sharedMailState(owner))).not.toContain(
        'provider-secret-leak',
      );
    },
  );
  it('records explicit refusal without claiming delivery or retrying', async () => {
    await connect();
    sendMode = 'reject';
    await expect(sendSharedMail(owner, input(), authorize)).rejects.toThrow(
      'refuse',
    );
    expect(await sendSharedMail(owner, input(), authorize)).toEqual({
      status: 'rejected',
      replayed: true,
    });
    expect(sendCalls()).toHaveLength(1);
  });
  it('rejects a changed payload using the same request reference', async () => {
    await connect();
    await sendSharedMail(owner, input(), authorize);
    await expect(
      sendSharedMail(
        owner,
        { ...input(), recipient: 'different@example.ch' },
        authorize,
      ),
    ).rejects.toThrow('autre message');
    expect(sendCalls()).toHaveLength(1);
  });
  it('scopes connection, history and request IDs to the company', async () => {
    await connect();
    await sendSharedMail(owner, input(), authorize);
    const other = { ...owner, organizationId: 'org-b', userId: 'owner-b' };
    expect(
      (await sharedMailState(other, { entity: 'invoices', id: documentId }))
        .history,
    ).toEqual([]);
    expect((await sharedMailState(other)).connection.connected).toBe(false);
    await connect(other, 'second@example.ch');
    await sendSharedMail(other, input('org-b'), async () => other);
    expect(sendCalls()).toHaveLength(2);
    const sent = sendCalls().map(
      (c) => JSON.parse(c.init.body as string).from.email,
    );
    expect(sent).toEqual(['office@example.ch', 'second@example.ch']);
  });
  it('binds the encrypted secret to its company and connection revision', async () => {
    await connect();
    const other = { ...owner, organizationId: 'org-b' };
    await connect(other);
    db.exec(
      "UPDATE company_mail_connections SET secret_ciphertext=(SELECT secret_ciphertext FROM company_mail_connections WHERE organization_id='org-a') WHERE organization_id='org-b'",
    );
    await expect(
      sendSharedMail(other, input('org-b'), async () => other),
    ).rejects.toThrow('préparation');
    expect(sendCalls()).toHaveLength(0);
  });
  it.each(['member', 'accountant', 'read_only'])(
    'prevents %s from configuring or removing the company connection',
    async (role) => {
      const actor = { ...owner, role };
      await expect(connect(actor)).rejects.toThrow('administrateur');
      await expect(disconnectSharedMail(actor)).rejects.toThrow(
        'administrateur',
      );
      expect(calls).toHaveLength(0);
    },
  );
  it('prevents a read-only user from sending even a replay', async () => {
    await connect();
    await sendSharedMail(owner, input(), authorize);
    await expect(
      sendSharedMail({ ...owner, role: 'read_only' }, input(), authorize),
    ).rejects.toThrow('consultation');
    expect(sendCalls()).toHaveLength(1);
  });
  it('rechecks the user after preparation and keeps the draft unsent after revocation', async () => {
    await connect();
    await expect(
      sendSharedMail(owner, input(), async () => ({
        ...owner,
        role: 'read_only',
      })),
    ).rejects.toThrow('consultation');
    expect(sendCalls()).toHaveLength(0);
    expect(submissions()[0].state).toBe('rejected');
  });
  it('stops when the administrator disconnects during draft preparation', async () => {
    await connect();
    afterDraft = async () => {
      await disconnectSharedMail(owner);
    };
    await expect(sendSharedMail(owner, input(), authorize)).rejects.toThrow(
      'messagerie a changé',
    );
    expect(sendCalls()).toHaveLength(0);
    expect((await sharedMailState(owner)).connection.connected).toBe(false);
  });
  it.each(['preparing', 'submitting'])(
    'does not leave a crashed %s worker pending forever',
    async (state) => {
      await connect();
      await sendSharedMail(owner, input(), authorize);
      db.prepare(
        'UPDATE company_mail_submissions SET state=?,created_at=?',
      ).run(state, Math.floor(Date.now() / 1000) - 121);
      expect(await sendSharedMail(owner, input(), authorize)).toEqual({
        status: state === 'submitting' ? 'uncertain' : 'rejected',
        replayed: true,
      });
      expect(sendCalls()).toHaveLength(1);
    },
  );
  it('keeps an accepted receipt after disconnect, without sending through a replacement account', async () => {
    await connect();
    await sendSharedMail(owner, input(), authorize);
    await disconnectSharedMail(owner);
    expect(await sendSharedMail(owner, input(), authorize)).toEqual({
      status: 'accepted',
      replayed: true,
    });
    expect(sendCalls()).toHaveLength(1);
  });
  it.each([
    { confirmed: false },
    { recipient: 'client@example.ch\r\nBcc:leak@example.ch' },
    { pdfBase64: btoa('not pdf') },
    { pdfBase64: 'a='.repeat(50) },
    { subject: 'Facture\nInjected' },
    { attachmentName: '../Facture.pdf' },
    { fromEmail: 'forged@example.ch' },
    { signatureLogoDataUrl: 'not-yet-supported' },
  ])(
    'rejects malformed or unreviewed input before reserving/sending (%j)',
    async (change) => {
      await connect();
      await expect(
        sendSharedMail(owner, { ...input(), ...change }, authorize),
      ).rejects.toThrow();
      expect(submissions()).toHaveLength(0);
      expect(sendCalls()).toHaveLength(0);
    },
  );
  it('handles the maximum PDF without a recursive base64 validation expression', async () => {
    await connect();
    const pdf = Buffer.alloc(6 * 1024 * 1024, 32);
    pdf.write('%PDF-1.7\n');
    await sendSharedMail(
      owner,
      { ...input(), pdfBase64: pdf.toString('base64') },
      authorize,
    );
    expect(sendCalls()).toHaveLength(1);
  });
  it('does not replace a working connection when the user is revoked during verification', async () => {
    await connect();
    const previous = db
      .prepare('SELECT connection_id FROM company_mail_connections')
      .get();
    await expect(
      connectSharedMail(
        owner,
        { token, fromEmail: 'second@example.ch', fromName: 'B' },
        async () => {
          throw new AccountPublicError('Accès révoqué', 403);
        },
      ),
    ).rejects.toThrow('révoqué');
    expect(
      db.prepare('SELECT connection_id FROM company_mail_connections').get(),
    ).toEqual(previous);
  });
  it('bounds the shared rate independently of the user and uses company indexes', async () => {
    await connect();
    await sendSharedMail(owner, input(), authorize);
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO company_mail_submissions SELECT organization_id,'extra-'||value,payload_hash,connection_id,actor_id,entity,document_id,recipient,subject,from_email,attachment_hash,state,draft_id,?,? FROM company_mail_submissions,json_each(?)`,
    ).run(now, now, JSON.stringify(Array.from({ length: 359 }, (_, i) => i)));
    await expect(
      sendSharedMail(
        owner,
        { ...input(), requestId: crypto.randomUUID() },
        authorize,
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(sendCalls()).toHaveLength(1);
    expect(
      JSON.stringify(
        db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT COUNT(*) FROM company_mail_submissions WHERE organization_id=? AND created_at>=?',
          )
          .all('org-a', now - 3600),
      ),
    ).toContain('company_mail_rate_idx');
    expect(
      JSON.stringify(
        db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT request_id FROM company_mail_submissions WHERE organization_id=? AND entity=? AND document_id=? ORDER BY created_at DESC LIMIT 10',
          )
          .all('org-a', 'invoices', documentId),
      ),
    ).toContain('company_mail_document_idx');
  });
  it('never follows a redirect with the provider credential', async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe('manual');
        return new Response('', {
          status: 302,
          headers: { Location: 'https://untrusted.example' },
        });
      },
    );
    await expect(
      new InfomaniakSender(token, fetcher).verify('office@example.ch', 'A'),
    ).rejects.toThrow('refusé');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('stores the actual provider sender name instead of claiming an ignored display name', async () => {
    const result = await connectSharedMail(
      owner,
      {
        token,
        fromEmail: 'office@example.ch',
        fromName: 'Name ignored by provider',
      },
      authorize,
    );
    expect(result.connection.fromName).toBe('Entreprise');
    expect(
      db
        .prepare('SELECT identity_id,from_name FROM company_mail_connections')
        .get(),
    ).toMatchObject({ identity_id: 'identity-a', from_name: 'Entreprise' });
  });
  it('refuses to send after an identity is changed at the provider', async () => {
    await connect();
    const original = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
        (typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : url.url
        ).endsWith('/signatures')
          ? ok({
              signatures: [
                {
                  id: 'replacement',
                  sender: 'office@example.ch',
                  full_name: 'Other company',
                },
              ],
            })
          : original(url, init),
      ),
    );
    await expect(sendSharedMail(owner, input(), authorize)).rejects.toThrow(
      'identité d’expédition a changé',
    );
    expect(calls.filter((c) => c.init.method === 'POST')).toHaveLength(0);
    expect(sendCalls()).toHaveLength(0);
  });
  it('fails closed instead of silently using the default sender when identity is absent', async () => {
    const original = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
        (typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : url.url
        ).endsWith('/signatures')
          ? ok({ signatures: [] })
          : original(url, init),
      ),
    );
    await expect(connect()).rejects.toThrow('Ajoutez une identité');
    expect(
      db.prepare('SELECT * FROM company_mail_connections').all(),
    ).toHaveLength(0);
  });
  it('rejects a stale connection without a verified sender before upload', async () => {
    await connect();
    db.exec('UPDATE company_mail_connections SET identity_id=NULL');
    expect((await sharedMailState(owner)).connection.connected).toBe(false);
    await expect(sendSharedMail(owner, input(), authorize)).rejects.toThrow(
      'Connectez une adresse',
    );
    expect(submissions()).toHaveLength(0);
  });
  it('exposes a common ISO timestamp and pending state while an accepted receipt is still in flight', async () => {
    await connect();
    beforeSubmit = async () => {
      const state = await sharedMailState(owner, {
        entity: 'invoices',
        id: documentId,
      });
      expect(state.history[0]).toMatchObject({
        status: 'pending',
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      });
    };
    await sendSharedMail(owner, input(), authorize);
  });
  it('does not send twice when another platform uppercases the same UUID', async () => {
    await connect();
    await sendSharedMail(owner, input(), authorize);
    expect(
      await sendSharedMail(
        owner,
        {
          ...input(),
          requestId: requestId.toUpperCase(),
          documentId: documentId.toUpperCase(),
          sourceRevision: 'A'.repeat(64),
          connectionId: input().connectionId.toUpperCase(),
        },
        authorize,
      ),
    ).toEqual({ status: 'accepted', replayed: true });
    expect(sendCalls()).toHaveLength(1);
  });
  it.each(['preparing', 'submitting'])(
    'does not leave a dead %s request pending in shared history',
    async (status) => {
      await connect();
      await sendSharedMail(owner, input(), authorize);
      db.prepare(
        'UPDATE company_mail_submissions SET state=?,created_at=?',
      ).run(status, Math.floor(Date.now() / 1000) - 121);
      const state = await sharedMailState(owner, {
        entity: 'invoices',
        id: documentId,
      });
      expect(state.history[0].status).toBe(
        status === 'preparing' ? 'rejected' : 'uncertain',
      );
      expect(sendCalls()).toHaveLength(1);
    },
  );
});

const routeRequest = (
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  new Request('https://zentraapp.ch/api/company-mail', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://zentraapp.ch',
      ...headers,
    },
    body: JSON.stringify(body),
  });
const connectBody = () => ({
  action: 'connect',
  organizationId: 'org-a',
  token,
  fromEmail: 'office@example.ch',
  fromName: 'Entreprise',
});
async function device(user = 'owner') {
  const session = 'zds_' + (user === 'owner' ? 'o' : 'm').repeat(43);
  const hash = await hashOpaqueToken('device-session', session);
  db.prepare(
    "INSERT INTO license_activations VALUES(?,'sub-a',?,1,1,NULL)",
  ).run('license-' + user, 'installation-' + user);
  db.prepare(
    "INSERT INTO device_sessions VALUES(?,?,'org-a',?,?,1,1,2000000000,NULL)",
  ).run('session-' + user, hash, user, 'installation-' + user);
  return { Authorization: 'Bearer ' + session, Origin: 'tauri://localhost' };
}
describe('shared mail HTTP routes with real membership, device-session and entitlement checks', () => {
  it('lets the sending device query one receipt after a lost response with fresh membership checks', async () => {
    await POST(routeRequest(connectBody()));
    const native = await device('colleague');
    const sent = await POST(routeRequest(input(), native));
    expect(await sent.json()).toMatchObject({
      organizationId: 'org-a',
      status: 'accepted',
    });
    const read = () =>
      GET(
        new Request(
          'https://zentraapp.ch/api/company-mail?organizationId=org-a&requestId=' +
            requestId,
          { headers: native },
        ),
      );
    const receipt = await read();
    expect(receipt.status).toBe(200);
    expect(receipt.headers.get('cache-control')).toContain('no-store');
    expect(await receipt.json()).toMatchObject({
      organizationId: 'org-a',
      receipt: { requestId, status: 'accepted' },
    });
    db.prepare(
      "UPDATE organization_members SET revoked_at=1 WHERE organization_id='org-a' AND user_id='colleague'",
    ).run();
    expect((await read()).status).toBe(401);
    expect(sendCalls()).toHaveLength(1);
  });
  it('allows a fresh browser owner connection and device colleague send without exposing the credential', async () => {
    const response = await POST(routeRequest(connectBody()));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(JSON.stringify(await response.json())).not.toContain(token);
    const native = await device('colleague');
    const sent = await POST(routeRequest(input(), native));
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ status: 'accepted' });
    expect(sendCalls()).toHaveLength(1);
    const read = await GET(
      new Request(
        'https://zentraapp.ch/api/company-mail?organizationId=org-a&entity=invoices&documentId=' +
          documentId,
        { headers: native },
      ),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      organizationId: 'org-a',
      canConfigure: false,
      history: [{ actorId: 'colleague', status: 'accepted' }],
    });
  });
  it.each(['https://evil.example', 'null'])(
    'rejects cross-origin browser mutations (%s)',
    async (origin) => {
      expect(
        (await POST(routeRequest(connectBody(), { Origin: origin }))).status,
      ).toBe(403);
      expect(calls).toHaveLength(0);
    },
  );
  it('rejects a forged browser origin even with a valid native bearer', async () => {
    expect(
      (
        await POST(
          routeRequest(connectBody(), {
            ...(await device()),
            Origin: 'https://evil.example',
          }),
        )
      ).status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it('does not fall back to a logged-in cookie when the native credential is invalid', async () => {
    expect(
      (
        await POST(
          routeRequest(connectBody(), {
            Authorization: 'Bearer invalid',
            Origin: 'tauri://localhost',
          }),
        )
      ).status,
    ).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it('rejects signed-out browser access', async () => {
    mock.user.mockResolvedValue(null);
    expect((await POST(routeRequest(connectBody()))).status).toBe(401);
    expect(
      (
        await GET(
          new Request(
            'https://zentraapp.ch/api/company-mail?organizationId=org-a',
          ),
        )
      ).status,
    ).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it('does not trust a requested company outside the bearer binding', async () => {
    expect(
      (
        await POST(
          routeRequest(
            { ...connectBody(), organizationId: 'org-b' },
            await device(),
          ),
        )
      ).status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it('does not trust a requested company outside browser membership', async () => {
    expect(
      (await POST(routeRequest({ ...connectBody(), organizationId: 'org-b' })))
        .status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it.each([
    'UPDATE device_sessions SET revoked_at=1',
    'UPDATE device_sessions SET expires_at=1',
    'UPDATE license_activations SET revoked_at=1',
    "UPDATE organization_members SET revoked_at=1 WHERE user_id='owner'",
  ])('rejects stale device access: %s', async (change) => {
    const native = await device();
    db.exec(change);
    expect((await POST(routeRequest(connectBody(), native))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it('prevents a member exceeding their seat limit from reading shared configuration', async () => {
    const native = await device('colleague');
    db.exec('UPDATE subscriptions SET seat_limit=1');
    expect(
      (
        await GET(
          new Request(
            'https://zentraapp.ch/api/company-mail?organizationId=org-a',
            { headers: native },
          ),
        )
      ).status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it.each(['member', 'accountant', 'read_only'])(
    'blocks company connection changes by a browser %s',
    async (role) => {
      db.prepare(
        "UPDATE organization_members SET role=? WHERE user_id='owner'",
      ).run(role);
      expect((await POST(routeRequest(connectBody()))).status).toBe(403);
      expect(calls).toHaveLength(0);
    },
  );
  it('blocks sends for an expired plan but permits the browser owner to disconnect', async () => {
    await connect();
    db.exec('UPDATE subscriptions SET entitlement_valid_until=1');
    expect((await POST(routeRequest(input()))).status).toBe(402);
    expect(sendCalls()).toHaveLength(0);
    const state = await GET(
      new Request('https://zentraapp.ch/api/company-mail?organizationId=org-a'),
    );
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ canSend: false });
    expect(
      (
        await POST(
          routeRequest({ action: 'disconnect', organizationId: 'org-a' }),
        )
      ).status,
    ).toBe(200);
  });
  it('rechecks revocation after creating a draft and never submits it', async () => {
    await connect();
    afterDraft = async () => {
      db.exec(
        "UPDATE organization_members SET revoked_at=1 WHERE user_id='owner'",
      );
    };
    expect((await POST(routeRequest(input()))).status).toBe(403);
    expect(sendCalls()).toHaveLength(0);
    expect(submissions()[0].state).toBe('rejected');
  });
  it('rechecks subscription expiry after creating a draft and never submits it', async () => {
    await connect();
    afterDraft = async () => {
      db.exec('UPDATE subscriptions SET entitlement_valid_until=1');
    };
    expect((await POST(routeRequest(input()))).status).toBe(402);
    expect(sendCalls()).toHaveLength(0);
  });
  it('returns a safe diagnostic without leaking a provider error or key', async () => {
    await connect();
    sendMode = 'timeout';
    const response = await POST(routeRequest(input()));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('confirmation certaine');
    expect(body).not.toContain('provider-secret-leak');
    expect(body).not.toContain(token);
  });
});
