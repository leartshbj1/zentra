import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const mock = vi.hoisted(() => ({
  db: null as unknown,
  active: true,
  enabled: true,
  linked: true,
  reserved: 0,
  finished: [] as boolean[],
}));
vi.mock('@/lib/runtime', () => ({ database: () => mock.db, runtimeValue:(key:string)=>key==='STRIPE_SECRET_KEY'?'sk_live_fixture':'' }));
vi.mock('@/lib/automation/service', () => ({
  automationEntitlement: async () => mock.active,
}));
vi.mock('@/lib/automation/config', () => ({
  settingsFor: async () => ({
    enabled: mock.enabled,
    consent: true,
    mode: 'suggest',
    flags: ['email_classification'],
    thresholds: { high: 0.95 },
  }),
  globalFlags: async () => ['email_classification'],
  decisionApiKey: async () => '',
}));
vi.mock('@/lib/supplier-inbox/service', () => ({
  workspaceLink: async () => ({
    enabled: mock.linked,
    organization_id: 'org',
    connected_by: 'owner',
  }),
  gestionActive: async () => true,
}));
vi.mock('@/lib/support/billing', () => ({
  reserveAnalysis: async () => {
    mock.reserved++;
    return 'reservation';
  },
  finishAnalysis: async (_id: unknown, success: boolean) => {
    mock.finished.push(success);
  },
}));
vi.mock('@/lib/automation/provider', () => ({
  JevDecisionProvider: class {
    async decide() {
      return {
        answers: { confirmation: { choice: 'confirmed', confidence: 0.99 } },
      };
    }
  },
}));
import {
  appointmentState,
  appointmentAction,
  appointmentDaily,
  captureAppointment,
} from './service';
import type { Workspace, SourceTicket } from '@/lib/support/types';
import {
  rememberSupplier,
  supplierHabits,
  forgetSupplier,
} from '@/lib/supplier-inbox/habits';
import type { DeviceSessionContext } from '@/lib/account';
let db: DatabaseSync;
const session = {
  organizationId: 'org',
  userId: 'owner',
  role: 'owner',
  installationId: 'windows',
} as DeviceSessionContext;
const actor = { ...session, founder: false };
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  mock.active = true;
  mock.enabled = true;
  mock.linked = true;
  mock.reserved = 0;
  mock.finished = [];
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const n of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL('../../drizzle/' + n, import.meta.url), 'utf8'),
    );
  db.exec(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub','cus','price','active',2000000000,1,1);INSERT INTO organizations VALUES('org','Company','sub','owner',1,1);INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('ws','owner','Support',1,1)",
  );
  db.prepare(
    'INSERT INTO automation_appointments(id,organization_id,workspace_id,source_key,source_hash,subject,sender,extraction,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    'org',
    'ws',
    'key',
    'hash',
    'Confirmé',
    'a@example.ch',
    JSON.stringify({
      title: 'Réunion',
      confidence: 0.99,
      issues: [],
      status: 'scheduled',
    }),
    'ready',
    1,
    1,
  );
  db.exec("UPDATE subscriptions SET entitlement_valid_until=2000000000;INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('mem','org','owner','owner@example.test','owner',1);INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,livemode,updated_at) VALUES('org','addon','cus','active',1,2000000000,1,1);INSERT INTO support_gestion_links VALUES('ws','org',1,0,'owner',1)");
  mock.db = {
    prepare: (q: string) => {
      let args: SQLInputValue[] = [];
      const stmt = {
        bind: (...a: SQLInputValue[]) => {
          args = a;
          return stmt;
        },
        first: async () => db.prepare(q).get(...args) || null,
        all: async () => ({ results: db.prepare(q).all(...args) }),
        run: async () => ({
          meta: { changes: Number(db.prepare(q).run(...args).changes) },
        }),
      };
      return stmt;
    },
  };
});
afterEach(() => db.close());
it('isolates company data and respects the subscription and read-only role', async () => {
  expect(
    (await appointmentState({ ...actor, organizationId: 'other' })).items,
  ).toEqual([]);
  await expect(
    appointmentAction(
      { ...session, role: 'read_only' },
      { action: 'claim', id },
    ),
  ).rejects.toThrow('consultation');
  mock.active = false;
  expect((await appointmentState(actor)).items).toEqual([]);
  await expect(
    appointmentAction(session, { action: 'claim', id }),
  ).rejects.toThrow('Activez');
});
it('reserves a single stable appointment across two devices and recovers lost acknowledgement', async () => {
  const a = (await appointmentAction(session, {
    action: 'claim',
    id,
    automatic: true,
  })) as { claimToken: string };
  await expect(
    appointmentAction(
      { ...session, installationId: 'mac' },
      { action: 'claim', id, automatic: true },
    ),
  ).rejects.toThrow('autre appareil');
  const retry = (await appointmentAction(session, {
    action: 'claim',
    id,
    automatic: true,
  })) as { claimToken: string };
  expect(retry.claimToken).toBe(a.claimToken);
  await appointmentAction(session, {
    action: 'finish',
    id,
    claimToken: a.claimToken,
    automatic: true,
  });
  expect(
    await appointmentAction(
      { ...session, installationId: 'mac' },
      { action: 'claim', id },
    ),
  ).toMatchObject({ alreadyImported: true });
  expect(
    (await appointmentDaily('org', 0, Date.now() / 1000 + 5)).imported,
  ).toBe(1);
});
it('does not auto import reviewed updates, cancellations, paused workflows or uncertain results', async () => {
  mock.enabled = false;
  await expect(
    appointmentAction(session, { action: 'claim', id, automatic: true }),
  ).rejects.toThrow('vérification');
  mock.enabled = true;
  db.prepare('UPDATE automation_appointments SET imported_at=1 WHERE id=?').run(
    id,
  );
  await expect(
    appointmentAction(session, { action: 'claim', id, automatic: true }),
  ).rejects.toThrow('vérification');
});
it('retains failures as an actionable review and rejects another device releasing the claim', async () => {
  const a = (await appointmentAction(session, { action: 'claim', id })) as {
    claimToken: string;
  };
  await expect(
    appointmentAction(
      { ...session, installationId: 'mac' },
      { action: 'release', id, claimToken: a.claimToken },
    ),
  ).rejects.toThrow('changé');
  await appointmentAction(session, {
    action: 'release',
    id,
    claimToken: a.claimToken,
    reason: 'Heure de fin manquante',
  });
  expect((await appointmentState(actor)).items[0]).toMatchObject({
    state: 'review',
    extraction: { issues: ['Heure de fin manquante'] },
  });
});
it('learns only a valid supplier mapping, shared within the company and removable by an administrator', async () => {
  await rememberSupplier(actor, 'Invoices@vendor.test', 'Atelier Étoile SA', {
    supplierId: id,
    category: 'Logiciels',
    accountId: null,
  });
  expect((await supplierHabits('org'))[0]).toMatchObject({
    sender: 'invoices@vendor.test',
    supplierName: 'atelieretoilesa',
    category: 'Logiciels',
  });
  expect(await supplierHabits('other')).toEqual([]);
  await rememberSupplier(actor, 'Invoices@vendor.test', 'Atelier Étoile SA', {
    supplierId: id,
    category: 'Télécommunications',
    accountId: null,
  });
  const rows = await supplierHabits('org');
  expect(rows).toHaveLength(1);
  expect(rows[0].category).toBe('Télécommunications');
  await expect(
    forgetSupplier({ ...actor, role: 'member' }, rows[0].id),
  ).rejects.toThrow('administrateur');
  await forgetSupplier(actor, rows[0].id);
  expect(await supplierHabits('org')).toEqual([]);
});
const workspace = { id: 'ws', owner_id: 'owner' } as Workspace;
function mail(time = '090000'): SourceTicket {
  return {
    externalId: 'm1',
    subject: 'Confirmation de rendez-vous',
    body: 'Votre rendez-vous est confirmé.',
    version: '1',
    closed: false,
    groupId: null,
    agentId: null,
    mail: {
      sender: 'client@example.ch',
      attachments: [],
      calendarText: `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:client-appointment\r\nSUMMARY:Rendez-vous client\r\nDTSTART;TZID=Europe/Zurich:20260922T${time}\r\nDTEND;TZID=Europe/Zurich:20260922T110000\r\nEND:VEVENT\r\nEND:VCALENDAR`,
    },
  };
}
it('rechecks a previously incomplete invitation once its identical calendar can be read',async()=>{
  const incomplete={...mail(),incomplete:true};
  await captureAppointment(workspace,incomplete);
  const first=(await appointmentState(actor)).items.find(i=>i.subject==='Confirmation de rendez-vous')!;
  expect(first.state).toBe('review');
  await captureAppointment(workspace,{...incomplete,incomplete:false});
  const updated=(await appointmentState(actor)).items.filter(i=>i.subject==='Confirmation de rendez-vous');
  expect(updated).toHaveLength(1);
  expect(updated[0]).toMatchObject({id:first.id,state:'ready',extraction:{issues:[]}});
  await captureAppointment(workspace,{...incomplete,incomplete:false});
  expect(mock.reserved).toBe(2);
});
it('captures a confirmed mail once and holds later modifications for review', async () => {
  await captureAppointment(workspace, mail());
  await captureAppointment(workspace, mail());
  expect(mock.reserved).toBe(1);
  expect(mock.finished).toEqual([true]);
  const created = (await appointmentState(actor)).items.find(
    (i) => i.subject === 'Confirmation de rendez-vous',
  )!;
  expect(created).toMatchObject({
    state: 'ready',
    extraction: { startTime: '09:00', startDate: '2026-09-22' },
  });
  const claim = (await appointmentAction(session, {
    action: 'claim',
    id: created.id,
    automatic: true,
  })) as { claimToken: string };
  await appointmentAction(session, {
    action: 'finish',
    id: created.id,
    claimToken: claim.claimToken,
    automatic: true,
  });
  await captureAppointment(workspace, mail('100000'));
  const revised = (await appointmentState(actor)).items.find(
    (i) => i.id === created.id,
  )!;
  expect(revised).toMatchObject({
    state: 'review',
    extraction: { startTime: '10:00' },
  });
  expect(revised.importedAt).toBeTruthy();
  await expect(
    appointmentAction(session, {
      action: 'claim',
      id: created.id,
      automatic: true,
    }),
  ).rejects.toThrow('vérification');
});
it('keeps a concurrent mail update retryable and balances the analysis reservation', async () => {
  await captureAppointment(workspace, mail());
  const created = (await appointmentState(actor)).items.find(
    (i) => i.subject === 'Confirmation de rendez-vous',
  )!;
  await appointmentAction(session, {
    action: 'claim',
    id: created.id,
    automatic: true,
  });
  await expect(captureAppointment(workspace, mail('100000'))).rejects.toThrow(
    'en cours',
  );
  expect(mock.finished).toEqual([true, false]);
});
it('does not analyse a disconnected or paused company mailbox', async () => {
  mock.linked = false;
  await captureAppointment(workspace, mail());
  mock.linked = true;
  mock.enabled = false;
  await captureAppointment(workspace, mail());
  expect(mock.reserved).toBe(0);
});
