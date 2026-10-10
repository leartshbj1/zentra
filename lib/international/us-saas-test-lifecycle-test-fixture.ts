import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { sqliteUsDeviceDatabase } from './us-device-test-fixture';
import { canonicalCreationJson, createOrResumeUsWorkspace } from './workspace-creation';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { d1UsTestPurchaseStore } from './us-saas-test-d1';
import { prepareUsAuthorityAdmission } from './saas-authority';
import { validateUsTestPurchase, verifiedUsTestSession, verifiedUsTestPaidProof } from './us-saas-test-contract';
import { validateUsTestLifecycleBinding, verifiedUsTestLifecycleObservation, type UsTestLifecycleObservation } from './us-saas-test-lifecycle-contract';
import { d1UsTestLifecycleStore } from './us-saas-test-lifecycle-d1';
import type { SaasSubscriptionAuthority, SaasSubscriptionOffer, ServerStripePrice } from './subscriptions';

const folder=new URL('../../drizzle/',import.meta.url);
export const lifecycleMigrationFiles=readdirSync(folder).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&Number(name.slice(0,4))<=92).sort();
export const lifecycleSql=readFileSync(new URL('0092_international_us_saas_test_lifecycle.sql',folder),'utf8');

/** Real0000..0092 SQL. Initial admission is committed before0092, so the
 * migration exercises populated US and CH history. Provider/Auth/PG are
 * synthetic trusted fixtures; no hosted/provider behaviour is asserted. */
