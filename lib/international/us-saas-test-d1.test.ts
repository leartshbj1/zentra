import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalCreationJson, createOrResumeUsWorkspace, type WorkspaceCreationIntent } from './workspace-creation';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { d1UsAuthorityStore } from './saas-authority-d1';
import { prepareUsAuthorityAdmission, type UsSaasPolicy } from './saas-authority';
import { d1UsTestPurchaseStore } from './us-saas-test-d1';
import { UsTestBillingError, validateUsTestPurchase, verifiedUsTestPaidProof, verifiedUsTestSession, type UsTestPaidProof, type UsTestPurchase, type UsTestSession } from './us-saas-test-contract';
import type { SaasSubscriptionAuthority, SaasSubscriptionOffer, ServerStripePrice } from './subscriptions';
import { seedUsDeviceFixture, sqliteUsDeviceDatabase } from './us-device-test-fixture';
import { createUsTestBillingHandlers, type UsTestBillingDependencies } from './us-saas-test-server';

// Real SQL 0000..0091 in disposable SQLite with deferred FK enforcement. PG,
// Auth and provider attestations are synthetic trusted TEST fixtures. This does
// not assert webhook signature verification, hosted D1 or workerd concurrency.
const folder = new URL('../../drizzle/',import.meta.url);
const files = readdirSync(folder).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&Number(name.slice(0,4))<=91).sort();
const additions = files.filter(name=>Number(name.slice(0,4))>=90);
const actor='11111111-1111-4111-8111-111111111111';
const offer:SaasSubscriptionOffer={kind:'saas_subscription',catalogVersion:'us_saas_TEST_fixture',country:'US',currency:'USD',module:'gestion',plan:'us_saas_fixture',priceId:'price_us_saas_fixture',productId:'prod_us_saas_fixture',environment:'TEST',unitAmountMinor:'123',interval:'month',intervalCount:1,taxBehavior:'exclusive'};
const price:ServerStripePrice={id:offer.priceId,active:true,livemode:false,currency:'usd',unit_amount:123,type:'recurring',tax_behavior:'exclusive',recurring:{interval:'month',interval_count:1,usage_type:'licensed'},product:{id:offer.productId,active:true}};
let fixture:ReturnType<typeof sqliteUsDeviceDatabase>, intent:WorkspaceCreationIntent, purchase:UsTestPurchase, now:number, policy:UsSaasPolicy, authority:SaasSubscriptionAuthority, chBefore:unknown;
const revalidate=async()=>{};
function chSnapshot(){return ['subscriptions','organizations','organization_members','license_activations','device_sessions'].map(table=>fixture.sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());}
async function pending(owner=actor){
  const stamp=new Date(now*1000).toISOString();
  return createOrResumeUsWorkspace(owner,{requestId:randomUUID(),confirmationVersion:1,companyName:'Fictitious US SaaS TEST',configuration:{schemaVersion:1,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Fictitious Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}}},{store:d1WorkspaceCreationStore(fixture.database),allocateId:()=>randomUUID(),now:()=>stamp,fingerprint:async text=>createHash('sha256').update(text).digest('hex'),admit:async value=>({creationId:value.creationId,organizationId:value.organizationId,actorUserId:owner,requestId:value.requestId,configurationFingerprint:value.fingerprint,configuration:value.configuration,revision:1,updatedBy:owner,updatedAt:stamp,replayed:false}),revalidate});
}
function candidate(saved=intent):UsTestPurchase{return validateUsTestPurchase({purchaseId:randomUUID(),creationId:saved.creationId,organizationId:saved.organizationId,actorUserId:saved.actorUserId,requestId:saved.requestId,configurationFingerprint:saved.fingerprint,receipt:saved.receipt!,offer,seatLimit:3,providerAccountId:'acct_FictitiousUsTest',siteOrigin:'https://example.invalid',integrationIdentifier:'zentra_us_test_abcdefgh',createdAt:now,expiresAt:now+3600},saved);}
function session(p=purchase,patch:Partial<UsTestSession>={}){return verifiedUsTestSession(p,{purchaseId:p.purchaseId,sessionId:'cs_test_'+p.purchaseId.replaceAll('-',''),customerId:null,subscriptionId:null,createdAt:p.createdAt,expiresAt:p.expiresAt,...patch});}
function proof(p=purchase,s:UsTestSession=session(p),patch:Partial<UsTestPaidProof>={}){return verifiedUsTestPaidProof(p,{purchaseId:p.purchaseId,sessionId:s.sessionId,customerId:'cus_FictitiousUsTest',subscriptionId:authority.subscriptionId,invoiceId:authority.evidence!.referenceId,eventId:'evt_FictitiousInitial',providerAccountId:p.providerAccountId,authority,serverPrice:price,verifiedAt:now,...patch});}
function admission(value=authority,checkedAt=now){return prepareUsAuthorityAdmission(intent,{authority:value,seatLimit:3},{...policy,now:checkedAt},price);}
async function bound(){const store=d1UsTestPurchaseStore(fixture.database);purchase=await store.reserve(intent,purchase,revalidate);const saved=await store.bind(purchase,session(),revalidate);return {store,saved};}
async function admitted(){const b=await bound(),paid=proof(purchase,b.saved),a=admission();const ready=await b.store.admit(intent,purchase,b.saved,paid,a,revalidate);return {...b,paid,a,ready};}
function count(table:string){return fixture.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n;}
function write(table:string,row:Record<string,SQLInputValue>,replace=false){const columns=Object.keys(row);return fixture.sql.prepare(`INSERT ${replace?'OR REPLACE ':''}INTO ${table}(${columns.join(',')})VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(row));}
function purchaseRow(p=purchase):Record<string,SQLInputValue>{return {purchase_id:p.purchaseId,creation_id:p.creationId,organization_id:p.organizationId,actor_user_id:p.actorUserId,request_id:p.requestId,configuration_fingerprint:p.configurationFingerprint,receipt_json:canonicalCreationJson(p.receipt),offer_json:canonicalCreationJson(p.offer),seat_limit:p.seatLimit,provider_account_id:p.providerAccountId,site_origin:p.siteOrigin,integration_identifier:p.integrationIdentifier,created_at:p.createdAt,expires_at:p.expiresAt};}
function proofRow(paid=proof()):Record<string,SQLInputValue>{return {purchase_id:purchase.purchaseId,session_id:paid.sessionId,organization_id:purchase.organizationId,creation_id:purchase.creationId,actor_user_id:purchase.actorUserId,customer_id:paid.customerId,subscription_id:paid.subscriptionId,invoice_id:paid.invoiceId,event_id:paid.eventId,provider_account_id:paid.providerAccountId,authority_json:canonicalCreationJson(paid.authority),seat_limit:purchase.seatLimit,verified_at:paid.verifiedAt};}
function interceptedDatabase(options:{lostInsert?:string;lostBatch?:boolean;dropFinalization?:boolean}){
  let lost=false;
  return {
    prepare(sql:string){const original=fixture.database.prepare(sql);const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>({bind(...values:unknown[]){return wrap(statement.bind(...values));},first:statement.first.bind(statement),all:statement.all.bind(statement),async run(){const result=await statement.run();if(!lost&&options.lostInsert&&sql.includes(options.lostInsert)){lost=true;throw new Error('Synthetic response loss after committed insert');}return result;}} as D1PreparedStatement);return wrap(original);},
    async batch(statements:D1PreparedStatement[]){const result=await fixture.database.batch(options.dropFinalization?statements.slice(0,-1):statements);if(options.lostBatch&&!lost){lost=true;throw new Error('Synthetic response loss after committed batch');}return result;},
  } as Pick<D1Database,'prepare'|'batch'>;
}
beforeEach(async()=>{
  fixture=sqliteUsDeviceDatabase();
  for(const file of additions.filter(name=>!name.startsWith('0091_')))fixture.sql.exec(readFileSync(new URL(file,folder),'utf8'));
  now=Number(fixture.sql.prepare('SELECT unixepoch() AS t').get()!.t);
  fixture.sql.prepare("INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)VALUES('sub_ExistingCH','cus_ExistingCH','price_ExistingCH','active',?,?)").run(now+86400,now);
  fixture.sql.prepare("INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)VALUES('existing-CH','Existing CH','sub_ExistingCH',?,?,?)").run(actor,now,now);
  fixture.sql.prepare("INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)VALUES('ch-owner','existing-CH',?,'synthetic@example.invalid','owner',?)").run(actor,now);
  chBefore=chSnapshot();
  fixture.sql.exec(readFileSync(new URL('0091_international_us_saas_test_checkout.sql',folder),'utf8'));
  intent=await pending();purchase=candidate();policy={catalog:[{offer,seatLimit:3}],environment:'TEST',now};
  authority={kind:'saas_subscription_authority',organizationId:intent.organizationId,subscriptionId:'sub_FictitiousUsTest',offer,status:'active',evidence:{kind:'verified_payment',referenceId:'in_FictitiousUsTest',organizationId:intent.organizationId,subscriptionId:'sub_FictitiousUsTest',environment:'TEST',catalogVersion:offer.catalogVersion,priceId:offer.priceId,currency:'USD',startsAt:now-60,endsAt:now+86400,revoked:false}};
});
afterEach(()=>{expect(chSnapshot()).toEqual(chBefore);expect(fixture.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);fixture.sql.close();});

describe('immutable initial US/USD TEST purchase and atomic D1 admission',()=>{
  it('accepts the valid captured purchase directly through real SQL constraints',()=>{
    write('international_us_saas_test_purchases',purchaseRow());expect(count('international_us_saas_test_purchases')).toBe(1);
  });
  it('loads all 92 real migrations, reserves before dispatch and scopes private reads to actor/request or known session',async()=>{
    expect(files.map(name=>Number(name.slice(0,4)))).toEqual(Array.from({length:92},(_,index)=>index));
    const {store,saved}=await bound();expect(await store.find(actor,intent.requestId)).toEqual(purchase);expect(await store.find(randomUUID(),intent.requestId)).toBeNull();expect(await store.bySession(saved.sessionId)).toEqual(purchase);expect(await store.bySession('cs_test_unknown')).toBeNull();expect(await store.session(purchase.purchaseId)).toEqual(saved);expect(count('international_saas_authorities')).toBe(0);expect((await d1WorkspaceCreationStore(fixture.database).find(actor,intent.requestId))!.state).toBe('postgres_confirmed');
  });
  it('reuses the original purchase ID/expiry for a semantic retry and never changes provider creation parameters',async()=>{
    const store=d1UsTestPurchaseStore(fixture.database),saved=await store.reserve(intent,purchase,revalidate),later={...purchase,purchaseId:randomUUID(),createdAt:now+10,expiresAt:now+3610,integrationIdentifier:'zentra_us_test_ijklmnop'};expect(await store.reserve(intent,later,revalidate)).toEqual(saved);expect(count('international_us_saas_test_purchases')).toBe(1);
  });
  it.each(['offer','seatLimit','providerAccountId','siteOrigin'] as const)('rejects changed immutable purchase %s under the same browser request',async field=>{
    const store=d1UsTestPurchaseStore(fixture.database);await store.reserve(intent,purchase,revalidate);const changes={offer:{...offer,unitAmountMinor:'124'},seatLimit:4,providerAccountId:'acct_OtherTest',siteOrigin:'https://other.invalid',integrationIdentifier:'zentra_us_test_ijklmnop'};await expect(store.reserve(intent,{...purchase,[field]:changes[field]},revalidate)).rejects.toMatchObject({code:'purchase_conflict',status:409});expect(await store.find(actor,intent.requestId)).toEqual(purchase);
  });
  it.each(['creation_id','organization_id','actor_user_id','request_id','configuration_fingerprint','receipt_json'] as const)('enforces durable creation snapshot %s in SQL rather than only JS',field=>{
    const row=purchaseRow();row[field]=field==='receipt_json'?canonicalCreationJson({...purchase.receipt,updatedBy:randomUUID()}):field==='configuration_fingerprint'?'f'.repeat(64):randomUUID();expect(()=>write('international_us_saas_test_purchases',row)).toThrow('international_us_test_purchase_scope');expect(count('international_us_saas_test_purchases')).toBe(0);
  });
  it('rejects a reserved/unconfirmed intention and refuses adoption of the CH company',async()=>{
    fixture.sql.prepare("INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)VALUES('sub_CollisionCH','cus_CollisionCH','price_CollisionCH','active',?,?)").run(now+86400,now);
    fixture.sql.prepare("INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)VALUES(?,'Collision','sub_CollisionCH',?,?,?)").run(intent.organizationId,actor,now,now);const baseline=chSnapshot();await expect(d1UsTestPurchaseStore(fixture.database).reserve(intent,purchase,revalidate)).rejects.toMatchObject({status:503});expect(chSnapshot()).toEqual(baseline);fixture.sql.prepare('DELETE FROM organizations WHERE organization_id=?').run(intent.organizationId);fixture.sql.exec("DELETE FROM subscriptions WHERE subscription_id='sub_CollisionCH'");
    const organizationId=randomUUID(),creationId=randomUUID(),requestId=randomUUID(),reserved={...intent,organizationId,creationId,requestId,configuration:{...intent.configuration,organizationId},state:'reserved' as const,receipt:null};await d1WorkspaceCreationStore(fixture.database).reserve(reserved);expect(()=>write('international_us_saas_test_purchases',{...purchaseRow(),organization_id:organizationId,creation_id:creationId,request_id:requestId})).toThrow('international_us_test_purchase_scope');
  });
  it('requires branded session/payment/admission attestations and exact durable session scope',async()=>{
    const store=d1UsTestPurchaseStore(fixture.database);purchase=await store.reserve(intent,purchase,revalidate);const s=session();await expect(store.bind(purchase,{...s},revalidate)).rejects.toMatchObject({code:'unverified_session'});const saved=await store.bind(purchase,s,revalidate),paid=proof(purchase,saved);await expect(store.admit(intent,purchase,saved,{...paid},admission(),revalidate)).rejects.toMatchObject({code:'unverified_payment'});await expect(store.admit(intent,purchase,saved,paid,JSON.parse(JSON.stringify(admission())),revalidate)).rejects.toMatchObject({code:'invalid_authority'});await expect(store.admit(intent,purchase,{...saved,sessionId:'cs_test_Foreign'},paid,admission(),revalidate)).rejects.toMatchObject({code:'session_conflict'});expect(count('international_us_saas_test_paid_proofs')).toBe(0);
  });
  it('binds one immutable session and rejects another session, customer, subscription or expiry',async()=>{
    const store=d1UsTestPurchaseStore(fixture.database);purchase=await store.reserve(intent,purchase,revalidate);const saved=await store.bind(purchase,session(purchase,{customerId:'cus_Initial',subscriptionId:'sub_Initial'}),revalidate);expect(await store.bind(purchase,session(purchase,{customerId:'cus_Initial',subscriptionId:'sub_Initial'}),revalidate)).toEqual(saved);for(const patch of [{sessionId:'cs_test_Other',customerId:'cus_Initial',subscriptionId:'sub_Initial'},{customerId:'cus_Other',subscriptionId:'sub_Initial'},{customerId:'cus_Initial',subscriptionId:'sub_Other'}])await expect(store.bind(purchase,session(purchase,patch),revalidate)).rejects.toMatchObject({code:'session_conflict',status:409});expect(()=>fixture.sql.prepare('UPDATE international_us_saas_test_sessions SET expires_at=expires_at+1').run()).toThrow('international_us_test_session_immutable');
  });
  it('accepts open to paid session hints on retry without rewriting the initial immutable binding',async()=>{
    const {store,saved}=await bound();expect(await store.bind(purchase,session(purchase,{customerId:'cus_FictitiousUsTest',subscriptionId:authority.subscriptionId}),revalidate)).toEqual(saved);expect(await store.session(purchase.purchaseId)).toEqual(saved);expect(saved.customerId).toBeNull();expect((await store.admit(intent,purchase,saved,proof(purchase,saved),admission(),revalidate)).state).toBe('ready');
  });
  it('coalesces simultaneous semantic reservations with independently allocated IDs, suffixes and times',async()=>{
    const store=d1UsTestPurchaseStore(fixture.database),other={...purchase,purchaseId:randomUUID(),integrationIdentifier:'zentra_us_test_ijklmnop',createdAt:now-1,expiresAt:now+3599};const [one,two]=await Promise.all([store.reserve(intent,purchase,revalidate),store.reserve(intent,other,revalidate)]);expect(one).toEqual(two);expect(count('international_us_saas_test_purchases')).toBe(1);
  });
  it('rejects cross-purchase branded session/payment even when each attestation is valid alone',async()=>{
    const {store,saved}=await bound(),otherIntent=await pending(randomUUID()),other=candidate(otherIntent);await store.reserve(otherIntent,other,revalidate);await expect(store.bind(other,session(),revalidate)).rejects.toMatchObject({code:'session_mismatch'});await expect(store.admit(intent,purchase,saved,proof({...purchase,providerAccountId:'acct_OtherTest'},saved),admission(),revalidate)).rejects.toMatchObject({code:'invalid_authority'});expect(count('international_us_saas_test_paid_proofs')).toBe(0);
  });
  it('commits proof, own authority, owner and ready together, and persists only the narrow private projection',async()=>{
    const {store,saved,ready}=await admitted();expect(ready.state).toBe('ready');expect(count('international_us_saas_test_paid_proofs')).toBe(1);expect(count('international_saas_authorities')).toBe(1);expect(count('international_workspace_members')).toBe(1);expect(await d1UsAuthorityStore(fixture.database).access(purchase.organizationId,actor,policy)).toMatchObject({role:'owner',subscriptionId:authority.subscriptionId});expect(await store.bySession(saved.sessionId)).toEqual(purchase);const row=fixture.sql.prepare('SELECT * FROM international_us_saas_test_paid_proofs').get()!;expect(Object.keys(row)).not.toContain('serverPrice');expect(JSON.stringify(row)).not.toMatch(/secret|token|checkout\.stripe/);
  });
  it('preserves the first proof while replaying equivalent provider events and verification times',async()=>{
    const {store,saved,ready}=await admitted(),before=fixture.sql.prepare('SELECT * FROM international_us_saas_test_paid_proofs').get();const paid=proof(purchase,saved,{eventId:'evt_EquivalentDelivery',verifiedAt:now+1});expect(await store.admit(intent,purchase,saved,paid,admission(authority,now+1),revalidate)).toEqual(ready);expect(fixture.sql.prepare('SELECT * FROM international_us_saas_test_paid_proofs').get()).toEqual(before);
  });
  it('refuses a renewal invoice or altered initial customer instead of overwriting the authority/history',async()=>{
    const {store,saved}=await admitted(),before=fixture.sql.prepare('SELECT * FROM international_us_saas_test_paid_proofs').get();await expect(store.admit(intent,purchase,saved,proof(purchase,saved,{customerId:'cus_Other'}),admission(),revalidate)).rejects.toMatchObject({code:'admission_conflict'});const renewal={...authority,evidence:{...authority.evidence!,referenceId:'in_Renewal',endsAt:now+172800}};await expect(store.admit(intent,purchase,saved,proof(purchase,saved,{authority:renewal,invoiceId:'in_Renewal'}),admission(renewal),revalidate)).rejects.toMatchObject({code:'admission_conflict'});expect(fixture.sql.prepare('SELECT * FROM international_us_saas_test_paid_proofs').get()).toEqual(before);
  });
  it('blocks the old internal authority sink when the new purchase requires its bound proof',async()=>{
    await bound();await expect(d1UsAuthorityStore(fixture.database).admit(intent,admission(),revalidate)).rejects.toMatchObject({status:503});expect(count('international_saas_authorities')).toBe(0);expect(count('international_workspace_members')).toBe(0);expect(count('international_us_saas_test_paid_proofs')).toBe(0);
  });
  it('keeps the existing private 0087 admission valid when no TEST purchase exists',async()=>{
    const seeded=await seedUsDeviceFixture(fixture.database);expect(await d1UsAuthorityStore(fixture.database).access(seeded.intent.organizationId,seeded.actor,seeded.policy)).toMatchObject({role:'owner'});expect(count('international_us_saas_test_purchases')).toBe(0);expect(count('international_us_saas_test_paid_proofs')).toBe(0);
  });
  it('cannot commit a paid proof alone through its actual deferred authority FK',async()=>{
    await bound();expect(()=>write('international_us_saas_test_paid_proofs',proofRow())).toThrow('FOREIGN KEY constraint failed');expect(count('international_us_saas_test_paid_proofs')).toBe(0);
  });
  it.each(['organization_id','creation_id','actor_user_id','provider_account_id','seat_limit','invoice_id','customer_id','subscription_id'] as const)('rejects substituted proof %s through actual SQL scope guards',async field=>{
    const store=d1UsTestPurchaseStore(fixture.database);purchase=await store.reserve(intent,purchase,revalidate);await store.bind(purchase,session(purchase,{customerId:'cus_FictitiousUsTest',subscriptionId:authority.subscriptionId}),revalidate);const row=proofRow();row[field]=field==='seat_limit'?4:field==='invoice_id'?'in_Other':field==='customer_id'?'cus_Other':field==='subscription_id'?'sub_Other':field==='provider_account_id'?'acct_Other':randomUUID();expect(()=>write('international_us_saas_test_paid_proofs',row)).toThrow('international_us_test_proof_scope');expect(count('international_us_saas_test_paid_proofs')).toBe(0);
  });
  it('rolls back proof/authority/member when the final ready write is missing',async()=>{
    const {saved}=await bound(),store=d1UsTestPurchaseStore(interceptedDatabase({dropFinalization:true}));await expect(store.admit(intent,purchase,saved,proof(purchase,saved),admission(),revalidate)).rejects.toMatchObject({status:503});for(const table of ['international_us_saas_test_paid_proofs','international_saas_authorities','international_workspace_members'])expect(count(table)).toBe(0);expect((await d1WorkspaceCreationStore(fixture.database).find(actor,intent.requestId))!.state).toBe('postgres_confirmed');
  });
  it.each(['purchase','session','admission'] as const)('recovers an uncertain committed %s response through exact durable replay',async step=>{
    const db=interceptedDatabase(step==='admission'?{lostBatch:true}:{lostInsert:step==='purchase'?'INSERT INTO international_us_saas_test_purchases':'INSERT INTO international_us_saas_test_sessions'}),store=d1UsTestPurchaseStore(db);purchase=await store.reserve(intent,purchase,revalidate);const saved=await store.bind(purchase,session(),revalidate);const ready=await store.admit(intent,purchase,saved,proof(purchase,saved),admission(),revalidate);expect(ready.state).toBe('ready');expect(count('international_us_saas_test_purchases')).toBe(1);expect(count('international_us_saas_test_sessions')).toBe(1);expect(count('international_us_saas_test_paid_proofs')).toBe(1);expect(count('international_workspace_members')).toBe(1);
  });
  it('withholds a committed result after authorization loss and recovers without duplicate writes',async()=>{
    const {store,saved}=await bound(),paid=proof(purchase,saved),a=admission();const changed=async()=>{if(fixture.sql.prepare('SELECT state FROM international_workspace_creation_intents WHERE creation_id=?').get(intent.creationId)!.state==='ready')throw new UsTestBillingError('session_changed',401);};await expect(store.admit(intent,purchase,saved,paid,a,changed)).rejects.toMatchObject({code:'session_changed',status:401});expect(count('international_us_saas_test_paid_proofs')).toBe(1);expect((await store.admit(intent,purchase,saved,paid,a,revalidate)).state).toBe('ready');expect(count('international_workspace_members')).toBe(1);
  });
  it('never writes after initial fresh authorization fails',async()=>{
    await expect(d1UsTestPurchaseStore(fixture.database).reserve(intent,purchase,async()=>{throw new UsTestBillingError('unauthorized',401);})).rejects.toMatchObject({status:401});expect(count('international_us_saas_test_purchases')).toBe(0);
  });
  it('fails every mutation/replay closed after terminal authority revocation',async()=>{
    const {store,saved,paid,a}=await admitted();fixture.sql.prepare('UPDATE international_saas_authorities SET revoked_at=unixepoch() WHERE organization_id=?').run(purchase.organizationId);await expect(store.reserve(intent,purchase,revalidate)).rejects.toMatchObject({status:402});await expect(store.bind(purchase,session(),revalidate)).rejects.toMatchObject({status:402});await expect(store.admit(intent,purchase,saved,paid,a,revalidate)).rejects.toMatchObject({status:402});await expect(d1UsAuthorityStore(fixture.database).admit(intent,a,revalidate)).rejects.toMatchObject({status:402});expect(()=>fixture.sql.exec('UPDATE international_saas_authorities SET revoked_at=NULL')).toThrow('international_saas_authority_immutable');expect(count('international_us_saas_test_paid_proofs')).toBe(1);
  });
  it.each(['international_us_saas_test_purchases','international_us_saas_test_sessions','international_us_saas_test_paid_proofs'])('blocks UPDATE, DELETE and INSERT OR REPLACE of %s history',async table=>{
    await admitted();const row=fixture.sql.prepare(`SELECT * FROM ${table}`).get() as Record<string,SQLInputValue>;expect(()=>fixture.sql.exec(`UPDATE ${table} SET purchase_id=purchase_id`)).toThrow('immutable');expect(()=>fixture.sql.exec(`DELETE FROM ${table}`)).toThrow('immutable');expect(()=>write(table,row,true)).toThrow('exists');expect(fixture.sql.prepare(`SELECT * FROM ${table}`).get()).toEqual(row);
  });
  it('refuses malformed, duplicate, extra, CH/production or SQL NULL offer JSON',()=>{
    for(const encoded of ['{}',canonicalCreationJson({...offer,country:'CH',currency:'CHF'}),canonicalCreationJson({...offer,environment:'PRODUCTION'}),canonicalCreationJson({...offer,privateKey:'never persist'}),canonicalCreationJson(offer).replace('"kind":','"kind":"saas_subscription","kind":')])expect(()=>write('international_us_saas_test_purchases',{...purchaseRow(),offer_json:encoded})).toThrow();expect(count('international_us_saas_test_purchases')).toBe(0);
  });
  it('fails closed if the new migration is missing instead of falling back to legacy billing',async()=>{
    const old=sqliteUsDeviceDatabase();try{await expect(d1UsTestPurchaseStore(old.database).find(actor,intent.requestId)).rejects.toMatchObject({code:'service_unavailable',status:503});await expect(d1UsTestPurchaseStore(old.database).reserve(intent,purchase,revalidate)).rejects.toMatchObject({code:'service_unavailable',status:503});expect(old.sql.prepare('SELECT count(*) AS n FROM subscriptions').get()!.n).toBe(0);}finally{old.sql.close();}
  });
  it('composes real HTTP handlers, immutable D1 store and SQL admission with trusted TEST gateway fixtures',async()=>{
    const store=d1UsTestPurchaseStore(fixture.database),creations=d1WorkspaceCreationStore(fixture.database);
    let createCalls=0,verifiedSignatures=0,verifyCalls=0;
    const dependencies:UsTestBillingDependencies={
      enabled:()=>true,configuration:()=>({policy,providerAccountId:purchase.providerAccountId,siteOrigin:purchase.siteOrigin}),user:async()=>({userId:actor}),creations:()=>creations,purchases:()=>store,
      gateway:()=>({
        async create(p){createCalls++;expect(await store.find(actor,intent.requestId)).toEqual(p);return {session:session(p),url:'https://checkout.stripe.com/c/pay/cs_test_Fictitious'};},
        async locate(event){expect(event).toEqual({id:'evt_FictitiousInitial',trustedFixture:true});const p=await store.find(actor,intent.requestId);return p?{sessionId:session(p).sessionId,eventId:'evt_FictitiousInitial'}:null;},
        async verify(p,s,eventId){verifyCalls++;return proof(p,s,{eventId});},
      }),
      async confirmCreation(){throw new Error('Already confirmed fixture must not issue PG admission');},
      async verifyEvent(raw,signature){expect(signature).toBe('synthetic_verified_signature');expect(raw).toBe('{"id":"evt_FictitiousInitial"}');verifiedSignatures++;return {id:'evt_FictitiousInitial',trustedFixture:true};},
      rateLimit:async()=>{},now:()=>now,allocateId:()=>randomUUID(),integrationIdentifier:()=>'zentra_us_test_abcdefgh',diagnostic:()=>{},
    };
    const handlers=createUsTestBillingHandlers(dependencies),origin=purchase.siteOrigin;
    const request=(body:unknown,path='')=>new Request(origin+'/api/international/billing/test'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Zentra-Expected-User':actor},body:JSON.stringify(body)});
    const checkout=await handlers.POST(request({requestId:intent.requestId,module:offer.module,plan:offer.plan,confirmTest:true}));expect(checkout.status).toBe(200);const pendingBody=await checkout.json();expect(pendingBody).toMatchObject({purchase:{state:'checkout_pending'},workspace:{state:'postgres_confirmed'}});expect(JSON.stringify(pendingBody)).not.toMatch(/providerAccountId|configurationFingerprint|priceId|subscriptionId|invoiceId|purchaseId/);expect(count('international_saas_authorities')).toBe(0);await expect(d1UsAuthorityStore(fixture.database).access(intent.organizationId,actor,policy)).rejects.toMatchObject({status:403});
    const received=await handlers.WEBHOOK(new Request(origin+'/api/international/billing/test/webhook',{method:'POST',headers:{'Stripe-Signature':'synthetic_verified_signature'},body:'{"id":"evt_FictitiousInitial"}'}));expect(received.status).toBe(200);expect(await received.json()).toEqual({received:true,disposition:'admitted'});expect(verifiedSignatures).toBe(1);expect((await creations.find(actor,intent.requestId))!.state).toBe('ready');const firstProof=fixture.sql.prepare('SELECT * FROM international_us_saas_test_paid_proofs').get();
    const recovered=await handlers.RECOVER(request({requestId:intent.requestId},'/recover'));expect(recovered.status).toBe(200);expect(await recovered.json()).toMatchObject({purchase:{state:'ready'},workspace:{state:'ready'}});expect(fixture.sql.prepare('SELECT * FROM international_us_saas_test_paid_proofs').get()).toEqual(firstProof);expect(createCalls).toBe(1);expect(verifyCalls).toBe(2);expect(count('international_workspace_members')).toBe(1);expect(await d1UsAuthorityStore(fixture.database).access(intent.organizationId,actor,policy)).toMatchObject({role:'owner',subscriptionId:authority.subscriptionId});
    fixture.sql.prepare('UPDATE international_saas_authorities SET revoked_at=unixepoch() WHERE organization_id=?').run(intent.organizationId);await expect(d1UsAuthorityStore(fixture.database).access(intent.organizationId,actor,policy)).rejects.toMatchObject({status:402});expect((await handlers.RECOVER(request({requestId:intent.requestId},'/recover'))).status).toBe(402);expect(fixture.sql.prepare('SELECT * FROM international_us_saas_test_paid_proofs').get()).toEqual(firstProof);expect(chSnapshot()).toEqual(chBefore);
  });
});
