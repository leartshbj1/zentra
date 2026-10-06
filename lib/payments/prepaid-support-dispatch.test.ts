import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { Connection, Workspace } from '@/lib/support/types';

const fixture = vi.hoisted(() => ({
  database: null as unknown,
  stripeCalls: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => fixture.database,
  runtimeValue: (key: string) =>
    key === 'TYPESAFE_API_KEY' ? 'synthetic-local-test-key' : '',
  stripeConfiguration: () => ({
    secretKey: '',
    testMode: '',
    priceIds: {},
    signingKey: '',
  }),
}));
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      fixture.stripeCalls();
      throw new Error('No merchant API is allowed in this test.');
    }
    static createFetchHttpClient() {
      fixture.stripeCalls();
      throw new Error('No merchant HTTP is allowed in this test.');
    }
  },
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => null }));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
vi.mock('@/lib/site-url', () => ({
  publicSiteUrl: () => 'https://zentra.example.test',
}));

import { D1PrepaidPeriods, type PrepaidContractInput } from './prepaid-periods';
import { prepaidAutomationAccess } from './prepaid-access';
import { requireSupportSubscription } from '@/lib/support/billing';
import { supportAutomationState } from '@/lib/automation/execution';
import { processTicket } from '@/lib/support/service';
import { CATEGORIES, PRIORITIES, LANGUAGES } from '@/lib/support/types';

const clock = Date.parse('2026-10-06T10:11:12Z') / 1000;
const owner = 'owner-dispatch-fixture';
const organizationId = 'company-dispatch-fixture';
const workspaceId = 'support-dispatch-fixture';
const companyId = 'pfp_11111111-1111-4111-8111-111111111111';
const supportId = 'pfp_22222222-2222-4222-8222-222222222222';
const optionId = 'pfp_33333333-3333-4333-8333-333333333333';
const ticketId = 'ticket-dispatch-fixture';
const inactiveSupportMessage =
  'Activez un abonnement dans Abonnement pour utiliser le tri et le routage. Vos tickets restent dans votre logiciel de support.';
let db: DatabaseSync;
let afterReservation: (() => Promise<void>) | null;
let network: ReturnType<typeof vi.spyOn>;
let workspace: Workspace;
let connection: Connection;
let supportPeriodId: string;

