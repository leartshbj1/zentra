import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AccountPublicError } from '../account-security';
import { SupabaseServerError } from '../supabase-server';
import { getUsSellerProfile, putUsSellerProfile, type SellerProfileStore, type UsSellerProfile } from './seller-profile';
import { createUsSellerProfileHandlers, type SellerProfileServerDependencies } from './seller-profile-server';
import type { CompanyConfiguration } from './types';

// Complete local collaboration/content/country/ERP/admission schemas. PGlite
// is real PostgreSQL WASM, but serializes statements: no two-connection or hosted
// Auth/PostgREST/D1/payment/staging evidence is claimed by these fixtures.
const moduleDirectory=process.env.PGLITE_MODULE_DIR,enabled=!!moduleDirectory&&isAbsolute(moduleDirectory);
type Sql={exec(sql:string):Promise<unknown>;query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>};
type Database=Sql&{transaction<T>(task:(sql:Sql)=>Promise<T>):Promise<T>;close():Promise<void>};
let db:Database,legacyBefore:unknown;
const chOrg=randomUUID(),chActor=randomUUID();
const seller:UsSellerProfile={displayName:'Fictitious seller',contactEmail:'seller@example.test',contactPhone:'+1 212 555 0100'};
const config=(organizationId:string)=>({schemaVersion:1,organizationId,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Fictitious Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}});
const asRole=<T=Record<string,unknown>>(role:'service_role'|'anon'|'authenticated',sql:string,values?:unknown[])=>db.transaction(async tx=>{await tx.exec(`set local role ${role}`);return (await tx.query<T>(sql,values)).rows;});
async function snapshotCH(){return (await db.query('select to_jsonb(p) as profile,(select to_jsonb(w) from public.zentra_workspaces w where w.organization_id=p.organization_id) as workspace,(select to_jsonb(c) from public.zentra_workspace_country_configs c where c.organization_id=p.organization_id) as country from public.zentra_company_profiles p where p.organization_id=$1',[chOrg])).rows;}
async function fixture(){
  const organizationId=randomUUID(),userId=randomUUID(),actor={organizationId,userId,role:'owner' as const},configuration=config(organizationId);
  await asRole('service_role','select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6)',[organizationId,randomUUID(),userId,randomUUID(),JSON.stringify(configuration),createHash('sha256').update(organizationId).digest('hex')]);
  let lose=false;
  const store:SellerProfileStore={async rpc<T>(name:string,parameters:Readonly<Record<string,unknown>>){
    const write=name==='zentra_put_us_seller_profile';if(!write&&name!=='zentra_read_us_seller_profile')throw new Error('Unexpected fixture RPC');
    try{
      const rows=await asRole<{result:T}>('service_role',write?'select public.zentra_put_us_seller_profile($1,$2,$3,$4::uuid,$5::jsonb) as result':'select public.zentra_read_us_seller_profile($1) as result',write?[parameters?.p_organization,parameters?.p_actor,parameters?.p_expected_revision,parameters?.p_request_id,JSON.stringify(parameters?.p_profile)]:[parameters?.p_organization]);
      if(write&&lose){lose=false;throw new SupabaseServerError(503,'synthetic_response_lost');}return rows[0].result;
    }catch(error){if(error instanceof SupabaseServerError)throw error;throw new SupabaseServerError(400,(error as {code?:string}).code??'fixture_sql');}
  }};
  const count=async()=>Number((await db.query<{count:number}>('select count(*)::integer as count from public.zentra_us_seller_profile_changes where organization_id=$1',[organizationId])).rows[0].count);
  const request=(expectedRevision=0,profile=seller)=>({expectedRevision,requestId:randomUUID(),profile});
  return {actor,store,count,request,loseNext(){lose=true;}};
}
describe.runIf(enabled)('seller service through real PostgreSQL RPC and complete local schema',()=>{
  beforeAll(async()=>{
    expect(JSON.parse(await readFile(join(moduleDirectory!,'package.json'),'utf8')).name).toBe('@electric-sql/pglite');
    const {PGlite}=createRequire(import.meta.url)(join(moduleDirectory!,'dist/index.cjs')) as {PGlite:new()=>Database};db=new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for(const name of ['202609140100_company_profiles','202609140200_company_collaboration','202609200300_company_content','20261007194528_international_workspace_country_config'])await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
    await db.query('insert into public.zentra_workspaces(organization_id,updated_by) values($1,$2)',[chOrg,chActor]);
    await db.query('insert into public.zentra_company_profiles(organization_id,profile,updated_by) values($1,$2::jsonb,$3)',[chOrg,JSON.stringify({company_name:'Existing CH identity',private_identifier:'fixture-only'}),chActor]);
    const chConfig={...config(chOrg),country:'CH',currency:'CHF',language:'fr',timeZone:'Europe/Zurich',address:{country:'CH',line1:'1 Rue Fictive',city:'Genève',subdivision:'GE',postalCode:'1201'}};
    await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)',[chOrg,chActor,randomUUID(),JSON.stringify(chConfig)]);legacyBefore=await snapshotCH();
    for(const name of ['20261007222349_international_us_erp_persistence','20261007224820_international_us_erp_delta_stream','20261007225725_international_us_erp_seller_snapshot','20261008001726_new_us_workspace_admission','20261008013200_international_tax_proof_allowlist','20261008034422_international_us_seller_profile'])await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
  },20000);
  afterAll(async()=>{await db?.close();});
  it('preserves the exact legacy CH parent/profile/country after migration and US writes',async()=>{
    const f=await fixture();await putUsSellerProfile(f.store,f.actor,f.request());expect(await snapshotCH()).toEqual(legacyBefore);expect((await db.query('select * from public.zentra_us_seller_profiles where organization_id=$1',[chOrg])).rows).toEqual([]);
  });
  it('starts unset then persists only the scoped public seller, with a matching immutable receipt',async()=>{
    const f=await fixture();expect(await getUsSellerProfile(f.store,f.actor)).toEqual({status:'unconfigured',organizationId:f.actor.organizationId,revision:0});const request=f.request(),receipt=await putUsSellerProfile(f.store,f.actor,request);expect(receipt).toMatchObject({status:'configured',organizationId:f.actor.organizationId,revision:1,profile:seller,updatedBy:f.actor.userId,requestId:request.requestId,replayed:false});expect(await getUsSellerProfile(f.store,f.actor)).toEqual({status:'configured',organizationId:f.actor.organizationId,revision:1,profile:seller,updatedBy:f.actor.userId,updatedAt:receipt.updatedAt});expect(await f.count()).toBe(1);
  });
  it('replays the exact original receipt after newer profile writes without replacing the head',async()=>{
    const f=await fixture(),request=f.request(),first=await putUsSellerProfile(f.store,f.actor,request);await putUsSellerProfile(f.store,f.actor,f.request(1,{displayName:'Newer seller'}));expect(await putUsSellerProfile(f.store,f.actor,request)).toEqual({...first,replayed:true});expect(await getUsSellerProfile(f.store,f.actor)).toMatchObject({revision:2,profile:{displayName:'Newer seller'}});expect(await f.count()).toBe(2);
  });
  it('recovers the same durable receipt after a lost commit response, exactly once',async()=>{
    const f=await fixture(),request=f.request();f.loseNext();await expect(putUsSellerProfile(f.store,f.actor,request)).rejects.toMatchObject({code:'service_unavailable',status:503});expect(await f.count()).toBe(1);expect(await putUsSellerProfile(f.store,f.actor,request)).toMatchObject({revision:1,replayed:true,requestId:request.requestId});expect(await f.count()).toBe(1);
  });
  it.each(['response_loss','revocation'] as const)('integrates Auth HTTP withholding after %s with durable old replay after a newer edit',async kind=>{
    const f=await fixture(),request=f.request(),url=`https://zentra.test/api/international/workspaces/${f.actor.organizationId}/seller`;let revoked=false,withhold=true,first:unknown;
    const store:SellerProfileStore={async rpc<T>(name:string,parameters:Readonly<Record<string,unknown>>):Promise<T>{const result=await f.store.rpc<T>(name,parameters);if(name==='zentra_put_us_seller_profile'&&withhold){withhold=false;first=structuredClone(result);if(kind==='revocation')revoked=true;}return result;}};
    const dependencies:SellerProfileServerDependencies={enabled:async()=>true,authority:async()=>{if(revoked)throw new AccountPublicError('private fixture auth',401);return {mode:'browser',actor:{...f.actor,managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'}};},configuration:async()=>config(f.actor.organizationId) as CompanyConfiguration,rateLimit:async()=>{},diagnostic:()=>{},store:()=>store};
    const handler=createUsSellerProfileHandlers(dependencies),put=()=>new Request(url,{method:'PUT',headers:{Origin:'https://zentra.test','Content-Type':'application/json','X-Zentra-Expected-User':f.actor.userId},body:JSON.stringify(request)});
    expect((await handler.GET(new Request(url),f.actor.organizationId)).status).toBe(200);if(kind==='response_loss')f.loseNext();const failed=await handler.PUT(put(),f.actor.organizationId);expect(failed.status).toBe(kind==='revocation'?401:503);expect(await failed.json()).toEqual({error:kind==='revocation'?'unauthorized':'service_unavailable'});expect(failed.headers.get('Cache-Control')).toContain('no-store');expect(await f.count()).toBe(1);
    revoked=false;withhold=false;if(kind==='response_loss')first=(await putUsSellerProfile(f.store,f.actor,request));await putUsSellerProfile(f.store,f.actor,f.request(1,{displayName:'Later seller'}));const replay=await handler.PUT(put(),f.actor.organizationId);expect(replay.status).toBe(200);expect(await replay.json()).toEqual({...first as Record<string,unknown>,replayed:true});expect(await f.count()).toBe(2);expect(await (await handler.GET(new Request(url),f.actor.organizationId)).json()).toMatchObject({revision:2,profile:{displayName:'Later seller'}});
  });
  it.each(['actor','revision','profile'] as const)('refuses a reused request with different %s while preserving history',async changed=>{
    const f=await fixture(),request=f.request();await putUsSellerProfile(f.store,f.actor,request);const actor=changed==='actor'?{...f.actor,userId:randomUUID()}:f.actor,input=changed==='revision'?{...request,expectedRevision:1}:changed==='profile'?{...request,profile:{displayName:'Changed'}}:request;await expect(putUsSellerProfile(f.store,actor,input)).rejects.toMatchObject({code:'request_id_conflict',status:409});expect(await f.count()).toBe(1);
  });
  it('refuses stale CAS rather than overwriting and isolates the same request UUID in another US workspace',async()=>{
    const a=await fixture(),b=await fixture(),request=a.request();await putUsSellerProfile(a.store,a.actor,request);await expect(putUsSellerProfile(a.store,a.actor,a.request())).rejects.toMatchObject({code:'revision_conflict'});await putUsSellerProfile(b.store,b.actor,request);expect(await a.count()).toBe(1);expect(await b.count()).toBe(1);
  });
  it('preserves revoked Auth errors before SQL, and refuses non-owner roles without a write',async()=>{
    const f=await fixture(),revoked=new AccountPublicError('private revoked token',401);await expect(putUsSellerProfile(f.store,f.actor,f.request(),async()=>{throw revoked;})).rejects.toBe(revoked);for(const role of ['admin','accountant','member','read_only'] as const)await expect(putUsSellerProfile(f.store,{...f.actor,role},f.request())).rejects.toMatchObject({code:'forbidden'});expect(await f.count()).toBe(0);
  });
  it.each(['CH','missing','unconfigured'] as const)('rejects %s workspace reads and writes without a CH fallback',async kind=>{
    const f=await fixture();const organizationId=kind==='CH'?chOrg:randomUUID();if(kind==='unconfigured')await db.query('insert into public.zentra_workspaces(organization_id,updated_by) values($1,$2)',[organizationId,f.actor.userId]);const actor={...f.actor,organizationId};await expect(getUsSellerProfile(f.store,actor)).rejects.toMatchObject({code:'workspace_unavailable',status:409});await expect(putUsSellerProfile(f.store,actor,f.request())).rejects.toMatchObject({code:'workspace_unavailable'});expect(await snapshotCH()).toEqual(legacyBefore);
  });
  it.each([{displayName:'Seller',ein:'12-3456789'},{displayName:'Seller',logoRef:{assetId:randomUUID(),contentSha256:'a'.repeat(64)}},{displayName:'Seller',organizationId:'foreign'},{displayName:'Seller',contactEmail:null},{displayName:' Seller '},{displayName:'\u00a0'},{displayName:'Seller\uFEFF'},{displayName:'😀'.repeat(129)},{displayName:'Seller',contactEmail:'sales\u00a0name@example.test'},{displayName:'Seller',contactEmail:'invalid'},{displayName:'control\nname'}])('enforces the SQL public-profile allowlist for privileged RPC input %j',async profile=>{
    const f=await fixture();await expect(asRole('service_role','select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4::jsonb)',[f.actor.organizationId,f.actor.userId,randomUUID(),JSON.stringify(profile)])).rejects.toMatchObject({code:'PS004'});expect(await f.count()).toBe(0);
  });
  it('allows the exact UTF-16 boundary and preserves Unicode public content through the real RPC',async()=>{
    const f=await fixture(),profile={displayName:'😀'.repeat(128),contactEmail:'unicode@example.test',contactPhone:'☎ +1 212 555 0100'};expect((await putUsSellerProfile(f.store,f.actor,f.request(0,profile))).profile).toEqual(profile);expect((await getUsSellerProfile(f.store,f.actor))).toMatchObject({profile});
  });
  it('table constraints also reject malformed profiles or audit actors in a privileged direct insert',async()=>{
    const f=await fixture();for(const [profile,changedBy] of [[{displayName:'Seller',ein:'12-3456789'},f.actor.userId],[seller,'actor\ncontrol']])await expect(asRole('service_role','insert into public.zentra_us_seller_profile_changes(organization_id,request_id,previous_revision,revision,previous_profile,profile,changed_by,changed_at) values($1,$2::uuid,0,1,null,$3::jsonb,$4,now())',[f.actor.organizationId,randomUUID(),JSON.stringify(profile),changedBy])).rejects.toMatchObject({code:'23514'});expect(await f.count()).toBe(0);
  });
  it('cannot insert an isolated future receipt or a head without its matching history',async()=>{
    const f=await fixture();await expect(asRole('service_role','insert into public.zentra_us_seller_profile_changes(organization_id,request_id,previous_revision,revision,previous_profile,profile,changed_by,changed_at) values($1,$2::uuid,0,1,null,$3::jsonb,$4,now())',[f.actor.organizationId,randomUUID(),JSON.stringify(seller),f.actor.userId])).rejects.toMatchObject({code:'PS005'});expect(await f.count()).toBe(0);
    await expect(asRole('service_role','insert into public.zentra_us_seller_profiles(organization_id,revision,profile,updated_by,updated_at) values($1,1,$2::jsonb,$3,now())',[f.actor.organizationId,JSON.stringify(seller),f.actor.userId])).rejects.toMatchObject({code:'PS005'});
  });
  it('rolls back the audit insert if the later head write fails, then permits an exact retry',async()=>{
    const f=await fixture(),request=f.request();await db.exec(`create function public.seller_test_fail_head() returns trigger language plpgsql as $$ begin raise exception using errcode='PS005',message='synthetic head failure';end $$;create trigger seller_test_fail_head before insert on public.zentra_us_seller_profiles for each row when(new.organization_id='${f.actor.organizationId}') execute function public.seller_test_fail_head();`);
    try{await expect(putUsSellerProfile(f.store,f.actor,request)).rejects.toMatchObject({code:'service_unavailable',status:503});expect(await f.count()).toBe(0);expect(await getUsSellerProfile(f.store,f.actor)).toMatchObject({status:'unconfigured',revision:0});}finally{await db.exec('drop trigger seller_test_fail_head on public.zentra_us_seller_profiles;drop function public.seller_test_fail_head();');}
    expect(await putUsSellerProfile(f.store,f.actor,request)).toMatchObject({revision:1,replayed:false});expect(await f.count()).toBe(1);
  });
  it('keeps audit updates/deletes and head deletion, tenant reassignment or in-place edits forbidden',async()=>{
    const f=await fixture();await putUsSellerProfile(f.store,f.actor,f.request());for(const statement of ['update public.zentra_us_seller_profile_changes set changed_by=\'forged\' where organization_id=$1','delete from public.zentra_us_seller_profile_changes where organization_id=$1','delete from public.zentra_us_seller_profiles where organization_id=$1','update public.zentra_us_seller_profiles set profile=\'{"displayName":"Forged"}\' where organization_id=$1','update public.zentra_us_seller_profiles set organization_id=\'foreign\' where organization_id=$1'])await expect(db.query(statement,[f.actor.organizationId])).rejects.toMatchObject({code:'PS005'});expect(await f.count()).toBe(1);expect(await getUsSellerProfile(f.store,f.actor)).toMatchObject({revision:1,profile:seller});
  });
  it.each(['anon','authenticated'] as const)('denies %s table and RPC privileges; RLS also denies after a temporary SELECT grant',async role=>{
    const f=await fixture();await putUsSellerProfile(f.store,f.actor,f.request());for(const table of ['zentra_us_seller_profiles','zentra_us_seller_profile_changes'])await expect(asRole(role,`select * from public.${table} where organization_id=$1`,[f.actor.organizationId])).rejects.toMatchObject({code:'42501'});
    await expect(asRole(role,'select public.zentra_read_us_seller_profile($1)',[f.actor.organizationId])).rejects.toMatchObject({code:'42501'});await expect(asRole(role,'select public.zentra_put_us_seller_profile($1,$2,1,$3::uuid,$4::jsonb)',[f.actor.organizationId,f.actor.userId,randomUUID(),JSON.stringify(seller)])).rejects.toMatchObject({code:'42501'});
    await db.transaction(async tx=>{await tx.exec(`grant select on public.zentra_us_seller_profiles,public.zentra_us_seller_profile_changes to ${role};set local role ${role};`);expect((await tx.query('select * from public.zentra_us_seller_profiles')).rows).toEqual([]);expect((await tx.query('select * from public.zentra_us_seller_profile_changes')).rows).toEqual([]);await tx.exec('reset role');await tx.exec(`revoke select on public.zentra_us_seller_profiles,public.zentra_us_seller_profile_changes from ${role};`);});
  });
  it('uses only INVOKER functions with empty search paths, no PUBLIC execute, and service-only non-destructive grants',async()=>{
    const functions=(await db.query<{proname:string;prosecdef:boolean;proconfig:string[]}>('select proname,prosecdef,proconfig from pg_proc where proname=any($1::text[])',[['zentra_us_seller_profile_valid','zentra_guard_us_seller_history','zentra_guard_us_seller_head','zentra_guard_us_seller_complete_receipt','zentra_read_us_seller_profile','zentra_put_us_seller_profile']])).rows;expect(functions).toHaveLength(6);for(const row of functions){expect(row.prosecdef).toBe(false);expect(row.proconfig).toContain('search_path=""');}
    expect((await db.query<{allowed:boolean}>("select has_function_privilege('anon','public.zentra_read_us_seller_profile(text)','EXECUTE') or has_function_privilege('authenticated','public.zentra_put_us_seller_profile(text,text,bigint,uuid,jsonb)','EXECUTE') as allowed")).rows[0].allowed).toBe(false);
    expect((await db.query<{allowed:boolean}>("select has_table_privilege('service_role','public.zentra_us_seller_profile_changes','UPDATE') or has_table_privilege('service_role','public.zentra_us_seller_profiles','DELETE') or has_table_privilege('service_role','public.zentra_us_seller_profile_changes','TRUNCATE') as allowed")).rows[0].allowed).toBe(false);
  });
  it('the service-role policy still works without bypassrls',async()=>{
    const f=await fixture();await db.exec('alter role service_role nobypassrls');try{await putUsSellerProfile(f.store,f.actor,f.request());expect(await getUsSellerProfile(f.store,f.actor)).toMatchObject({profile:seller});}finally{await db.exec('alter role service_role bypassrls');}
  });
});
