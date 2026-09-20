import { database, fileArchive } from '@/lib/runtime';
import { AccountPublicError } from '@/lib/account-security';
import { supabaseRealtimeConfiguration } from '@/lib/supabase-server-runtime';
export const PHASE2_PATH='/api/founder/phase2';
export const PHASE2_DOMAIN='zentra-phase2-audit-v1\n';
type Action={operation:'inventory'|'table'|'objects'|'object'|'supabase-users'|'supabase-buckets'|'supabase-objects'|'supabase-object';table?:string;offset?:number;cursor?:string;key?:string;bucket?:string;prefix?:string};
export function parsePhase2Action(input:unknown):Action {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AccountPublicError('Commande invalide.');
  const a=input as Record<string,unknown>;
  if(!['inventory','table','objects','object','supabase-users','supabase-buckets','supabase-objects','supabase-object'].includes(String(a.operation))||Object.keys(a).some(k=>!['operation','table','offset','cursor','key','bucket','prefix'].includes(k)))throw new AccountPublicError('Commande inconnue.');
  if(a.operation==='table'&&(typeof a.table!=='string'||!/^[a-z][a-z0-9_]{0,80}$/.test(a.table)||!Number.isSafeInteger(a.offset)||Number(a.offset)<0))throw new AccountPublicError('Table ou pagination invalide.');
  if(a.operation==='objects'&&a.cursor!==undefined&&(typeof a.cursor!=='string'||a.cursor.length>4096))throw new AccountPublicError('Pagination invalide.');
  if(a.operation==='object'&&(typeof a.key!=='string'||!a.key||a.key.length>1024||a.key.startsWith('_phase2_recovery/')))throw new AccountPublicError('Objet invalide.');
  if(a.operation==='supabase-objects'||a.operation==='supabase-object'){
    if(typeof a.bucket!=='string'||!/^[a-z0-9_-]{1,100}$/.test(a.bucket)||a.bucket==='zentra-releases')throw new AccountPublicError('Stockage invalide.');
    if(a.operation==='supabase-objects'&&(!Number.isSafeInteger(a.offset)||Number(a.offset)<0||typeof a.prefix!=='string'||a.prefix.length>1024))throw new AccountPublicError('Pagination invalide.');
    if(a.operation==='supabase-object'&&(typeof a.key!=='string'||!a.key||a.key.length>1024))throw new AccountPublicError('Objet invalide.');
  }
  return a as Action;
}
async function tables(){return (await database().prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name").all<{name:string;sql:string}>()).results;}
export async function phase2Read(action:Action):Promise<unknown|Response>{
  if(action.operation.startsWith('supabase-')) {
    const {url,secretKey}=supabaseRealtimeConfiguration();
    if(!url.startsWith('https://')||!secretKey)throw new AccountPublicError('Stockage non configuré.',503);
    const path=action.operation==='supabase-users'?'/auth/v1/admin/users?page=1&per_page=1000':action.operation==='supabase-buckets'?'/storage/v1/bucket':action.operation==='supabase-objects'?`/storage/v1/object/list/${encodeURIComponent(action.bucket!)}`:`/storage/v1/object/authenticated/${encodeURIComponent(action.bucket!)}/${action.key!.split('/').map(encodeURIComponent).join('/')}`;
    const headers:Record<string,string>={apikey:secretKey,Authorization:`Bearer ${secretKey}`,'Content-Type':'application/json'};
    const response=await fetch(`${url}${path}`,{method:action.operation==='supabase-objects'?'POST':'GET',headers,redirect:'manual',signal:AbortSignal.timeout(30000),...(action.operation==='supabase-objects'?{body:JSON.stringify({prefix:action.prefix,offset:action.offset,limit:100,sortBy:{column:'name',order:'asc'}})}:{})});
    if(!response.ok)throw new AccountPublicError(`Lecture de sécurité Supabase impossible (${response.status}).`,502);
    if(action.operation==='supabase-object')return new Response(response.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store'}});
    return response.json();
  }
  if(action.operation==='inventory'){
    const schema=await tables();const counts=[];
    if(schema.some(table=>!/^[a-z_][a-z0-9_]*$/.test(table.name)))throw new AccountPublicError('Schéma inattendu.',409);
    const totals:{name:string;n:number}[]=[];
    for(let i=0;i<schema.length;i+=20)totals.push(...(await database().prepare(schema.slice(i,i+20).map(table=>`SELECT '${table.name}' AS name,COUNT(*) AS n FROM "${table.name}"`).join(' UNION ALL ')).all<{name:string;n:number}>()).results);
    for(const table of schema){
      if(!/^[a-z_][a-z0-9_]*$/.test(table.name))throw new AccountPublicError('Schéma inattendu.',409);
      counts.push({...table,count:totals.find(row=>row.name===table.name)?.n??0});
    }
    return {tables:counts,triggers:(await database().prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).results};
  }
  if(action.operation==='table'){
    if(!(await tables()).some(t=>t.name===action.table))throw new AccountPublicError('Table inconnue.',404);
    const columns=(await database().prepare(`PRAGMA table_info("${action.table}")`).all<{name:string;pk:number}>()).results;
    const pk=columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk);
    const order=pk.length?pk.map(c=>`"${c.name.replaceAll('"','""')}"`).join(','):'rowid';
    const rows=(await database().prepare(`SELECT * FROM "${action.table}" ORDER BY ${order} LIMIT 100 OFFSET ?`).bind(action.offset!).all()).results;
    return {table:action.table,offset:action.offset,rows,nextOffset:rows.length===100?action.offset!+100:null};
  }
  if(action.operation==='objects'){
    const page=await fileArchive().list({limit:100,...(action.cursor?{cursor:action.cursor}:{})});
    return {objects:page.objects.map(o=>({key:o.key,size:o.size,etag:o.etag,uploaded:o.uploaded.toISOString()})),cursor:page.truncated?page.cursor:null};
  }
  const object=await fileArchive().get(action.key!);
  if(!object)throw new AccountPublicError('Objet introuvable.',404);
  return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
