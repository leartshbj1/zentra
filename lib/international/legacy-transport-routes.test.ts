import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const mock = vi.hoisted(() => ({
  session: vi.fn(), backupSession: vi.fn(), filesSession: vi.fn(), recoverySession: vi.fn(),
  guard: vi.fn(), upstream: vi.fn(), database: vi.fn(), storage: vi.fn(),
  client: vi.fn(), configuration: vi.fn(), watch: vi.fn(),
  jsonBody: vi.fn(), bytesBody: vi.fn(), user: vi.fn(), memberships: vi.fn(), rate: vi.fn(),
}));
vi.mock('@/lib/account', async original => ({
  ...await original<typeof import('@/lib/account')>(),
  requireDeviceSession: mock.session, membershipsForUser: mock.memberships,
  enforceAccountRateLimit: mock.rate, enforceSyncRateLimit: mock.rate,
}));
vi.mock('@/lib/international/legacy-country-guard', async original => ({
  ...await original<typeof import('@/lib/international/legacy-country-guard')>(),
  requireLegacyCountryTransport: mock.guard,
}));
vi.mock('@/lib/runtime', () => ({ database: mock.database, fileArchive: mock.storage }));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: mock.user }));
vi.mock('@/lib/request-body', async original => ({
  ...await original<typeof import('@/lib/request-body')>(),
  readJsonObjectWithinLimit: mock.jsonBody, readBytesBodyWithinLimit: mock.bytesBody,
}));
// Session facades are isolated so a library guard cannot hide an omitted HTTP guard.
vi.mock('@/lib/workspace-backup-http', async original => ({
  ...await original<typeof import('@/lib/workspace-backup-http')>(), backupSession: mock.backupSession,
}));
vi.mock('@/lib/business-sync-files-http', async original => ({
  ...await original<typeof import('@/lib/business-sync-files-http')>(), businessFilesSession: mock.filesSession,
}));
vi.mock('@/lib/backup-recovery', async original => ({
  ...await original<typeof import('@/lib/backup-recovery')>(),
  recoverySession: mock.recoverySession, recoveryDownload: mock.upstream,
}));
vi.mock('@/lib/workspace-backup', async original => ({
  ...await original<typeof import('@/lib/workspace-backup')>(),
  beginBackup: mock.upstream, listBackups: mock.upstream, completeBackup: mock.upstream,
  deleteBackup: mock.upstream, getBackup: mock.upstream,
  downloadBackupChunk: mock.upstream, uploadBackupChunk: mock.upstream,
}));
vi.mock('@/lib/business-sync-bootstrap', () => ({
  abandonBootstrap: mock.upstream, beginBootstrap: mock.upstream,
  bootstrapStatus: mock.upstream, uploadBootstrapChunk: mock.upstream,
}));
vi.mock('@/lib/business-sync-validation', () => ({ structuralValidationStatus: mock.upstream, validateBootstrapStructure: mock.upstream }));
vi.mock('@/lib/business-sync-integrity', () => ({ bootstrapIntegrityStatus: mock.upstream, validateBootstrapIntegrity: mock.upstream }));
vi.mock('@/lib/business-sync-publication', () => ({ publishBootstrap: mock.upstream }));
vi.mock('@/lib/business-sync-files', () => ({
  beginBusinessFiles: mock.upstream, businessFilesStatus: mock.upstream, completeBusinessFiles: mock.upstream,
  uploadBusinessFilePage: mock.upstream, businessFileStatus: mock.upstream,
  uploadBusinessFilePart: mock.upstream, verifyBusinessFile: mock.upstream,
}));
vi.mock('@/lib/business-sync-history', () => ({ historyHead: mock.upstream, historyChunk: mock.upstream, historyFilePage: mock.upstream, historyFilePart: mock.upstream }));
vi.mock('@/lib/business-sync-transactions', () => ({ beginBusinessTransaction: mock.upstream, businessTransactionStatus: mock.upstream, uploadBusinessTransactionChunk: mock.upstream }));
vi.mock('@/lib/business-sync-transaction-validation', () => ({ businessTransactionValidationStatus: mock.upstream, validateBusinessTransaction: mock.upstream }));
vi.mock('@/lib/business-sync-transaction-fingerprint', () => ({ businessTransactionFingerprintStatus: mock.upstream, fingerprintBusinessTransaction: mock.upstream }));
vi.mock('@/lib/business-sync-transaction-review', () => ({ beginBusinessTransactionReview: mock.upstream, businessTransactionReviewStatus: mock.upstream, reviewBusinessTransaction: mock.upstream }));
vi.mock('@/lib/business-sync-transaction-files', () => ({ businessTransactionFileStatus: mock.upstream, uploadBusinessTransactionFilePart: mock.upstream, verifyBusinessTransactionFile: mock.upstream }));
vi.mock('@/lib/business-sync-transaction-delivery', () => ({ businessTransactionDeliveryResource: mock.upstream, businessTransactionDeliveryStatus: mock.upstream, prepareBusinessTransactionDelivery: mock.upstream }));
vi.mock('@/lib/business-sync-transaction-commit', () => ({ commitBusinessTransaction: mock.upstream, committedBusinessTransactionResource: mock.upstream, committedBusinessTransactionsSince: mock.upstream }));
vi.mock('@/lib/business-sync-committed-files', () => ({ committedBusinessTransactionFile: mock.upstream }));
vi.mock('@/lib/business-sync-retirement', () => ({ businessRetirement: mock.upstream, retireBusinessTransactions: mock.upstream, businessRetirementCancellation: mock.upstream, cancelBusinessRetirement: mock.upstream }));
vi.mock('@/lib/document-number-reservations', () => ({ numberReservationRequest: mock.upstream, reserveDocumentNumbers: mock.upstream }));
vi.mock('@/lib/company-copy', () => ({ requireCompanyCopy: mock.upstream, companyCopy: mock.upstream, publishCompanyCopy: mock.upstream }));
vi.mock('@/lib/company-collaboration', () => ({
  collaborationBase: mock.upstream, collaborationHead: mock.upstream,
  collaborationRevision: (value: number) => value, collaborationRevisionHead: mock.upstream,
  collaborationSnapshot: mock.upstream, commitCollaboration: mock.upstream,
  downloadCollaborationChunk: mock.upstream, prepareCollaboration: mock.upstream, receiveCollaborationChunk: mock.upstream,
}));
vi.mock('@/lib/company-content', () => ({ companyContentManifest: mock.upstream, prepareCompanyContent: mock.upstream, readCompanyContent: mock.upstream, receiveCompanyContent: mock.upstream }));
vi.mock('@/lib/company-realtime', () => ({ watchCompanyRevision: mock.watch }));
vi.mock('@/lib/supabase-server-runtime', () => ({ supabaseServerClient: mock.client, supabaseRealtimeConfiguration: mock.configuration }));
vi.mock('@/lib/team-seats', () => ({ teamSeats: mock.upstream, requireInvitationCapacity: mock.upstream, requireMemberSeat: mock.upstream }));

