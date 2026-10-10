import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashUsMailboxImportRequest, hashUsMailboxImportSource, usMailboxImportDocumentName,
  validateUsMailboxImportRequest, validateUsMailboxImportSource, validateUsMailboxImportResult,
  type UsMailboxImportRequest, type UsMailboxImportSource,
} from './us-support-mailbox-import-contract';

const organizationId = randomUUID(), workspaceId = randomUUID(), actor = randomUUID();
const request: UsMailboxImportRequest = { schemaVersion:1,requestId:randomUUID(),connectionId:randomUUID(),expectedMailboxRevision:1,uid:'123',attachmentId:'part-1',expectedMessageVersion:'1700000000' };
const source: UsMailboxImportSource = { provider:'infomaniak',mailboxId:'mailbox-test',folderId:'inbox-test',uid:request.uid,attachmentId:request.attachmentId,messageVersion:request.expectedMessageVersion,
  messageSha256:'a'.repeat(64),sourceName:'Original.pdf',documentName:'Original.pdf',receivedAt:1700000000,contentSha256:'b'.repeat(64),sizeBytes:100,mediaType:'application/pdf' };
function result() {
  const sourceHash = 'c'.repeat(64);
  return { reservation:{ schemaVersion:1,organizationId,workspaceId,actorUserId:actor,requestId:request.requestId,requestHash:'d'.repeat(64),request,
    claim:{ schemaVersion:1,organizationId,workspaceId,sourceHash,connectionId:request.connectionId,mailboxRevision:1,suggestedDocumentId:randomUUID(),source,claimedBy:actor,claimedAt:1700000000 },createdAt:1700000000 },
  completion:{ schemaVersion:1,organizationId,workspaceId,sourceHash,documentId:randomUUID(),contentSha256:source.contentSha256,sizeBytes:source.sizeBytes,mediaType:source.mediaType,completedBy:randomUUID(),completedAt:1700000001 },replayed:false };
}
describe('US mailbox import closed contracts and private hashes', () => {
  it('detaches and freezes the public request and private source without accepting provider proof by shape', () => {
    const mutable = { ...request }, saved = validateUsMailboxImportRequest(mutable); mutable.uid = '999';
    expect(saved.uid).toBe('123'); expect(Object.isFrozen(saved)).toBe(true); expect(Object.isFrozen(validateUsMailboxImportSource(source))).toBe(true);
  });
  it.each([
    { schemaVersion:2 },{ requestId:'invalid' },{ connectionId:'invalid' },{ expectedMailboxRevision:0 },{ expectedMailboxRevision:1.5 },
    { uid:'123@inbox' },{ uid:'1'.repeat(21) },{ attachmentId:'../part' },{ attachmentId:'white space' },{ expectedMessageVersion:'' },{ expectedMessageVersion:'\u202eevil' },{ token:'never-public' },
  ])('rejects malformed or extra request fields %#', patch => { expect(() => validateUsMailboxImportRequest({ ...request,...patch })).toThrow(expect.objectContaining({ code:'invalid_mailbox_import_request',status:422 })); });
  it.each(Object.keys(request))('rejects missing public key %s', key => { const v: Record<string,unknown> = { ...request }; delete v[key]; expect(() => validateUsMailboxImportRequest(v)).toThrow(); });
  it('rejects getters and non-JSON values without evaluating them', () => {
    let reads = 0; const v = { ...request }; Object.defineProperty(v,'uid',{ enumerable:true,get() { reads++; return '123'; } });
    expect(() => validateUsMailboxImportRequest(v)).toThrow(); expect(reads).toBe(0);
  });
  it.each([
    { provider:'other' },{ mailboxId:' hidden' },{ folderId:'' },{ messageSha256:'A'.repeat(64) },{ contentSha256:'not-a-hash' },{ sourceName:'../a.pdf' },
    { sourceName:'a.ics',documentName:'a.ics' },{ documentName:'changed.pdf' },{ sizeBytes:0 },{ sizeBytes:6*1024*1024+1 },{ receivedAt:0 },{ mediaType:'text/plain' },{ credentialsCiphertext:'forbidden' },
  ])('rejects malformed or extra private source fields %#', patch => { expect(() => validateUsMailboxImportSource({ ...source,...patch })).toThrow(expect.objectContaining({ code:'invalid_mailbox_import_record',status:503 })); });
  it('derives one bounded filename while retaining the original name as a separate fact', () => {
    const name = 'A'.repeat(176)+'.PDF'; const documentName = usMailboxImportDocumentName(name);
    expect(documentName).toHaveLength(160); expect(documentName.endsWith('.pdf')).toBe(true);
    expect(validateUsMailboxImportSource({ ...source,sourceName:name,documentName }).sourceName).toBe(name);
    expect(usMailboxImportDocumentName('  Cafe\u0301.PDF')).toBe('Café.pdf'); expect(usMailboxImportDocumentName('.jpeg')).toBe('attachment.jpeg');
  });
  it('avoids splitting a surrogate pair at the bounded filename boundary', () => { const name = 'A'.repeat(155)+'😀.png'; expect(usMailboxImportDocumentName(name)).toBe('A'.repeat(155)+'.png'); });
  it('binds request hashes to complete public material, actor, organization and request ID', async () => {
    const hash = await hashUsMailboxImportRequest(organizationId,actor,request);
    for (const q of [{ ...request,requestId:randomUUID() },{ ...request,connectionId:randomUUID() },{ ...request,expectedMailboxRevision:2 },{ ...request,uid:'124' },{ ...request,attachmentId:'part-2' },{ ...request,expectedMessageVersion:'next' }]) expect(await hashUsMailboxImportRequest(organizationId,actor,q)).not.toBe(hash);
    expect(await hashUsMailboxImportRequest(randomUUID(),actor,request)).not.toBe(hash); expect(await hashUsMailboxImportRequest(organizationId,randomUUID(),request)).not.toBe(hash);
  });
  it('keeps locator hash stable across changed immutable source facts, enabling conflict detection', async () => {
    const hash = await hashUsMailboxImportSource(organizationId,workspaceId,source);
    expect(await hashUsMailboxImportSource(organizationId,workspaceId,{ ...source,messageVersion:'next',messageSha256:'e'.repeat(64),contentSha256:'f'.repeat(64),sizeBytes:200,receivedAt:1700000001 })).toBe(hash);
    for (const s of [{ ...source,mailboxId:'other' },{ ...source,folderId:'other' },{ ...source,uid:'124' },{ ...source,attachmentId:'part-2' }]) expect(await hashUsMailboxImportSource(organizationId,workspaceId,s)).not.toBe(hash);
    expect(await hashUsMailboxImportSource(randomUUID(),workspaceId,source)).not.toBe(hash); expect(await hashUsMailboxImportSource(organizationId,randomUUID(),source)).not.toBe(hash);
  });
  it('allows distinct claimant/completer and canonical document ID without exposing source as a public DTO', () => {
    const value = result(), saved = validateUsMailboxImportResult(value,organizationId);
    expect(saved.completion!.completedBy).not.toBe(saved.reservation.claim.claimedBy); expect(saved.completion!.documentId).not.toBe(saved.reservation.claim.suggestedDocumentId);
    expect(Object.isFrozen(saved.reservation.claim.source)).toBe(true);
  });
  it.each(['organizationId','workspaceId','sourceHash','contentSha256','sizeBytes','mediaType','completedAt'] as const)('rejects completion mismatch %s', key => {
    const v = result(); const bad = key === 'sizeBytes' ? 101 : key === 'completedAt' ? 1699999999 : key === 'mediaType' ? 'image/png' : key.endsWith('Id') ? randomUUID() : 'f'.repeat(64);
    expect(() => validateUsMailboxImportResult({ ...v,completion:{ ...v.completion,[key]:bad } },organizationId)).toThrow(expect.objectContaining({ status:503 }));
  });
});
