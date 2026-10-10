import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../support/crypto';
import { createLedger } from './accounting/ledger';
import { usStarterChart } from './countries/us/accounting';
import { sha256Hex } from './canonical-hash';
import { mailboxImportFixture } from './us-support-mailbox-import-test-fixture';
import { createUsMailboxImportHandler, type UsMailboxImportDependencies } from './us-support-mailbox-import-server';
import { usMailboxEncryptionContext } from './us-support-mailbox-contract';
import type { UsMailboxImportRequest, UsMailboxImportStore } from './us-support-mailbox-import-contract';
import type { UsSupplierDocumentRecord, UsSupplierDocumentStore } from './us-supplier-document-contract';
import type { UsSupplierDocumentArchive } from './us-supplier-document-archive';
import type { ErpState } from './runtime-types';
import { d1UsTeamStore } from './us-team-store';
import { hashUsTeamCommand, hashUsTeamToken, newUsTeamToken } from './us-team-validation';
import type { UsTeamContext, UsTeamPrivateCommand } from './us-team-contract';

type Base = Awaited<ReturnType<typeof mailboxImportFixture>>;
/** These in-memory test ports use closures only; no receiver is required. */
type StatelessPort<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (this: void, ...args: A) => R : T[K] };
const opened: Base[] = [];
afterEach(() => { for (const f of opened.splice(0)) { expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]); f.sql.close(); } });
async function actualMember(f: Base, role: 'admin'|'accountant'|'member'|'read_only') {
  const userId = randomUUID(), email = userId+'@example.test', a = f.context().authority;
  const owner: UsTeamContext = { schemaVersion:1,organizationId:a.organizationId,mode:'member',role:a.role,user:{ userId:f.actor,email:null,emailConfirmed:false },subscriptionId:a.subscriptionId,
    environment:a.environment,catalogVersion:a.catalogVersion,priceId:a.priceId,seatLimit:a.seatLimit,checkedAt:a.checkedAt,validStartsAt:a.validStartsAt,validEndsAt:a.validEndsAt,credential:a.credential };
  const store = d1UsTeamStore(f.database,{ now:f.now }), invitationId = randomUUID(), tokenHash = await hashUsTeamToken(newUsTeamToken());
  const invitation: UsTeamPrivateCommand = { schemaVersion:1,requestId:randomUUID(),expectedTeamRevision:await store.revision(owner),action:'create_invitation',email,role,invitationId,tokenHash,expiresAt:f.now()+604800 };
  await store.commit({ context:owner,command:invitation,requestHash:await hashUsTeamCommand(a.organizationId,f.actor,invitation) });
  const accept: UsTeamPrivateCommand = { schemaVersion:1,requestId:randomUUID(),expectedTeamRevision:await store.revision(owner),action:'accept_invitation',invitationId,tokenHash,membershipId:randomUUID(),firstName:'US',lastName:'TEST',displayName:'US TEST' };
  await store.commit({ context:{ ...owner,mode:'recipient',role,user:{ userId,email,emailConfirmed:true } },command:accept,requestHash:await hashUsTeamCommand(a.organizationId,userId,accept) });
  return userId;
}
async function fixture() {
  const f = await mailboxImportFixture(); opened.push(f);
  const org = f.intent.organizationId, key = btoa('x'.repeat(32)), token = 'H2b-fictitious-only'; let currentUser: string = f.actor;
  async function reconnect(expectedRevision: number) {
    const connectionId = randomUUID(), c = f.context(currentUser);
    const credentialsCiphertext = await encryptSecret(key,token,usMailboxEncryptionContext(c,connectionId,expectedRevision+1));
    await f.mailbox.commit(c,{ ...f.connection,requestId:randomUUID(),expectedRevision,connectionId,tokenSha256:await sha256Hex(token),credentialsCiphertext,verifiedAt:f.now() },async () => f.context(currentUser));
    return connectionId;
  }
  const connectionId = await reconnect(1), bytes = new TextEncoder().encode('%PDF-1.7\nFictitious composition only');
  const source = f.source({ sourceName:'invoice.pdf',documentName:'invoice.pdf',sizeBytes:bytes.length,contentSha256:await sha256Hex(bytes),receivedAt:f.now(),messageVersion:String(f.now()) });
  const input = f.request({ connectionId,expectedMailboxRevision:2,expectedMessageVersion:source.messageVersion });
  const configuration = f.intent.configuration;
  const state: ErpState = { schemaVersion:4,revision:10,configuration,counters:{ estimate:0,invoice:0,project:0 },
    ledger:createLedger({ organizationId:org,currency:'USD',basis:'accrual',accounts:usStarterChart,periods:[] }),customers:[],estimates:[],invoices:[],projects:[],vendors:[],vendorBills:[],vendorPayments:[] };
  const records = new Map<string,UsSupplierDocumentRecord>(), objects = new Map<string,Uint8Array>();
  const documents: StatelessPort<UsSupplierDocumentStore> = {
    list:async () => structuredClone([...records.values()]),read:vi.fn<UsSupplierDocumentStore['read']>(async (_actor,id) => structuredClone(records.get(id) ?? null)),
    reserve:vi.fn<UsSupplierDocumentStore['reserve']>(async (_actor,descriptor) => { const previous = records.get(descriptor.id) ?? [...records.values()].find(r => r.organizationId === descriptor.organizationId && r.contentSha256 === descriptor.contentSha256); if (previous) return structuredClone(previous);
      const saved = { ...descriptor,stored:false,proposalId:null }; records.set(saved.id,saved); return structuredClone(saved); }),
    complete:vi.fn<UsSupplierDocumentStore['complete']>(async (_actor,id) => { const saved = { ...records.get(id)!,stored:true }; records.set(id,saved); return structuredClone(saved); }),
    link:vi.fn(async () => { throw new Error('No analysis/financial operation in this composition'); }),
  };
  const archive: StatelessPort<UsSupplierDocumentArchive> = {
    get:vi.fn<UsSupplierDocumentArchive['get']>(async k => { const b = objects.get(k); return b ? { size:b.length,body:new Blob([Uint8Array.from(b)]).stream() } : null; }),
    put:vi.fn<UsSupplierDocumentArchive['put']>(async (k,b,options) => { expect(options.onlyIf.get('If-None-Match')).toBe('*'); if (!objects.has(k)) objects.set(k,b.slice()); return {}; }),
  };
  const dependencies: UsMailboxImportDependencies = {
    enabled:async () => true,now:f.now,member:async () => f.context(currentUser),configuration:async () => structuredClone(configuration),freshSupportedSchemaVersion:() => 4,
    store:() => ({ supportedSchemaVersion:4,read:async () => structuredClone(state),receipt:async () => null,commit:vi.fn(async () => { throw new Error('No ERP writes'); }) }),
    mailboxStore:async () => f.mailbox,importStore:async () => f.imports,documentStore:async () => documents,archive:async () => archive,
    findDocument:async (actor,hash) => structuredClone([...records.values()].find(r => r.organizationId === actor.organizationId && r.contentSha256 === hash) ?? null),
    encryptionKey:vi.fn(async () => key),attachment:vi.fn<UsMailboxImportDependencies['attachment']>(async (_connection,secret,_request,check) => { await check(); expect(secret).toBe(token); return { source:structuredClone(source),bytes:bytes.slice() }; }),extractText:async () => null,
  };
  const handler = createUsMailboxImportHandler(dependencies);
  const run = (q: UsMailboxImportRequest = input) => handler(new Request('https://zentra.example.test/api/import',{ method:'POST',headers:{ Origin:'https://zentra.example.test','Content-Type':'application/json','X-Zentra-Erp-Schema-Version':'4','X-Zentra-Expected-User':currentUser },body:JSON.stringify(q) }),org);
  const disconnect = async (expectedRevision = 2) => f.mailbox.commit(f.context(currentUser),{ schemaVersion:1,requestId:randomUUID(),action:'disconnect',expectedRevision },async () => f.context(currentUser));
  return { f,org,input,source,records,objects,documents,archive,dependencies,run,reconnect,disconnect,actor(userId:string) { currentUser = userId; } };
}

