import type { DeviceSessionContext } from './account';
import { AccountPublicError, roleCanWriteInvoices, sha256Hex } from './account-security';
import { backupId, backupManifest, type BackupManifest } from './workspace-backup';
import { supabaseServerClient } from './supabase-server-runtime';

type Head = {organization_id:string;revision:number;snapshot_id:string|null;updated_at:string;updated_by:string};
type Snapshot = {id:string;organization_id:string;installation_id:string;created_by:string;base_revision:number;revision:number|null;manifest:BackupManifest;size_bytes:number};
const noWrite = () => new AccountPublicError('Votre rôle permet de consulter l’entreprise, sans la modifier.',403);
export function collaborationRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value)<0) throw new AccountPublicError('La version de l’entreprise est invalide. Actualisez la synchronisation.');
  return Number(value);
}
export async function collaborationHead(actor: DeviceSessionContext) {
  const db=supabaseServerClient();
  const heads=await db.select<Head>('zentra_workspaces',{organization_id:`eq.${actor.organizationId}`,limit:1});
  const head=heads[0];
  const snapshot=head?.snapshot_id ? await collaborationSnapshot(actor,head.snapshot_id) : null;
  return {organizationId:actor.organizationId,userId:actor.userId,role:actor.role,enabled:Boolean(head),
    revision:head?.revision ?? 0,snapshotId:head?.snapshot_id ?? null,updatedAt:head?.updated_at ?? null,manifest:snapshot?.manifest ?? null};
}
export async function collaborationSnapshot(actor: DeviceSessionContext,id:unknown): Promise<Snapshot> {
  const rows=await supabaseServerClient().select<Snapshot>('zentra_workspace_snapshots',{
    organization_id:`eq.${actor.organizationId}`,id:`eq.${backupId(id)}`,limit:1,
  });
  const row=rows[0];
  if(!row || (row.revision===null && (row.created_by!==actor.userId || row.installation_id!==actor.installationId)))
    throw new AccountPublicError('Cette version de l’entreprise est introuvable.',404);
  return {...row,manifest:backupManifest(row.manifest)};
}
export async function prepareCollaboration(actor: DeviceSessionContext,input:Record<string,unknown>) {
  if (!roleCanWriteInvoices(actor.role)) throw noWrite();
  const id=backupId(input.id),manifest=backupManifest(input.manifest),base=collaborationRevision(input.baseRevision);
  const db=supabaseServerClient();
  let heads=await db.select<Head>('zentra_workspaces',{organization_id:`eq.${actor.organizationId}`,limit:1});
  if(!heads.length) {
    if(!['owner','admin'].includes(actor.role)||input.confirmFullAccess!==true||base!==0)
      throw new AccountPublicError('Le titulaire doit d’abord activer le partage de toute l’entreprise.',403);
    // Ignore a concurrent activation; the revision comparison below remains authoritative.
    if(!Array.isArray(input.numbers)||input.numbers.length>1000)throw new AccountPublicError('Les séries de numéros doivent être préparées avant le partage.');
    const numbers=input.numbers.map((row:Record<string,unknown>)=>{
      if(!row||typeof row.prefix!=='string'||!/^[A-Z0-9-]{1,12}$/.test(row.prefix)||!Number.isInteger(row.year)||Number(row.year)<1900||Number(row.year)>9999
        ||!Number.isSafeInteger(row.minimum)||Number(row.minimum)<1||Number(row.minimum)>999999999)throw new AccountPublicError('Une série de numéros est invalide.');
      return {prefix:row.prefix,year:row.year,minimum:row.minimum};
    });
    await db.insert('zentra_workspaces',{organization_id:actor.organizationId,updated_by:actor.userId,number_floors:numbers},
      {prefer:['resolution=ignore-duplicates']});
    heads=await db.select<Head>('zentra_workspaces',{organization_id:`eq.${actor.organizationId}`,limit:1});
  }
  const saved=await db.select<Snapshot>('zentra_workspace_snapshots',{organization_id:`eq.${actor.organizationId}`,id:`eq.${id}`,limit:1});
  if(saved[0]) {
    const row=saved[0];
    if(row.installation_id!==actor.installationId||row.created_by!==actor.userId||row.base_revision!==base
      ||JSON.stringify(backupManifest(row.manifest))!==JSON.stringify(manifest))
      throw new AccountPublicError('Cet envoi ne correspond plus aux données préparées.',409);
  } else {
    if(heads[0].revision!==base) return {conflict:true,...await collaborationHead(actor)};
    // Bound retained transport copies and preserve every uncommitted branch.
    const usage=await db.select<{size_bytes:number}>('zentra_workspace_snapshots',{organization_id:`eq.${actor.organizationId}`,select:'size_bytes',limit:1001});
    if(usage.length>=1000 || usage.reduce((sum,row)=>sum+row.size_bytes,0)+manifest.size_bytes>2*1024*1024*1024)
      throw new AccountPublicError('L’espace de synchronisation est plein. Vos données restent sur cet appareil. Contactez le support pour libérer les anciennes versions.',409);
    await db.insert('zentra_workspace_snapshots',{organization_id:actor.organizationId,id,installation_id:actor.installationId,
      created_by:actor.userId,base_revision:base,manifest,size_bytes:manifest.size_bytes});
  }
  const chunks=await db.select<{chunk_index:number}>('zentra_workspace_chunks',{organization_id:`eq.${actor.organizationId}`,snapshot_id:`eq.${id}`,select:'chunk_index',limit:65});
  return {id,received:chunks.map(row=>row.chunk_index),revision:saved[0]?.revision ?? null};
}
async function chunkPath(org:string,id:string,index:number) { return `${await sha256Hex(org)}/${id}/${index}`; }
function chunkIndex(snapshot:Snapshot,value:string|null) {
  if(value===null||!/^(0|[1-9][0-9]?)$/.test(value)||!snapshot.manifest.chunks[Number(value)]) throw new AccountPublicError('Ce fragment est invalide.');
  return Number(value);
}
export async function receiveCollaborationChunk(actor:DeviceSessionContext,id:unknown,index:string|null,bytes:Uint8Array) {
  if(!roleCanWriteInvoices(actor.role))throw noWrite();
  const snapshot=await collaborationSnapshot(actor,id),n=chunkIndex(snapshot,index),part=snapshot.manifest.chunks[n];
  if(snapshot.installation_id!==actor.installationId||snapshot.created_by!==actor.userId)throw noWrite();
  if(bytes.byteLength!==part.size_bytes||await sha256Hex(bytes)!==part.sha256)throw new AccountPublicError('Le document envoyé est incomplet. L’envoi sera repris.');
  const db=supabaseServerClient(),path=await chunkPath(actor.organizationId,snapshot.id,n);
  // Immutable storage makes an ambiguous upload safely retryable. Any failure
  // must be followed by an exact byte check before a receipt is recorded.
  try { await db.companyChunk('POST',path,bytes); }
  catch(error) {
    const stored=await db.companyChunk('GET',path).catch(()=>{throw error;});
    if(stored.byteLength!==part.size_bytes||await sha256Hex(stored)!==part.sha256)throw error;
  }
  await db.insert('zentra_workspace_chunks',{organization_id:actor.organizationId,snapshot_id:snapshot.id,chunk_index:n,
    sha256:part.sha256,size_bytes:part.size_bytes},{prefer:['resolution=ignore-duplicates']});
  return {received:true};
}
export async function downloadCollaborationChunk(actor:DeviceSessionContext,id:unknown,index:string|null) {
  const snapshot=await collaborationSnapshot(actor,id),n=chunkIndex(snapshot,index),part=snapshot.manifest.chunks[n];
  const bytes=await supabaseServerClient().companyChunk('GET',await chunkPath(actor.organizationId,snapshot.id,n));
  if(bytes.byteLength!==part.size_bytes||await sha256Hex(bytes)!==part.sha256)throw new AccountPublicError('Le document reçu est incomplet. Aucune donnée ne sera remplacée.',502);
  return bytes;
}
export async function commitCollaboration(actor:DeviceSessionContext,id:unknown) {
  if(!roleCanWriteInvoices(actor.role))throw noWrite();
  const result=await supabaseServerClient().rpc<{committed:boolean;revision:number;snapshotId:string;conflict?:boolean}>('zentra_commit_workspace',{
    p_organization:actor.organizationId,p_snapshot:backupId(id),p_installation:actor.installationId,p_actor:actor.userId,
  });
  // A cleanup failure must never disguise a successful commit and make the
  // sender repeat its business operation. The next successful commit retries.
  if(result.committed)await pruneCollaborationHistory(actor.organizationId).catch(()=>undefined);
  return result;
}

export async function pruneCollaborationHistory(organization:string) {
  const db=supabaseServerClient();
  const heads=await db.select<Head>('zentra_workspaces',{organization_id:`eq.${organization}`,limit:1});
  const head=heads[0];if(!head)return;
  // The current state retains the full accounting/audit history. These are
  // transport copies; keep ten completed revisions and all uncommitted work.
  const old=await db.select<Snapshot>('zentra_workspace_snapshots',{organization_id:`eq.${organization}`,revision:'not.is.null',order:'revision.desc',offset:10,limit:2});
  for(const snapshot of old){
    if(snapshot.revision===null||snapshot.id===head.snapshot_id||snapshot.revision>=head.revision)continue;
    const manifest=backupManifest(snapshot.manifest);
    const paths=await Promise.all(manifest.chunks.map((_,index)=>chunkPath(organization,backupId(snapshot.id),index)));
    await db.removeCompanyChunks(paths);
    await db.delete('zentra_workspace_snapshots',{organization_id:`eq.${organization}`,id:`eq.${snapshot.id}`,revision:`eq.${snapshot.revision}`});
  }
}
