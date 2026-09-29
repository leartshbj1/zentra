import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { encryptSecret } from './crypto';
import * as mailDocuments from './mail-documents';
import { SupportError, type Connection, type Workspace } from './types';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  subscription: vi.fn(),
  ingest: vi.fn(),
  process: vi.fn(),
  capture: vi.fn(),
  captureNeeded: vi.fn(),
  report: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => mocks.db,
  runtimeValue: (key: string) => key === 'SUPPORT_MAIL_SYNC_TOKEN' ? 'scheduler-fixture'
    : key === 'SUPPORT_ENCRYPTION_KEY' ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' : '',
}));
vi.mock('./billing', () => ({ requireSupportSubscription: mocks.subscription }));
vi.mock('./service', () => ({ ingest: mocks.ingest, processTicket: mocks.process }));
vi.mock('@/lib/automation/execution', () => ({ supportAutomationState: async () => ({ enabled: false }) }));
vi.mock('@/lib/supplier-inbox/capture', () => ({
  mailboxCaptureNeeded: mocks.captureNeeded,
  captureMailboxInvoices: mocks.capture,
}));
vi.mock('@/lib/service-diagnostics', () => ({ reportServiceFailure: mocks.report }));
vi.mock('./infomaniak-imap', () => ({
  decodeImapCredentials: () => null,
  encodeImapCredentials: vi.fn(),
  openImapMailbox: () => { throw new Error('Unexpected IMAP access'); },
}));
import { runMailSync, syncMailbox } from './mail-sync';
import { runMailSyncBatch } from './mail-sync-batch';

