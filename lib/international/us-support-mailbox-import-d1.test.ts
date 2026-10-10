import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { d1UsMailboxImportStore } from './us-support-mailbox-import-d1';
import { mailboxImportFixture, mailboxImportAuthority } from './us-support-mailbox-import-test-fixture';
import { UsMailboxError, type UsMailboxContext } from './us-support-mailbox-contract';
import { hashUsMailboxImportRequest, hashUsMailboxImportSource, type UsMailboxImportRequest, type UsMailboxImportSource, type UsMailboxImportStore } from './us-support-mailbox-import-contract';
import { d1UsTeamStore } from './us-team-store';
import { hashUsTeamCommand, hashUsTeamToken, newUsTeamToken } from './us-team-validation';
import type { UsTeamContext, UsTeamPrivateCommand } from './us-team-contract';
import { d1UsDeviceStore } from './us-device-d1';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { d1UsSupportWorkspaceStore } from './us-support-workspace-d1';
import { createOrResumeUsWorkspace } from './workspace-creation';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { d1UsTestPurchaseStore } from './us-saas-test-d1';
import { prepareUsAuthorityAdmission } from './saas-authority';
import { validateUsTestPurchase, verifiedUsTestSession, verifiedUsTestPaidProof } from './us-saas-test-contract';

type Fixture = Awaited<ReturnType<typeof mailboxImportFixture>>;
const opened: Fixture[] = [];
async function fixture(includeImport = true) { const f = await mailboxImportFixture(includeImport); opened.push(f); return f; }
afterEach(() => { for (const f of opened.splice(0)) { expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]); f.sql.close(); } });
function count(f: Fixture, suffix = 'requests'): number { return Number(f.sql.prepare('SELECT count(*) AS n FROM international_us_support_mail_import_'+suffix).get()!.n); }
async function claim(f: Fixture, q = f.request(), s = f.source({ uid:q.uid,attachmentId:q.attachmentId,messageVersion:q.expectedMessageVersion }), userId = f.actor, store: UsMailboxImportStore = f.imports) {
  return store.claim(f.context(userId),{ request:q,source:s,suggestedDocumentId:randomUUID() },async () => f.context(userId));
}
function intercepted(f: Fixture, batch: (this:void,statements: D1PreparedStatement[]) => Promise<D1Result[]>) { return { prepare:f.database.prepare.bind(f.database),batch } as Pick<D1Database,'prepare'|'batch'>; }
function team(c: UsMailboxContext): UsTeamContext { const a = c.authority; return { schemaVersion:1,organizationId:a.organizationId,mode:'member',role:a.role,
  user:{ userId:a.userId,email:null,emailConfirmed:false },subscriptionId:a.subscriptionId,environment:a.environment,catalogVersion:a.catalogVersion,priceId:a.priceId,
  seatLimit:a.seatLimit,checkedAt:a.checkedAt,validStartsAt:a.validStartsAt,validEndsAt:a.validEndsAt,credential:a.credential }; }
