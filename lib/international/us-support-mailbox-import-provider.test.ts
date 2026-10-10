import { randomUUID } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import { sha256Hex } from './canonical-hash';
import { UsMailboxError,type UsMailboxConnection } from './us-support-mailbox-contract';
import type { UsMailboxImportRequest } from './us-support-mailbox-import-contract';
import { createUsMailboxImportProvider } from './us-support-mailbox-import-provider';

const requestUrl = (input: RequestInfo | URL): string => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
function fixture() {
  const connection: UsMailboxConnection = {id:randomUUID(),provider:'infomaniak',email:'test@example.test',mailboxId:'box',folderId:'folder',revision:1,tokenSha256:'a'.repeat(64),credentialsCiphertext:null,verifiedAt:1791600000,connectedBy:randomUUID()};
  const request: UsMailboxImportRequest = {schemaVersion:1,requestId:randomUUID(),connectionId:connection.id,expectedMailboxRevision:1,uid:'42',attachmentId:'part1',expectedMessageVersion:'1791600000'};
  const bytes = new TextEncoder().encode('%PDF-1.7\nFictitious PDF only'), body: Record<string,unknown> = {uid:'42@folder',date:1791600000,subject:'Private subject',from:[{email:'vendor@example.test'}],body:'Private mail text',attachments:[{part_id:'part1',name:'invoice.pdf',size:bytes.length,mime_type:'application/pdf'}]};
  let reads = 0;
  const fetcher: typeof fetch = vi.fn(async (input,init) => {
    const url = new URL(requestUrl(input)); expect(url.origin).toBe('https://mail.infomaniak.com'); expect(init?.redirect).toBe('manual'); expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-key');
    if (url.pathname.endsWith('/attachment/part1')) return new Response(Uint8Array.from(bytes));
    reads++; return Response.json({result:'success',data:body});
  });
  return {connection,request,body,bytes,fetcher,reads:()=>reads,run:(check=async()=>{})=>createUsMailboxImportProvider(fetcher)(connection,'fixture-key',request,check)};
}
describe('US explicit attachment provider, fictitious fixed-origin transport',()=>{
  it('corroborates real UID, both manifests and bytes without retaining body or sender',async()=>{
    const t=fixture(),check=vi.fn(async()=>{}),result=await t.run(check);
    expect(result.bytes).toEqual(t.bytes);expect(result.source).toMatchObject({provider:'infomaniak',mailboxId:'box',folderId:'folder',uid:'42',attachmentId:'part1',sourceName:'invoice.pdf',documentName:'invoice.pdf',mediaType:'application/pdf',contentSha256:await sha256Hex(t.bytes)});
    expect(t.fetcher).toHaveBeenCalledTimes(3);expect(t.reads()).toBe(2);expect(check.mock.calls.length).toBeGreaterThan(6);expect(JSON.stringify(result.source)).not.toMatch(/Private|vendor@example/);
  });
  it.each([undefined,'42','43@folder','42@other','42@folder@other'])('rejects uncorroborated upstream UID %s before download',async uid=>{const t=fixture();t.body.uid=uid;await expect(t.run()).rejects.toMatchObject({code:'mailbox_source_conflict',status:409});expect(t.fetcher).toHaveBeenCalledOnce();});
  it.each(['/api/mail/box/folder/folder/message/42/attachment/part1','/mail/box/folder/folder/message/42/attachment/part1','https://mail.infomaniak.com/api/mail/box/folder/folder/message/42/attachment/part1'])('accepts a corroborated resource path %s',async resource=>{const t=fixture();Object.assign((t.body.attachments as object[])[0],{resource,part_id:'different-undocumented-id'});expect((await t.run()).bytes).toEqual(t.bytes);});
  it.each(['https://foreign.example.test/api/mail/box/folder/folder/message/42/attachment/part1','/api/mail/other/folder/folder/message/42/attachment/part1','/api/mail/box/folder/other/message/42/attachment/part1','/api/mail/box/folder/folder/message/43/attachment/part1','/api/mail/box/folder/folder/message/42/attachment/part1?secret=x','/api/mail/box/folder/folder/message/42/attachment/%2E%2E'])('rejects an untrusted resource %s',async resource=>{const t=fixture();Object.assign((t.body.attachments as object[])[0],{resource});await expect(t.run()).rejects.toMatchObject({code:'mailbox_attachment_unavailable'});expect(t.fetcher).toHaveBeenCalledOnce();});
  it('rejects duplicate part identities even when raw part_id differs',async()=>{const t=fixture();const a=(t.body.attachments as object[])[0];t.body.attachments=[a,{...a,part_id:'another',resource:'/api/mail/box/folder/folder/message/42/attachment/part1'}];await expect(t.run()).rejects.toMatchObject({code:'mailbox_attachment_unavailable'});});
  it.each([{name:'invoice.ics'},{name:'../invoice.pdf'},{size:0},{size:7*1024*1024},{mime_type:'text/html'},{is_inline:true}])('rejects unusable attachment manifest %j',async patch=>{const t=fixture();Object.assign((t.body.attachments as object[])[0],patch);await expect(t.run()).rejects.toMatchObject({code:'mailbox_attachment_unavailable'});});
  it('rejects metadata changes between observations',async()=>{const t=fixture(),base=t.fetcher;const changed: typeof fetch=async(input,init)=>{if(requestUrl(input).includes('/attachment/'))t.body.subject='Changed';return base(input,init);};await expect(createUsMailboxImportProvider(changed)(t.connection,'fixture-key',t.request,async()=>{})).rejects.toMatchObject({code:'mailbox_source_conflict'});});
  it.each(['size','signature'])('rejects downloaded %s mismatch',async kind=>{const t=fixture(),base=t.fetcher;const bad:typeof fetch=async(input,init)=>requestUrl(input).includes('/attachment/')?new Response(kind==='size'?new Uint8Array(8):new Uint8Array(t.bytes.length)):base(input,init);await expect(createUsMailboxImportProvider(bad)(t.connection,'fixture-key',t.request,async()=>{})).rejects.toMatchObject({code:'mailbox_attachment_unavailable'});});
  it('refuses provider redirects without following a foreign URL',async()=>{const t=fixture();const transport=vi.fn<typeof fetch>(async()=>new Response(null,{status:302,headers:{Location:'https://foreign.example.test'}}));await expect(createUsMailboxImportProvider(transport)(t.connection,'fixture-key',t.request,async()=>{})).rejects.toMatchObject({status:503});expect(transport).toHaveBeenCalledOnce();});
  it('stops after fresh admission is revoked',async()=>{const t=fixture();let checks=0;await expect(t.run(async()=>{if(++checks===3)throw new UsMailboxError('forbidden',403);})).rejects.toMatchObject({code:'forbidden',status:403});expect(t.fetcher).toHaveBeenCalledOnce();});
  it('captures detached connection and request inputs before awaiting',async()=>{const t=fixture();let once=true;const result=await t.run(async()=>{if(once){once=false;(t.connection as {mailboxId:string}).mailboxId='foreign';(t.request as {uid:string}).uid='99';}});expect(result.source.mailboxId).toBe('box');expect(result.source.uid).toBe('42');});
});
