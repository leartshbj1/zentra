import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {DeviceSessionContext} from './account';
import {sha256Hex} from './account-security';
const mocks=vi.hoisted(()=>({db:vi.fn(),archive:vi.fn()}));
vi.mock('./supabase-server-runtime',()=>({supabaseServerClient:mocks.db}));
vi.mock('./runtime',()=>({fileArchive:mocks.archive}));
import {contentParts,prepareCompanyContent,receiveCompanyContent,readCompanyContent,companyContentManifest,legacyContentChunk,pruneCompanyContent} from './company-content';
const actor={organizationId:'org-a',userId:'alice',installationId:'pc',role:'owner'} as DeviceSessionContext;
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',generation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const bytes=new TextEncoder().encode('invoice and logo');
let db:{select:ReturnType<typeof vi.fn>;rpc:ReturnType<typeof vi.fn>;update:ReturnType<typeof vi.fn>;delete:ReturnType<typeof vi.fn>};
let archive:{put:ReturnType<typeof vi.fn>;get:ReturnType<typeof vi.fn>;delete:ReturnType<typeof vi.fn>};let part:{sha256:string;size_bytes:number};let manifest:any;
beforeEach(async()=>{
 part={sha256:await sha256Hex(bytes),size_bytes:bytes.length};manifest={format:'zentra-cloud-backup',version:1,app_version:'1.75.0',...part,chunks:[part]};
 db={select:vi.fn(),rpc:vi.fn().mockResolvedValue({ready:false,storageKey:generation}),update:vi.fn(),delete:vi.fn()};
 archive={put:vi.fn(),get:vi.fn().mockResolvedValue({size:bytes.length,arrayBuffer:async()=>bytes.buffer}),delete:vi.fn()};mocks.db.mockReturnValue(db);mocks.archive.mockReturnValue(archive);
});
describe('incremental company transport',()=>{
 it('rejects malformed manifests and an attempt to write with read-only access',async()=>{
  for(const input of [[],[null],[{...part,size_bytes:0}],[{...part,sha256:'../escape'}],[{...part,size_bytes:1048577}],[part,part]])expect(()=>contentParts(input,manifest)).toThrow();
  await expect(prepareCompanyContent({...actor,role:'read_only'},{id,baseRevision:0,manifest,entries:[part]})).rejects.toThrow();expect(db.rpc).not.toHaveBeenCalled();
 });
 it('reserves storage only after verifying exact bytes, and records readiness only after durable upload',async()=>{
  await expect(receiveCompanyContent(actor,id,part.sha256,new Uint8Array(bytes.length))).rejects.toThrow();expect(db.rpc).not.toHaveBeenCalled();
  await receiveCompanyContent(actor,id,part.sha256,bytes);
  expect(db.rpc.mock.calls[0][1]).toMatchObject({p_organization:actor.organizationId,p_actor:'alice',p_installation:'pc'});
  expect(archive.put.mock.invocationCallOrder[0]).toBeLessThan(db.update.mock.invocationCallOrder[0]);
  expect(db.update.mock.calls[0][2]).toEqual({query:{organization_id:'eq.org-a',sha256:`eq.${part.sha256}`,storage_key:`eq.${generation}`,state:'eq.uploading'}});
  archive.put.mockRejectedValueOnce(new Error('network'));db.update.mockClear();await expect(receiveCompanyContent(actor,id,part.sha256,bytes)).rejects.toThrow('network');expect(db.update).not.toHaveBeenCalled();
 });
 it('does not retransmit an acknowledged blob and binds every lookup to the organization',async()=>{
  db.rpc.mockResolvedValueOnce({ready:true,storageKey:generation});await receiveCompanyContent(actor,id,part.sha256,bytes);expect(archive.put).not.toHaveBeenCalled();
  db.select.mockResolvedValueOnce([]);await expect(readCompanyContent(actor,id,part.sha256)).rejects.toThrow('entreprise');expect(archive.get).not.toHaveBeenCalled();
  db.select.mockResolvedValueOnce([part]).mockResolvedValueOnce([{storage_key:generation}]);expect(await readCompanyContent(actor,id,part.sha256)).toEqual(bytes);
  for(const call of db.select.mock.calls)expect(call[1].organization_id).toBe('eq.org-a');
 });
 it('paginates large recipes instead of silently dropping the last documents',async()=>{
  const parts=Array.from({length:600},()=>part);db.select.mockResolvedValueOnce(parts.slice(0,500)).mockResolvedValueOnce(parts.slice(500));
  expect(await companyContentManifest(actor,id,{...manifest,size_bytes:bytes.length*600})).toHaveLength(600);
  expect(db.select.mock.calls.map(c=>c[1].offset)).toEqual([0,500]);
 });
 it('reconstructs the exact legacy archive bytes and rejects damaged cached content',async()=>{
  db.select.mockResolvedValueOnce([part]).mockResolvedValueOnce([{storage_key:generation}]);expect(await legacyContentChunk(actor,id,manifest,0)).toEqual(bytes);
  db.select.mockResolvedValueOnce([part]).mockResolvedValueOnce([{storage_key:generation}]);archive.get.mockResolvedValueOnce({size:bytes.length,arrayBuffer:async()=>new Uint8Array(bytes.length).buffer});
  await expect(legacyContentChunk(actor,id,manifest,0)).rejects.toThrow('incomplet');
 });
 it('binds cleanup to the claimed storage generation',async()=>{
  db.rpc.mockResolvedValueOnce([{sha256:part.sha256,storage_key:generation}]);await pruneCompanyContent(actor.organizationId);
  expect(archive.delete.mock.calls[0][0]).toContain(`/${generation}`);expect(db.delete.mock.calls[0][1]).toMatchObject({storage_key:`eq.${generation}`,state:'eq.deleting'});
 });
});
