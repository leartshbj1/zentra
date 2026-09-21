import { AccountPublicError } from './account-security';
import { database, fileArchive, runtimeValue } from './runtime';
import { supabaseRealtimeConfiguration } from './supabase-server-runtime';
import { phase2Tables, phase2Preserved, phase2ResetStatements, phase2ArchiveDeleteGuard } from './phase2-reset-plan';

type ResetAction = { operation: 'reset-d1'|'reset-r2-object'|'reset-supabase-object'; acknowledgement: string; backupSha256: string; counts?: Record<string,number>; key?: string; bucket?: string; sha256?: string };
export const RESET_ACK='RESET_ALL_ZENTRA_TEST_ACCOUNTS_20260921';
export function parsePhase2Reset(input:Record<string,unknown>): ResetAction {
  if (!['reset-d1','reset-r2-object','reset-supabase-object'].includes(String(input.operation)) ||
      Object.keys(input).some(k=>!['operation','acknowledgement','backupSha256','counts','key','bucket','sha256'].includes(k)) ||
      input.acknowledgement!==RESET_ACK || typeof input.backupSha256!=='string' || !/^[a-f0-9]{64}$/.test(input.backupSha256))
    throw new AccountPublicError('Réinitialisation non autorisée.',403);
  if(input.operation==='reset-d1') {
    if(!input.counts || typeof input.counts!=='object' || Array.isArray(input.counts))throw new AccountPublicError('Inventaire requis.');
    const counts=input.counts as Record<string,unknown>;
    const expected=phase2Tables.filter(t=>t!=='founder_admin_nonces');
    if(Object.keys(counts).sort().join(',')!==[...expected].sort().join(',') || Object.values(counts).some(n=>!Number.isSafeInteger(n)||Number(n)<0))throw new AccountPublicError('Inventaire incomplet.');
  } else {
    if(typeof input.key!=='string'||!input.key||input.key.length>1024||input.key.startsWith('_phase2_recovery/')||typeof input.sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.sha256))throw new AccountPublicError('Objet de récupération invalide.');
    if(input.operation==='reset-supabase-object' && !['zentra-company-data','zentra-invoice-archives'].includes(String(input.bucket)))throw new AccountPublicError('Stockage exclu de la remise à zéro.',403);
  }
  return input as ResetAction;
}


async function contentHash(bytes:ArrayBuffer){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}

export async function phase2Reset(action:ResetAction):Promise<unknown> {
  const proof=runtimeValue('PHASE2_RESET_BACKUP_SHA256');
  if(runtimeValue('PHASE2_RESET_MODE')!=='maintenance'||!proof||proof!==action.backupSha256)throw new AccountPublicError('La sauvegarde validée et le mode maintenance sont requis.',403);
  if(action.operation==='reset-d1') {
    const schema=(await database().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{name:string}>()).results.filter(t=>!t.name.startsWith('_')).map(t=>t.name).sort();
    if(schema.join(',')!==[...phase2Tables].sort().join(','))throw new AccountPublicError('Le schéma a changé depuis la sauvegarde.',409);
    const guard=await database().prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='invoice_archives_immutable_delete_guard'").first<{sql:string}>();
    if(guard?.sql!==phase2ArchiveDeleteGuard)throw new AccountPublicError('La protection des archives a changé.',409);
    // D1 batch is transactional: both the immutable guard and all data are
    // restored on any failure, including a concurrent write since the backup.
    await database().batch(phase2ResetStatements(action.counts!).map(sql=>database().prepare(sql)));
    return {reset:true,preserved:phase2Preserved};
  }
  if(action.operation==='reset-r2-object') {
    const object=await fileArchive().get(action.key!);
    if(!object)return {deleted:true,alreadyAbsent:true};
    if(await contentHash(await object.arrayBuffer())!==action.sha256)throw new AccountPublicError('Le document a changé depuis la sauvegarde.',409);
    await fileArchive().delete(action.key!);return {deleted:true};
  }
  const {url,secretKey}=supabaseRealtimeConfiguration();
  const headers={apikey:secretKey,Authorization:`Bearer ${secretKey}`,'Content-Type':'application/json'};
  const path=`${url}/storage/v1/object/authenticated/${action.bucket}/${action.key!.split('/').map(encodeURIComponent).join('/')}`;
  const saved=await fetch(path,{headers,redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(!saved.ok)throw new AccountPublicError(`Vérification du document impossible (${saved.status}).`,409);
  if(await contentHash(await saved.arrayBuffer())!==action.sha256)throw new AccountPublicError('Le document a changé depuis la sauvegarde.',409);
  const result=await fetch(`${url}/storage/v1/object/${action.bucket}`,{method:'DELETE',headers,redirect:'manual',signal:AbortSignal.timeout(30000),body:JSON.stringify({prefixes:[action.key]})});
  if(!result.ok)throw new AccountPublicError(`Nettoyage du document impossible (${result.status}).`,502);
  await result.body?.cancel();return {deleted:true};
}

export { phase2ResetStatements } from './phase2-reset-plan';