import { AccountPublicError } from '@/lib/account-security';
import { LegacyCountryTransportError } from './legacy-country-guard';
import * as bootstrap from '../../app/api/sync/bootstrap/route';
import * as structure from '../../app/api/sync/bootstrap/structure/route';
import * as integrity from '../../app/api/sync/bootstrap/integrity/route';
import * as publish from '../../app/api/sync/bootstrap/publish/route';
import * as pages from '../../app/api/sync/bootstrap/files/route';
import * as file from '../../app/api/sync/bootstrap/file/route';
import * as history from '../../app/api/sync/history/route';
import * as historyFile from '../../app/api/sync/history/file/route';
import * as numbers from '../../app/api/sync/numbers/route';
import * as transactions from '../../app/api/sync/transactions/route';
import * as validation from '../../app/api/sync/transactions/validate/route';
import * as fingerprint from '../../app/api/sync/transactions/fingerprint/route';
import * as review from '../../app/api/sync/transactions/review/route';
import * as transactionFile from '../../app/api/sync/transactions/file/route';
import * as delivery from '../../app/api/sync/transactions/delivery/route';
import * as commit from '../../app/api/sync/transactions/commit/route';
import * as retirement from '../../app/api/sync/transactions/retirement/route';
import * as cancel from '../../app/api/sync/transactions/retirement/cancel/route';
import * as backups from '../../app/api/backups/route';
import * as backupItem from '../../app/api/backups/item/route';
import * as backupChunk from '../../app/api/backups/chunk/route';
import * as recoveryList from '../../app/api/backups/account/route';
import * as recoveryFile from '../../app/api/backups/account/file/route';
import * as companyCopy from '../../app/api/account/company-copy/route';
import * as collaboration from '../../app/api/account/collaboration/route';
import * as team from '../../app/api/account/team/route';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Handler = (request: Request) => Promise<Response>;
const methods: Method[] = ['GET', 'POST', 'PUT', 'DELETE'];
const inventory: { path: string; module: Partial<Record<Method, Handler>> }[] = [
  { path: '/api/sync/bootstrap', module: bootstrap },
  { path: '/api/sync/bootstrap/structure', module: structure },
  { path: '/api/sync/bootstrap/integrity', module: integrity },
  { path: '/api/sync/bootstrap/publish', module: publish },
  { path: '/api/sync/bootstrap/files', module: pages },
  { path: '/api/sync/bootstrap/file', module: file },
  { path: '/api/sync/history', module: history },
  { path: '/api/sync/history/file', module: historyFile },
  { path: '/api/sync/numbers', module: numbers },
  { path: '/api/sync/transactions', module: transactions },
  { path: '/api/sync/transactions/validate', module: validation },
  { path: '/api/sync/transactions/fingerprint', module: fingerprint },
  { path: '/api/sync/transactions/review', module: review },
  { path: '/api/sync/transactions/file', module: transactionFile },
  { path: '/api/sync/transactions/delivery', module: delivery },
  { path: '/api/sync/transactions/commit', module: commit },
  { path: '/api/sync/transactions/retirement', module: retirement },
  { path: '/api/sync/transactions/retirement/cancel', module: cancel },
  { path: '/api/backups', module: backups },
  { path: '/api/backups/item', module: backupItem },
  { path: '/api/backups/chunk', module: backupChunk },
  { path: '/api/backups/account', module: recoveryList },
  { path: '/api/backups/account/file', module: recoveryFile },
  { path: '/api/account/company-copy', module: companyCopy },
  { path: '/api/account/collaboration', module: collaboration },
  { path: '/api/account/team', module: team },
];
const endpoints = inventory.flatMap(({ path, module }) => methods.flatMap(method => {
  const handler = module[method];
  return handler ? [{ label: `${method} ${path}`, path, method, handler }] : [];
}));
const actor = { organizationId: 'authenticated-company', organizationName: 'Entreprise fictive',
  sessionId: 'session', installationId: 'device', userId: 'owner', role: 'owner', subscriptionId: 'unpaid', entitlementValidUntil: 0 };