function d1() {
  return {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          values = args;
          return statement;
        },
        async first() {
          return db.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { success: true, results: db.prepare(query).all(...values) };
        },
        async run() {
          const meta = db.prepare(query).run(...values);
          if (
            afterReservation &&
            meta.changes &&
            query.startsWith('INSERT INTO support_analysis_usage')
          ) {
            const interrupt = afterReservation;
            afterReservation = null;
            await interrupt();
          }
          return { success: true, meta };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}
function store() {
  return new D1PrepaidPeriods(d1(), () => clock);
}
async function payment(
  productKey: string,
  contractId: string,
  transactionId: number,
) {
  const input: PrepaidContractInput = {
    contractId,
    ownerId: owner,
    organizationId: productKey.startsWith('support:') ? null : organizationId,
    workspaceId: productKey.startsWith('support:') ? workspaceId : null,
    apiOrigin: 'https://checkout.postfinance.ch',
    spaceId: 405,
    environment: 'PRODUCTION',
    productKey,
  };
  await store().createContract(input);
  const period = await store().reservePeriod(contractId, 0);
  await store().bindTransaction(period.periodId, transactionId);
  await store().recordReconciledSettlement({
    periodId: period.periodId,
    transactionId,
    invoiceId: transactionId + 10,
    apiOrigin: input.apiOrigin,
    spaceId: input.spaceId,
    environment: 'PRODUCTION',
    ownerId: owner,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    startsAt: period.startsAt,
    endsAt: period.endsAt,
    currency: 'CHF',
    priceChfMinor: period.priceChfMinor,
    catalogVersion: period.catalogVersion,
    evidenceFingerprint: 'a'.repeat(64),
  });
  return period;
}
function choice(keys: string[], selected: string) {
  return {
    type: 'choice',
    choice: selected,
    confidence: 0.98,
    probabilities: Object.fromEntries(
      keys.map((key) => [
        key,
        key === selected ? 0.98 : 0.02 / (keys.length - 1),
      ]),
    ),
  };
}
function analysisResponse() {
  return Response.json({
    model: 'synthetic-fixture',
    answers: {
      category: choice(Object.keys(CATEGORIES), 'bug'),
      priority: choice(Object.keys(PRIORITIES), 'normal'),
      language: choice(Object.keys(LANGUAGES), 'fr'),
      frustration: {
        type: 'score',
        score: 0.1,
        confidence: 0.9,
        probabilities: { '0': 0.9, '1': 0.1, '2': 0 },
      },
      human_requested: { type: 'noul', noul: 0.01 },
    },
  });
}
function assertRetainedAndReleased() {
  expect(
    db
      .prepare(
        'SELECT state,subject,body,decision_json,automatic,routed_at,lease,lease_until,error FROM support_tickets WHERE id=?',
      )
      .get(ticketId),
  ).toMatchObject({
    state: 'error',
    subject: 'Problème de connexion fictif',
    body: 'La connexion échoue.',
    decision_json: null,
    automatic: 0,
    routed_at: null,
    lease: null,
    lease_until: null,
    error: inactiveSupportMessage,
  });
  expect(
    db
      .prepare('SELECT state FROM support_analysis_usage WHERE ticket_id=?')
      .get(ticketId),
  ).toMatchObject({ state: 'released' });
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM support_analysis_usage WHERE state IN ('charged','reserved')",
      )
      .get(),
  ).toMatchObject({ count: 0 });
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM support_events WHERE kind IN ('ready','routed')",
      )
      .get(),
  ).toMatchObject({ count: 0 });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(clock * 1000));
  fixture.stripeCalls.mockClear();
  afterReservation = null;
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.function('unixepoch', () => clock);
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  fixture.database = d1();
  await payment('gestion:start', companyId, 71);
  supportPeriodId = (await payment('support:team', supportId, 72)).periodId;
  await payment('automation', optionId, 73);
  db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_plan_id,seat_limit,entitlement_valid_until,livemode,updated_at)
    VALUES(?,?,'stale-cache','active',?,'zentra-pro-monthly-89-chf',10,?,1,?)`).run(
    companyId,
    companyId,
    clock + 999999,
    clock + 999999,
    clock,
  );
  db.prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)').run(
    organizationId,
    'Entreprise fictive',
    companyId,
    owner,
    clock,
    clock,
  );
  db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES('owner-dispatch',?,?, 'owner@example.test','owner',?)`).run(
    organizationId,
    owner,
    clock,
  );
  db.prepare(`INSERT INTO support_workspaces(id,owner_id,name,mode,threshold,created_at,updated_at)
    VALUES(?,?,'Support fictif','automatic',85,?,?)`).run(
    workspaceId,
    owner,
    clock,
    clock,
  );
  db.prepare(`INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at)
    VALUES(?,?,1,0,?,?)`).run(workspaceId, organizationId, owner, clock);
  db.prepare(`INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,paid_plan_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at)
    VALUES(?,?,?,'business','business','active',?,?,'stale-proof',0,1,?)`).run(
    workspaceId,
    supportId,
    supportId,
    clock,
    clock + 999999,
    clock,
  );
  db.prepare(
    `INSERT INTO automation_platform(id,value,updated_by,updated_at) VALUES('features','["email_classification"]',?,?)`,
  ).run(owner, clock);
  db.prepare(`INSERT INTO automation_settings(organization_id,enabled,mode,flags,consent_version,updated_at)
    VALUES(?,1,'suggest','["email_classification"]','automation-2026-09-20',?)`).run(
    organizationId,
    clock,
  );
  db.prepare(`INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,active,created_at)
    VALUES('connection-dispatch',?,'api','Connecteur fictif','','','','',?, ?,1,?)`).run(
    workspaceId,
    JSON.stringify({
      teams: [{ id: 'support', name: 'Équipe Support' }],
      agents: [],
    }),
    JSON.stringify({ bug: { teamId: 'support' } }),
    clock,
  );
  const source = {
    externalId: '123',
    subject: 'Problème de connexion fictif',
    body: 'La connexion échoue.',
    version: '1',
    groupId: null,
    agentId: null,
    closed: false,
  };
  db.prepare(`INSERT INTO support_tickets(id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,created_at,updated_at)
    VALUES(?,?,'connection-dispatch','123',?,?,?,'fixture-fingerprint',?,?)`).run(
    ticketId,
    workspaceId,
    source.subject,
    source.body,
    JSON.stringify(source),
    clock,
    clock,
  );
  workspace = db
    .prepare('SELECT * FROM support_workspaces WHERE id=?')
    .get(workspaceId) as unknown as Workspace;
  connection = db
    .prepare('SELECT * FROM support_connections WHERE id=?')
    .get('connection-dispatch') as unknown as Connection;
  network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => analysisResponse());
  await expect(requireSupportSubscription(workspace)).resolves.toBeUndefined();
  expect(await supportAutomationState(workspaceId)).toMatchObject({
    active: true,
    enabled: true,
  });
});
afterEach(() => {
  expect(fixture.stripeCalls).not.toHaveBeenCalled();
  network.mockRestore();
  db.close();
  vi.useRealTimers();
});

describe('real Support dispatch with prepaid proof revoked during an owned reservation', () => {
  it('denies the first HTTP attempt after reservation, releases quota and preserves the ticket and business error', async () => {
    afterReservation = async () => {
      await store().revokeReconciledPeriod(supportPeriodId, 'b'.repeat(64));
    };
    await expect(
      processTicket(ticketId, workspace, connection, 'worker@example.test'),
    ).rejects.toMatchObject({
      status: 402,
      message: inactiveSupportMessage,
    });
    expect(network).not.toHaveBeenCalled();
    expect(await prepaidAutomationAccess(organizationId)).not.toBeNull();
    assertRetainedAndReleased();
  });

  it('rechecks the proof after an analysis response before charging or publishing its routing decision', async () => {
    network.mockImplementationOnce(async () => {
      await store().revokeReconciledPeriod(supportPeriodId, 'b'.repeat(64));
      return analysisResponse();
    });
    await expect(
      processTicket(ticketId, workspace, connection, 'worker@example.test'),
    ).rejects.toMatchObject({ status: 402 });
    expect(network).toHaveBeenCalledTimes(1);
    assertRetainedAndReleased();
  });
});