export async function lifecycleFixture(includeLifecycle=true) {
  const f=sqliteUsDeviceDatabase(86);
  for(const name of lifecycleMigrationFiles.filter(name=>Number(name.slice(0,4))>=87&&Number(name.slice(0,4))<=91))f.sql.exec(readFileSync(new URL(name,folder),'utf8'));
  let clock=Number(f.sql.prepare('SELECT unixepoch() AS n').get()!.n);
  f.sql.function('unixepoch',()=>clock);
  const actor=randomUUID(),createdAt=clock-60,stamp=new Date(createdAt*1000).toISOString();
  f.sql.prepare("INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)VALUES('sub_LifecycleCH','cus_LifecycleCH','price_LifecycleCH','active',?,?)").run(clock+86400,clock);
  f.sql.prepare("INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)VALUES('lifecycle-CH','Existing CH','sub_LifecycleCH',?,?,?)").run(actor,clock,clock);
  f.sql.prepare("INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)VALUES('member-lifecycle-CH','lifecycle-CH',?,'owner@example.test','owner',?)").run(actor,clock);
  const initial=await createOrResumeUsWorkspace(actor,{requestId:randomUUID(),confirmationVersion:1,companyName:'Fictitious lifecycle TEST',configuration:{schemaVersion:1,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Fictitious St',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}}},{store:d1WorkspaceCreationStore(f.database),allocateId:()=>randomUUID(),now:()=>stamp,fingerprint:async text=>createHash('sha256').update(text).digest('hex'),admit:async saved=>({creationId:saved.creationId,organizationId:saved.organizationId,actorUserId:actor,requestId:saved.requestId,configurationFingerprint:saved.fingerprint,configuration:saved.configuration,revision:1,updatedBy:actor,updatedAt:stamp,replayed:false}),revalidate:async()=>{}});
  const offer:SaasSubscriptionOffer={kind:'saas_subscription',catalogVersion:'lifecycle_TEST_fixture',country:'US',currency:'USD',module:'complet',plan:'lifecycle_fixture',priceId:'price_LifecycleFixture',productId:'prod_LifecycleFixture',environment:'TEST',unitAmountMinor:'123',interval:'month',intervalCount:1,taxBehavior:'exclusive'};
  const price:ServerStripePrice={id:offer.priceId,active:true,livemode:false,currency:'usd',unit_amount:123,type:'recurring',tax_behavior:'exclusive',recurring:{interval:'month',interval_count:1,usage_type:'licensed'},product:{id:offer.productId,active:true}};
  const policy={catalog:[{offer,seatLimit:8}],environment:'TEST' as const,now:clock};
  const authority:SaasSubscriptionAuthority={kind:'saas_subscription_authority',organizationId:initial.organizationId,subscriptionId:'sub_'+initial.organizationId.replaceAll('-',''),offer,status:'active',evidence:{kind:'verified_payment',referenceId:'in_Initial'+initial.organizationId.replaceAll('-',''),organizationId:initial.organizationId,subscriptionId:'sub_'+initial.organizationId.replaceAll('-',''),environment:'TEST',catalogVersion:offer.catalogVersion,priceId:offer.priceId,currency:'USD',startsAt:createdAt,endsAt:clock+120,revoked:false}};
  const purchases=d1UsTestPurchaseStore(f.database);
  const purchase=await purchases.reserve(initial,validateUsTestPurchase({purchaseId:randomUUID(),creationId:initial.creationId,organizationId:initial.organizationId,actorUserId:actor,requestId:initial.requestId,configurationFingerprint:initial.fingerprint,receipt:initial.receipt!,offer,seatLimit:8,providerAccountId:'acct_LifecycleFixture',siteOrigin:'https://example.invalid',integrationIdentifier:'zentra_us_test_abcdefgh',createdAt,expiresAt:createdAt+3600},initial),async()=>{});
  const session=await purchases.bind(purchase,verifiedUsTestSession(purchase,{purchaseId:purchase.purchaseId,sessionId:'cs_test_'+purchase.purchaseId.replaceAll('-',''),customerId:null,subscriptionId:null,createdAt,expiresAt:purchase.expiresAt}),async()=>{});
  const proof=verifiedUsTestPaidProof(purchase,{purchaseId:purchase.purchaseId,sessionId:session.sessionId,customerId:'cus_LifecycleFixture',subscriptionId:authority.subscriptionId,invoiceId:authority.evidence!.referenceId,eventId:'evt_Initial',providerAccountId:purchase.providerAccountId,authority,serverPrice:price,verifiedAt:clock});
  const admission=prepareUsAuthorityAdmission(initial,{authority,seatLimit:8},policy,price);
  const intent=await purchases.admit(initial,purchase,session,proof,admission,async()=>{});
  const binding=validateUsTestLifecycleBinding({purchase,session,customerId:proof.customerId,subscriptionId:proof.subscriptionId,initialInvoiceId:proof.invoiceId});
  const historicalTables=['subscriptions','organizations','organization_members','license_activations','device_sessions','international_saas_authorities','international_workspace_members','international_workspace_creation_intents','international_us_saas_test_purchases','international_us_saas_test_sessions','international_us_saas_test_paid_proofs'];
  const snapshot=()=>historicalTables.map(table=>({table,rows:f.sql.prepare('SELECT * FROM '+table+' ORDER BY rowid').all(),foreignKeys:f.sql.prepare('PRAGMA foreign_key_list('+table+')').all()}));
  const before=snapshot();if(includeLifecycle)f.sql.exec(lifecycleSql);
  function paid(patch:Partial<UsTestLifecycleObservation>={}) {
    const invoiceId='in_Renewal'+purchase.purchaseId.replaceAll('-','');
    return verifiedUsTestLifecycleObservation(binding,{eventId:'evt_Renewal',subscriptionId:binding.subscriptionId,sourceType:'invoice',sourceId:invoiceId,purchaseId:purchase.purchaseId,organizationId:purchase.organizationId,customerId:binding.customerId,providerAccountId:purchase.providerAccountId,observedAt:clock,action:'paid_period',reason:'paid',invoiceId,authority:{...authority,evidence:{...authority.evidence!,referenceId:invoiceId,startsAt:authority.evidence!.endsAt,endsAt:authority.evidence!.endsAt+3600}},serverPrice:price,...patch});
  }
  return {...f,actor,intent,initial,purchase,session,binding,authority,policy,price,proof,admission,before,snapshot,paid,store:d1UsTestLifecycleStore(f.database),now:()=>clock,setNow(value:number){clock=value;},canonical:canonicalCreationJson};
}