beforeEach(() => {
  vi.resetAllMocks();
  for (const session of [mock.session, mock.backupSession, mock.filesSession, mock.recoverySession]) session.mockResolvedValue(actor);
  mock.guard.mockRejectedValue(new LegacyCountryTransportError());
  mock.rate.mockResolvedValue(undefined);
  mock.upstream.mockResolvedValue({});
  mock.jsonBody.mockResolvedValue({});
  mock.bytesBody.mockResolvedValue(new Uint8Array([1]));
});
function request(path: string, method: Method) {
  const url = new URL(path, 'https://zentra.example');
  url.searchParams.set('organizationId', 'forged-company');
  const req = new Request(url, {
    method, ...(method === 'POST' || method === 'PUT' ? { body: 'not even valid JSON' } : {}),
  });
  const readers: MockInstance[] = [vi.spyOn(req, 'json'), vi.spyOn(req, 'text'), vi.spyOn(req, 'arrayBuffer')];
  if (req.body) readers.push(vi.spyOn(req.body, 'getReader'));
  return { req, readers };
}
function expectNoIO(req: Request, readers: ReturnType<typeof request>['readers']) {
  expect(req.bodyUsed).toBe(false);
  for (const reader of readers) expect(reader).not.toHaveBeenCalled();
  for (const spy of [mock.jsonBody, mock.bytesBody, mock.upstream, mock.database, mock.storage, mock.client, mock.configuration, mock.watch]) expect(spy).not.toHaveBeenCalled();
}

