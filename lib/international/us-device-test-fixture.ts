import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createOrResumeUsWorkspace, canonicalCreationJson } from './workspace-creation';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { d1UsAuthorityStore } from './saas-authority-d1';
import { prepareUsAuthorityAdmission, type UsSaasPolicy } from './saas-authority';
import type { SaasSubscriptionAuthority, SaasSubscriptionOffer, ServerStripePrice } from './subscriptions';
import { createUsDeviceHandlers, type UsDeviceDependencies } from './us-device-server';
import { d1UsDeviceStore } from './us-device-d1';
import { US_DEVICE_PROTOCOL, hashUsDeviceSecret } from './us-device-contract';

// Actual complete SQL 0000..0089. Auth, PG confirmation/config and verified
// payment/Price are explicitly trusted TEST fixtures, never live providers.
export const usDeviceMigrationFiles=readdirSync(new URL('../../drizzle/',import.meta.url)).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&Number(name.slice(0,4))<=89).sort();
export const usDeviceMigrationSources=usDeviceMigrationFiles.map(name=>readFileSync(new URL('../../drizzle/'+name,import.meta.url),'utf8'));
export function sqliteUsDeviceDatabase(maxMigration=89){
  const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');for(let i=0;i<usDeviceMigrationSources.length;i++)if(Number(usDeviceMigrationFiles[i].slice(0,4))<=maxMigration)sql.exec(usDeviceMigrationSources[i]);
  // Historical device/migration fixtures deliberately stop at0089. This
  // initial-only projection keeps those consumer tests explicit; renewal tests
  // replace it with the actual0092 migration and never use this alias as proof.
  if(maxMigration>=87)sql.exec('CREATE VIEW international_effective_saas_authorities AS SELECT * FROM international_saas_authorities');
  const database={
    prepare(text:string){let values:SQLInputValue[]=[];const statement={bind(...bound:SQLInputValue[]){values=bound;return statement;},async first(){return sql.prepare(text).get(...values)??null;},async all(){return {success:true,results:sql.prepare(text).all(...values)};},async run(){const result=sql.prepare(text).run(...values);return {success:true,meta:{changes:Number(result.changes)}};}};return statement;},
    async batch(statements:{run():Promise<unknown>}[]){sql.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}},
  } as unknown as D1Database;
  return {sql,database};
}
export async function seedUsDeviceFixture(database:D1Database,role:'owner'|'admin'|'accountant'|'member'|'read_only'='owner',seatLimit=2,validFor=86400){
  const owner=randomUUID(),actor=role==='owner'?owner:randomUUID();
  // Use the fixture database's own clock. On Windows Date.now() can lead
  // SQLite unixepoch() by one second at a boundary; production rightly refuses
  // authority rows dated in its SQL future. Do not weaken that commit fence.
  const clock=await database.prepare('SELECT unixepoch() AS timestamp').first<{timestamp:number}>();
  if(!clock||!Number.isSafeInteger(clock.timestamp)||clock.timestamp<1)throw new Error('Invalid local TEST database clock');
  let timestamp=clock.timestamp;
  const stamp=new Date(timestamp*1000).toISOString();
  const intent=await createOrResumeUsWorkspace(owner,{requestId:randomUUID(),confirmationVersion:1,companyName:'US native TEST fixture',configuration:{schemaVersion:1,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Fictitious St',city:'New York',postalCode:'10001',subdivision:'NY'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}}},{store:d1WorkspaceCreationStore(database),allocateId:()=>randomUUID(),now:()=>stamp,fingerprint:async text=>createHash('sha256').update(text).digest('hex'),admit:async value=>({creationId:value.creationId,organizationId:value.organizationId,actorUserId:value.actorUserId,requestId:value.requestId,configurationFingerprint:value.fingerprint,configuration:value.configuration,revision:1,updatedBy:owner,updatedAt:stamp,replayed:false}),revalidate:async()=>{}});
  const offer:SaasSubscriptionOffer={kind:'saas_subscription',catalogVersion:'us_device_TEST_fixture',country:'US',currency:'USD',module:'gestion',plan:'us_device_fixture',priceId:'price_us_device_fixture',productId:'prod_us_device_fixture',environment:'TEST',unitAmountMinor:'123',interval:'month',intervalCount:1,taxBehavior:'exclusive'};
  const price:ServerStripePrice={id:offer.priceId,active:true,livemode:false,currency:'usd',unit_amount:123,type:'recurring',tax_behavior:'exclusive',recurring:{interval:'month',interval_count:1,usage_type:'licensed'},product:{id:offer.productId,active:true}};
  const policy:UsSaasPolicy={catalog:[{offer,seatLimit}],environment:'TEST',now:timestamp};
  const subscriptionId='sub_us_device_'+randomUUID();
  const authority:SaasSubscriptionAuthority={kind:'saas_subscription_authority',organizationId:intent.organizationId,subscriptionId,offer,status:'active',evidence:{kind:'verified_payment',referenceId:'in_us_device_'+randomUUID(),organizationId:intent.organizationId,subscriptionId,environment:'TEST',catalogVersion:offer.catalogVersion,priceId:offer.priceId,currency:'USD',startsAt:timestamp-60,endsAt:timestamp+validFor,revoked:false}};
  const authorityStore=d1UsAuthorityStore(database,{authoritySource:'initial_admission'});await authorityStore.admit(intent,prepareUsAuthorityAdmission(intent,{authority,seatLimit},policy,price),async()=>{});
  if(role!=='owner')await database.prepare('INSERT INTO international_workspace_members(membership_id,organization_id,user_id,role,joined_at)VALUES(?,?,?,?,?)').bind('member_'+randomUUID(),intent.organizationId,actor,role,timestamp).run();
  const store=d1UsDeviceStore(database);let flags=true,configurationStamp=canonicalCreationJson({revision:1,configuration:intent.configuration});let user:string=actor;
  const deps:UsDeviceDependencies={enabled:()=>flags,user:async()=>({userId:user}),now:()=>timestamp,store:()=>store,rateLimit:async()=>{},
    async access(organizationId,userId){const access=await authorityStore.access(organizationId,userId,{...policy,now:timestamp});return {organizationId:access.organizationId,organizationName:intent.companyName,userId:access.userId,role:access.role,subscriptionId:access.subscriptionId,entitlementValidUntil:authority.evidence!.endsAt,configurationStamp};},
  };
  const handlers=createUsDeviceHandlers(deps),installationId=randomUUID(),sessionToken='zus_'+randomBytes(32).toString('base64url'),sessionTokenHash=await hashUsDeviceSecret('session',sessionToken);
  const request=(path:string,body?:unknown,bearer=false)=>new Request('https://zentraapp.ch/api/international/device/'+path,{method:body!==undefined||path==='revoke'?'POST':'GET',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(path==='approve'?{Origin:'https://zentraapp.ch'}:{}),...(bearer?{Authorization:'Bearer '+sessionToken}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  async function start(){return (await handlers.START(request('start',{protocol:US_DEVICE_PROTOCOL,installationId,sessionTokenHash,supportedSchemaVersion:3}))).json() as Promise<{deviceCode:string;userCode:string;expiresAt:number}>;}
  async function approve(userCode:string){return handlers.APPROVE(request('approve',{protocol:US_DEVICE_PROTOCOL,userCode,organizationId:intent.organizationId}));}
  const exchange=(deviceCode:string)=>handlers.EXCHANGE(request('exchange',{protocol:US_DEVICE_PROTOCOL,deviceCode,installationId,sessionToken}));
  return {database,owner,actor,intent,authority,policy,store,deps,handlers,installationId,sessionToken,sessionTokenHash,request,start,approve,exchange,setFlags(value:boolean){flags=value;},setUser(value:string){user=value;},setNow(value:number){timestamp=value;},now:()=>timestamp,setConfiguration(value:string){configurationStamp=value;}};
}
