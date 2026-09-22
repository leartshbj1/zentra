import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Workspace, SourceTicket } from '@/lib/support/types';
const m = vi.hoisted(() => ({
  db: null as unknown,
  put: vi.fn(),
  extract: vi.fn(),
  reserve: vi.fn(),
  finish: vi.fn(),
  read: vi.fn(),
  active: true,
}));
vi.mock('@/lib/runtime', () => ({
  database: () => m.db,
  runtimeValue: (key:string)=>key==='STRIPE_SECRET_KEY'?'sk_live_fixture':'',
  fileArchive: () => ({ put: m.put }),
}));
vi.mock('@/lib/automation/config', () => ({
  decisionApiKey: async () => 'synthetic-key',
  settingsFor: async()=>({enabled:true,consent:true,flags:['supplier_routing']}),
  globalFlags:async()=>['supplier_routing'],
}));
vi.mock('@/lib/automation/provider', () => ({ JevDecisionProvider: class {} }));
vi.mock('@/lib/support/billing', () => ({
  reserveAnalysis: m.reserve,
  finishAnalysis: m.finish,
}));
vi.mock('@/lib/support/infomaniak', () => ({ readMailAttachment: m.read }));
vi.mock('./documents', () => ({
  invoiceMedia: () => 'application/pdf',
  invoiceText: async () => 'Synthetic invoice text to analyze',
}));
vi.mock('./extraction', async (original) => ({
  ...(await original<object>()),
  extractInvoice: m.extract,
}));
vi.mock('./service', () => ({
  workspaceLink: async () => ({
    organization_id: 'org',
    enabled: 1,
    connected_by: 'owner',
  }),
  gestionActive: async () => m.active,
  documentDigest: async (b: Uint8Array) =>
    createHash('sha256').update(b).digest('hex'),
  mailReceiptId: async (org: string, c: string, msg: string) =>
    [org, c, msg].join(':'),
}));
import { captureMailboxInvoices } from './capture';
let sql: DatabaseSync;
const extraction = {
  kind: 'supplier_invoice',
  kindConfidence: 0.99,
  confidence: 0.99,
  issues: [],
  totalCents: 10810,
};
const input = {
  workspace: { id: 'ws', owner_id: 'owner' } as Workspace,
  connectionId: 'conn',
  token: 'not-a-real-token',
  mailboxId: 'box',
  folderId: 'folder',
  uid: 'mail1',
  source: {
    externalId: 'mail1',
    subject: 'Facture',
    mail: {
      sender: 'vendor@example.test',
      attachments: [{ id: 'att1', name: 'facture.pdf', size: 100 }],
    },
  } as SourceTicket,
};
beforeEach(() => {
  vi.clearAllMocks();
  m.active = true;
  m.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
  m.reserve.mockResolvedValue('reservation');
  m.extract.mockResolvedValue(extraction);
  m.put.mockResolvedValue({});
  m.finish.mockResolvedValue(undefined);
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'),
    );
  sql.exec(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub','cus','price','active',2000000000,1,1);INSERT INTO organizations VALUES('org','Test','sub','owner',1,1);INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('ws','owner','Test',1,1)",
  );
  sql.exec("UPDATE subscriptions SET entitlement_valid_until=2000000000;INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('mem','org','owner','owner@example.test','owner',1);INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,livemode,updated_at) VALUES('org','addon','cus','active',1,2000000000,1,1);INSERT INTO support_gestion_links VALUES('ws','org',1,0,'owner',1)");
  m.db = {
    prepare: (query: string) => {
      let args: SQLInputValue[] = [];
      const p = {
        bind: (...v: SQLInputValue[]) => {
          args = v;
          return p;
        },
        run: async () => ({ meta: sql.prepare(query).run(...args) }),
        first: async () => sql.prepare(query).get(...args) || null,
      };
      return p;
    },
  };
});
afterEach(() => sql.close());
it('preserves the original, counts one paid analysis and deduplicates repeated delivery', async () => {
  await captureMailboxInvoices(input);
  await captureMailboxInvoices(input);
  expect(m.extract).toHaveBeenCalledTimes(1);
  expect(m.put).toHaveBeenCalledTimes(1);
  expect(m.finish).toHaveBeenCalledWith('reservation', true);
  expect(sql.prepare('SELECT state FROM supplier_inbox').get()).toMatchObject({
    state: 'ready',
  });
});
it('deduplicates the same attachment delivered in a second message', async () => {
  await captureMailboxInvoices(input);
  await captureMailboxInvoices({
    ...input,
    source: { ...input.source, externalId: 'mail2' },
  });
  expect(m.extract).toHaveBeenCalledTimes(1);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM supplier_inbox').get()?.n).toBe(
    1,
  );
});
it('does not lose documents or consume quota on a failed analysis', async () => {
  m.extract.mockRejectedValueOnce(Error('provider unavailable'));
  await expect(captureMailboxInvoices(input)).rejects.toThrow('unavailable');
  expect(m.finish).toHaveBeenCalledWith('reservation', false);
  expect(
    sql.prepare('SELECT COUNT(*) AS n FROM supplier_mail_receipts').get()?.n,
  ).toBe(0);
  await captureMailboxInvoices(input);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM supplier_inbox').get()?.n).toBe(
    1,
  );
});
it('does not send invoice text after quota or Gestion access expires', async () => {
  m.reserve.mockRejectedValueOnce(Error('quota'));
  await expect(captureMailboxInvoices(input)).rejects.toThrow('quota');
  expect(m.extract).not.toHaveBeenCalled();
  m.active = false;
  await captureMailboxInvoices(input);
  expect(m.extract).not.toHaveBeenCalled();
});
it('keeps uncertain non-invoice classifications for human review', async () => {
  m.extract.mockResolvedValueOnce({
    ...extraction,
    kind: 'other',
    kindConfidence: 0.6,
    issues: ['Confirmez le document.'],
  });
  await captureMailboxInvoices(input);
  expect(sql.prepare('SELECT state FROM supplier_inbox').get()).toMatchObject({
    state: 'review',
  });
});
it('retries if the original cannot be archived, without acknowledging the message', async () => {
  m.put.mockRejectedValueOnce(Error('storage'));
  await expect(captureMailboxInvoices(input)).rejects.toThrow('storage');
  expect(
    sql.prepare('SELECT COUNT(*) AS n FROM supplier_mail_receipts').get()?.n,
  ).toBe(0);
});