describe('legacy HTTP country boundary inventory', () => {
  it('covers every sync/backup route file and the three aggregated account routes', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const discover = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? discover(join(folder, entry.name)) : entry.name === 'route.ts' ? [relative(join(root, 'app'), folder).replaceAll('\\', '/')] : []);
    const actual = [...discover(join(root, 'app/api/sync')), ...discover(join(root, 'app/api/backups')),
      'api/account/company-copy', 'api/account/collaboration', 'api/account/team'].map(path => `/${path}`).sort();
    expect(inventory.map(route => route.path).sort()).toEqual(actual);
    expect(inventory).toHaveLength(26);
    expect(endpoints).toHaveLength(53);
  });

  it.each(endpoints)('$label refuses US before body, reads, retries, uploads, PG/D1 choice or watch', async ({ path, method, handler }) => {
    const { req, readers } = request(path, method);
    const response = await handler(req);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'international_legacy_transport_forbidden' });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mock.guard).toHaveBeenCalledOnce();
    expect(mock.guard).toHaveBeenCalledWith(actor.organizationId);
    expectNoIO(req, readers);
  });

  it.each(endpoints)('$label checks authentication/scope before invoking the country guard', async ({ path, method, handler }) => {
    for (const session of [mock.session, mock.backupSession, mock.filesSession, mock.recoverySession]) session.mockRejectedValue(new AccountPublicError('Accès refusé.', 401));
    const { req, readers } = request(path, method);
    expect((await handler(req)).status).toBe(401);
    expect(mock.guard).not.toHaveBeenCalled();
    expectNoIO(req, readers);
  });

  it.each(endpoints)('$label fails closed when the guard cannot read its prerequisite table', async ({ path, method, handler }) => {
    mock.guard.mockRejectedValue(new Error('D1_ERROR: no such table: international_workspace_creation_intents'));
    const { req, readers } = request(path, method);
    expect((await handler(req)).status).toBeGreaterThanOrEqual(500);
    expectNoIO(req, readers);
  });

  it('refuses a US watch before any realtime configuration or upstream read', async () => {
    const { req, readers } = request('/api/account/collaboration?watch=0', 'GET');
    expect((await collaboration.GET(req)).status).toBe(409);
    expectNoIO(req, readers);
  });

  it('rechecks the original company after long poll and withholds the result if it became US', async () => {
    mock.guard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new LegacyCountryTransportError());
    mock.configuration.mockReturnValue({ url: 'https://example.supabase.co', secretKey: 'synthetic-test-key' });
    mock.watch.mockResolvedValue({ organizationId: actor.organizationId, revision: 4 });
    const response = await collaboration.GET(new Request('https://zentra.example/api/account/collaboration?watch=3'));
    expect(response.status).toBe(409);
    expect(mock.session).toHaveBeenCalledTimes(2);
    expect(mock.guard.mock.calls).toEqual([[actor.organizationId], [actor.organizationId]]);
    expect(mock.watch).toHaveBeenCalledOnce();
    expect(mock.upstream).not.toHaveBeenCalled();
    expect(await response.json()).not.toHaveProperty('revision');
  });

  it.each(['organizationId', 'userId', 'installationId', 'sessionId'] as const)('withholds the old watch result when authenticated %s changed during the wait', async field => {
    mock.guard.mockResolvedValue(undefined);
    mock.session.mockResolvedValueOnce(actor).mockResolvedValueOnce({ ...actor, [field]: 'replacement' });
    mock.configuration.mockReturnValue({ url: 'https://example.supabase.co', secretKey: 'synthetic-test-key' });
    mock.watch.mockResolvedValue({ organizationId: actor.organizationId, revision: 4 });
    const response = await collaboration.GET(new Request('https://zentra.example/api/account/collaboration?watch=3'));
    expect(response.status).toBe(403);
    expect(mock.session).toHaveBeenCalledTimes(2);
    expect(mock.guard).toHaveBeenCalledOnce();
    expect(mock.upstream).not.toHaveBeenCalled();
    expect(await response.json()).not.toHaveProperty('revision');
  });

  it('preserves CH number write permissions before body or country lookup', async () => {
    mock.session.mockResolvedValue({ ...actor, role: 'read_only' });
    const { req, readers } = request('/api/sync/numbers', 'POST');
    expect((await numbers.POST(req)).status).toBe(403);
    expect(mock.guard).not.toHaveBeenCalled();
    expectNoIO(req, readers);
  });

  it('preserves the real CH full-backup role policy before country lookup', async () => {
    const actual = await vi.importActual<typeof import('@/lib/workspace-backup-http')>('@/lib/workspace-backup-http');
    mock.backupSession.mockImplementation(actual.backupSession);
    mock.session.mockResolvedValue({ ...actor, role: 'member' });
    const { req, readers } = request('/api/backups', 'GET');
    expect((await backups.GET(req)).status).toBe(403);
    expect(mock.guard).not.toHaveBeenCalled();
    expectNoIO(req, readers);
  });

  it('preserves CH team management permission before country lookup or body', async () => {
    mock.session.mockResolvedValue({ ...actor, role: 'member' });
    const { req, readers } = request('/api/account/team', 'POST');
    expect((await team.POST(req)).status).toBe(403);
    expect(mock.guard).not.toHaveBeenCalled();
    expectNoIO(req, readers);
  });

  it('keeps browser recovery available to an unpaid CH owner without a device or paid entitlement', async () => {
    const actual = await vi.importActual<typeof import('@/lib/backup-recovery')>('@/lib/backup-recovery');
    mock.recoverySession.mockImplementation(actual.recoverySession);
    mock.guard.mockResolvedValue(undefined);
    mock.user.mockResolvedValue({ userId: actor.userId });
    mock.memberships.mockResolvedValue([actor]);
    mock.upstream.mockResolvedValue([]);
    const response = await recoveryList.GET(new Request(`https://zentra.example/api/backups/account?organizationId=${actor.organizationId}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(mock.user).toHaveBeenCalledWith({ refreshSession: true });
    expect(mock.memberships).toHaveBeenCalledWith(actor.userId);
    expect(mock.session).not.toHaveBeenCalled();
    expect(mock.guard).toHaveBeenCalledWith(actor.organizationId);
    expect(mock.upstream).toHaveBeenCalledWith(actor.organizationId);
  });
});
