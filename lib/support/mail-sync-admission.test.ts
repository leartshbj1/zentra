import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { encryptSecret } from './crypto';
import { mailExternalId, type MailReference } from './infomaniak';
import { SupportError, type SourceTicket, type Workspace } from './types';

const mocks = vi.hoisted(() => ({
  db: null as unknown, enabled: true, subscription: vi.fn(), open: vi.fn(),
  list: vi.fn(), read: vi.fn(), close: vi.fn(), prepare: vi.fn(),
  needed: vi.fn(), capture: vi.fn(), ingest: vi.fn(), process: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => mocks.db,
  runtimeValue: (key: string) => key === 'SUPPORT_MAIL_SYNC_TOKEN' ? 'closed-fixture-token'
    : key === 'SUPPORT_ENCRYPTION_KEY' ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    : key === 'STRIPE_SECRET_KEY' ? 'sk_live_fixture' : '',
}));
vi.mock('./billing', async original => ({
  ...await original<typeof import('./billing')>(), requireSupportSubscription: mocks.subscription,
}));
vi.mock('./service', () => ({ ingest: mocks.ingest, processTicket: mocks.process }));
vi.mock('@/lib/automation/execution', () => ({ supportAutomationState: async () => ({ enabled: mocks.enabled }) }));
vi.mock('@/lib/supplier-inbox/capture', () => ({ mailboxCaptureNeeded: mocks.needed, captureMailboxInvoices: mocks.capture }));
vi.mock('./mail-documents', () => ({ prepareMailDocuments: mocks.prepare }));
vi.mock('./infomaniak-imap', () => ({
  decodeImapCredentials: () => ({ password: 'closed-fixture-password', firstUid: 1 }),
  encodeImapCredentials: vi.fn(), openImapMailbox: mocks.open,
}));
import { runMailSync } from './mail-sync';
import { reserveAnalysis, finishAnalysis } from './billing';

const TIME = 1_800_000_000;
const workspaceId = 'admission-workspace', connectionId = 'admission-mailbox';
const request = () => new Request('https://zentraapp.ch/api/support/mail-sync', {
  method: 'POST', headers: { Authorization: 'Bearer closed-fixture-token' },
});
let sql: DatabaseSync, time: number;
let newest: { messages: MailReference[]; count: number };
let historical: { messages: MailReference[]; count: number };
let readCost: number, prepareCost: number, captureCost: number, processCost: number;
let attachment: boolean;
let reads: string[], preparations: string[], captures: string[], classifications: string[];
let completedCaptures: Set<string>;
const advance = (milliseconds: number) => { time += milliseconds; };
const refs = (...uids: string[]) => uids.map(uid => ({ uid, date: TIME }));
const mailbox = () => sql.prepare('SELECT * FROM support_mailboxes WHERE connection_id=?').get(connectionId)!;
const admitted = () => ({ deadline: time + 20_000 });
function resume() { time = Number(mailbox().next_sync_at) * 1000; }

