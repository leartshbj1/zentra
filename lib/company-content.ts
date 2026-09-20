import type { DeviceSessionContext } from './account';
import { AccountPublicError, roleCanWriteInvoices, sha256Hex } from './account-security';
import { backupId, backupManifest, type BackupManifest } from './workspace-backup';
import { supabaseServerClient } from './supabase-server-runtime';
import { fileArchive } from './runtime';

export const CONTENT_PART_BYTES = 1024 * 1024;
export type ContentPart = { sha256: string; size_bytes: number };
export function contentHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new AccountPublicError('Référence de modification invalide.');
  return value;
}
export function contentParts(value: unknown, manifest: BackupManifest): ContentPart[] {
  if (!Array.isArray(value) || !value.length || value.length > 8192) throw new AccountPublicError('Liste des modifications invalide.');
  const sizes = new Map<string, number>();
  const parts = value.map(v => {
    if (!v || !Number.isSafeInteger(v.size_bytes) || v.size_bytes < 1 || v.size_bytes > CONTENT_PART_BYTES) throw new AccountPublicError('Taille de modification invalide.');
    const sha256 = contentHash(v.sha256);
    if (sizes.has(sha256) && sizes.get(sha256) !== v.size_bytes) throw new AccountPublicError('Liste des modifications incohérente.');
    sizes.set(sha256, v.size_bytes);
    return { sha256, size_bytes: v.size_bytes as number };
  });
  if (parts.reduce((n, p) => n + p.size_bytes, 0) !== manifest.size_bytes) throw new AccountPublicError('La taille des modifications est incohérente.');
  return parts;
}
function numbers(value: unknown) {
  if (!Array.isArray(value) || value.length > 1000) throw new AccountPublicError('Les séries de numéros doivent être préparées.');
  return value.map(v => {
    if (!v || typeof v.prefix !== 'string' || !/^[A-Z0-9-]{1,12}$/.test(v.prefix) || !Number.isInteger(v.year) || v.year < 1900 || v.year > 9999 || !Number.isSafeInteger(v.minimum) || v.minimum < 1 || v.minimum > 999999999) throw new AccountPublicError('Une série de numéros est invalide.');
    return {prefix:v.prefix,year:v.year,minimum:v.minimum};
  });
}
export async function prepareCompanyContent(actor: DeviceSessionContext, input: Record<string, unknown>) {
  if (!roleCanWriteInvoices(actor.role)) throw new AccountPublicError('Votre accès permet de consulter l’entreprise.',403);
  if (!Number.isSafeInteger(input.baseRevision) || Number(input.baseRevision)<0) throw new AccountPublicError('Version de référence invalide.');
  const manifest=backupManifest(input.manifest), entries=contentParts(input.entries,manifest);
  return supabaseServerClient().rpc('zentra_prepare_content',{
    p_organization:actor.organizationId,p_snapshot:backupId(input.id),p_installation:actor.installationId,p_actor:actor.userId,
    p_base:input.baseRevision,p_manifest:manifest,p_entries:entries,p_digest:await sha256Hex(JSON.stringify(entries)),
    p_activate:['owner','admin'].includes(actor.role)&&input.confirmFullAccess===true,p_numbers:numbers(input.numbers??[]),
  });
}
export async function companyContentManifest(actor: DeviceSessionContext, id: string, manifest: BackupManifest) {
  const db=supabaseServerClient();const rows:ContentPart[]=[];
  // PostgREST enforces its own page cap; never assume an 8192 limit returns all rows.
  for(let offset=0;offset<8192;offset+=500){
    const page=await db.select<ContentPart>('zentra_workspace_content_parts',{organization_id:`eq.${actor.organizationId}`,snapshot_id:`eq.${backupId(id)}`,select:'sha256,size_bytes',order:'part_index.asc',offset,limit:500});
    rows.push(...page);if(page.length<500)break;
  }
  return contentParts(rows,manifest);
}
async function path(org:string,hash:string,generation:string){return `company-content/v1/${await sha256Hex(org)}/${contentHash(hash)}/${backupId(generation)}`;}
export async function receiveCompanyContent(actor:DeviceSessionContext,id:unknown,hash:unknown,bytes:Uint8Array){
  if(!roleCanWriteInvoices(actor.role))throw new AccountPublicError('Votre accès permet de consulter l’entreprise.',403);
  const digest=contentHash(hash),snapshot=backupId(id);
  if(!bytes.length||bytes.length>CONTENT_PART_BYTES||await sha256Hex(bytes)!==digest)throw new AccountPublicError('Le changement reçu est incomplet. Son envoi reprendra automatiquement.');
  const db=supabaseServerClient(),reservation=await db.rpc<{ready:boolean;storageKey:string}>('zentra_reserve_content_blob',{p_organization:actor.organizationId,p_snapshot:snapshot,p_installation:actor.installationId,p_actor:actor.userId,p_hash:digest,p_size:bytes.length});
  if(reservation.ready)return {received:true};
  // Content-addressed immutable bytes; retry after an ambiguous write is safe.
  await fileArchive().put(await path(actor.organizationId,digest,reservation.storageKey),bytes,{httpMetadata:{contentType:'application/octet-stream'}});
  await db.update('zentra_workspace_content_blobs',{state:'ready'},{query:{organization_id:`eq.${actor.organizationId}`,sha256:`eq.${digest}`,storage_key:`eq.${reservation.storageKey}`,state:'eq.uploading'}});
  return {received:true};
}
export async function readCompanyContent(actor:DeviceSessionContext,id:string,hash:unknown){
  const digest=contentHash(hash),db=supabaseServerClient();
  const rows=await db.select<ContentPart>('zentra_workspace_content_parts',{organization_id:`eq.${actor.organizationId}`,snapshot_id:`eq.${backupId(id)}`,sha256:`eq.${digest}`,select:'sha256,size_bytes',limit:1});
  if(!rows[0])throw new AccountPublicError('Ce changement ne fait pas partie de cette entreprise.',404);
  return contentBytes(actor.organizationId,rows[0]);
}
async function contentBytes(org:string,part:ContentPart){
  const rows=await supabaseServerClient().select<{storage_key:string}>('zentra_workspace_content_blobs',{organization_id:`eq.${org}`,sha256:`eq.${part.sha256}`,state:'eq.ready',size_bytes:`eq.${part.size_bytes}`,select:'storage_key',limit:1});
  if(!rows[0])throw new AccountPublicError('Un changement doit être téléchargé à nouveau.',502);
  const object=await fileArchive().get(await path(org,part.sha256,rows[0].storage_key));
  if(!object||object.size!==part.size_bytes||object.size>CONTENT_PART_BYTES)throw new AccountPublicError('Un changement doit être téléchargé à nouveau.',502);
  const bytes=new Uint8Array(await object.arrayBuffer());
  if(await sha256Hex(bytes)!==part.sha256)throw new AccountPublicError('Un changement est incomplet. Les données locales sont conservées.',502);
  return bytes;
}
/** Old clients still request the original 8 MiB archive chunks. Reconstruct
 * just that range, so both protocol generations share one authoritative head. */
