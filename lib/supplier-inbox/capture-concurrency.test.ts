import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { Workspace, SourceTicket } from '@/lib/support/types';
const boundary = vi.hoisted(() => ({
  storage: null as unknown as AsyncLocalStorage<D1Database>,
  put: vi.fn(),
  emptyReads: 0,
  emptyReadBarrier: null as Promise<void> | null,
  failRetainBefore: false,
  failRetainAfter: false,
  failInboxAfter: false,
  failReceiptAfter: false,
  failCompleteBefore: false,
  failCleanupRead: false,
  cleanupReadBarrier: null as Promise<void> | null,
  cleanupReadSeen: 0,
  keyReadBarrier: null as Promise<void> | null,
  keyReadSeen: 0,
}));
vi.mock('@/lib/runtime', () => ({
  database: () => {
    const db = boundary.storage.getStore();
    if (!db) throw Error('No closed database context');
    return db;
  },
  runtimeValue: (key: string) =>
    key === 'STRIPE_SECRET_KEY'
      ? 'sk_live_fixture'
      : key === 'TYPESAFE_API_KEY'
        ? 'synthetic-provider-key'
        : '',
  fileArchive: () => ({ put: boundary.put }),
  stripeConfiguration: () => ({
    secretKey: 'sk_live_fixture',
    testMode: 'false',
    siteUrl: 'https://company.invalid',
  }),
}));
import { captureMailboxInvoices } from './capture';
import { JEV_ENDPOINT } from '@/lib/automation/transport';
import {
  analysisReservationAdmission,
  finishCapturedAnalysis,
  reserveAnalysis,
} from '@/lib/support/billing';
let directory: string,
  first: DatabaseSync,
  second: DatabaseSync,
  fetcher: ReturnType<typeof vi.fn>;
const adapter = (sql: DatabaseSync) =>
  ({
    prepare: (query: string) => {
      let args: SQLInputValue[] = [];
      const statement = {
        bind: (...values: SQLInputValue[]) => {
          args = values;
          return statement;
        },
        first: async () => {
          if (
            boundary.failCleanupRead &&
            /SELECT \* FROM supplier_capture_analyses.*owner_token=\?/.test(
              query,
            )
          ) {
            boundary.failCleanupRead = false;
            boundary.cleanupReadBarrier = null;
            boundary.cleanupReadSeen = 0;
            throw Error('synthetic interrupted cleanup');
          }
          const result = sql.prepare(query).get(...args) || null;
          if (
            boundary.cleanupReadBarrier &&
            /SELECT \* FROM supplier_capture_analyses.*owner_token=\?/.test(
              query,
            )
          ) {
            const wait = boundary.cleanupReadBarrier;
            boundary.cleanupReadBarrier = null;
            boundary.cleanupReadSeen++;
            await wait;
          }
          if (
            query ===
              "SELECT secret FROM support_platform_secrets WHERE id='typesafe'" &&
            boundary.keyReadBarrier
          ) {
            const wait = boundary.keyReadBarrier;
            boundary.keyReadBarrier = null;
            boundary.keyReadSeen++;
            await wait;
          }
          if (
            boundary.emptyReadBarrier &&
            /^SELECT id FROM supplier_inbox WHERE organization_id=\? AND source_sha256=\?$/.test(
              query,
            )
          ) {
            boundary.emptyReads++;
            await boundary.emptyReadBarrier;
          }
          return result;
        },
        all: async () => ({ results: sql.prepare(query).all(...args) }),
        run: async () => {
          const retains =
            /UPDATE supplier_capture_analyses SET extraction=/.test(query);
          if (retains && boundary.failRetainBefore) {
            boundary.failRetainBefore = false;
            throw Error('synthetic storage failure');
          }
          if (
            /UPDATE supplier_capture_analyses SET state='completed'/.test(
              query,
            ) &&
            boundary.failCompleteBefore
          ) {
            boundary.failCompleteBefore = false;
            throw Error('synthetic completion storage failure');
          }
          const meta = sql.prepare(query).run(...args);
          if (retains && boundary.failRetainAfter) {
            boundary.failRetainAfter = false;
            throw Error('synthetic result ACK lost');
          }
          if (
            /^INSERT INTO supplier_inbox/.test(query) &&
            boundary.failInboxAfter
          ) {
            boundary.failInboxAfter = false;
            throw Error('synthetic inbox ACK lost');
          }
          if (
            /^INSERT INTO supplier_mail_receipts/.test(query) &&
            boundary.failReceiptAfter
          ) {
            boundary.failReceiptAfter = false;
            throw Error('synthetic mail ACK lost');
          }
          return { meta };
        },
      };
      return statement;
    },
  }) as unknown as D1Database;
const invoiceText =
  'Synthetic Materials SA\nFacture no SYN-20261004-01\nDate facture 2026-10-04\nÉchéance 2026-11-04\nDevise CHF\nTotal hors taxe 100.00\nTVA 8.1 % 8.10\nTotal facture 108.10';
