import { createRequire } from 'node:module';
import { readFileSync,readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { createOrResumeUsWorkspace,canonicalCreationJson,type WorkspaceCreationIntent } from './workspace-creation';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { prepareUsAuthorityAdmission,type UsSaasPolicy } from './saas-authority';
import { d1UsAuthorityStore } from './saas-authority-d1';
import type { SaasSubscriptionAuthority,SaasSubscriptionOffer,ServerStripePrice } from './subscriptions';

const require=createRequire(import.meta.url);
const {Miniflare}=createRequire(require.resolve('wrangler'))('miniflare');
let runtime:{getD1Database(name:string):Promise<D1Database>;dispose():Promise<void>},database:D1Database;
const actor='11111111-1111-4111-8111-111111111111';
const offer:SaasSubscriptionOffer={kind:'saas_subscription',catalogVersion:'fixture_workerd_US',country:'US',currency:'USD',module:'gestion',plan:'fixture_US',priceId:'price_workerd_US',productId:'prod_workerd_US',environment:'TEST',unitAmountMinor:'1000',interval:'month',intervalCount:1,taxBehavior:'exclusive'};
const price:ServerStripePrice={id:offer.priceId,active:true,livemode:false,currency:'usd',unit_amount:1000,type:'recurring',tax_behavior:'exclusive',recurring:{interval:'month',interval_count:1,usage_type:'licensed'},product:{id:offer.productId,active:true}};
async function fixture(seed:number){
  const id=(part:number)=>`00000000-0000-4000-8000-${String(seed*10+part).padStart(12,'0')}`;
  const now=Math.floor(Date.now()/1000),stamp=new Date(now*1000).toISOString();let part=0;
  const intent=await createOrResumeUsWorkspace(actor,{requestId:id(9),confirmationVersion:1,companyName:'Fictitious workerd company',configuration:{schemaVersion:1,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Example St',city:'New York',postalCode:'10001',subdivision:'NY'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}}},{store:d1WorkspaceCreationStore(database),allocateId:()=>id(++part),now:()=>stamp,fingerprint:async text=>createHash('sha256').update(text).digest('hex'),admit:async value=>({creationId:value.creationId,organizationId:value.organizationId,actorUserId:value.actorUserId,requestId:value.requestId,configurationFingerprint:value.fingerprint,configuration:value.configuration,revision:1,updatedBy:actor,updatedAt:stamp,replayed:false}),revalidate:async()=>{}});
  const policy:UsSaasPolicy={catalog:[{offer,seatLimit:3}],environment:'TEST',now};
  const subscriptionId=`sub_workerd_US_${seed}`;
  const authority:SaasSubscriptionAuthority={kind:'saas_subscription_authority',organizationId:intent.organizationId,subscriptionId,offer,status:'active',evidence:{kind:'verified_payment',referenceId:`in_workerd_US_${seed}`,organizationId:intent.organizationId,subscriptionId,environment:'TEST',catalogVersion:offer.catalogVersion,priceId:offer.priceId,currency:'USD',startsAt:now-60,endsAt:now+86400,revoked:false}};
  return {intent,policy,authority,candidate:prepareUsAuthorityAdmission(intent,{authority,seatLimit:3},policy,price)};
}
beforeAll(async()=>{
  runtime=new Miniflare({modules:true,script:'export default { fetch(){return new Response("Isolated US admission D1 test");} }',d1Databases:['DB'],compatibilityDate:'2026-05-15'});
  database=await runtime.getD1Database('DB');
  const files=readdirSync(new URL('../../drizzle/',import.meta.url)).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&Number(name.slice(0,4))<=87).sort();expect(files.length).toBe(88);
  for(const file of files)for(const sql of readFileSync(new URL('../../drizzle/'+file,import.meta.url),'utf8').split('--> statement-breakpoint').filter(value=>value.trim()))await database.prepare(sql).run();
},60000);
afterAll(async()=>{if(runtime)await runtime.dispose();});

describe('actual local workerd D1 batching and US registry (synthetic PG/payment proofs)',()=>{
  it('admits and replays a US workspace through the real D1 adapter and deferred foreign keys',async()=>{const f=await fixture(1),store=d1UsAuthorityStore(database);const ready=await store.admit(f.intent,f.candidate,async()=>{});expect(ready.state).toBe('ready');expect(await store.admit(f.intent,f.candidate,async()=>{})).toEqual(ready);expect(await store.access(f.intent.organizationId,actor,f.policy)).toMatchObject({role:'owner',subscriptionId:f.authority.subscriptionId});expect(await database.prepare('SELECT count(*) total FROM organizations').first()).toEqual({total:0});});
  it('rolls back all three actual D1 statements if intent finalization updates zero rows',async()=>{
    const f=await fixture(2),c=f.candidate;
    await expect(database.batch([
      database.prepare('INSERT INTO international_saas_authorities(organization_id,creation_id,owner_user_id,subscription_id,environment,catalog_version,country,currency,offer_json,authority_json,seat_limit,revision,updated_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(c.organizationId,c.creationId,c.ownerUserId,c.authority.subscriptionId,'TEST',offer.catalogVersion,'US','USD',canonicalCreationJson(offer),canonicalCreationJson(c.authority),3,1,c.updatedAt),
      database.prepare("INSERT INTO international_workspace_members(membership_id,organization_id,user_id,role,joined_at)VALUES(?,?,?,'owner',?)").bind('fixture-owner',c.organizationId,c.ownerUserId,c.updatedAt),
      database.prepare("UPDATE international_workspace_creation_intents SET state='ready',own_subscription_id=?,updated_at=? WHERE creation_id=? AND configuration_fingerprint=?").bind(c.authority.subscriptionId,new Date(c.updatedAt*1000).toISOString(),c.creationId,'f'.repeat(64)),
    ])).rejects.toThrow('FOREIGN KEY constraint failed');
    expect(await database.prepare('SELECT count(*) total FROM international_saas_authorities WHERE organization_id=?').bind(f.intent.organizationId).first()).toEqual({total:0});
    expect(await database.prepare('SELECT count(*) total FROM international_workspace_members WHERE organization_id=?').bind(f.intent.organizationId).first()).toEqual({total:0});
    expect((await d1WorkspaceCreationStore(database).find(actor,f.intent.requestId))?.state).toBe('postgres_confirmed');
  });
  it('coalesces concurrent identical requests against workerd D1 without duplicating owner or proof',async()=>{const f=await fixture(3),store=d1UsAuthorityStore(database);const results=await Promise.all([store.admit(f.intent,f.candidate,async()=>{}),store.admit(f.intent,f.candidate,async()=>{})]);expect(results[0]).toEqual(results[1]);expect(await database.prepare('SELECT count(*) total FROM international_workspace_members WHERE organization_id=?').bind(f.intent.organizationId).first()).toEqual({total:1});});
  it('revokes current US rights irreversibly while keeping the original proof and setup receipt',async()=>{const f=await fixture(4),store=d1UsAuthorityStore(database);const ready:WorkspaceCreationIntent=await store.admit(f.intent,f.candidate,async()=>{});await database.prepare('UPDATE international_saas_authorities SET revoked_at=unixepoch() WHERE organization_id=?').bind(f.intent.organizationId).run();await expect(store.access(f.intent.organizationId,actor,f.policy)).rejects.toMatchObject({code:'subscription_required',status:402});const row=await database.prepare('SELECT authority_json FROM international_saas_authorities WHERE organization_id=?').bind(f.intent.organizationId).first<{authority_json:string}>();expect(row?.authority_json).toBe(canonicalCreationJson(f.authority));expect((await d1WorkspaceCreationStore(database).find(actor,f.intent.requestId))?.receipt).toEqual(ready.receipt);await expect(database.prepare('UPDATE international_saas_authorities SET revoked_at=NULL WHERE organization_id=?').bind(f.intent.organizationId).run()).rejects.toThrow();});
});
