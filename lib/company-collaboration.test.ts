import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {DeviceSessionContext} from './account';
const stubs=vi.hoisted(()=>({client:vi.fn()}));
vi.mock('./supabase-server-runtime',()=>({supabaseServerClient:stubs.client}));
vi.mock('./company-realtime',()=>({announceCompanyRevision:vi.fn(async()=>undefined)}));
vi.mock('./runtime',()=>({database:vi.fn(),fileArchive:vi.fn()}));
import {collaborationHead,collaborationSnapshot,prepareCollaboration,receiveCollaborationChunk,downloadCollaborationChunk,commitCollaboration,pruneCollaborationHistory} from './company-collaboration';
import {sha256Hex} from './account-security';
const a={organizationId:'org_a',installationId:'device-a',userId:'alice',role:'owner'} as DeviceSessionContext;
const b={...a,organizationId:'org_b',installationId:'device-b',userId:'bob'};
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bytes=new TextEncoder().encode('private company logo and records');
type Row=Record<string,unknown>;
let rows:Record<string,Row[]>;let blobs:Map<string,Uint8Array>;let db:ReturnType<typeof makeClient>;let manifest:Record<string,unknown>;
function makeClient(){return {
 select:vi.fn(async(table:string,query:Record<string,unknown>)=>(rows[table]??[]).filter(row=>Object.entries(query).every(([key,value])=>!String(value).startsWith('eq.')||String(row[key])===String(value).slice(3))).slice(0,Number(query.limit)||1000)),
 insert:vi.fn(async(table:string,row:Row)=>{const value=structuredClone(row);if(table==='zentra_workspaces')Object.assign(value,{revision:0,snapshot_id:null});if(table==='zentra_workspace_snapshots')value.revision=null;(rows[table]??=[]).push(value);return [value];}),
 companyChunk:vi.fn(async(method:string,path:string,data?:Uint8Array)=>{if(method==='POST'){if(blobs.has(path))throw new Error('already uploaded');blobs.set(path,data!);return new Uint8Array();}if(!blobs.has(path))throw new Error('missing');return blobs.get(path)!;}),
 rpc:vi.fn(async()=>({committed:true,revision:1,snapshotId:id})),
 removeCompanyChunks:vi.fn(async(_paths:string[])=>undefined),
 delete:vi.fn(async(_table:string,_query:Record<string,unknown>)=>[]),
};}
beforeEach(async()=>{rows={};blobs=new Map();db=makeClient();stubs.client.mockReturnValue(db);const sha256=await sha256Hex(bytes);manifest={format:'zentra-cloud-backup',version:1,app_version:'1.67.0',sha256,size_bytes:bytes.length,chunks:[{sha256,size_bytes:bytes.length}]};});
async function prepare(actor=a){return prepareCollaboration(actor,{id,baseRevision:0,manifest,confirmFullAccess:true,numbers:[{prefix:'F',year:2026,minimum:42}]});}
describe('Supabase complete company collaboration',()=>{
 it('requires explicit initial consent from a manager',async()=>{
  for(const role of ['member','accountant','read_only'])await expect(prepare({...a,role} as DeviceSessionContext)).rejects.toThrow();
  await expect(prepareCollaboration(a,{id,baseRevision:0,manifest,numbers:[]})).rejects.toThrow('titulaire');
  expect(db.insert).not.toHaveBeenCalled();
 });
 it('uses only the session organization and preserves a complete resumable manifest',async()=>{
  await prepareCollaboration(a,{id,baseRevision:0,manifest,confirmFullAccess:true,numbers:[],organizationId:'org_b',createdBy:'forged'});
  expect(rows.zentra_workspace_snapshots[0]).toMatchObject({organization_id:'org_a',created_by:'alice',installation_id:'device-a'});
  expect((await collaborationHead(b)).enabled).toBe(false);
  expect(await prepare()).toMatchObject({id,received:[]});expect(rows.zentra_workspace_snapshots).toHaveLength(1);
 });
 it('rejects changed or foreign pending uploads and never exposes another tenant',async()=>{
  await prepare();await expect(collaborationSnapshot(b,id)).rejects.toThrow('introuvable');
  await expect(collaborationSnapshot({...a,userId:'colleague',installationId:'other'},id)).rejects.toThrow('introuvable');
  await expect(prepareCollaboration(a,{id,baseRevision:0,manifest:{...manifest,sha256:'b'.repeat(64)}})).rejects.toThrow('correspond');
 });
 it('refuses corrupt or oversized chunks before storing anything',async()=>{
  await prepare();
  for(const index of ['-1','1','00','64','../0'])await expect(receiveCollaborationChunk(a,id,index,bytes)).rejects.toThrow();
  await expect(receiveCollaborationChunk(a,id,'0',new Uint8Array(bytes.length))).rejects.toThrow('incomplet');
  expect(db.companyChunk).not.toHaveBeenCalled();
 });
 it('recovers an ambiguous immutable upload only after checking exact stored bytes',async()=>{
  await prepare();const path=`${await sha256Hex(a.organizationId)}/${id}/0`;blobs.set(path,bytes);
  await receiveCollaborationChunk(a,id,'0',bytes);
  expect(db.companyChunk.mock.calls.map(call=>call[0])).toEqual(['POST','GET']);
  expect(rows.zentra_workspace_chunks[0]).toMatchObject({organization_id:'org_a',snapshot_id:id,chunk_index:0});
  rows.zentra_workspace_chunks=[];blobs.set(path,new Uint8Array(bytes.length));
  await expect(receiveCollaborationChunk(a,id,'0',bytes)).rejects.toThrow('already uploaded');
  expect(rows.zentra_workspace_chunks).toHaveLength(0);
 });
 it('makes committed versions readable by colleagues but not writable in consultation mode',async()=>{
  await prepare();await receiveCollaborationChunk(a,id,'0',bytes);rows.zentra_workspace_snapshots[0].revision=1;
  for(const role of ['member','accountant','read_only'])expect(await downloadCollaborationChunk({...a,role,userId:'colleague',installationId:'other'} as DeviceSessionContext,id,'0')).toEqual(bytes);
  await expect(commitCollaboration({...a,role:'read_only'},id)).rejects.toThrow('rôle');
  await expect(receiveCollaborationChunk({...a,role:'read_only'},id,'0',bytes)).rejects.toThrow('rôle');
 });
 it('reports a competing revision without creating or overwriting any snapshot',async()=>{
  rows.zentra_workspaces=[{organization_id:'org_a',revision:2,snapshot_id:null}];
  expect(await prepare()).toMatchObject({conflict:true,revision:2});expect(db.insert).not.toHaveBeenCalled();
 });
 it('binds the atomic commit to the verified user and installation',async()=>{
  await commitCollaboration(a,id);
  expect(db.rpc).toHaveBeenCalledWith('zentra_commit_workspace',{p_organization:'org_a',p_snapshot:id,p_installation:'device-a',p_actor:'alice'});
 });
 it('prunes only completed older transport copies inside the same organization',async()=>{
  const oldId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  db.select.mockResolvedValueOnce([{organization_id:'org_a',revision:20,snapshot_id:id}]);
  db.select.mockResolvedValueOnce([{id:oldId,revision:9,manifest},{id,revision:20,manifest},{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',revision:null,manifest}]);
  await pruneCollaborationHistory('org_a');
  expect(db.select).toHaveBeenNthCalledWith(2,'zentra_workspace_snapshots',{organization_id:'eq.org_a',revision:'not.is.null',order:'revision.desc',offset:10,limit:2});
  expect(db.removeCompanyChunks).toHaveBeenCalledExactlyOnceWith([`${await sha256Hex('org_a')}/${oldId}/0`]);
  expect(db.delete).toHaveBeenCalledExactlyOnceWith('zentra_workspace_snapshots',{organization_id:'eq.org_a',id:`eq.${oldId}`,revision:'eq.9'});
 });
 it('never disguises an acknowledged commit when transport cleanup fails',async()=>{
  db.select.mockRejectedValueOnce(new Error('cleanup unavailable'));
  await expect(commitCollaboration(a,id)).resolves.toMatchObject({committed:true,revision:1});
 });
});