async function member(f: Fixture, role: 'admin'|'accountant'|'member'|'read_only') {
  const userId = randomUUID(), email = userId+'@example.test', store = d1UsTeamStore(f.database,{ now:f.now }), owner = team(f.context());
  const invitationId = randomUUID(), tokenHash = await hashUsTeamToken(newUsTeamToken());
  const invitation: UsTeamPrivateCommand = { schemaVersion:1,requestId:randomUUID(),expectedTeamRevision:await store.revision(owner),action:'create_invitation',email,role,invitationId,tokenHash,expiresAt:f.now()+604800 };
  await store.commit({ context:owner,command:invitation,requestHash:await hashUsTeamCommand(owner.organizationId,f.actor,invitation) });
  const accept: UsTeamPrivateCommand = { schemaVersion:1,requestId:randomUUID(),expectedTeamRevision:await store.revision(owner),action:'accept_invitation',invitationId,tokenHash,membershipId:randomUUID(),firstName:'US',lastName:'TEST',displayName:'US TEST' };
  await store.commit({ context:{ ...owner,mode:'recipient',role,user:{ userId,email,emailConfirmed:true } },command:accept,requestHash:await hashUsTeamCommand(owner.organizationId,userId,accept) });
  return userId;
}
async function native(f: Fixture, schema: ErpSchemaVersion) {
  const store = d1UsDeviceStore(f.database), sessionId = 'usd_'+randomUUID(), codeHash = randomBytes(32).toString('base64url'), tokenHash = randomBytes(32).toString('base64url');
  await store.start({ codeHash,tokenHash,installationId:randomUUID(),userCode:'ABCD-EFGH',schema,now:f.now() });
  await store.approve('ABCD-EFGH',{ organizationId:f.intent.organizationId,organizationName:'US TEST',userId:f.actor,role:'owner',subscriptionId:f.authority.subscriptionId,entitlementValidUntil:f.authority.evidence!.endsAt,configurationStamp:'fictitious TEST' },f.now());
  await store.consume((await store.challenge('code',codeHash))!,sessionId,f.now()); return { store,tokenHash,credential:{ kind:'device' as const,sessionId,supportedSchemaVersion:schema } };
}
function renewal(f: Fixture) { const invoiceId = 'in_ImportRenewal'; return f.paid({ invoiceId,sourceId:invoiceId,authority:{ ...f.authority,evidence:{ ...f.authority.evidence!,referenceId:invoiceId,startsAt:f.now(),endsAt:f.authority.evidence!.endsAt+3600 } } }); }
function insert(f: Fixture, table: string, values: Record<string,SQLInputValue>, replace = false) {
  const keys = Object.keys(values); f.sql.prepare(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table}(${keys.join(',')})VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(values));
}
async function rawRequest(f: Fixture, patch: Partial<UsMailboxImportRequest> = {}, sourcePatch: Partial<UsMailboxImportSource> = {}) {
  const q = f.request(patch), s = f.source({ uid:q.uid,attachmentId:q.attachmentId,messageVersion:q.expectedMessageVersion,...sourcePatch }), c = f.context();
  const values: Record<string,SQLInputValue> = { command_id:randomUUID(),organization_id:c.authority.organizationId,workspace_id:c.workspaceId,actor_user_id:c.authority.userId,
    request_id:q.requestId,request_hash:await hashUsMailboxImportRequest(c.authority.organizationId,c.authority.userId,q),connection_id:q.connectionId,mailbox_revision:q.expectedMailboxRevision,
    source_hash:await hashUsMailboxImportSource(c.authority.organizationId,c.workspaceId,s),request_json:canonicalErpJson(q),source_json:canonicalErpJson(s),context_json:canonicalErpJson(c),created_at:c.authority.checkedAt };
  return { q,s,values };
}
function insertSource(f: Fixture, r: Awaited<ReturnType<typeof rawRequest>>) {
  const v = r.values, s = r.s;
  insert(f,'international_us_support_mail_import_sources',{ organization_id:v.organization_id,workspace_id:v.workspace_id,source_hash:v.source_hash,first_command_id:v.command_id,
    connection_id:v.connection_id,mailbox_revision:v.mailbox_revision,suggested_document_id:randomUUID(),provider:s.provider,mailbox_id:s.mailboxId,folder_id:s.folderId,uid:s.uid,attachment_id:s.attachmentId,
    source_json:v.source_json,claimed_by:v.actor_user_id,claimed_at:v.created_at });
}
async function company(f: Fixture) {
  const stamp = new Date(f.now()*1000).toISOString(), { organizationId:_organizationId,...configuration } = f.intent.configuration;
  const initial = await createOrResumeUsWorkspace(f.actor,{ requestId:randomUUID(),confirmationVersion:1,companyName:'Second US import TEST',configuration },{
    store:d1WorkspaceCreationStore(f.database),allocateId:() => randomUUID(),now:() => stamp,fingerprint:async text => createHash('sha256').update(text).digest('hex'),
    admit:async i => ({ creationId:i.creationId,organizationId:i.organizationId,actorUserId:f.actor,requestId:i.requestId,configurationFingerprint:i.fingerprint,configuration:i.configuration,revision:1,updatedBy:f.actor,updatedAt:stamp,replayed:false }),revalidate:async () => {} });
  const subscriptionId = 'sub_'+initial.organizationId.replaceAll('-',''), invoiceId = 'in_'+initial.organizationId.replaceAll('-','');
  const current = { ...f.authority,organizationId:initial.organizationId,subscriptionId,evidence:{ ...f.authority.evidence!,organizationId:initial.organizationId,subscriptionId,referenceId:invoiceId } };
  const purchases = d1UsTestPurchaseStore(f.database), purchase = await purchases.reserve(initial,validateUsTestPurchase({ ...f.purchase,purchaseId:randomUUID(),creationId:initial.creationId,organizationId:initial.organizationId,requestId:initial.requestId,configurationFingerprint:initial.fingerprint,receipt:initial.receipt!,createdAt:f.now(),expiresAt:f.now()+3600 },initial),async () => {});
  const session = await purchases.bind(purchase,verifiedUsTestSession(purchase,{ purchaseId:purchase.purchaseId,sessionId:'cs_test_'+purchase.purchaseId.replaceAll('-',''),customerId:null,subscriptionId:null,createdAt:f.now(),expiresAt:purchase.expiresAt }),async () => {});
  const proof = verifiedUsTestPaidProof(purchase,{ purchaseId:purchase.purchaseId,sessionId:session.sessionId,customerId:'cus_SecondImport',subscriptionId,invoiceId,eventId:'evt_SecondImport',providerAccountId:purchase.providerAccountId,authority:current,serverPrice:f.price,verifiedAt:f.now() });
  await purchases.admit(initial,purchase,session,proof,prepareUsAuthorityAdmission(initial,{ authority:current,seatLimit:8 },{ ...f.policy,now:f.now() },f.price),async () => {});
  const a = () => mailboxImportAuthority(f,initial.organizationId), registry = await d1UsSupportWorkspaceStore(f.database,{ now:f.now }).create(a(),{ schemaVersion:1,requestId:randomUUID(),name:'Second US Support' },async () => a());
  return () => ({ schemaVersion:1 as const,authority:a(),workspaceId:registry.workspace.workspaceId });
}

