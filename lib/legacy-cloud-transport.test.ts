import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSessionContext } from './account';
import type { BackupManifest } from './workspace-backup';
import type { WorkspaceCreationIntent } from './international/workspace-creation';

const mocks = vi.hoisted(() => ({ database: vi.fn(), archive: vi.fn(), session: vi.fn(), rate: vi.fn(), user: vi.fn(), postgres: vi.fn(), announce: vi.fn() }));
vi.mock('./runtime', () => ({ database: mocks.database, fileArchive: mocks.archive }));
vi.mock('./account', async importOriginal => ({
  ...(await importOriginal<typeof import('./account')>()),
  requireDeviceSession: mocks.session, enforceAccountRateLimit: mocks.rate,
}));
vi.mock('../app/zentra-auth', () => ({ getZentraUser: mocks.user }));
vi.mock('./supabase-server-runtime', () => ({ supabaseServerClient: mocks.postgres, supabaseRealtimeConfiguration: vi.fn() }));
vi.mock('./company-realtime', () => ({ announceCompanyRevision: mocks.announce }));

import * as projects from '../app/api/projects/sync/route';
import { GET as projectFile } from '../app/api/projects/sync/file/route';
import * as invoices from '../app/api/archive/invoices/route';
import { GET as invoiceFile } from '../app/api/archive/invoices/[archiveId]/route';
import { GET as recoverInvoice } from '../app/api/archive/account/[archiveId]/route';
import { storedDocument, storeDocument, deleteDocument, downloadDocument } from './project-sync';
import { collaborationHead, collaborationRevisionHead, collaborationBase, collaborationSnapshot, prepareCollaboration, receiveCollaborationChunk, downloadCollaborationChunk, commitCollaboration, pruneCollaborationHistory, collaborationRevision } from './company-collaboration';
import { prepareCompanyContent, companyContentManifest, receiveCompanyContent, readCompanyContent, legacyContentChunk, pruneCompanyContent, contentHash } from './company-content';
import { AccountPublicError, sha256Hex } from './account-security';
import { d1WorkspaceCreationStore } from './international/workspace-creation-d1';
import { LEGACY_COUNTRY_GUARD_CODE, LegacyCountryTransportError } from './international/legacy-country-guard';