export async function legacyContentChunk(actor:DeviceSessionContext,id:string,manifest:BackupManifest,index:number){
  const entries=await companyContentManifest(actor,id,manifest),start=index*8*1024*1024,end=start+manifest.chunks[index].size_bytes;
  const output=new Uint8Array(end-start);let offset=0;
  for(const entry of entries){const next=offset+entry.size_bytes;if(next>start&&offset<end){const bytes=await contentBytes(actor.organizationId,entry);const a=Math.max(start,offset),b=Math.min(end,next);output.set(bytes.subarray(a-offset,b-offset),a-start);}offset=next;if(offset>=end)break;}
  if(await sha256Hex(output)!==manifest.chunks[index].sha256)throw new AccountPublicError('Cette copie doit être téléchargée à nouveau.',502);
  return output;
}
export async function pruneCompanyContent(org:string){
  const db=supabaseServerClient();const hashes=await db.rpc<{sha256:string;storage_key:string}[]>('zentra_claim_content_cleanup',{p_organization:org});
  // A storage generation prevents a delayed/retried cleanup from deleting a
  // newer upload of the same hash after another worker completed the cleanup.
  for(const item of hashes){await fileArchive().delete(await path(org,item.sha256,item.storage_key));await db.delete('zentra_workspace_content_blobs',{organization_id:`eq.${org}`,sha256:`eq.${contentHash(item.sha256)}`,storage_key:`eq.${backupId(item.storage_key)}`,state:'eq.deleting'});}
}