describe('US mail attachment import on real0000..0095 SQLite; fake provider/PG/R2 proof boundary', () => {
  it('preserves legacy CH and initial US history, with no core Support insert', async () => {
    const f = await fixture(); const first = await claim(f);
    await f.imports.complete(f.context(),{ requestId:first.reservation.requestId,requestHash:first.reservation.requestHash,document:f.document() },async () => f.context());
    expect(f.snapshot()).toEqual(f.before); expect(f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(f.legacyBefore);
    for (const table of ['support_connections','support_mailboxes','support_members','support_tickets']) expect(f.sql.prepare('SELECT count(*) AS n FROM '+table).get()!.n).toBe(0);
    expect(count(f)).toBe(1); expect(count(f,'sources')).toBe(1); expect(count(f,'completions')).toBe(1);
  });
  it('keeps first claim ID/time, raw source name and private facts on exact retry', async () => {
    const f = await fixture(), q = f.request(), source = f.source(), first = await claim(f,q,source); f.setNow(f.now()+31);
    const again = await claim(f,q,source); expect(again).toEqual({ ...first,replayed:true }); expect(count(f)).toBe(1);
    const saved = f.sql.prepare('SELECT * FROM international_us_support_mail_import_requests').get()!;
    expect(saved.request_hash).toBe(await hashUsMailboxImportRequest(f.intent.organizationId,f.actor,q));
    const retained = JSON.stringify(f.sql.prepare('SELECT * FROM international_us_support_mail_import_sources').get());
    for (const secret of ['mailbox@example.test',f.connection.credentialsCiphertext,f.connection.tokenSha256]) expect(retained).not.toContain(secret);
  });
  it.each(['uid','attachmentId','expectedMessageVersion','connectionId','expectedMailboxRevision'] as const)('refuses changed same request material %s', async key => {
    const f = await fixture(), q = f.request(); await claim(f,q);
    const changed = { ...q,[key]:key === 'expectedMailboxRevision' ? 2 : key === 'connectionId' ? randomUUID() : 'changed' };
    if (key === 'uid') changed.uid = '124';
    await expect(claim(f,changed)).rejects.toMatchObject({ status:409,code:'mailbox_import_idempotency_conflict' }); expect(count(f)).toBe(1);
  });
  it.each(['messageVersion','messageSha256','contentSha256','sourceName','receivedAt','sizeBytes','mediaType'] as const)('refuses a changed source fact %s under the same UID/part', async key => {
    const f = await fixture(); await claim(f);
    const s = f.source(key === 'sourceName' ? { sourceName:'Other.pdf',documentName:'Other.pdf' } : key === 'mediaType' ? { mediaType:'image/png',sourceName:'Original.png',documentName:'Original.png' }
      : { [key]:key === 'receivedAt' ? f.now()-99 : key === 'sizeBytes' ? 101 : key.endsWith('Sha256') ? 'd'.repeat(64) : 'new-version' });
    await expect(claim(f,f.request({ expectedMessageVersion:s.messageVersion }),s)).rejects.toMatchObject({ status:409,code:'mailbox_import_source_conflict' });
    expect(count(f)).toBe(1); expect(count(f,'sources')).toBe(1);
  });
  it('deduplicates a source across real actors while keeping their own exact receipts and one first claim', async () => {
    const f = await fixture(), admin = await member(f,'admin'), q = f.request(), owner = await claim(f,q);
    expect(await f.imports.find(f.context(admin),q.requestId,owner.reservation.requestHash)).toBeNull();
    const other = await claim(f,q,undefined,admin);
    expect(other.reservation.actorUserId).toBe(admin); expect(other.reservation.claim).toEqual(owner.reservation.claim); expect(other.reservation.requestHash).not.toBe(owner.reservation.requestHash);
    expect(count(f)).toBe(2); expect(count(f,'sources')).toBe(1);
    await expect(f.imports.find(f.context(admin),q.requestId,owner.reservation.requestHash)).rejects.toMatchObject({ status:409 });
  });
  it('deduplicates reconnect aliases but retains the first connection and suggested ID', async () => {
    const f = await fixture(), first = await claim(f), connectionId = randomUUID();
    await f.mailbox.commit(f.context(),{ ...f.connection,requestId:randomUUID(),expectedRevision:1,connectionId,verifiedAt:f.now() },async () => f.context());
    const next = await claim(f,f.request({ connectionId,expectedMailboxRevision:2 }));
    expect(next.reservation.claim).toEqual(first.reservation.claim); expect(next.reservation.request.connectionId).toBe(connectionId); expect(count(f)).toBe(2); expect(count(f,'sources')).toBe(1);
  });
  it('commits one canonical PG original after disconnect without adopting its filename/author as mail facts', async () => {
    const f = await fixture(), first = await claim(f), document = f.document();
    await f.mailbox.commit(f.context(),{ schemaVersion:1,requestId:randomUUID(),expectedRevision:1,action:'disconnect' },async () => f.context());
    const done = await f.imports.complete(f.context(),{ requestId:first.reservation.requestId,requestHash:first.reservation.requestHash,document },async () => f.context());
    expect(done.completion).toMatchObject({ documentId:document.id,completedBy:f.actor,contentSha256:document.contentSha256 });
    expect(done.reservation.claim.source.sourceName).toBe('Original.pdf'); expect(document.fileName).toBe('Canonical existing.pdf');
    expect((await f.imports.find(f.context(),first.reservation.requestId,first.reservation.requestHash))!.completion).toEqual(done.completion);
    expect((await claim(f,first.reservation.request)).replayed).toBe(true);
    await expect(claim(f)).rejects.toMatchObject({ status:409,code:'mailbox_import_connection_changed' });
  });
  it('can complete using a different current actor with its own reservation, preserving original claimant', async () => {
    const f = await fixture(), owner = await claim(f), admin = await member(f,'admin'), second = await claim(f,f.request(),undefined,admin), document = f.document();
    const done = await f.imports.complete(f.context(admin),{ requestId:second.reservation.requestId,requestHash:second.reservation.requestHash,document },async () => f.context(admin));
    expect(done.completion!.completedBy).toBe(admin); expect(done.reservation.claim.claimedBy).toBe(f.actor);
    expect((await f.imports.find(f.context(),owner.reservation.requestId,owner.reservation.requestHash))!.completion).toEqual(done.completion);
  });
  it.each(['organizationId','contentSha256','sizeBytes','mediaType','stored'] as const)('rejects unverified/mismatching PG descriptor %s', async key => {
    const f = await fixture(), first = await claim(f), value = key === 'organizationId' ? randomUUID() : key === 'sizeBytes' ? 101 : key === 'stored' ? false : key === 'mediaType' ? 'image/png' : 'd'.repeat(64);
    await expect(f.imports.complete(f.context(),{ requestId:first.reservation.requestId,requestHash:first.reservation.requestHash,document:f.document({ [key]:value }) },async () => f.context())).rejects.toMatchObject({ status:key === 'organizationId' || key === 'stored' ? 503 : 409 }); expect(count(f,'completions')).toBe(0);
  });
  it('preserves exact completion replay and rejects a changed canonical ID', async () => {
    const f = await fixture(), first = await claim(f), input = { requestId:first.reservation.requestId,requestHash:first.reservation.requestHash,document:f.document() };
    const done = await f.imports.complete(f.context(),input,async () => f.context()); f.setNow(f.now()+31);
    expect(await f.imports.complete(f.context(),input,async () => f.context())).toEqual({ ...done,replayed:true });
    await expect(f.imports.complete(f.context(),{ ...input,document:{ ...input.document,id:randomUUID() } },async () => f.context())).rejects.toMatchObject({ status:409 });
  });
  it.each(['claim','complete'] as const)('recovers %s after actual commit with lost acknowledgement', async phase => {
    const f = await fixture(), q = f.request(); let batches = 0;
    const store = d1UsMailboxImportStore(intercepted(f,async statements => { batches++; await f.database.batch(statements); throw new Error('synthetic lost ACK'); }),{ now:f.now });
    const first = await claim(f,q,undefined,f.actor,phase === 'claim' ? store : f.imports);
    const done = phase === 'complete' ? await store.complete(f.context(),{ requestId:q.requestId,requestHash:first.reservation.requestHash,document:f.document() },async () => f.context()) : first;
    expect(done.replayed).toBe(true); expect(batches).toBe(1); expect(count(f)).toBe(1); expect(count(f,'sources')).toBe(1); expect(count(f,'completions')).toBe(phase === 'complete' ? 1 : 0);
  });
  it('rolls back an inserted request when the matching source step fails', async () => {
    const f = await fixture(), store = d1UsMailboxImportStore(intercepted(f,async statements => f.database.batch([statements[0],f.database.prepare('SELECT nonexistent_test_column FROM international_us_support_mail_import_sources')])),{ now:f.now });
    await expect(claim(f,undefined,undefined,f.actor,store)).rejects.toMatchObject({ status:503 }); expect(count(f)).toBe(0); expect(count(f,'sources')).toBe(0);
  });
  it('retains a commit but refuses a success response after fresh Auth loss', async () => {
    const f = await fixture(), q = f.request(); let committed = false;
    const store = d1UsMailboxImportStore(intercepted(f,async statements => { const result = await f.database.batch(statements); committed = true; return result; }),{ now:f.now });
    await expect(store.claim(f.context(),{ request:q,source:f.source(),suggestedDocumentId:randomUUID() },async () => { if (committed) throw new UsMailboxError('unauthorized',401); return f.context(); })).rejects.toMatchObject({ status:401 });
    expect(count(f)).toBe(1); expect((await claim(f,q)).replayed).toBe(true);
  });
  it.each(['accountant','member','read_only'] as const)('does not delegate mailbox imports to role %s', async role => {
    const f = await fixture(), userId = await member(f,role), q = f.request();
    await expect(claim(f,q,undefined,userId)).rejects.toMatchObject({ status:403 });
    await expect(f.imports.find(f.context(userId),q.requestId,'a'.repeat(64))).rejects.toMatchObject({ status:403 }); expect(count(f)).toBe(0);
  });
  it('rejects unknown membership, a substituted registry and a CH scope', async () => {
    const f = await fixture(), q = f.request();
    await expect(claim(f,q,undefined,randomUUID())).rejects.toMatchObject({ status:403 });
    await expect(f.imports.find({ ...f.context(),workspaceId:randomUUID() },q.requestId,'a'.repeat(64))).rejects.toMatchObject({ status:403 });
    await expect(f.imports.find({ ...f.context(),authority:{ ...f.context().authority,organizationId:randomUUID() } },q.requestId,'a'.repeat(64))).rejects.toMatchObject({ status:403 });
  });
  it('isolates two actual US companies of one owner and never uses the legacy Support parent', async () => {
    const f = await fixture(), first = await claim(f), second = await company(f);
    expect(await f.imports.find(second(),first.reservation.requestId,first.reservation.requestHash)).toBeNull();
    await expect(f.imports.claim(second(),{ request:first.reservation.request,source:f.source(),suggestedDocumentId:randomUUID() },async () => second())).rejects.toMatchObject({ status:409,code:'mailbox_import_connection_changed' });
    expect(count(f)).toBe(1); expect(f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(f.legacyBefore);
  });
  it('replays through fresh renewal but rejects a paid-period switch during an operation', async () => {
    const f = await fixture(), q = f.request(), first = await claim(f,q); await f.store.apply(f.binding,renewal(f),async () => {});
    expect(await claim(f,q)).toEqual({ ...first,replayed:true });
    const invoiceId = 'in_ImportSecondRenewal', next = f.paid({ eventId:'evt_ImportSecondRenewal',invoiceId,sourceId:invoiceId,authority:{ ...f.authority,evidence:{ ...f.authority.evidence!,referenceId:invoiceId,startsAt:f.now(),endsAt:f.authority.evidence!.endsAt+7200 } } });
    const store = d1UsMailboxImportStore(intercepted(f,async statements => { await f.store.apply(f.binding,next,async () => {}); return f.database.batch(statements); }),{ now:f.now });
    await expect(claim(f,f.request({ uid:'124' }),undefined,f.actor,store)).rejects.toMatchObject({ status:409 }); expect(count(f)).toBe(1);
  });
  it('fails closed for receipt read and completion after terminal authority revocation', async () => {
    const f = await fixture(), first = await claim(f); f.sql.prepare('UPDATE international_saas_authorities SET revoked_at=? WHERE organization_id=?').run(f.now(),f.intent.organizationId);
    await expect(f.imports.find(f.context(),first.reservation.requestId,first.reservation.requestHash)).rejects.toMatchObject({ status:402 });
    await expect(f.imports.complete(f.context(),{ requestId:first.reservation.requestId,requestHash:first.reservation.requestHash,document:f.document() },async () => f.context())).rejects.toMatchObject({ status:402 }); expect(count(f,'completions')).toBe(0);
  });
  it.each([1,2,3,4] as const)('requires actual native v4 for schema %s and honors session revocation', async schema => {
    const f = await fixture(), n = await native(f,schema), c = () => f.context(f.actor,n.credential), q = f.request(), input = { request:q,source:f.source(),suggestedDocumentId:randomUUID() };
    if (schema !== 4) { await expect(f.imports.claim(c(),input,async () => c())).rejects.toMatchObject({ status:409,code:'client_schema_required' }); expect(count(f)).toBe(0); }
    else { const first = await f.imports.claim(c(),input,async () => c()); await n.store.revoke(n.tokenHash,f.now()); await expect(f.imports.find(c(),q.requestId,first.reservation.requestHash)).rejects.toMatchObject({ status:401 }); }
  });
  it('refuses a new claim if the connection changes between JS validation and SQL insertion', async () => {
    const f = await fixture(), store = d1UsMailboxImportStore(intercepted(f,async statements => { await f.mailbox.commit(f.context(),{ schemaVersion:1,requestId:randomUUID(),expectedRevision:1,action:'disconnect' },async () => f.context()); return f.database.batch(statements); }),{ now:f.now });
    await expect(claim(f,undefined,undefined,f.actor,store)).rejects.toMatchObject({ status:409,code:'mailbox_import_connection_changed' }); expect(count(f)).toBe(0);
  });
  it('fails explicitly with missing0095 and no legacy fallback', async () => { const f = await fixture(false); await expect(f.imports.find(f.context(),randomUUID(),'a'.repeat(64))).rejects.toMatchObject({ status:503 }); expect(f.sql.prepare('SELECT count(*) AS n FROM support_connections').get()!.n).toBe(0); });
});

describe('0095 SQL guards independently of service validators', () => {
  it('requires request and source in one transaction instead of allowing an orphan request', async () => {
    const f = await fixture(), r = await rawRequest(f); f.sql.exec('BEGIN'); insert(f,'international_us_support_mail_import_requests',r.values);
    expect(() => f.sql.exec('COMMIT')).toThrow(/FOREIGN KEY/); f.sql.exec('ROLLBACK'); expect(count(f)).toBe(0);
  });
  it('refuses a source with no first request and immutable history replacements/deletes', async () => {
    const f = await fixture(), first = await claim(f); await f.imports.complete(f.context(),{ requestId:first.reservation.requestId,requestHash:first.reservation.requestHash,document:f.document() },async () => f.context());
    for (const suffix of ['requests','sources','completions']) {
      const table = 'international_us_support_mail_import_'+suffix, saved = { ...f.sql.prepare('SELECT * FROM '+table).get()! } as Record<string,SQLInputValue>;
      expect(() => insert(f,table,saved,true)).toThrow(/us_mail_import_(immutable|idempotency_conflict)/);
      expect(() => f.sql.exec('UPDATE '+table+' SET organization_id=organization_id')).toThrow(/us_mail_import_immutable/);
      expect(() => f.sql.exec('DELETE FROM '+table)).toThrow(/us_mail_import_immutable/);
    }
    const orphan = await rawRequest(f,{ uid:'124' }); expect(() => insertSource(f,orphan)).toThrow(/us_mail_import_invalid_record/);
  });
  it.each(['authorityReference','validStartsAt','validEndsAt','seatLimit','ownerUserId','subscriptionId','priceId','environment','catalogVersion'] as const)('rejects direct current admission drift %s', async key => {
    const f = await fixture(), r = await rawRequest(f), c = JSON.parse(r.values.context_json as string) as UsMailboxContext, value = c.authority[key];
    r.values.context_json = canonicalErpJson({ ...c,authority:{ ...c.authority,[key]:typeof value === 'number' ? value+1 : value+'_different' } });
    expect(() => insert(f,'international_us_support_mail_import_requests',r.values)).toThrow(/us_mail_import_subscription_required/); expect(count(f)).toBe(0);
  });
  it('rejects direct stale timestamp, native schema spoof, duplicate JSON keys and altered source hash alias', async () => {
    const f = await fixture(), r = await rawRequest(f); f.setNow(f.now()+31);
    expect(() => insert(f,'international_us_support_mail_import_requests',r.values)).toThrow(/us_mail_import_subscription_required/);
    const fresh = await rawRequest(f), c = JSON.parse(fresh.values.context_json as string) as UsMailboxContext;
    fresh.values.context_json = canonicalErpJson({ ...c,authority:{ ...c.authority,credential:{ kind:'device',sessionId:'usd_'+randomUUID(),supportedSchemaVersion:3 } } });
    expect(() => insert(f,'international_us_support_mail_import_requests',fresh.values)).toThrow(/us_mail_import_unauthorized/);
    const duplicate = await rawRequest(f); duplicate.values.request_json = (duplicate.values.request_json as string).replace('{','{"schemaVersion":1,');
    expect(() => insert(f,'international_us_support_mail_import_requests',duplicate.values)).toThrow(/us_mail_import_invalid_record/);
    await claim(f); const badHash = await rawRequest(f); badHash.values.source_hash = 'f'.repeat(64);
    expect(() => insert(f,'international_us_support_mail_import_requests',badHash.values)).toThrow(/us_mail_import_source_conflict/);
  });
  it('enforces500 sources and2000 requests while existing exact retries remain readable', async () => {
    const f = await fixture(), first = await claim(f), firstRequest = await rawRequest(f);
    const rows = await Promise.all(Array.from({ length:499 },(_,n) => rawRequest(f,{ uid:String(n+1000) })));
    f.sql.exec('BEGIN'); for (const r of rows) { insert(f,'international_us_support_mail_import_requests',r.values); insertSource(f,r); } f.sql.exec('COMMIT');
    expect(count(f,'sources')).toBe(500); const overflow = await rawRequest(f,{ uid:'99999' }); expect(() => insert(f,'international_us_support_mail_import_requests',overflow.values)).toThrow(/us_mail_import_capacity_exceeded/);
    const aliases = await Promise.all(Array.from({ length:1500 },() => rawRequest(f)));
    f.sql.exec('BEGIN'); for (const r of aliases) insert(f,'international_us_support_mail_import_requests',r.values); f.sql.exec('COMMIT');
    expect(count(f)).toBe(2000); expect(() => insert(f,'international_us_support_mail_import_requests',firstRequest.values)).toThrow(/us_mail_import_capacity_exceeded/);
    expect((await f.imports.find(f.context(),first.reservation.requestId,first.reservation.requestHash))!.reservation).toEqual(first.reservation);
  },20_000);
});