// Real local D1 SQL chain, with in-memory Node SQLite. Supabase, Auth, device
// verification and R2 are explicit test ports, not live services. No claim of
// Cloudflare behavior, external-store atomicity or two-connection concurrency.
const migrations = readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()
  .map(name => readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
const actorId = '20000000-0000-4000-8000-000000000001';
const us = '20000000-0000-4000-8000-000000000002';
const ch = 'legacy-ch';
const snapshot = '20000000-0000-4000-8000-000000000003';
const project = '20000000-0000-4000-8000-000000000004';
const timestamp = '2026-10-08T02:00:00.000Z';
const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const origin = 'https://zentra.example';
const actor = (organizationId: string, role: DeviceSessionContext['role'] = 'owner'): DeviceSessionContext => ({
  organizationId, organizationName: 'Fictitious company', subscriptionId: 'sub_expired_ch',
  userId: actorId, role, installationId: 'fictitious-pc', sessionId: 'fictitious-session', entitlementValidUntil: 0,
});
type Trace = { sql: string; values: SQLInputValue[] };
let sqlite: DatabaseSync;
let traces: Trace[];
let manifest: BackupManifest;
let digest: string;
let onGuard: (() => void) | undefined;
let authorizeSyntheticUsRecovery = false;
const objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
const storage = {
  put: vi.fn(async (key: string, bytes: Uint8Array, options: { customMetadata?: Record<string, string> }) => { objects.set(key, { bytes: bytes.slice(), customMetadata: options.customMetadata ?? {} }); }),
  get: vi.fn(async (key: string) => {
    const object = objects.get(key);
    return object ? { body: object.bytes, size: object.bytes.length, customMetadata: object.customMetadata, arrayBuffer: async () => object.bytes.slice().buffer } : null;
  }),
  delete: vi.fn(async (key: string) => { objects.delete(key); }),
};
const recoveryIdentity = (sql: string) => /^SELECT archive\.organization_id\s+FROM invoice_archives archive/.test(sql);
const guardQuery = (sql: string) => sql.includes('FROM international_workspace_creation_intents');
function adapter() {
  return { prepare(sql: string) {
    const trace: Trace = { sql, values: [] }; traces.push(trace);
    return { bind(...values: SQLInputValue[]) {
      trace.values = values;
      return {
        async first() {
          if (guardQuery(sql)) { const callback = onGuard; onGuard = undefined; callback?.(); }
          // An authorized legacy artifact with an admitted US identity cannot
          // exist through today's admission schema. Inject ONLY its identity
          // authorization result to verify this recovery boundary defensively;
          // this is not proof of an actual ready US organization or entitlement.
          if (authorizeSyntheticUsRecovery && recoveryIdentity(sql)) return { organization_id: us };
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
      };
    } };
  } } as unknown as Pick<D1Database, 'prepare'>;
}
beforeEach(async () => {
  vi.clearAllMocks(); objects.clear(); traces = []; onGuard = undefined; authorizeSyntheticUsRecovery = false;
  sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  for (const sql of migrations) sqlite.exec(sql);
  sqlite.prepare('INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at,seat_limit) VALUES(?,?,?,\'canceled\',0,0,1)').run('sub_expired_ch', 'cus_fictitious', 'price_fictitious');
  sqlite.prepare('INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,0,0)').run(ch, 'Entreprise CH fictive', 'sub_expired_ch', actorId);
  sqlite.prepare("INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,'owner',0)").run('membership-fictitious', ch, actorId, 'owner@example.invalid');
  mocks.database.mockReturnValue(adapter()); mocks.archive.mockReturnValue(storage);
  mocks.session.mockResolvedValue(actor(ch)); mocks.user.mockResolvedValue({ userId: actorId }); mocks.rate.mockResolvedValue(undefined);
  digest = await sha256Hex(pdf);
  manifest = { format: 'zentra-cloud-backup', version: 1, app_version: '1.90.15', sha256: digest, size_bytes: pdf.length, chunks: [{ sha256: digest, size_bytes: pdf.length }] };
});
afterEach(() => sqlite.close());
async function reserveUs(state: 'reserved' | 'postgres_confirmed' = 'reserved') {
  const intent: WorkspaceCreationIntent = {
    organizationId: us, creationId: '20000000-0000-4000-8000-000000000005', actorUserId: actorId,
    requestId: '20000000-0000-4000-8000-000000000006', companyName: 'Fictitious US company', confirmationVersion: 1,
    fingerprint: 'a'.repeat(64), state: 'reserved', receipt: null, createdAt: timestamp, updatedAt: timestamp,
    configuration: { schemaVersion: 1, organizationId: us, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York',
      address: { country: 'US', line1: '10 Fictitious Avenue', postalCode: '10001', city: 'New York', subdivision: 'NY' },
      accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } },
  };
  const store = d1WorkspaceCreationStore(adapter()); await store.reserve(intent);
  if (state === 'postgres_confirmed') await store.confirm(intent, { creationId: intent.creationId, organizationId: us, actorUserId: actorId, requestId: intent.requestId, configurationFingerprint: intent.fingerprint, configuration: intent.configuration, revision: 1, updatedBy: actorId, updatedAt: timestamp, replayed: false }, timestamp);
  traces = []; mocks.session.mockResolvedValue(actor(us));
}
function assertNoStorageOrBusiness(allowRecoveryIdentity = false) {
  expect(traces.filter(trace => !guardQuery(trace.sql) && !(allowRecoveryIdentity && recoveryIdentity(trace.sql)))).toEqual([]);
  expect(mocks.postgres).not.toHaveBeenCalled(); expect(mocks.archive).not.toHaveBeenCalled(); expect(mocks.announce).not.toHaveBeenCalled();
  expect(storage.put).not.toHaveBeenCalled(); expect(storage.get).not.toHaveBeenCalled(); expect(storage.delete).not.toHaveBeenCalled();
  for (const trace of traces.filter(trace => guardQuery(trace.sql))) expect(trace.values).toEqual([us]);
}
const directIo: [string, (request: Request) => Promise<unknown>][] = [
  ['project stored metadata', () => storedDocument(us, snapshot)],
  ['project upload', request => storeDocument(request, us)],
  ['project deletion', () => deleteDocument(us, snapshot, project)],
  ['project download', () => downloadDocument(us, snapshot)],
  ['company head', () => collaborationHead(actor(us), 1)],
  ['company revision', () => collaborationRevisionHead(actor(us))],
  ['company baseline', () => collaborationBase(actor(us), 1)],
  ['company snapshot', () => collaborationSnapshot(actor(us), snapshot)],
  ['company prepare/replay', () => prepareCollaboration(actor(us), { id: snapshot, manifest, baseRevision: 0, confirmFullAccess: true, numbers: [] })],
  ['company receive', () => receiveCollaborationChunk(actor(us), snapshot, '0', pdf)],
  ['company download', () => downloadCollaborationChunk(actor(us), snapshot, '0')],
  ['company commit/replay', () => commitCollaboration(actor(us), snapshot)],
  ['company prune', () => pruneCollaborationHistory(us)],
  ['content prepare/replay', () => prepareCompanyContent(actor(us), { id: snapshot, manifest, entries: manifest.chunks, baseRevision: 0, confirmFullAccess: true })],
  ['content manifest', () => companyContentManifest(actor(us), snapshot, manifest)],
  ['content receive/replay', () => receiveCompanyContent(actor(us), snapshot, digest, pdf)],
  ['content download', () => readCompanyContent(actor(us), snapshot, digest)],
  ['legacy content reconstruction', () => legacyContentChunk(actor(us), snapshot, manifest, 0)],
  ['content prune', () => pruneCompanyContent(us)],
];
const contexts = { params: Promise.resolve({ archiveId: `arc_${snapshot}` }) };
const http: [string, string, (request: Request) => Promise<Response>][] = [
  ['project list', 'GET', projects.GET], ['project upload', 'PUT', projects.PUT], ['project deletion', 'DELETE', projects.DELETE],
  ['project download', 'GET', projectFile], ['invoice list', 'GET', invoices.GET], ['invoice upload/replay', 'POST', invoices.POST],
  ['invoice download', 'GET', request => invoiceFile(request, contexts)], ['account recovery', 'GET', request => recoverInvoice(request, contexts)],
];
const watchedRequest = (method: string) => {
  const request = new Request(`${origin}/api/test?id=${snapshot}&projectId=${project}`, { method, ...(method === 'POST' || method === 'PUT' ? { body: 'deliberately invalid unread payload' } : {}) });
  return { request, body: vi.spyOn(request, 'body', 'get'), text: vi.spyOn(request, 'text'), bytes: vi.spyOn(request, 'arrayBuffer') };
};

describe('legacy cloud I/O admission', () => {
  it.each(['reserved', 'postgres_confirmed'] as const)('denies every direct I/O export before SQL/PG/R2/body for %s US', async state => {
    await reserveUs(state);
    for (const [name, run] of directIo) {
      traces = []; const watched = watchedRequest('PUT');
      await expect(run(watched.request), name).rejects.toBeInstanceOf(LegacyCountryTransportError);
      expect(traces).toHaveLength(1); assertNoStorageOrBusiness();
      expect(watched.body).not.toHaveBeenCalled(); expect(watched.text).not.toHaveBeenCalled(); expect(watched.bytes).not.toHaveBeenCalled();
    }
  });
  it.each(['reserved', 'postgres_confirmed'] as const)('denies all file/archive HTTP transports with a stable code for %s US', async state => {
    await reserveUs(state);
    for (const [name, method, handler] of http) {
      traces = []; authorizeSyntheticUsRecovery = name === 'account recovery'; const watched = watchedRequest(method);
      const response = await handler(watched.request);
      expect(response.status, name).toBe(409); expect(await response.json()).toMatchObject({ code: LEGACY_COUNTRY_GUARD_CODE });
      expect(response.headers.get('cache-control')).toContain('no-store'); assertNoStorageOrBusiness(authorizeSyntheticUsRecovery);
      expect(watched.body).not.toHaveBeenCalled(); expect(watched.text).not.toHaveBeenCalled(); expect(watched.bytes).not.toHaveBeenCalled();
    }
    expect(mocks.rate).not.toHaveBeenCalled();
  });
  it('requires authentication before querying the guard, body or archive identity', async () => {
    mocks.session.mockRejectedValue(new AccountPublicError('Authentication required', 401)); mocks.user.mockResolvedValue(null);
    for (const [name, method, handler] of http) {
      const watched = watchedRequest(method); expect((await handler(watched.request)).status, name).toBe(401);
      expect(watched.body).not.toHaveBeenCalled();
    }
    expect(traces).toEqual([]); expect(mocks.postgres).not.toHaveBeenCalled(); expect(mocks.archive).not.toHaveBeenCalled();
  });
  it('checks write roles before the country guard while preserving CH consultation', async () => {
    await reserveUs(); mocks.session.mockResolvedValue(actor(us, 'read_only'));
    for (const [method, handler] of [['PUT', projects.PUT], ['DELETE', projects.DELETE], ['POST', invoices.POST]] as const)
      expect((await handler(watchedRequest(method).request)).status).toBe(403);
    for (const run of [() => prepareCollaboration(actor(us, 'read_only'), {}), () => receiveCollaborationChunk(actor(us, 'read_only'), snapshot, '0', pdf), () => commitCollaboration(actor(us, 'read_only'), snapshot), () => prepareCompanyContent(actor(us, 'read_only'), {}), () => receiveCompanyContent(actor(us, 'read_only'), snapshot, digest, pdf)])
      await expect(run()).rejects.toMatchObject({ status: 403 });
    expect(traces).toEqual([]); expect(mocks.postgres).not.toHaveBeenCalled(); expect(mocks.archive).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue(actor(ch, 'read_only'));
    expect((await projects.GET(new Request(`${origin}/api/projects/sync`))).status).toBe(200);
    expect((await invoices.GET(new Request(`${origin}/api/archive/invoices`))).status).toBe(200);
  });
  it('fails closed at every direct I/O entry when the required guard table is missing', async () => {
    sqlite.exec('DROP TABLE international_workspace_creation_intents');
    for (const [name, run] of directIo) {
      traces = []; const watched = watchedRequest('PUT'); await expect(run(watched.request), name).rejects.toThrow('no such table');
      assertNoStorageOrBusiness(); expect(watched.body).not.toHaveBeenCalled();
    }
  });
  it('keeps parsers independent of admission and storage', () => {
    expect(collaborationRevision(7)).toBe(7); expect(contentHash('a'.repeat(64))).toBe('a'.repeat(64)); expect(traces).toEqual([]);
  });
});

async function uploadCh() {
  return invoices.POST(new Request(`${origin}/api/archive/invoices`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceInvoiceId: 'fictitious-invoice', revision: 1, invoiceNumber: 'F-2026/42', issueDate: '2026-10-08', correctionKind: 'initial', pdfBase64: btoa(String.fromCharCode(...pdf)) }) }));
}
async function storedArchiveContext() {
  expect((await uploadCh()).status).toBe(201);
  const row = sqlite.prepare('SELECT archive_id FROM invoice_archives WHERE organization_id=?').get(ch)!;
  return { params: Promise.resolve({ archiveId: String(row.archive_id) }) };
}
describe('Swiss invoice archiving and account recovery', () => {
  it('stores, replays, lists and downloads the exact immutable CH PDF through the complete SQL chain', async () => {
    const context = await storedArchiveContext();
    const replay = await uploadCh(); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ alreadyStored: true });
    expect(storage.put).toHaveBeenCalledOnce();
    const list = await invoices.GET(new Request(`${origin}/api/archive/invoices`)); expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ archives: [{ invoiceNumber: 'F-2026/42', status: 'stored' }] });
    const response = await invoiceFile(new Request(`${origin}/api/archive/invoices/file`), context);
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(pdf);
    expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('x-zentra-content-sha256')).toBe(digest);
    expect(sqlite.prepare('SELECT COUNT(*) total FROM invoice_archives').get()).toEqual({ total: 1 });
  });
  it('allows an active CH member to recover exact archived bytes after subscription expiry', async () => {
    const context = await storedArchiveContext(); traces = []; mocks.session.mockClear(); storage.get.mockClear();
    const response = await recoverInvoice(new Request(`${origin}/api/archive/account/file`), context);
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(pdf);
    expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.user).toHaveBeenCalledWith({ refreshSession: true });
    expect(traces.map(trace => recoveryIdentity(trace.sql) ? 'authorization' : guardQuery(trace.sql) ? 'guard' : 'metadata')).toEqual(['authorization', 'guard', 'metadata']);
    expect(traces[0].values).toEqual([actorId, (await context.params).archiveId]);
    expect(traces[2].values).toEqual([actorId, (await context.params).archiveId, ch]);
    expect(traces.some(trace => /subscriptions|license_activations/.test(trace.sql))).toBe(false);
    expect(sqlite.prepare('SELECT status,current_period_end FROM subscriptions').get()).toEqual({ status: 'canceled', current_period_end: 0 });
  });
  it('does not disclose country, metadata or bytes to another account or a revoked member', async () => {
    const context = await storedArchiveContext();
    for (const userId of ['another-account', actorId]) {
      if (userId === actorId) sqlite.exec('UPDATE organization_members SET revoked_at=1');
      mocks.user.mockResolvedValue({ userId }); traces = []; storage.get.mockClear();
      expect((await recoverInvoice(new Request(`${origin}/api/archive/account/file`), context)).status).toBe(404);
      expect(traces).toHaveLength(1); expect(recoveryIdentity(traces[0].sql)).toBe(true); expect(storage.get).not.toHaveBeenCalled();
    }
  });
  it('rechecks membership after admission, before retrieving R2 bytes', async () => {
    const context = await storedArchiveContext(); traces = []; storage.get.mockClear();
    onGuard = () => sqlite.exec('UPDATE organization_members SET revoked_at=1');
    expect((await recoverInvoice(new Request(`${origin}/api/archive/account/file`), context)).status).toBe(404);
    expect(traces).toHaveLength(3); expect(storage.get).not.toHaveBeenCalled();
  });
  it('returns unavailable without metadata/body/R2 access if the guard migration is missing', async () => {
    const context = await storedArchiveContext(); sqlite.exec('DROP TABLE international_workspace_creation_intents'); traces = []; storage.get.mockClear();
    expect((await recoverInvoice(new Request(`${origin}/api/archive/account/file`), context)).status).toBe(500);
    expect(traces).toHaveLength(2); expect(recoveryIdentity(traces[0].sql)).toBe(true); expect(guardQuery(traces[1].sql)).toBe(true); expect(storage.get).not.toHaveBeenCalled();
    for (const [name, method, handler] of http.filter(([name]) => name !== 'account recovery')) {
      traces = []; const watched = watchedRequest(method); expect((await handler(watched.request)).status, name).toBe(500);
      expect(traces).toHaveLength(1); expect(guardQuery(traces[0].sql)).toBe(true); expect(watched.body).not.toHaveBeenCalled();
    }
    expect(storage.get).not.toHaveBeenCalled();
  });
});