describe('HTTP H2b → real D1 0000..0095; fictitious PG/R2/provider ports only', () => {
  it('imports once, returns a sanitized exact DTO, then replays after real disconnect and secret purge', async () => {
    const t = await fixture(), before = structuredClone(t.f.snapshot()), response = await t.run(); expect(response.status).toBe(200);
    const body = await response.text(); expect(body).not.toMatch(/H2b-fictitious|messageSha256|mailboxId|folderId|documentText|credentialsCiphertext/);
    const first = JSON.parse(body) as { document:{ id:string }; requestHash:string }; expect(JSON.parse(body)).toMatchObject({ schemaVersion:1,organizationId:t.org,userId:t.f.actor,replayed:false,document:{ stored:true,readable:false } });
    await t.disconnect(); t.dependencies.encryptionKey = async () => { throw new Error('No old key on historical replay'); };
    const again = await t.run(); expect(again.status).toBe(200); expect(await again.json()).toMatchObject({ requestHash:first.requestHash,replayed:true,document:{ id:first.document.id } });
    expect(t.dependencies.attachment).toHaveBeenCalledOnce(); expect(t.records.size).toBe(1); expect(t.objects.size).toBe(1); expect(t.documents.link).not.toHaveBeenCalled();
    expect(t.f.sql.prepare('SELECT count(*) AS n FROM international_us_support_mail_import_completions').get()!.n).toBe(1);
    expect(t.f.sql.prepare('SELECT credentials_ciphertext FROM international_us_support_mailbox_secrets WHERE connection_id=?').get(t.input.connectionId)!.credentials_ciphertext).toBeNull();
    expect(t.f.snapshot()).toEqual(before); expect(t.f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(t.f.legacyBefore);
  });
  it('recovers a lost actual D1 completion response after disconnect, without a second provider read or blob write', async () => {
    const t = await fixture(), original = t.f.imports; let lost = true;
    const imports: UsMailboxImportStore = { ...original,async complete(...args) { const value = await original.complete(...args); if (lost) { lost = false; throw new Error('TEST lost D1 completion ACK'); } return value; } };
    t.dependencies.importStore = async () => imports;
    expect((await t.run()).status).toBe(503); await t.disconnect(); const response = await t.run(); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ replayed:true,document:{ stored:true } });
    expect(t.dependencies.attachment).toHaveBeenCalledOnce(); expect(t.archive.put).toHaveBeenCalledOnce(); expect(t.f.sql.prepare('SELECT count(*) AS n FROM international_us_support_mail_import_requests').get()!.n).toBe(1);
    expect(t.f.sql.prepare('SELECT count(*) AS n FROM international_us_support_mail_import_completions').get()!.n).toBe(1);
  });
  it('confirms pre-existing archived bytes into PG and D1 after losing the connection before PG confirmation', async () => {
    const t = await fixture(), complete = t.documents.complete; let first = true;
    t.documents.complete = async (...args) => { if (first) { first = false; await t.disconnect(); throw new Error('TEST no PG completion ACK'); } return complete(...args); };
    expect((await t.run()).status).toBe(503); expect(t.objects.size).toBe(1); expect([...t.records.values()][0].stored).toBe(false);
    const response = await t.run(); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ replayed:true,document:{ stored:true } }); expect(t.dependencies.attachment).toHaveBeenCalledOnce(); expect(t.archive.put).toHaveBeenCalledOnce();
  });
  it('uses real admin membership for a source alias through reconnect, preserving first source claim and canonical original', async () => {
    const t = await fixture(); const first = await (await t.run()).json() as { document:{ id:string } };
    const admin = await actualMember(t.f,'admin'); t.actor(admin); const connectionId = await t.reconnect(2);
    const response = await t.run({ ...t.input,requestId:randomUUID(),connectionId,expectedMailboxRevision:3 }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId:admin,document:{ id:first.document.id,createdBy:t.f.actor },replayed:true });
    expect(t.records.size).toBe(1); expect(t.objects.size).toBe(1); expect(t.f.sql.prepare('SELECT count(*) AS n FROM international_us_support_mail_import_sources').get()!.n).toBe(1);
    expect(t.f.sql.prepare('SELECT count(*) AS n FROM international_us_support_mail_import_requests').get()!.n).toBe(2);
    expect(t.f.sql.prepare('SELECT connection_id,claimed_by FROM international_us_support_mail_import_sources').get()).toMatchObject({ connection_id:t.input.connectionId,claimed_by:t.f.actor });
  });
  it.each(['accountant','member','read_only'] as const)('denies actual role %s before provider or a provenance claim', async role => {
    const t = await fixture(), userId = await actualMember(t.f,role); t.actor(userId); expect((await t.run()).status).toBe(403);
    expect(t.dependencies.attachment).not.toHaveBeenCalled(); expect(t.records.size).toBe(0); expect(t.f.sql.prepare('SELECT count(*) AS n FROM international_us_support_mail_import_requests').get()!.n).toBe(0);
  });
  it('rejects a substituted H1 registry at the actual store boundary before provider access', async () => {
    const t = await fixture(), unknownWorkspaceId = randomUUID(); t.dependencies.member = async () => ({ ...t.f.context(),workspaceId:unknownWorkspaceId });
    expect((await t.run()).status).toBe(403); expect(t.dependencies.attachment).not.toHaveBeenCalled(); expect(t.records.size).toBe(0);
  });
});