const TIME = 1_800_000_000;
const request = () => new Request('https://zentraapp.ch/api/support/mail-sync', {
  method: 'POST', headers: { Authorization: 'Bearer scheduler-fixture' },
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function entered(g: ReturnType<typeof gate>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([g.promise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Provider barrier was not reached')), 1000);
    })]);
  } finally { clearTimeout(timeout); }
}
let sql: DatabaseSync;
let clock: ReturnType<typeof vi.spyOn>;
let provider: ReturnType<typeof vi.fn>;
let onList: (id: string) => Promise<void>;
let onRead: (id: string) => Promise<void>;
let emptyMailbox: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  clock = vi.spyOn(Date, 'now').mockReturnValue(TIME * 1000);
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort())
    sql.exec(readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'));
  mocks.db = {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...bound: SQLInputValue[]) { values = bound; return statement; },
        async first() { return sql.prepare(query).get(...values) ?? null; },
        async all() { return { results: sql.prepare(query).all(...values) }; },
        async run() { return { success: true, meta: sql.prepare(query).run(...values) }; },
      };
      return statement;
    },
  };
  mocks.subscription.mockResolvedValue(undefined);
  mocks.ingest.mockResolvedValue({ id: 'ticket-fixture' });
  mocks.process.mockResolvedValue(undefined);
  mocks.captureNeeded.mockResolvedValue(false);
  mocks.capture.mockResolvedValue(undefined);
  mocks.report.mockReturnValue('diagnostic-fixture');
  onList = async () => {};
  onRead = async () => {};
  emptyMailbox = false;
  provider = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://mail.infomaniak.com');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer mailbox-fixture');
    const id = /^\/api\/mail\/([^/]+)\//.exec(url.pathname)?.[1];
    if (!id) throw new Error('Unexpected provider path');
    if (url.pathname.endsWith('/message')) {
      await onList(id);
      return Response.json({ result: 'success', data: { threads: emptyMailbox ? [] : [
        { date: TIME, messages: [{ uid: '1@inbox', folder_id: 'inbox' }] },
      ] } });
    }
    expect(url.pathname).toBe(`/api/mail/${id}/folder/inbox/message/1`);
    await onRead(id);
    return Response.json({ result: 'success', data: {
      subject: 'Fixture mail', body: 'Fixture body', from: [{ email: 'sender@example.test' }],
    } });
  });
  vi.stubGlobal('fetch', provider);
});
afterEach(() => {
  sql.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function box(id: string, options: {
  due?: number; active?: number; provider?: string; mode?: string; leaseUntil?: number;
} = {}) {
  const workspaceId = `workspace-${id}`;
  sql.prepare('INSERT INTO support_workspaces(id,owner_id,name,mode,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(workspaceId, `owner-${id}`, id, options.mode ?? 'review', TIME, TIME);
  const secret = await encryptSecret('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'mailbox-fixture', `connection:${workspaceId}:${id}`);
  sql.prepare('INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, workspaceId, options.provider ?? 'infomaniak', id, 'mail.infomaniak.com', `${id}@example.test`, secret, '', '{}', '{}', options.active ?? 1, TIME);
  sql.prepare('INSERT INTO support_mailboxes(connection_id,workspace_id,email,mailbox_id,folder_id,since_at,next_sync_at,lease,lease_until) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, workspaceId, `${id}@example.test`, id, 'inbox', TIME - 100, options.due ?? TIME - 10, options.leaseUntil ? 'existing-owner' : null, options.leaseUntil ?? 0);
  return {
    workspace: sql.prepare('SELECT * FROM support_workspaces WHERE id=?').get(workspaceId) as unknown as Workspace,
    connection: sql.prepare('SELECT * FROM support_connections WHERE id=?').get(id) as unknown as Connection,
  };
}
const mailbox = (id: string) => sql.prepare('SELECT * FROM support_mailboxes WHERE connection_id=?').get(id)!;
function replaceLease(id: string) {
  sql.prepare('UPDATE support_mailboxes SET lease=?,lease_until=?,next_sync_at=?,scan_offset=?,last_sync_at=?,last_error=? WHERE connection_id=?')
    .run('replacement-owner', TIME + 900, TIME + 777, 80, TIME - 7, 'replacement-status', id);
  return mailbox(id);
}

it('claims different oldest due mailboxes while two scheduler requests overlap', async () => {
  await box('a'); await box('b');
  const barrier = gate(), release = gate(), seen: string[] = [];
  onList = async id => { seen.push(id); if (seen.length === 2) barrier.resolve(); await release.promise; };
  const runs = [runMailSync(request()), runMailSync(request())];
  let results;
  try {
    await entered(barrier);
    expect(seen.sort()).toEqual(['a', 'b']);
    expect(mailbox('a').lease).not.toBe(mailbox('b').lease);
    expect(mailbox('a').lease_until).toBe(TIME + 600);
    expect(mailbox('b').lease_until).toBe(TIME + 600);
  } finally { release.resolve(); results = await Promise.all(runs); }
  expect(results).toEqual([
    expect.objectContaining({ idle: false, imported: 1 }),
    expect.objectContaining({ idle: false, imported: 1 }),
  ]);
});

it('keeps a manual future-due sync exclusive while the scheduler services another mailbox', async () => {
  const manual = await box('a', { due: TIME + 300 }); await box('b');
  const barrier = gate(), release = gate();
  onList = async id => { if (id === 'a') { barrier.resolve(); await release.promise; } };
  const pending = syncMailbox(manual.workspace, manual.connection);
  let result;
  try {
    await entered(barrier);
    expect(await syncMailbox(manual.workspace, manual.connection)).toMatchObject({ syncing: true });
    expect(await runMailSync(request())).toMatchObject({ idle: false, imported: 1 });
    expect(mailbox('a').lease).not.toBeNull();
    expect(mailbox('b').lease).toBeNull();
  } finally { release.resolve(); result = await pending; }
  expect(result).toMatchObject({ imported: 1 });
});

it('excludes future, leased, paused, disconnected and non-mail connections without provider reads', async () => {
  await box('future', { due: TIME + 1 });
  await box('leased', { leaseUntil: TIME + 1 });
  await box('paused', { mode: 'paused' });
  await box('inactive', { active: 0 });
  await box('other', { provider: 'zendesk' });
  const before = sql.prepare('SELECT * FROM support_mailboxes ORDER BY connection_id').all();
  expect(await runMailSync(request())).toMatchObject({ idle: true });
  expect(provider).not.toHaveBeenCalled();
  expect(sql.prepare('SELECT * FROM support_mailboxes ORDER BY connection_id').all()).toEqual(before);
});

it('serves 150 due SQLite mailboxes in bounded cycles despite one failed oldest mailbox', async () => {
  emptyMailbox = true;
  for (let index = 0; index < 150; index++)
    await box(`box-${String(index).padStart(3, '0')}`, { due: TIME - 200 + index });
  const visited: string[] = [];
  onList = async id => {
    visited.push(id);
    if (id === 'box-000') throw new Error('Fixture provider unavailable');
  };
  let remaining = 150, checked = 0, failures = 0, cycles = 0;
  while (remaining > 0 && cycles < 40) {
    const result = await runMailSyncBatch(request());
    expect(result.mailboxes.checked).toBeGreaterThan(0);
    expect(result.mailboxes.checked).toBeLessThanOrEqual(4);
    expect(result.mailboxes.active).toBe(0);
    expect(result.mailboxes.due).toBeLessThan(remaining);
    checked += result.mailboxes.checked;
    failures += result.mailboxes.failed;
    remaining = result.mailboxes.due;
    cycles++;
  }
  expect({ checked, failures, remaining, cycles }).toEqual({ checked: 150, failures: 1, remaining: 0, cycles: 38 });
  expect(visited).toHaveLength(150);
  expect(new Set(visited).size).toBe(150);
  expect(mailbox('box-000')).toMatchObject({ lease: null, lease_until: 0, next_sync_at: TIME + 300, last_sync_at: null });
  expect(sql.prepare('SELECT COUNT(*) AS n FROM support_mailboxes WHERE last_sync_at=? AND lease IS NULL').get(TIME)).toMatchObject({ n: 149 });
  expect(await runMailSyncBatch(request())).toMatchObject({ idle: true, failed: false, mailboxes: { checked: 0, due: 0, active: 0 } });
});

it.each(['success', 'error'])('preserves the replacement lease after a late provider %s', async outcome => {
  await box('a');
  const barrier = gate(), release = gate();
  onRead = async () => { barrier.resolve(); await release.promise; if (outcome === 'error') throw new Error('Provider interrupted'); };
  const pending = runMailSync(request());
  let replacement, result;
  try { await entered(barrier); replacement = replaceLease('a'); }
  finally { release.resolve(); result = await pending; }
  expect(result).toMatchObject({ idle: false, syncing: true, incomplete: true });
  expect(mailbox('a')).toEqual(replacement);
  expect(mocks.ingest).not.toHaveBeenCalled();
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.process).not.toHaveBeenCalled();
});

it('does not revive an expired lease or continue effects after a slow read', async () => {
  await box('a');
  onRead = async () => { clock.mockReturnValue((TIME + 601) * 1000); };
  expect(await runMailSync(request())).toMatchObject({ syncing: true, incomplete: true });
  expect(mailbox('a').lease_until).toBeLessThanOrEqual(TIME + 600);
  expect(mailbox('a').scan_offset).toBe(0);
  expect(mailbox('a').last_sync_at).toBeNull();
  expect(mocks.ingest).not.toHaveBeenCalled();
});

it('backs off and releases its claim when subscription validation rejects before any provider read', async () => {
  await box('a');
  mocks.subscription.mockImplementation(async () => {
    expect(mailbox('a').lease).not.toBeNull();
    throw new SupportError('Abonnement expiré.', 403);
  });
  expect(await runMailSync(request())).toMatchObject({ idle: false, failed: true });
  expect(provider).not.toHaveBeenCalled();
  expect(mailbox('a')).toMatchObject({ lease: null, lease_until: 0, next_sync_at: TIME + 300 });
});

it('starts no provider work once the caller deadline has already elapsed', async () => {
  await box('a');
  expect(await runMailSync(request(), { deadline: TIME * 1000 })).toMatchObject({ incomplete: true, budgetExhausted: true });
  expect(provider).not.toHaveBeenCalled();
  expect(mailbox('a').lease).toBeNull();
});

it('persists the admitted mailbox when its read crosses the admission deadline', async () => {
  await box('a');
  onRead = async () => { clock.mockReturnValue((TIME + 2) * 1000); };
  expect(await runMailSync(request(), { deadline: (TIME + 1) * 1000 })).toMatchObject({ imported: 1, incomplete: false });
  expect(mailbox('a')).toMatchObject({ lease: null, lease_until: 0, next_sync_at: TIME + 302, scan_offset: 0, last_sync_at: TIME + 2 });
  expect(mocks.ingest).toHaveBeenCalledTimes(1);
});

it.each(['paused', 'disconnected'])('stops subsequent provider reads when a claimed mailbox becomes %s', async mode => {
  await box('a');
  onList = async () => {
    if (mode === 'paused') sql.prepare("UPDATE support_workspaces SET mode='paused' WHERE id=?").run('workspace-a');
    else sql.prepare('UPDATE support_connections SET active=0 WHERE id=?').run('a');
  };
  const result = await runMailSync(request());
  expect(result).not.toMatchObject({ imported: 1 });
  expect(provider).toHaveBeenCalledTimes(1);
  expect(mocks.ingest).not.toHaveBeenCalled();
});

it.each(['list', 'prepare', 'capture'])('finishes an admitted mailbox after slow %s crosses the admission deadline', async stage => {
  await box('slow');
  const advance = () => { clock.mockReturnValue((TIME + 25) * 1000); };
  const actualPrepare = mailDocuments.prepareMailDocuments;
  const preparation = vi.spyOn(mailDocuments, 'prepareMailDocuments');
  if (stage === 'list') onList = async () => { advance(); };
  if (stage === 'prepare') preparation.mockImplementation(async (...args) => {
    advance(); return actualPrepare(...args);
  });
  if (stage === 'capture') {
    mocks.captureNeeded.mockResolvedValue(true);
    mocks.capture.mockImplementation(async () => { advance(); });
  }
  const result = await runMailSync(request(), { deadline: (TIME + 20) * 1000 });
  expect(result).toMatchObject({ idle: false, imported: 1, incomplete: false });
  expect(result.budgetExhausted).not.toBe(true);
  expect(mocks.ingest).toHaveBeenCalledTimes(1);
  expect(preparation).toHaveBeenCalledTimes(1);
  expect(mailbox('slow')).toMatchObject({ lease: null, lease_until: 0,
    last_sync_at: TIME + 25, next_sync_at: TIME + 325, scan_offset: 0 });
  // The completed unit is persisted and is not prepared/captured again next tick.
  expect(await runMailSync(request())).toMatchObject({ idle: true });
  expect(preparation).toHaveBeenCalledTimes(1);
  expect(mocks.ingest).toHaveBeenCalledTimes(1);
  expect(mocks.capture).toHaveBeenCalledTimes(stage === 'capture' ? 1 : 0);
});

it('finishes both admitted slow units but does not claim a third mailbox after the deadline', async () => {
  for (const id of ['a','b','c']) await box(id);
  const actualPrepare=mailDocuments.prepareMailDocuments;
  vi.spyOn(mailDocuments,'prepareMailDocuments').mockImplementation(async (...args)=>{
    clock.mockReturnValue((TIME+25)*1000);return actualPrepare(...args);
  });
  const result=await runMailSyncBatch(request());
  expect(result).toMatchObject({ imported:2,more:true,mailboxes:{checked:2,due:1,active:0,budgetExhausted:true} });
  expect(mailbox('a').last_sync_at).toBe(TIME+25);
  expect(mailbox('b').last_sync_at).toBe(TIME+25);
  expect(mailbox('c')).toMatchObject({lease:null,lease_until:0,last_sync_at:null});
  expect(mocks.ingest).toHaveBeenCalledTimes(2);
});

it('still fences effects when a slow preparation loses its lease', async () => {
  await box('a');
  const actualPrepare=mailDocuments.prepareMailDocuments;
  let replacement:ReturnType<typeof mailbox>;
  vi.spyOn(mailDocuments,'prepareMailDocuments').mockImplementation(async (...args)=>{
    clock.mockReturnValue((TIME+25)*1000);replacement=replaceLease('a');return actualPrepare(...args);
  });
  expect(await runMailSync(request(),{deadline:(TIME+20)*1000})).toMatchObject({syncing:true,incomplete:true});
  expect(mailbox('a')).toEqual(replacement!);
  expect(mocks.ingest).not.toHaveBeenCalled();expect(mocks.capture).not.toHaveBeenCalled();
});
