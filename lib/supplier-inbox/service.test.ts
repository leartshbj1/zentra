import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  db: null as unknown,
  active: true,
  settings: {
    enabled: true,
    consent: true,
    mode: 'suggest',
    flags: ['supplier_routing'],
    thresholds: { high: 0.95, medium: 0.65 },
  },
}));
vi.mock('@/lib/runtime', () => ({
  database: () => mocks.db,
  fileArchive: () => ({ get: async () => null }),
}));
vi.mock('@/lib/automation/service', () => ({
  automationEntitlement: async () => mocks.active,
}));
vi.mock('@/lib/automation/config', () => ({
  settingsFor: async () => mocks.settings,
  globalFlags: async () => ['supplier_routing'],
}));
vi.mock('@/lib/account', () => ({
  membershipsForUser: async () => [],
  requireBrowserMembership: async () => {},
}));
vi.mock('@/lib/founder-access', () => ({
  effectiveAccountUntil: async (_a: unknown, _b: unknown, until: number) =>
    until,
}));
import {
  inboxItem,
  claimInvoice,
  finishInvoice,
  releaseInvoice,
  ignoreInvoice,
  automaticAllowed,
  inboxState,
  inboxDaily,
  type InboxRow,
} from './service';
import type { DeviceSessionContext } from '@/lib/account';
let sql: DatabaseSync;
const id = '11111111-1111-4111-8111-111111111111';
const session: DeviceSessionContext = {
  organizationId: 'org_a',
  organizationName: 'A',
  userId: 'owner_a',
  role: 'owner',
  installationId: 'device_a',
  sessionId: 'session',
  subscriptionId: 'sub_a',
  entitlementValidUntil: 2000000000,
};
const actor = { ...session, founder: false };
const extraction = {
  kind: 'supplier_invoice',
  supplierName: 'Acme SA',
  reference: 'A-1',
  invoiceDate: '2026-09-20',
  dueDate: '2026-10-20',
  currency: 'CHF',
  netCents: 10000,
  vatCents: 810,
  totalCents: 10810,
  vatBp: 810,
  category: 'software',
  confidence: 0.99,
  evidence: {},
  issues: [],
};
function prepare(query: string) {
  let args: SQLInputValue[] = [];
  const p = {
    bind: (...v: SQLInputValue[]) => {
      args = v;
      return p;
    },
    run: async () => ({
      meta: { changes: Number(sql.prepare(query).run(...args).changes) },
    }),
    first: async () => sql.prepare(query).get(...args) || null,
    all: async () => ({ results: sql.prepare(query).all(...args) }),
  };
  return p;
}
beforeEach(() => {
  mocks.active = true;
  mocks.settings.enabled = true;
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((n) => n.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + name, import.meta.url), 'utf8'),
    );
  sql.exec(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub_a','cus_a','price','active',2000000000,1,1);INSERT INTO organizations VALUES('org_a','A','sub_a','owner_a',1,1);INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('ws','owner_a','Test',1,1);INSERT INTO support_gestion_links VALUES('ws','org_a',1,1,'owner_a',1)",
  );
  sql
    .prepare(
      "INSERT INTO supplier_inbox(id,organization_id,workspace_id,connection_id,message_id,source_sha256,file_name,media_type,object_key,size_bytes,sender,subject,extraction,state,created_at) VALUES(?,'org_a','ws','c','m','sha','test.pdf','application/pdf','object',100,'acme@example.ch','Facture',?,'ready',100)",
    )
    .run(id, JSON.stringify(extraction));
  mocks.db = { prepare };
});
afterEach(() => sql.close());
it('keeps documents private to their company', async () => {
  await expect(inboxItem('org_b', id)).rejects.toThrow('accessible');
  expect(
    (await inboxState({ ...actor, organizationId: 'org_b' })).items,
  ).toEqual([]);
});
it('checks the current company entitlement and settings at commit reservation', async () => {
  let row = await inboxItem('org_a', id);
  expect(await automaticAllowed(actor, row)).toBe(true);
  mocks.active = false;
  await expect(claimInvoice(session, { id, automatic: true })).rejects.toThrow(
    'vérification',
  );
  expect((await claimInvoice(session, { id, automatic: false })).item.id).toBe(
    id,
  );
});
it('allows only one installation to own an import, even across sessions', async () => {
  const first = await claimInvoice(session, { id, automatic: true });
  await expect(
    claimInvoice(
      { ...session, installationId: 'device_b' },
      { id, automatic: false },
    ),
  ).rejects.toThrow('autre appareil');
  const retry = await claimInvoice(
    { ...session, sessionId: 'renewed' },
    { id, automatic: false },
  );
  expect(retry.claimToken).toBe(first.claimToken);
});
it('acknowledges exactly one stable invoice and never duplicates daily counters', async () => {
  const claim = await claimInvoice(session, { id, automatic: true });
  await expect(
    finishInvoice(session, {
      id,
      invoiceId: 'another',
      claimToken: claim.claimToken,
    }),
  ).rejects.toThrow('changé');
  const done = {
    id,
    invoiceId: id,
    claimToken: claim.claimToken,
    automatic: true,
  };
  await finishInvoice(session, done);
  await finishInvoice(session, done);
  expect(
    (await claimInvoice(session, { id, automatic: false })).alreadyImported,
  ).toBe(true);
  const day = await inboxDaily('org_a', 0, 2200000000);
  expect(day.automatic).toBe(1);
  expect(day.imported).toBe(1);
});
it('refuses read-only imports and cross-device acknowledgements', async () => {
  await expect(
    claimInvoice({ ...session, role: 'read_only' }, { id }),
  ).rejects.toThrow('consultation');
  const claim = await claimInvoice(session, { id });
  await expect(
    finishInvoice(
      { ...session, installationId: 'device_b' },
      { id, invoiceId: id, claimToken: claim.claimToken },
    ),
  ).rejects.toThrow('changé');
});
it('returns failed uncommitted imports to review, without automatic retry loops', async () => {
  await claimInvoice(session, { id });
  await releaseInvoice(session, { id, reason: 'Choisissez un fournisseur.' });
  expect(await inboxItem('org_a', id)).toMatchObject({
    state: 'review',
    claimed_installation: null,
  });
  expect(
    JSON.parse((await inboxItem('org_a', id)).extraction).issues,
  ).toContain('Choisissez un fournisseur.');
});
it('cannot dismiss or release another device’s reservation', async () => {
  await claimInvoice(session, { id });
  await expect(ignoreInvoice(actor, id)).rejects.toThrow('cours');
  await expect(
    releaseInvoice({ ...session, installationId: 'device_b' }, { id }),
  ).rejects.toThrow('changé');
});
it('blocks inconsistent totals, foreign currency and low confidence', async () => {
  const row = await inboxItem('org_a', id);
  for (const change of [
    { netCents: 1 },
    { currency: 'EUR' },
    { confidence: 0.9 },
    { reference: null },
  ])
    expect(
      await automaticAllowed(actor, {
        ...row,
        extraction: JSON.stringify({ ...extraction, ...change }),
      } as InboxRow),
    ).toBe(false);
});
it('enforces document duplicate protection in the database', () => {
  expect(() =>
    sql.exec(
      `INSERT INTO supplier_inbox SELECT '22222222-2222-4222-8222-222222222222',organization_id,workspace_id,connection_id,message_id,source_sha256,file_name,media_type,object_key,size_bytes,sender,subject,extraction,state,claimed_installation,claim_token,invoice_id,automatic,created_at,imported_at FROM supplier_inbox`,
    ),
  ).toThrow(/UNIQUE/);
});