const bytes = new TextEncoder().encode('%PDF-1.7 synthetic attachment');
const input = (connectionId: string, message: string, workspaceId = 'ws') => ({
  workspace: {
    id: workspaceId,
    owner_id: workspaceId === 'ws-b' ? 'owner-b' : 'owner',
  } as Workspace,
  connectionId,
  token: 'synthetic-mail-token',
  mailboxId: 'box',
  folderId: 'folder',
  uid: message,
  source: {
    externalId: message,
    subject: 'Synthetic invoice',
    mail: {
      sender: 'vendor@example.invalid',
      attachments: [
        { id: 'attachment', name: 'synthetic.pdf', size: bytes.length },
      ],
    },
  } as SourceTicket,
  documents: new Map([
    ['attachment', { bytes, media: 'application/pdf', text: invoiceText }],
  ]),
});
const response = (body: string) => {
  const request = JSON.parse(body) as {
    questions: Record<string, { criteria: Record<string, string> }>;
  };
  const desired: Record<string, string> = {
    suppliername: 'Synthetic Materials SA',
    reference: 'SYN-20261004-01',
    invoicedate: '2026-10-04',
    duedate: '2026-11-04',
    currency: 'CHF',
    netcents: '10000',
    vatcents: '810',
    totalcents: '10810',
    vatbp: '810',
  };
  return Response.json({
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, q]) => {
        const choice =
          id === 'kind'
            ? 'supplier_invoice'
            : id === 'category'
              ? 'materials'
              : Object.keys(q.criteria).find((key) =>
                  q.criteria[key].startsWith(desired[id] + ' —'),
                ) || 'absent';
        return [
          id,
          {
            type: 'choice',
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(q.criteria).map((key) => [
                key,
                Number(key === choice),
              ]),
            ),
          },
        ];
      }),
    ),
    model: 'jev-1.13.0',
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 },
  });
};
const run = (
  sql: DatabaseSync,
  connectionId: string,
  message: string,
  workspaceId = 'ws',
) =>
  boundary.storage.run(adapter(sql), () =>
    captureMailboxInvoices(input(connectionId, message, workspaceId)),
  );