async function source(uid: string): Promise<SourceTicket> {
  return {
    externalId: await mailExternalId('fixture-remote', 'inbox', uid),
    subject: 'Closed invoice fixture', body: 'Closed fixture body', version: '1',
    groupId: null, agentId: null, closed: false,
    mail: { sender: 'supplier@example.test', uid,
      attachments: attachment ? [{ id: `${uid}:attachment`, name: 'fixture.pdf', size: 1 }] : [] },
  };
}
async function seedTicket(uid: string, state = 'pending') {
  const item = await source(uid);
  sql.prepare(`INSERT INTO support_tickets(id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(`ticket-${uid}`, workspaceId, connectionId, item.externalId,
    item.subject, item.body, JSON.stringify(item), `fingerprint-${uid}`, state, Math.floor(time / 1000), Math.floor(time / 1000));
}
beforeEach(async () => {
  vi.resetAllMocks(); time = TIME * 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => time);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  sql = new DatabaseSync(':memory:'); sql.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort())
    sql.exec(readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'));
  mocks.db = { prepare(query: string) {
    let values: SQLInputValue[] = [];
    const statement = {
      bind(...bound: SQLInputValue[]) { values = bound; return statement; },
      async first() { return sql.prepare(query).get(...values) ?? null; },
      async all() { return { results: sql.prepare(query).all(...values) }; },
      async run() { return { success: true, meta: sql.prepare(query).run(...values) }; },
    };
    return statement;
  } };
  sql.prepare('INSERT INTO support_workspaces(id,owner_id,name,mode,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(workspaceId, 'fixture-owner', 'Closed fixture company', 'review', TIME, TIME);
  const secret = await encryptSecret('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'closed-fixture-password', `connection:${workspaceId}:${connectionId}`);
  sql.prepare('INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(connectionId, workspaceId, 'infomaniak', 'Closed fixture', 'mail.infomaniak.com', 'fixture@example.test', secret, '', '{}', '{}', TIME);
  sql.prepare('INSERT INTO support_mailboxes(connection_id,workspace_id,email,mailbox_id,folder_id,since_at,next_sync_at) VALUES(?,?,?,?,?,?,?)')
    .run(connectionId, workspaceId, 'fixture@example.test', 'fixture-remote', 'inbox', TIME - 100, TIME - 1);
  newest = { messages: refs('3', '2', '1'), count: 3 }; historical = newest;
  readCost = prepareCost = captureCost = processCost = 0; attachment = false; mocks.enabled = true;
  reads = []; preparations = []; captures = []; classifications = []; completedCaptures = new Set();
  mocks.subscription.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue({ list: mocks.list, read: mocks.read, close: mocks.close, attachment: async () => new Uint8Array() });
  mocks.list.mockImplementation(async (offset: number) => offset === 0 ? newest : historical);
  mocks.read.mockImplementation(async (ref: MailReference) => { reads.push(ref.uid); advance(readCost); return source(ref.uid); });
  mocks.prepare.mockImplementation(async (item: SourceTicket) => { preparations.push(item.mail!.uid!); advance(prepareCost); return { source: item, documents: [] }; });
  mocks.needed.mockResolvedValue(false);
  mocks.capture.mockImplementation(async (input: { source: SourceTicket }) => {
    captures.push(input.source.mail!.uid!); advance(captureCost); completedCaptures.add(input.source.externalId);
  });
  mocks.ingest.mockImplementation(async (_connection: unknown, item: SourceTicket) => { await seedTicket(item.mail!.uid!); });
  mocks.process.mockImplementation(async (ticketId: string) => {
    classifications.push(ticketId); advance(processCost);
    sql.prepare("UPDATE support_tickets SET state='review' WHERE id=?").run(ticketId);
  });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No external calls are allowed'); }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['prepare','capture','classify'] as const)('keeps a visible %s begin boundary while its admitted work remains blocked',async phase=>{
  attachment=true;newest=historical={messages:refs('3'),count:1};
  if(phase==='capture')mocks.needed.mockResolvedValue(true);
  const operation=phase==='classify'?mocks.process:mocks[phase],original=operation.getMockImplementation()!;
  let release!:()=>void;let reached=false;
  operation.mockImplementationOnce(async(...args:unknown[])=>{reached=true;await new Promise<void>(resolve=>{release=resolve;});advance(27);return original(...args);});
  const run=runMailSync(request(),admitted());
  await vi.waitFor(()=>expect(reached).toBe(true));
  const logger=vi.mocked(console.info),progress=()=>logger.mock.calls.filter(([name,entry])=>name==='zentra_scheduler_progress'&&entry.phase==='mail.'+phase);
  const before=progress().slice(),closedBefore=mocks.close.mock.calls.length;
  release();const result=await run;expect(result).toMatchObject({imported:1,processed:1});expect(result.failed).toBeUndefined();
  expect(before).toHaveLength(1);expect(before[0][1]).toMatchObject({boundary:'begin',mailTransport:'imap'});expect(closedBefore).toBe(0);
  expect(progress()).toHaveLength(2);expect(progress()[1][1]).toMatchObject({boundary:'end',wallDurationMs:27});
  expect(progress()[1][1].reference).toBe(progress()[0][1].reference);
  expect(mailbox()).toMatchObject({scan_offset:0,lease:null,lease_until:0});expect(mocks.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(logger.mock.calls)).not.toMatch(/supplier@example|fixture@example|closed-fixture|admission-workspace|admission-mailbox|ticket-3|fixture.pdf/);
});

it('reports capture failure without changing its recoverable receipt path or losing ingestion and classification',async()=>{
  attachment=true;newest=historical={messages:refs('3'),count:1};mocks.needed.mockResolvedValue(true);
  const error=new SupportError('private-token private@example.test',503);mocks.capture.mockRejectedValue(error);
  expect(await runMailSync(request(),admitted())).toMatchObject({imported:1,processed:1,incomplete:true});
  expect(sql.prepare('SELECT state FROM support_tickets').get()).toMatchObject({state:'review'});
  expect(mailbox()).toMatchObject({lease:null,lease_until:0,last_error:error.message});
  const progress=vi.mocked(console.info).mock.calls.filter(([name,entry])=>name==='zentra_scheduler_progress'&&entry.phase==='mail.capture');
  expect(progress.map(([,entry])=>entry.boundary)).toEqual(['begin','failed']);
  expect(JSON.stringify(progress)).not.toMatch(/private|token|admission|fixture/);
});

it.each(['read', 'prepare', 'capture'] as const)('finishes one slow %s unit and admits no second mail after the budget', async stage => {
  if (stage === 'read') readCost = 25_000;
  if (stage === 'prepare') prepareCost = 25_000;
  if (stage === 'capture') {
    attachment = true; captureCost = 25_000;
    mocks.needed.mockImplementation(async (_workspace: string, _connection: string, external: string) => !completedCaptures.has(external));
  }
  const result = await runMailSync(request(), admitted());
  expect(result).toMatchObject({ idle: false, imported: 1, processed: 1, more: true, incomplete: true, budgetExhausted: true });
  expect(reads).toEqual(['3']); expect(preparations).toEqual(['3']);
  expect(captures).toEqual(stage === 'capture' ? ['3'] : []);
  expect(mailbox()).toMatchObject({ lease: null, lease_until: 0, scan_offset: 0, last_sync_at: TIME + 25, next_sync_at: TIME + 55 });
  // The retained page is revisited: completed mail skips read/preparation/capture,
  // while the next unread mail is admitted and persisted once.
  resume();
  expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 1, processed: 1, more: true });
  expect(reads).toEqual(['3', '2']); expect(preparations).toEqual(['3', '2']);
  expect(captures).toEqual(stage === 'capture' ? ['3', '2'] : []);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['open', 'list'] as const)('admits useful mail and classification when slow %s setup has consumed the budget', async stage => {
  const operation = mocks[stage];
  const original = operation.getMockImplementation()!;
  operation.mockImplementation(async (...args: unknown[]) => { advance(25_000); return original(...args); });
  expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 1, processed: 1, more: true, incomplete: true });
  expect(reads).toEqual(['3']); expect(classifications).toEqual(['ticket-3']);
  expect(mailbox()).toMatchObject({ lease: null, lease_until: 0, scan_offset: 0, next_sync_at: TIME + 55 });
});

it('drains one admitted slow classification and leaves later tickets unstarted until the next cycle', async () => {
  newest = historical = { messages: [], count: 0 }; processCost = 25_000;
  for (const uid of ['1', '2', '3']) await seedTicket(uid);
  expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 0, processed: 1, more: true, incomplete: true, budgetExhausted: true });
  expect(classifications).toEqual(['ticket-1']);
  expect(sql.prepare("SELECT id FROM support_tickets WHERE state='pending' ORDER BY id").all()).toEqual([{ id: 'ticket-2' }, { id: 'ticket-3' }]);
  expect(mailbox()).toMatchObject({ lease: null, lease_until: 0, next_sync_at: TIME + 55 });
  resume(); expect(await runMailSync(request(), admitted())).toMatchObject({ processed: 1, more: true });
  expect(classifications).toEqual(['ticket-1', 'ticket-2']);
});

it('keeps both mail and existing classification backlogs progressing when every read consumes the budget', async () => {
  readCost = 25_000;
  for (const uid of ['a', 'b', 'c']) await seedTicket(uid);
  for (let cycle = 0; cycle < 3; cycle++) {
    expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 1, processed: 1 });
    resume();
  }
  expect(reads).toEqual(['3', '2', '1']);
  expect(classifications).toEqual(['ticket-a', 'ticket-b', 'ticket-c']);
  expect(sql.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE state='review'").get()).toMatchObject({ n: 3 });
  expect(new Set(classifications).size).toBe(3);
});

it('never skips unread historical messages while newest messages arrive during the retained page', async () => {
  mocks.enabled = false; readCost = 25_000;
  newest = { messages: refs('100', '99'), count: 2 };
  historical = { messages: refs('80', '79', '78'), count: 20 };
  await seedTicket('100', 'review'); await seedTicket('99', 'review');
  sql.prepare('UPDATE support_mailboxes SET scan_offset=20').run();
  expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 1, more: true });
  expect(reads).toEqual(['80']); expect(mailbox().scan_offset).toBe(20);
  resume(); newest = { messages: refs('101', '100', '99'), count: 3 };
  expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 1, more: true });
  expect(reads).toEqual(['80', '101']); expect(mailbox().scan_offset).toBe(20);
  resume(); expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 1, more: true });
  expect(reads).toEqual(['80', '101', '79']); expect(mailbox().scan_offset).toBe(20);
  resume(); expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 1, more: true });
  expect(reads).toEqual(['80', '101', '79', '78']); expect(mailbox().scan_offset).toBe(40);
  expect(preparations).toEqual(reads);
});

it('retains the whole provider page instead of treating a message prefix as a thread or UID offset', async () => {
  mocks.enabled = false; readCost = 25_000;
  // The provider cursor counts threads/UID windows, not returned messages.
  newest = historical = { messages: refs('6', '5', '4', '3', '2', '1'), count: 2 };
  expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 1, more: true });
  expect(mailbox().scan_offset).toBe(0); expect(reads).toEqual(['6']);
  resume(); expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 1, more: true });
  expect(mailbox().scan_offset).toBe(0); expect(reads).toEqual(['6', '5']);
});

it('creates and charges only the real quota reservation for each admitted classification across resumes', async () => {
  newest = historical = { messages: [], count: 0 }; processCost = 25_000;
  sql.prepare(`INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,paid_plan_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at)
    VALUES(?,?,?,'team','team','active',?,?,?,0,1,?)`).run(workspaceId, 'sub_fixture', 'cus_fixture', TIME - 100, TIME + 86400, 'in_fixture', TIME);
  for (const uid of ['1', '2', '3']) await seedTicket(uid);
  mocks.process.mockImplementation(async (ticketId: string, workspace: Workspace) => {
    classifications.push(ticketId);
    const reservation = await reserveAnalysis(workspace, ticketId, `reservation-${ticketId}`);
    advance(processCost); await finishAnalysis(reservation, true);
    sql.prepare("UPDATE support_tickets SET state='review' WHERE id=?").run(ticketId);
  });
  for (let cycle = 1; cycle <= 3; cycle++) {
    expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 0, processed: 1 });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM support_analysis_usage WHERE state='charged'").get()).toMatchObject({ n: cycle });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM support_analysis_usage WHERE state='reserved'").get()).toMatchObject({ n: 0 });
    resume();
  }
  expect(classifications).toEqual(['ticket-1', 'ticket-2', 'ticket-3']);
  expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 0, processed: 0, incomplete: false });
  expect(sql.prepare('SELECT COUNT(*) AS n FROM support_analysis_usage').get()).toMatchObject({ n: 3 });
  expect(fetch).not.toHaveBeenCalled();
});

it('does not let a known oversized first mail consume the minimum useful admission forever', async () => {
  const actualRead = mocks.read.getMockImplementation()!;
  readCost = 25_000;
  mocks.read.mockImplementation(async (ref: MailReference) => {
    if (ref.uid === '3') { reads.push(ref.uid); throw new SupportError('Closed oversized fixture', 422); }
    return actualRead(ref);
  });
  expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 1, processed: 1, more: true, incomplete: true });
  expect(reads).toEqual(['3', '2']); expect(preparations).toEqual(['2']);
  resume(); expect(await runMailSync(request(), admitted())).toMatchObject({ imported: 1, processed: 1 });
  expect(preparations).toEqual(['2', '1']);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM support_tickets').get()).toMatchObject({ n: 2 });
});

it.each(['object', 'primitive'] as const)('retains only the closed IMAP transport for a wrapped %s failure', async kind => {
  const log = vi.mocked(console.error);
  mocks.read.mockRejectedValueOnce(kind === 'object' ? new Error('private-password private-supplier@example.test') : 'private-password private-supplier@example.test');
  expect(await runMailSync(request(), admitted())).toMatchObject({ failed: true });
  expect(log).toHaveBeenCalledWith('zentra_service_failure', expect.objectContaining({ mailStage: 'read', mailTransport: 'imap' }));
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-password|private-supplier|example\.test|https:|closed-fixture-token/);
  expect(fetch).not.toHaveBeenCalled();
});
