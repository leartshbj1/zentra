import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lifecycleFixture } from './us-saas-test-lifecycle-test-fixture';
import { d1UsSupportWorkspaceStore } from './us-support-workspace-d1';
import { d1UsMailboxStore } from './us-support-mailbox-d1';
import { d1UsMailboxImportStore } from './us-support-mailbox-import-d1';
import { validateUsMailboxContext, type UsMailboxContext, type UsMailboxPrivateCommand } from './us-support-mailbox-contract';
import type { UsSupportWorkspaceContext } from './us-support-workspace-contract';
import { usMailboxImportDocumentName, type UsMailboxImportRequest, type UsMailboxImportSource } from './us-support-mailbox-import-contract';
import type { UsSupplierDocumentRecord } from './us-supplier-document-contract';

const folder = new URL('../../drizzle/',import.meta.url);
export const mailboxImportSql = readFileSync(new URL('0095_international_us_support_mail_import.sql',folder),'utf8');
type Base = Awaited<ReturnType<typeof lifecycleFixture>>;
export function mailboxImportAuthority(f: Base, organizationId: string = f.intent.organizationId, userId: string = f.actor, credential: UsSupportWorkspaceContext['credential'] = { kind:'browser' }): UsSupportWorkspaceContext {
  const row = f.sql.prepare('SELECT * FROM international_effective_saas_authorities WHERE organization_id=?').get(organizationId)!;
  const current = JSON.parse(row.authority_json as string) as Base['authority'];
  const member = f.sql.prepare('SELECT role FROM international_workspace_members WHERE organization_id=? AND user_id=?').get(organizationId,userId);
  return { schemaVersion:1,organizationId,userId,role:(member?.role ?? 'member') as UsSupportWorkspaceContext['role'],ownerUserId:f.actor,
    subscriptionId:current.subscriptionId,environment:current.offer.environment,catalogVersion:current.offer.catalogVersion,priceId:current.offer.priceId,
    authorityReference:current.evidence!.referenceId,validStartsAt:current.evidence!.startsAt,validEndsAt:current.evidence!.endsAt,seatLimit:row.seat_limit as number,checkedAt:f.now(),credential };
}
/** Real0000..0095 and real paid TEST admission/H1/H2a. Only Auth/provider/PG/R2
 * inputs are fictitious; the fixture makes no hosted/distributed claim. */
export async function mailboxImportFixture(includeImport = true) {
  const f = await lifecycleFixture();
  f.sql.prepare("INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at)VALUES('legacy-import-support',?,'Existing CH Support',?,?)").run(f.actor,f.now(),f.now());
  const legacyBefore = f.sql.prepare('SELECT * FROM support_workspaces').all();
  f.sql.exec(readFileSync(new URL('0093_international_us_support_workspaces.sql',folder),'utf8'));
  const registry = await d1UsSupportWorkspaceStore(f.database,{ now:f.now }).create(mailboxImportAuthority(f),{ schemaVersion:1,requestId:randomUUID(),name:'US import TEST' },async () => mailboxImportAuthority(f));
  f.sql.exec(readFileSync(new URL('0094_international_us_support_mailbox.sql',folder),'utf8'));
  const context = (userId: string = f.actor,credential: UsSupportWorkspaceContext['credential'] = { kind:'browser' }): UsMailboxContext => validateUsMailboxContext({ schemaVersion:1,authority:mailboxImportAuthority(f,f.intent.organizationId,userId,credential),workspaceId:registry.workspace.workspaceId },f.intent.organizationId,f.now());
  const mailbox = d1UsMailboxStore(f.database,{ now:f.now });
  const connection: Extract<UsMailboxPrivateCommand,{ action:'connect' }> = { schemaVersion:1,requestId:randomUUID(),expectedRevision:0,action:'connect',email:'mailbox@example.test',tokenSha256:'a'.repeat(64),
    connectionId:randomUUID(),provider:'infomaniak',mailboxId:'mailbox-test',folderId:'inbox-test',credentialsCiphertext:'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==',verifiedAt:f.now() };
  await mailbox.commit(context(),connection,async () => context());
  if (includeImport) f.sql.exec(mailboxImportSql);
  const request = (patch: Partial<UsMailboxImportRequest> = {}): UsMailboxImportRequest => ({ schemaVersion:1,requestId:randomUUID(),connectionId:connection.connectionId,expectedMailboxRevision:1,uid:'123',attachmentId:'part-1',expectedMessageVersion:'1700000000',...patch });
  const source = (patch: Partial<UsMailboxImportSource> = {}): UsMailboxImportSource => ({ provider:'infomaniak',mailboxId:connection.mailboxId,folderId:connection.folderId,uid:'123',attachmentId:'part-1',messageVersion:'1700000000',messageSha256:'b'.repeat(64),sourceName:'Original.pdf',documentName:usMailboxImportDocumentName('Original.pdf'),receivedAt:f.now()-100,contentSha256:'c'.repeat(64),sizeBytes:100,mediaType:'application/pdf',...patch });
  const document = (patch: Partial<UsSupplierDocumentRecord> = {}): UsSupplierDocumentRecord => ({ schemaVersion:1,organizationId:f.intent.organizationId,id:randomUUID(),contentSha256:'c'.repeat(64),sizeBytes:100,mediaType:'application/pdf',fileName:'Canonical existing.pdf',documentText:null,textSha256:null,createdBy:randomUUID(),createdAt:new Date((f.now()-50)*1000).toISOString(),stored:true,proposalId:null,...patch });
  return { ...f,registry,legacyBefore,context,connection,mailbox,request,source,document,imports:d1UsMailboxImportStore(f.database,{ now:f.now }) };
}