const settle = async () => {
  for (let n = 0; n < 60; n++) await Promise.resolve();
};
beforeEach(() => {
  vi.clearAllMocks();
  boundary.keyReadBarrier = null;
  boundary.keyReadSeen = 0;
  boundary.failCompleteBefore = false;
  boundary.failCleanupRead = false;
  boundary.cleanupReadBarrier = null;
  boundary.cleanupReadSeen = 0;
  boundary.failRetainBefore = false;
  boundary.failRetainAfter = false;
  boundary.failInboxAfter = false;
  boundary.failReceiptAfter = false;
  boundary.emptyReads = 0;
  boundary.emptyReadBarrier = null;
  boundary.storage = new AsyncLocalStorage<D1Database>();
  directory = mkdtempSync(join(tmpdir(), 'zentra-capture-'));
  first = new DatabaseSync(join(directory, 'capture.sqlite'));
  first.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    first.exec(
      readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'),
    );
  first.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,entitlement_valid_until,seat_limit,entitlement_plan_id) VALUES('gestion-sub','customer','price','active',2000000000,1,1,2000000000,1,'zentra-solo-monthly-49-chf');
 INSERT INTO organizations VALUES('org','Synthetic company','gestion-sub','owner',1,1);
 INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('member','org','owner','owner@example.invalid','owner',1);
 INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('ws','owner','Synthetic Support',1,1);
 INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,status,paid_from,paid_until,paid_plan_id,livemode,updated_at) VALUES('ws','support-sub','customer','starter','active',1,2000000000,'starter',1,1);
 INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,livemode,updated_at) VALUES('org','automation-sub','customer','active',1,2000000000,1,1);
 INSERT INTO support_gestion_links VALUES('ws','org',1,0,'owner',1);
 INSERT INTO automation_platform(id,value,updated_by,updated_at) VALUES('features','["supplier_routing"]','owner',1);
 INSERT INTO automation_settings(organization_id,enabled,mode,flags,consent_version,updated_at) VALUES('org',1,'suggest','["supplier_routing"]','automation-2026-09-20',1);`);
  second = new DatabaseSync(join(directory, 'capture.sqlite'));
  second.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL');
  boundary.put.mockResolvedValue({});
  fetcher = vi.fn(async (url: unknown, options?: RequestInit) => {
    expect(url).toBe(JEV_ENDPOINT);
    return response(String(options?.body));
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  first?.close();
  second?.close();
  const target = resolve(directory),
    rest = relative(resolve(tmpdir()), target);
  if (
    isAbsolute(rest) ||
    rest.startsWith('..') ||
    !rest.startsWith('zentra-capture-')
  )
    throw Error('Unsafe test cleanup');
  rmSync(target, { recursive: true, force: true });
});
it('admits one external analysis and one charged quota for overlapping mailboxes in two SQLite connections', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fetcher.mockImplementation(async (url: unknown, options?: RequestInit) => {
    expect(url).toBe(JEV_ENDPOINT);
    await held;
    return response(String(options?.body));
  });
  let releaseReads!: () => void;
  boundary.emptyReadBarrier = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  const a = run(first, 'mailbox-a', 'message-a');
  const b = run(second, 'mailbox-b', 'message-b');
  const complete = Promise.allSettled([a, b]);
  await vi.waitFor(() => expect(boundary.emptyReads).toBe(2), {
    timeout: 1000,
    interval: 1,
  });
  releaseReads();
  await vi.waitFor(
    () => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(1),
    { timeout: 1000, interval: 1 },
  );
  await settle();
  release();
  const outcomes = await complete;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    first
      .prepare(
        "SELECT COUNT(*) AS n FROM support_analysis_usage WHERE state='charged'",
      )
      .get()?.n,
  ).toBe(1);
  expect(
    first.prepare('SELECT COUNT(*) AS n FROM supplier_inbox').get()?.n,
  ).toBe(1);
  expect(
    outcomes.filter((result) => result.status === 'fulfilled').length,
  ).toBe(1);
  const id = first.prepare('SELECT id FROM supplier_inbox').get()?.id;
  boundary.emptyReadBarrier = null;
  await (outcomes[0].status === 'rejected'
    ? run(first, 'mailbox-a', 'message-a')
    : run(second, 'mailbox-b', 'message-b'));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(first.prepare('SELECT id FROM supplier_inbox').get()?.id).toBe(id);
  expect(
    first.prepare('SELECT COUNT(*) AS n FROM supplier_mail_receipts').get()?.n,
  ).toBe(2);
  expect(
    first
      .prepare('SELECT state,extraction FROM supplier_capture_analyses')
      .get(),
  ).toMatchObject({ state: 'completed', extraction: null });
});

const count = (table: string, state?: string) =>
  first
    .prepare(
      `SELECT COUNT(*) AS n FROM ${table}${state ? ' WHERE state=?' : ''}`,
    )
    .get(...(state ? [state] : []))?.n;
const gate = () =>
  first.prepare('SELECT * FROM supplier_capture_analyses').get();
it('retains one validated result after archive failure and charges one successful import without a second analysis', async () => {
  boundary.put.mockRejectedValueOnce(Error('synthetic R2 failure'));
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow(
    'synthetic R2 failure',
  );
  const before = gate();
  expect(before).toMatchObject({ state: 'analyzed', owner_until: 0 });
  expect(before?.extraction).toBeTypeOf('string');
  expect(count('support_analysis_usage', 'released')).toBe(1);
  expect(count('supplier_mail_receipts')).toBe(0);
  await run(second, 'mailbox-a', 'message-a');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('support_analysis_usage', 'charged')).toBe(1);
  expect(count('support_analysis_usage', 'released')).toBe(1);
  expect(first.prepare('SELECT id FROM supplier_inbox').get()?.id).toBe(
    before?.inbox_id,
  );
  expect(gate()).toMatchObject({ state: 'completed', extraction: null });
  expect(count('supplier_mail_receipts')).toBe(1);
});
it('never retries an admitted external request with an unknown response, including after reopening the database', async () => {
  fetcher.mockRejectedValueOnce(Error('synthetic response lost'));
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow();
  const retained = gate();
  expect(retained).toMatchObject({ state: 'uncertain', extraction: null });
  expect(count('support_analysis_usage', 'reserved')).toBe(1);
  first.close();
  first = new DatabaseSync(join(directory, 'capture.sqlite'));
  first.exec('PRAGMA foreign_keys=ON');
  await expect(run(first, 'mailbox-b', 'message-b')).rejects.toThrow(
    'n’est pas confirmée',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(boundary.put).not.toHaveBeenCalled();
  expect(count('supplier_mail_receipts')).toBe(0);
  expect(gate()?.inbox_id).toBe(retained?.inbox_id);
});
it('does not let the provider internal 503 retry admit a second HTTP request', async () => {
  fetcher.mockResolvedValue(
    Response.json({ synthetic: true }, { status: 503 }),
  );
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(gate()?.state).toBe('uncertain');
  await expect(run(second, 'mailbox-b', 'message-b')).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('support_analysis_usage', 'charged')).toBe(0);
});
it('refuses a declined quota before HTTP and can recover without resetting or charging previous usage', async () => {
  first.exec('UPDATE support_subscriptions SET paid_until=1');
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toMatchObject({
    status: 402,
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(boundary.put).not.toHaveBeenCalled();
  expect(gate()?.state).toBe('retryable');
  expect(count('support_analysis_usage')).toBe(0);
  first.exec('UPDATE support_subscriptions SET paid_until=2000000000');
  await run(second, 'mailbox-a', 'message-a');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('support_analysis_usage', 'charged')).toBe(1);
});
it('reuses a result whose database ACK was lost instead of running the provider again', async () => {
  boundary.failRetainAfter = true;
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow(
    'synthetic result ACK lost',
  );
  expect(gate()?.state).toBe('analyzed');
  expect(count('supplier_inbox')).toBe(0);
  await run(second, 'mailbox-a', 'message-a');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('support_analysis_usage', 'charged')).toBe(1);
  expect(count('supplier_inbox')).toBe(1);
});
it('keeps a provider result unknown when it could not be durably retained, and never sends it again', async () => {
  boundary.failRetainBefore = true;
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow(
    'synthetic storage failure',
  );
  expect(gate()).toMatchObject({ state: 'uncertain', extraction: null });
  await expect(run(second, 'mailbox-a', 'message-a')).rejects.toThrow(
    'n’est pas confirmée',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(boundary.put).not.toHaveBeenCalled();
});
it('recovers a committed inbox insert after a lost ACK with the same inbox ID and no second analysis', async () => {
  boundary.failInboxAfter = true;
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow(
    'synthetic inbox ACK lost',
  );
  const id = first.prepare('SELECT id FROM supplier_inbox').get()?.id;
  expect(id).toBe(gate()?.inbox_id);
  expect(count('supplier_mail_receipts')).toBe(0);
  await run(second, 'mailbox-a', 'message-a');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('supplier_inbox')).toBe(1);
  expect(first.prepare('SELECT id FROM supplier_inbox').get()?.id).toBe(id);
  expect(count('support_analysis_usage', 'charged')).toBe(1);
  expect(count('supplier_mail_receipts')).toBe(1);
});
it('does not replay a completely stored capture after its mail receipt ACK was lost', async () => {
  boundary.failReceiptAfter = true;
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow(
    'synthetic mail ACK lost',
  );
  expect(gate()?.state).toBe('completed');
  expect(count('supplier_mail_receipts')).toBe(1);
  await run(second, 'mailbox-a', 'message-a');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(boundary.put).toHaveBeenCalledTimes(1);
  expect(count('support_analysis_usage', 'charged')).toBe(1);
});
it('does not expire an admitted analysis into a new provider call', async () => {
  fetcher.mockRejectedValueOnce(Error('synthetic response lost'));
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow();
  first.exec(
    "UPDATE supplier_capture_analyses SET state='analyzing',owner_until=0",
  );
  await expect(run(second, 'mailbox-b', 'message-b')).rejects.toThrow(
    'n’est pas confirmée',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('supplier_inbox')).toBe(0);
  expect(count('support_analysis_usage')).toBe(1);
});

it('never releases or charges twice after quota settlement succeeded but capture completion could not be stored', async () => {
  boundary.failCompleteBefore = true;
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow(
    'synthetic completion storage failure',
  );
  expect(count('support_analysis_usage', 'charged')).toBe(1);
  expect(count('support_analysis_usage', 'released')).toBe(0);
  expect(gate()).toMatchObject({ state: 'analyzed', owner_until: 0 });
  await run(second, 'mailbox-a', 'message-a');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('support_analysis_usage')).toBe(1);
  expect(count('support_analysis_usage', 'charged')).toBe(1);
  expect(gate()?.state).toBe('completed');
});
it('does not reserve an analysis for an unreadable original on an archive retry', async () => {
  const original = input('mailbox-a', 'message-a');
  original.documents.get('attachment')!.text = '';
  boundary.put.mockRejectedValueOnce(Error('synthetic R2 failure'));
  await expect(
    boundary.storage.run(adapter(first), () =>
      captureMailboxInvoices(original),
    ),
  ).rejects.toThrow();
  expect(gate()).toMatchObject({ state: 'analyzed', analysis_required: 0 });
  await boundary.storage.run(adapter(second), () =>
    captureMailboxInvoices(original),
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(count('support_analysis_usage')).toBe(0);
  expect(count('supplier_inbox')).toBe(1);
});
it('keeps a changed Gestion link from publishing an old-company result or reusing it for the new company', async () => {
  first.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,entitlement_valid_until,seat_limit,entitlement_plan_id) VALUES('gestion-b','customer-b','price','active',2000000000,1,1,2000000000,1,'zentra-solo-monthly-49-chf');
 INSERT INTO organizations VALUES('org-b','Second synthetic company','gestion-b','owner',1,1);
 INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('member-b','org-b','owner','owner@example.invalid','owner',1);
 INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,livemode,updated_at) VALUES('org-b','addon-b','customer','active',1,2000000000,1,1);
 INSERT INTO automation_settings(organization_id,enabled,mode,flags,consent_version,updated_at) VALUES('org-b',1,'suggest','["supplier_routing"]','automation-2026-09-20',1);`);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fetcher.mockImplementation(async (_url: unknown, options?: RequestInit) => {
    await held;
    return response(String(options?.body));
  });
  const outcome = run(first, 'mailbox-a', 'message-a').catch((error) => error);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1), {
    timeout: 1000,
    interval: 1,
  });
  first.exec(
    "UPDATE support_gestion_links SET organization_id='org-b' WHERE workspace_id='ws'",
  );
  release();
  expect(await outcome).toMatchObject({ status: 409 });
  expect(count('supplier_inbox')).toBe(0);
  expect(boundary.put).not.toHaveBeenCalled();
  await expect(run(second, 'mailbox-b', 'message-b')).rejects.toThrow(
    'lien avec Gestion a changé',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('supplier_mail_receipts')).toBe(0);
});
it('keeps identical attachments independent in two different companies and Support workspaces', async () => {
  first.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,entitlement_valid_until,seat_limit,entitlement_plan_id) VALUES('gestion-b','customer-b','price','active',2000000000,1,1,2000000000,1,'zentra-solo-monthly-49-chf');
 INSERT INTO organizations VALUES('org-b','Second synthetic company','gestion-b','owner-b',1,1);
 INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('member-b','org-b','owner-b','owner-b@example.invalid','owner',1);
 INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('ws-b','owner-b','Second Support',1,1);
 INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,status,paid_from,paid_until,paid_plan_id,livemode,updated_at) VALUES('ws-b','support-b','customer','starter','active',1,2000000000,'starter',1,1);
 INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,livemode,updated_at) VALUES('org-b','addon-b','customer','active',1,2000000000,1,1);
 INSERT INTO support_gestion_links VALUES('ws-b','org-b',1,0,'owner-b',1);
 INSERT INTO automation_settings(organization_id,enabled,mode,flags,consent_version,updated_at) VALUES('org-b',1,'suggest','["supplier_routing"]','automation-2026-09-20',1);`);
  await Promise.all([
    run(first, 'mailbox-a', 'message-a'),
    run(second, 'mailbox-b', 'message-b', 'ws-b'),
  ]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(count('supplier_capture_analyses')).toBe(2);
  expect(count('supplier_inbox')).toBe(2);
  expect(count('support_analysis_usage', 'charged')).toBe(2);
  const rows = first
    .prepare(
      'SELECT workspace_id,organization_id FROM supplier_inbox ORDER BY workspace_id',
    )
    .all();
  expect(rows).toMatchObject([
    { workspace_id: 'ws', organization_id: 'org' },
    { workspace_id: 'ws-b', organization_id: 'org-b' },
  ]);
});
it('refuses a corrupt retained result without a new analysis or quota reservation', async () => {
  boundary.put.mockRejectedValueOnce(Error('synthetic R2 failure'));
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow();
  first.exec(
    "UPDATE supplier_capture_analyses SET extraction='{bad' WHERE workspace_id='ws'",
  );
  await expect(run(second, 'mailbox-a', 'message-a')).rejects.toThrow(
    'n’est pas confirmée',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('support_analysis_usage')).toBe(1);
  expect(count('supplier_inbox')).toBe(0);
});

it('fences an expired owner before HTTP while the next owner releases only its uncharged reservation', async () => {
  let release!: () => void;
  boundary.keyReadBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const old = run(first, 'mailbox-a', 'message-a').catch((error) => error);
  await vi.waitFor(() => expect(boundary.keyReadSeen).toBe(1), {
    timeout: 1000,
    interval: 1,
  });
  const id = gate()?.inbox_id;
  expect(gate()?.state).toBe('preparing');
  first.exec('UPDATE supplier_capture_analyses SET owner_until=0');
  await run(second, 'mailbox-b', 'message-b');
  release();
  expect(await old).toMatchObject({ status: 409 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('supplier_inbox')).toBe(1);
  expect(first.prepare('SELECT id FROM supplier_inbox').get()?.id).toBe(id);
  expect(count('support_analysis_usage', 'released')).toBe(1);
  expect(count('support_analysis_usage', 'charged')).toBe(1);
  expect(count('supplier_mail_receipts')).toBe(1);
});
it('fences a late R2 acknowledgement after a validated-result owner was replaced, without releasing the new owner quota', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  boundary.put.mockImplementationOnce(async () => {
    await held;
    return {};
  });
  const old = run(first, 'mailbox-a', 'message-a').catch((error) => error);
  await vi.waitFor(() => expect(boundary.put).toHaveBeenCalledTimes(1), {
    timeout: 1000,
    interval: 1,
  });
  const id = gate()?.inbox_id;
  expect(gate()?.state).toBe('analyzed');
  first.exec('UPDATE supplier_capture_analyses SET owner_until=0');
  await run(second, 'mailbox-b', 'message-b');
  release();
  expect(await old).toMatchObject({ status: 409 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('supplier_inbox')).toBe(1);
  expect(first.prepare('SELECT id FROM supplier_inbox').get()?.id).toBe(id);
  expect(count('support_analysis_usage')).toBe(1);
  expect(count('support_analysis_usage', 'charged')).toBe(1);
  expect(count('support_analysis_usage', 'released')).toBe(0);
  expect(count('supplier_mail_receipts')).toBe(1);
});

it.each(['charged', 'missing'])(
  'keeps a preparing capture closed when its referenced quota is %s instead of clearing the reference',
  async (state) => {
    boundary.put.mockRejectedValueOnce(Error('synthetic R2 failure'));
    await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow();
    const original = gate();
    expect(original?.state).toBe('analyzed');
    const reservation = String(
      first.prepare('SELECT id FROM support_analysis_usage').get()?.id,
    );
    if (state === 'missing')
      first
        .prepare('DELETE FROM support_analysis_usage WHERE id=?')
        .run(reservation);
    else
      first
        .prepare("UPDATE support_analysis_usage SET state='charged' WHERE id=?")
        .run(reservation);
    first
      .prepare(
        "UPDATE supplier_capture_analyses SET state='preparing',extraction=NULL,reservation=?,owner_until=0",
      )
      .run(reservation);
    await expect(run(second, 'mailbox-a', 'message-a')).rejects.toThrow(
      state === 'charged'
        ? 'n’est pas confirmée'
        : 'réservation de cette analyse',
    );
    expect(gate()).toMatchObject({ state: 'uncertain', reservation });
    await expect(run(first, 'mailbox-b', 'message-b')).rejects.toThrow(
      'n’est pas confirmée',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(count('supplier_inbox')).toBe(0);
    expect(count('support_analysis_usage', 'released')).toBe(0);
    expect(count('support_analysis_usage', 'charged')).toBe(
      state === 'charged' ? 1 : 0,
    );
  },
);

it('requires fresh quota admission for a crash-retained extraction after its reservation expired and the quota filled', async () => {
  boundary.put.mockImplementationOnce(async () => {
    boundary.failCleanupRead = true;
    throw Error('synthetic process interruption');
  });
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow(
    'synthetic process interruption',
  );
  expect(gate()?.state).toBe('analyzed');
  first.exec(`UPDATE supplier_capture_analyses SET owner_until=0; UPDATE support_analysis_usage SET expires_at=0;
    INSERT INTO support_analysis_usage(id,workspace_id,period_start,ticket_id,state,expires_at,created_at)
    WITH RECURSIVE filled(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM filled WHERE n<2000)
    SELECT 'filled-'||n,'ws',1,'filled','charged',0,1 FROM filled;`);
  await expect(run(second, 'mailbox-b', 'message-b')).rejects.toMatchObject({
    status: 402,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('support_analysis_usage', 'charged')).toBe(2000);
  expect(count('supplier_inbox')).toBe(0);
});

const fillQuota = () =>
  first.exec(`INSERT INTO support_analysis_usage(id,workspace_id,period_start,ticket_id,state,expires_at,created_at)
 WITH RECURSIVE filled(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM filled WHERE n<2000)
 SELECT 'filled-'||n,'ws',1,'filled','charged',0,1 FROM filled;`);
it('does not send to the provider after Support was revoked while the API key read was pending', async () => {
  let release!: () => void;
  boundary.keyReadBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcome = run(first, 'mailbox-a', 'message-a').catch((error) => error);
  await vi.waitFor(() => expect(boundary.keyReadSeen).toBe(1), {
    timeout: 1000,
    interval: 1,
  });
  first.exec('UPDATE support_subscriptions SET paid_until=1');
  release();
  expect(await outcome).toMatchObject({ status: 402 });
  expect(fetcher).not.toHaveBeenCalled();
  expect(count('supplier_inbox')).toBe(0);
  expect(gate()?.state).toBe('retryable');
  first.exec('UPDATE support_subscriptions SET paid_until=2000000000');
  await run(second, 'mailbox-a', 'message-a');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('support_analysis_usage', 'charged')).toBe(1);
});
it('does not send to the provider after the pre-HTTP reservation expired and its quota filled', async () => {
  let release!: () => void;
  boundary.keyReadBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcome = run(first, 'mailbox-a', 'message-a').catch((error) => error);
  await vi.waitFor(() => expect(boundary.keyReadSeen).toBe(1), {
    timeout: 1000,
    interval: 1,
  });
  first.exec('UPDATE support_analysis_usage SET expires_at=0');
  fillQuota();
  release();
  expect(await outcome).toMatchObject({ status: 402 });
  expect(fetcher).not.toHaveBeenCalled();
  expect(count('supplier_inbox')).toBe(0);
  expect(count('support_analysis_usage', 'charged')).toBe(2000);
});
it('does not publish after the R2 response when the original quota admission expired and the quota filled', async () => {
  boundary.put.mockImplementationOnce(async () => {
    first.exec('UPDATE support_analysis_usage SET expires_at=0');
    fillQuota();
    return {};
  });
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toMatchObject({
    status: 402,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('supplier_inbox')).toBe(0);
  expect(count('supplier_mail_receipts')).toBe(0);
  expect(count('support_analysis_usage', 'charged')).toBe(2000);
  expect(gate()?.state).toBe('analyzed');
});
it('reuses the original result but admits its unfinished quota in the current period instead of the old period', async () => {
  boundary.put.mockImplementationOnce(async () => {
    boundary.failCleanupRead = true;
    throw Error('synthetic process interruption');
  });
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow();
  const reservation = gate()?.reservation;
  first.exec(
    'UPDATE supplier_capture_analyses SET owner_until=0; UPDATE support_subscriptions SET paid_from=2',
  );
  await run(second, 'mailbox-b', 'message-b');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    first
      .prepare(
        'SELECT state,period_start FROM support_analysis_usage WHERE id=?',
      )
      .get(String(reservation)),
  ).toMatchObject({ state: 'released', period_start: 1 });
  expect(
    first
      .prepare(
        "SELECT period_start FROM support_analysis_usage WHERE state='charged'",
      )
      .get()?.period_start,
  ).toBe(2);
  expect(count('supplier_inbox')).toBe(1);
});
it('never releases a reservation belonging to another workspace when retained metadata is inconsistent', async () => {
  boundary.put.mockRejectedValueOnce(Error('synthetic R2 failure'));
  await expect(run(first, 'mailbox-a', 'message-a')).rejects.toThrow();
  first.exec(
    "INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('other','other-owner','Other',1,1); INSERT INTO support_analysis_usage VALUES('foreign','other',1,'invoice:other','reserved',2000000000,1); UPDATE supplier_capture_analyses SET reservation='foreign'",
  );
  await expect(run(second, 'mailbox-a', 'message-a')).rejects.toThrow(
    'réservation de cette analyse',
  );
  expect(
    first
      .prepare("SELECT state FROM support_analysis_usage WHERE id='foreign'")
      .get()?.state,
  ).toBe('reserved');
  expect(gate()?.reservation).toBe('foreign');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('supplier_inbox')).toBe(0);
});
const quotaContext = <T>(action: () => Promise<T>) =>
  boundary.storage.run(adapter(first), action);
const workspace = { id: 'ws', owner_id: 'owner' } as Workspace;
it.each(['workspace', 'ticket', 'missing', 'state'])(
  'refuses %s reservation metadata without any write',
  async (kind) => {
    const id = await quotaContext(() =>
      reserveAnalysis(workspace, 'invoice:exact', 'metadata'),
    );
    if (kind === 'missing')
      first.prepare('DELETE FROM support_analysis_usage WHERE id=?').run(id);
    if (kind === 'state')
      first
        .prepare(
          "UPDATE support_analysis_usage SET state='unsupported' WHERE id=?",
        )
        .run(id);
    const before = first.prepare('SELECT * FROM support_analysis_usage').all();
    await expect(
      quotaContext(() =>
        analysisReservationAdmission(
          kind === 'workspace' ? { ...workspace, id: 'other' } : workspace,
          kind === 'ticket' ? 'invoice:other' : 'invoice:exact',
          id!,
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(first.prepare('SELECT * FROM support_analysis_usage').all()).toEqual(
      before,
    );
  },
);
it.each(['valid', 'expired', 'period', 'charged'])(
  'reads %s quota admission without modifying its state',
  async (kind) => {
    const id = await quotaContext(() =>
      reserveAnalysis(workspace, 'invoice:exact', 'metadata'),
    );
    if (kind === 'expired')
      first.exec('UPDATE support_analysis_usage SET expires_at=0');
    if (kind === 'period')
      first.exec('UPDATE support_subscriptions SET paid_from=2');
    if (kind === 'charged')
      first.exec(
        "UPDATE support_analysis_usage SET state='charged',expires_at=0,period_start=0",
      );
    const before = first.prepare('SELECT * FROM support_analysis_usage').all();
    expect(
      await quotaContext(() =>
        analysisReservationAdmission(workspace, 'invoice:exact', id!),
      ),
    ).toEqual({
      state: kind === 'charged' ? 'charged' : 'reserved',
      admitted: kind === 'valid' || kind === 'charged',
      periodStart: kind === 'charged' ? 0 : 1,
    });
    expect(first.prepare('SELECT * FROM support_analysis_usage').all()).toEqual(
      before,
    );
  },
);
it.each(['pack', 'trial', 'offered'])(
  'uses the actual %s quota period and re-admission rules',
  async (kind) => {
    const started = Math.floor(Date.now() / 1000) - 60;
    first.exec('UPDATE support_subscriptions SET paid_until=1');
    if (kind === 'pack')
      first
        .prepare(
          "INSERT INTO complete_subscriptions VALUES('gestion-sub','team','team',?,2000000000,'paid-pack-invoice')",
        )
        .run(started);
    if (kind === 'trial') {
      first
        .prepare(
          "INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at) VALUES('owner','synthetic-hash','org','gestion-sub',?,2000000000)",
        )
        .run(started);
      first.exec("INSERT INTO complete_trials VALUES('owner','org',250)");
    }
    if (kind === 'offered')
      first
        .prepare(
          "INSERT INTO founder_support_grants(email,grant_id,user_id,workspace_id,plan_id,valid_from,valid_until,revision,created_at,updated_at,last_operation_id) VALUES('owner@example.invalid','grant','owner','ws','starter',?,2000000000,1,1,1,'synthetic-op')",
        )
        .run(started);
    const id = await quotaContext(() =>
      reserveAnalysis(workspace, 'invoice:exact', 'metadata'),
    );
    expect(id?.startsWith('founder:')).toBe(kind === 'offered');
    const table =
      kind === 'offered' ? 'founder_support_usage' : 'support_analysis_usage';
    expect(
      first.prepare(`SELECT period_start FROM ${table}`).get()?.period_start,
    ).toBe(started);
    expect(
      await quotaContext(() =>
        analysisReservationAdmission(workspace, 'invoice:exact', id!),
      ),
    ).toEqual({ state: 'reserved', admitted: true, periodStart: started });
    first.exec(`UPDATE ${table} SET expires_at=0`);
    expect(
      await quotaContext(() =>
        analysisReservationAdmission(workspace, 'invoice:exact', id!),
      ),
    ).toEqual({ state: 'reserved', admitted: false, periodStart: started });
    const before = first.prepare(`SELECT * FROM ${table}`).all();
    if (kind === 'pack')
      first.exec('UPDATE complete_subscriptions SET paid_until=1');
    if (kind === 'trial')
      first.exec('UPDATE account_trials SET ends_at=started_at+1');
    if (kind === 'offered')
      first.exec('UPDATE founder_support_grants SET revoked_at=1');
    await expect(
      quotaContext(() =>
        analysisReservationAdmission(workspace, 'invoice:exact', id!),
      ),
    ).rejects.toMatchObject({ status: 402 });
    expect(first.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
  },
);

it.each(['workspace', 'ticket'])(
  'never releases a pre-HTTP quota after its %s binding changed while the key read was pending',
  async (kind) => {
    let release!: () => void;
    boundary.keyReadBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outcome = run(first, 'mailbox-a', 'message-a').catch(
      (error) => error,
    );
    await vi.waitFor(() => expect(boundary.keyReadSeen).toBe(1), {
      timeout: 1000,
      interval: 1,
    });
    if (kind === 'workspace')
      first.exec(
        "INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('other','other-owner','Other',1,1); UPDATE support_analysis_usage SET workspace_id='other'",
      );
    else
      first.exec("UPDATE support_analysis_usage SET ticket_id='invoice:other'");
    const before = first.prepare('SELECT * FROM support_analysis_usage').all();
    release();
    expect(await outcome).toMatchObject({ status: 409 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(count('supplier_inbox')).toBe(0);
    expect(gate()?.state).toBe('uncertain');
    expect(first.prepare('SELECT * FROM support_analysis_usage').all()).toEqual(
      before,
    );
  },
);

it('never releases the successor quota when an old cleanup owns only a historical row snapshot', async () => {
  let releaseCleanup!: () => void, releaseNewArchive!: () => void;
  const cleanupHeld = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const newArchiveHeld = new Promise<void>((resolve) => {
    releaseNewArchive = resolve;
  });
  boundary.put.mockImplementationOnce(async () => {
    boundary.cleanupReadBarrier = cleanupHeld;
    throw Error('synthetic R2 interruption');
  });
  boundary.put.mockImplementationOnce(async () => {
    await newArchiveHeld;
    return {};
  });
  const old = run(first, 'mailbox-a', 'message-a').catch((error) => error);
  await vi.waitFor(() => expect(boundary.cleanupReadSeen).toBe(1), {
    timeout: 1000,
    interval: 1,
  });
  const reservation = gate()?.reservation;
  first.exec('UPDATE supplier_capture_analyses SET owner_until=0');
  const next = run(second, 'mailbox-b', 'message-b');
  const nextOutcome = next.catch((error) => error);
  await vi.waitFor(() => expect(boundary.put).toHaveBeenCalledTimes(2), {
    timeout: 1000,
    interval: 1,
  });
  releaseCleanup();
  await old;
  try {
    expect(
      first
        .prepare('SELECT state FROM support_analysis_usage WHERE id=?')
        .get(String(reservation))?.state,
    ).toBe('reserved');
  } finally {
    releaseNewArchive();
    await nextOutcome;
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(count('support_analysis_usage', 'charged')).toBe(1);
  expect(count('supplier_inbox')).toBe(1);
});

it.each([
  'charge',
  'release',
  'owner',
  'phase',
  'reference',
  'period',
  'lease',
  'analyzing',
  'uncertain',
  'expired-quota',
])(
  'settles %s only under the exact current capture fence in SQLite',
  async (kind) => {
    const sha = 'a'.repeat(64),
      ownerToken = crypto.randomUUID();
    const reservation = await quotaContext(() =>
      reserveAnalysis(workspace, `invoice:${sha}`, 'settlement'),
    );
    first
      .prepare(
        "INSERT INTO supplier_capture_analyses(workspace_id,source_sha256,organization_id,inbox_id,owner_token,owner_until,state,reservation,analysis_required,created_at,updated_at) VALUES('ws',?,'org','synthetic-inbox',?,?,'analyzed',?,1,1,1)",
      )
      .run(sha, ownerToken, Math.floor(Date.now() / 1000) + 600, reservation);
    const capture = {
      workspaceId: 'ws',
      sourceSha256: sha,
      ownerToken,
      state: 'analyzed' as const,
      periodStart: 1,
    };
    if (kind === 'owner') capture.ownerToken = crypto.randomUUID();
    if (kind === 'phase')
      first.exec("UPDATE supplier_capture_analyses SET state='preparing'");
    if (kind === 'reference')
      first.exec(
        "UPDATE supplier_capture_analyses SET reservation='different'",
      );
    if (kind === 'period') capture.periodStart = 2;
    if (kind === 'lease')
      first.exec('UPDATE supplier_capture_analyses SET owner_until=0');
    if (kind === 'analyzing' || kind === 'uncertain')
      first.prepare('UPDATE supplier_capture_analyses SET state=?').run(kind);
    if (kind === 'expired-quota')
      first.exec('UPDATE support_analysis_usage SET expires_at=0');
    const success = kind !== 'release';
    const expected = kind === 'charge' || kind === 'release';
    expect(
      await quotaContext(() =>
        finishCapturedAnalysis(reservation, success, capture),
      ),
    ).toBe(expected);
    expect(
      first.prepare('SELECT state FROM support_analysis_usage').get()?.state,
    ).toBe(expected ? (success ? 'charged' : 'released') : 'reserved');
    if (expected) {
      expect(
        await quotaContext(() =>
          finishCapturedAnalysis(reservation, success, capture),
        ),
      ).toBe(true);
      expect(count('support_analysis_usage')).toBe(1);
    }
  },
);

// The same production extraction threshold must gate quota and provider admission.
it.each([
  ['three characters', 'abc', false],
  ['39 trimmed characters', 'x'.repeat(39), false],
  [
    '39 trimmed characters with whitespace',
    '  ' + 'x'.repeat(39) + ' \n ',
    false,
  ],
  ['40 trimmed characters', 'x'.repeat(40), true],
] as const)(
  'canonical trimmed invoice text admission: %s',
  async (_name, text, eligible) => {
    const incoming = input('mailbox-a', 'message-a');
    incoming.documents.get('attachment')!.text = text;
    await boundary.storage.run(adapter(first), () =>
      captureMailboxInvoices(incoming),
    );
    expect(fetcher).toHaveBeenCalledTimes(eligible ? 1 : 0);
    expect(count('support_analysis_usage')).toBe(eligible ? 1 : 0);
    expect(count('support_analysis_usage', 'charged')).toBe(eligible ? 1 : 0);
    expect(gate()?.analysis_required).toBe(eligible ? 1 : 0);
    expect(gate()?.state).toBe('completed');
    expect(count('supplier_inbox')).toBe(1);
    expect(first.prepare('SELECT state FROM supplier_inbox').get()?.state).toBe(
      'review',
    );
    if (!eligible)
      expect(
        JSON.parse(
          String(
            first.prepare('SELECT extraction FROM supplier_inbox').get()
              ?.extraction,
          ),
        ).issues,
      ).toContain('Le document doit être lu ou complété manuellement.');
  },
);
