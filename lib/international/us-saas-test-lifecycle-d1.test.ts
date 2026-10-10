import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalCreationJson } from './workspace-creation';
import { sha256Hex } from './canonical-hash';
import { d1UsAuthorityStore } from './saas-authority-d1';
import { createUsAutomationGrant } from './us-automation-policy';
import { d1UsTestLifecycleStore } from './us-saas-test-lifecycle-d1';
import { usTestLifecycleMaterial, verifiedUsTestLifecycleObservation, type UsTestLifecycleObservation } from './us-saas-test-lifecycle-contract';
import { lifecycleFixture, lifecycleMigrationFiles } from './us-saas-test-lifecycle-test-fixture';

type Fixture=Awaited<ReturnType<typeof lifecycleFixture>>;
const opened:Fixture[]=[];
async function fixture(enabled=true){const f=await lifecycleFixture(enabled);opened.push(f);return f;}
afterEach(()=>{for(const f of opened.splice(0)){expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);f.sql.close();}});
const check=async()=>{};
function count(f:Fixture,table='international_us_saas_test_lifecycle_receipts'){return f.sql.prepare('SELECT count(*) AS n FROM '+table).get()!.n;}
function renew(f:Fixture){f.setNow(f.authority.evidence!.endsAt+1);return f.paid();}
function risk(f:Fixture,patch:Partial<UsTestLifecycleObservation>={}){return verifiedUsTestLifecycleObservation(f.binding,{eventId:'evt_Risk',subscriptionId:f.binding.subscriptionId,sourceType:'charge',sourceId:'ch_Risk',purchaseId:f.purchase.purchaseId,organizationId:f.purchase.organizationId,customerId:f.binding.customerId,providerAccountId:f.purchase.providerAccountId,observedAt:f.now(),action:'revoke',reason:'refunded',invoiceId:f.binding.initialInvoiceId,authority:null,serverPrice:null,...patch});}
function write(f:Fixture,table:string,row:Record<string,SQLInputValue>,replace=false){const names=Object.keys(row);return f.sql.prepare(`INSERT ${replace?'OR REPLACE ':''}INTO ${table}(${names.join(',')})VALUES(${names.map(()=>'?').join(',')})`).run(...Object.values(row));}
function atomic(f:Fixture,operation:()=>void){f.sql.exec('BEGIN');try{operation();f.sql.exec('COMMIT');}catch(error){f.sql.exec('ROLLBACK');throw error;}}
async function rows(f:Fixture,value:UsTestLifecycleObservation){
  const material=usTestLifecycleMaterial(value),hash=await sha256Hex(material),revocation=f.sql.prepare('SELECT revoked_at FROM international_saas_authorities WHERE organization_id=?').get(f.purchase.organizationId)!.revoked_at;
  const receipt:Record<string,SQLInputValue>={receipt_hash:hash,purchase_id:value.purchaseId,organization_id:value.organizationId,subscription_id:value.subscriptionId,customer_id:value.customerId,provider_account_id:value.providerAccountId,event_id:value.eventId,source_type:value.sourceType,source_id:value.sourceId,action:value.action,reason:value.reason,invoice_id:value.invoiceId,material_json:material,observed_at:value.observedAt,period_invoice_id:value.action==='paid_period'?value.invoiceId:null,applied_revoked_at:value.action==='revoke'?revocation??value.observedAt:null};
  const period:Record<string,SQLInputValue>|null=value.action==='paid_period'?{provider_account_id:value.providerAccountId,invoice_id:value.invoiceId,organization_id:value.organizationId,purchase_id:value.purchaseId,subscription_id:value.subscriptionId,customer_id:value.customerId,starts_at:value.authority!.evidence!.startsAt,ends_at:value.authority!.evidence!.endsAt,authority_json:canonicalCreationJson(value.authority),observed_at:value.observedAt,receipt_hash:hash}:null;
  return {receipt,period};
}
function intercepted(f:Fixture,batch:(statements:D1PreparedStatement[])=>Promise<unknown>){return {prepare:f.database.prepare.bind(f.database),batch} as Pick<D1Database,'prepare'|'batch'>;}

describe('0092 immutable TEST lifecycle on the real0000..0092 SQLite chain',()=>{
  it('preserves populated CH, initial authority, proof, memberships, readiness and all existing FKs during migration',async()=>{
    const f=await fixture();expect(lifecycleMigrationFiles.map(name=>Number(name.slice(0,4)))).toEqual(Array.from({length:93},(_,i)=>i));expect(f.snapshot()).toEqual(f.before);expect(count(f)).toBe(0);expect(count(f,'international_us_saas_test_periods')).toBe(0);
  });
  it('resolves only the exact admitted0091 binding, including after terminal revocation',async()=>{
    const f=await fixture();expect(await f.store.bySubscription(f.binding.subscriptionId)).toEqual(f.binding);expect(await f.store.bySubscription('sub_Unknown')).toBeNull();expect(await f.store.bySubscription('sub_LifecycleCH')).toBeNull();await f.store.apply(f.binding,risk(f),check);expect(await f.store.bySubscription(f.binding.subscriptionId)).toEqual(f.binding);
  });
  it('fails closed when0092 is absent instead of falling back to the initial authority',async()=>{
    const f=await fixture(false);await expect(f.store.bySubscription(f.binding.subscriptionId)).rejects.toMatchObject({status:503});await expect(d1UsAuthorityStore(f.database).access(f.purchase.organizationId,f.actor,f.policy)).rejects.toMatchObject({status:503});await expect(f.store.apply(f.binding,renew(f),check)).rejects.toMatchObject({status:503});
  });
  it('renews after initial expiration for Gestion and Automation without rewriting any initial fact',async()=>{
    const f=await fixture(),before=f.snapshot(),observation=renew(f),store=d1UsAuthorityStore(f.database),policy={...f.policy,now:f.now()};await expect(store.access(f.purchase.organizationId,f.actor,policy)).rejects.toMatchObject({status:402});expect(await f.store.apply(f.binding,observation,check)).toBe('paid_period');expect(await store.access(f.purchase.organizationId,f.actor,policy)).toMatchObject({role:'owner',seatLimit:8});expect((await store.automationAuthority(f.purchase.organizationId,f.actor,policy)).authorityReference).toBe(observation.invoiceId);expect(f.snapshot()).toEqual(before);
  });
  it('preserves original admission replay after renewal',async()=>{
    const f=await fixture();await f.store.apply(f.binding,renew(f),check);const store=d1UsAuthorityStore(f.database);expect(await store.admit(f.initial,f.admission,check)).toEqual(f.intent);
  });
  it('replays exact facts without changing the first observed time, and supports distinct events for the same invoice',async()=>{
    const f=await fixture(),v=renew(f);expect(await f.store.apply(f.binding,v,check)).toBe('paid_period');f.setNow(f.now()+1);expect(await f.store.apply(f.binding,f.paid({observedAt:f.now()}),check)).toBe('replayed');expect(await f.store.apply(f.binding,f.paid({eventId:'evt_Other',observedAt:f.now()}),check)).toBe('paid_period');expect(count(f)).toBe(2);expect(count(f,'international_us_saas_test_periods')).toBe(1);expect(f.sql.prepare('SELECT min(observed_at) AS n FROM international_us_saas_test_lifecycle_receipts').get()).toEqual({n:v.observedAt});
  });
  it('accepts the initial invoice only with its exact original authority and never extends it',async()=>{
    const f=await fixture(),v=f.paid({invoiceId:f.binding.initialInvoiceId,sourceId:f.binding.initialInvoiceId,authority:f.authority});expect(await f.store.apply(f.binding,v,check)).toBe('paid_period');const altered=f.paid({eventId:'evt_InitialModified',invoiceId:f.binding.initialInvoiceId,sourceId:f.binding.initialInvoiceId,authority:{...f.authority,evidence:{...f.authority.evidence!,endsAt:f.authority.evidence!.endsAt+1}}});await expect(f.store.apply(f.binding,altered,check)).rejects.toMatchObject({status:409});expect(f.sql.prepare('SELECT authority_json FROM international_effective_saas_authorities').get()).toEqual({authority_json:canonicalCreationJson(f.authority)});
  });
  it('does not let a changed initial-invoice period through direct SQL',async()=>{
    const f=await fixture(),v=f.paid({invoiceId:f.binding.initialInvoiceId,sourceId:f.binding.initialInvoiceId,authority:{...f.authority,evidence:{...f.authority.evidence!,endsAt:f.authority.evidence!.endsAt+1}}}),r=await rows(f,v);expect(()=>atomic(f,()=>{write(f,'international_us_saas_test_lifecycle_receipts',r.receipt);write(f,'international_us_saas_test_periods',r.period!);})).toThrow('us_lifecycle_period_scope');expect(count(f)).toBe(0);
  });
  it('handles a newly observed refund on the same event as a distinct terminal fact',async()=>{
    const f=await fixture(),v=renew(f);await f.store.apply(f.binding,v,check);expect(await f.store.apply(f.binding,risk(f,{eventId:v.eventId}),check)).toBe('revoked');expect(count(f)).toBe(2);await expect(f.store.apply(f.binding,v,check)).rejects.toMatchObject({status:402});expect(await f.store.apply(f.binding,risk(f,{eventId:v.eventId,observedAt:f.now()+1}),check)).toBe('replayed');expect(()=>f.sql.exec('UPDATE international_saas_authorities SET revoked_at=NULL')).toThrow('international_saas_authority_immutable');
  });
  it.each(['refunded','disputed','restricted'] as const)('terminal %s of an older invoice denies every current right and never reactivates on a late paid event',async reason=>{
    const f=await fixture();await f.store.apply(f.binding,renew(f),check);await f.store.apply(f.binding,risk(f,{reason}),check);for(const requestedModule of ['gestion','automation'] as const)await expect(d1UsAuthorityStore(f.database).access(f.purchase.organizationId,f.actor,{...f.policy,now:f.now()},requestedModule)).rejects.toMatchObject({status:402});await expect(f.store.apply(f.binding,f.paid({eventId:'evt_LatePaid'}),check)).rejects.toMatchObject({status:402});expect(count(f,'international_us_saas_test_periods')).toBe(1);
  });
  it.each(['payment_pending','canceled_paid_through'] as const)('%s records no extra period and keeps only the already paid exclusive window',async reason=>{
    const f=await fixture();const v=risk(f,{action:'observe',reason,invoiceId:null});expect(await f.store.apply(f.binding,v,check)).toBe('observed');expect(count(f,'international_us_saas_test_periods')).toBe(0);const store=d1UsAuthorityStore(f.database);await expect(store.access(f.purchase.organizationId,f.actor,f.policy)).resolves.toMatchObject({role:'owner'});f.setNow(f.authority.evidence!.endsAt);await expect(store.access(f.purchase.organizationId,f.actor,{...f.policy,now:f.now()})).rejects.toMatchObject({status:402});
  });
  it('selects the longest already-started period despite out-of-order delivery, then expires at its exclusive end',async()=>{
    const f=await fixture(),v=renew(f);await f.store.apply(f.binding,v,check);const longer=f.paid({eventId:'evt_Longer',invoiceId:'in_Longer',sourceId:'in_Longer',authority:{...v.authority!,evidence:{...v.authority!.evidence!,referenceId:'in_Longer',startsAt:f.now(),endsAt:f.now()+7200}}});await f.store.apply(f.binding,longer,check);await f.store.apply(f.binding,f.paid({eventId:'evt_Delayed'}),check);expect((await d1UsAuthorityStore(f.database).automationAuthority(f.purchase.organizationId,f.actor,{...f.policy,now:f.now()})).authorityReference).toBe('in_Longer');f.setNow(longer.authority!.evidence!.endsAt);await expect(d1UsAuthorityStore(f.database).access(f.purchase.organizationId,f.actor,{...f.policy,now:f.now()})).rejects.toMatchObject({status:402});
  });
  it('does not reset the UTC usage key when the effective invoice changes',async()=>{
    const f=await fixture(),store=d1UsAuthorityStore(f.database),budget={schemaVersion:1 as const,cadence:'utc_calendar_month' as const,budgetPolicyVersion:'fixture1',processingPolicyVersion:'fixture1',entries:[{catalogVersion:f.purchase.offer.catalogVersion,priceId:f.purchase.offer.priceId,limit:10}]};const before=createUsAutomationGrant(await store.automationAuthority(f.purchase.organizationId,f.actor,f.policy),budget);await f.store.apply(f.binding,renew(f),check);const after=createUsAutomationGrant(await store.automationAuthority(f.purchase.organizationId,f.actor,{...f.policy,now:f.now()}),budget);expect([after.organizationId,after.environment,after.bucket,after.periodId]).toEqual([before.organizationId,before.environment,before.bucket,before.periodId]);expect(after.authorityReference).not.toBe(before.authorityReference);
  });
});

describe('private lifecycle sink provenance, SQL corroboration and atomic recovery',()=>{
  it('rejects a copied/unbranded observation before any write',async()=>{const f=await fixture(),v=renew(f);await expect(f.store.apply(f.binding,{...v},check)).rejects.toMatchObject({code:'unverified_lifecycle',status:422});expect(count(f)).toBe(0);});
  it('rejects a forged durable binding even with a genuinely branded observation',async()=>{const f=await fixture(),v=renew(f),forged={...f.binding,purchase:{...f.purchase,siteOrigin:'https://other.invalid'}};await expect(f.store.apply(forged,v,check)).rejects.toMatchObject({status:409});expect(count(f)).toBe(0);});
  it.each(['purchase_id','organization_id','subscription_id','customer_id','provider_account_id'] as const)('rejects direct SQL receipt scope drift in %s',async field=>{
    const f=await fixture(),r=await rows(f,renew(f));r.receipt[field]=field.endsWith('_id')?randomUUID():'wrong';expect(()=>write(f,'international_us_saas_test_lifecycle_receipts',r.receipt)).toThrow('us_lifecycle_scope');expect(count(f)).toBe(0);
  });
  it.each(['purchase_id','organization_id','subscription_id','customer_id','provider_account_id','authority_json','starts_at','ends_at'] as const)('rejects direct SQL period drift in %s and rolls back the receipt',async field=>{
    const f=await fixture(),r=await rows(f,renew(f));r.period![field]=field==='authority_json'?canonicalCreationJson({...f.authority,secret:'never persist'}):field==='starts_at'?f.now()+1:field==='ends_at'?f.now()+1:randomUUID();expect(()=>atomic(f,()=>{write(f,'international_us_saas_test_lifecycle_receipts',r.receipt);write(f,'international_us_saas_test_periods',r.period!);})).toThrow();expect(count(f)).toBe(0);
  });
  it.each(['paid','revoked'] as const)('cannot commit a %s receipt without its corresponding effect',async action=>{
    const f=await fixture(),r=await rows(f,action==='paid'?renew(f):risk(f));expect(()=>atomic(f,()=>write(f,'international_us_saas_test_lifecycle_receipts',r.receipt))).toThrow(/FOREIGN KEY/);expect(count(f)).toBe(0);
  });
  it.each(['receipt','period'] as const)('cannot rewrite/delete/replace immutable %s history',async kind=>{
    const f=await fixture(),v=renew(f);await f.store.apply(f.binding,v,check);const table=kind==='receipt'?'international_us_saas_test_lifecycle_receipts':'international_us_saas_test_periods',row=f.sql.prepare('SELECT * FROM '+table).get() as Record<string,SQLInputValue>;expect(()=>f.sql.exec('UPDATE '+table+' SET observed_at=observed_at+1')).toThrow('us_lifecycle_immutable');expect(()=>f.sql.exec('DELETE FROM '+table)).toThrow('us_lifecycle_immutable');expect(()=>write(f,table,row,true)).toThrow();expect(count(f,table)).toBe(1);
  });
  it('refuses a future period at the SQL sink, independently of gateway validation',async()=>{
    const f=await fixture(),v=renew(f),r=await rows(f,v);r.period!.starts_at=f.now()+1;const changed={...v.authority!,evidence:{...v.authority!.evidence!,startsAt:f.now()+1}};r.period!.authority_json=canonicalCreationJson(changed);r.receipt.material_json=canonicalCreationJson({...JSON.parse(r.receipt.material_json as string),authority:changed});expect(()=>atomic(f,()=>{write(f,'international_us_saas_test_lifecycle_receipts',r.receipt);write(f,'international_us_saas_test_periods',r.period!);})).toThrow();expect(count(f)).toBe(0);
  });
  it('refuses a branded first observation aged61s at SQL commit but preserves an old exact durable replay',async()=>{
    const f=await fixture(),v=renew(f);f.setNow(f.now()+61);await expect(f.store.apply(f.binding,v,check)).rejects.toMatchObject({status:503});expect(count(f)).toBe(0);expect(count(f,'international_us_saas_test_periods')).toBe(0);const fresh=f.paid({observedAt:f.now()});expect(await f.store.apply(f.binding,fresh,check)).toBe('paid_period');f.setNow(f.now()+61);expect(await f.store.apply(f.binding,v,check)).toBe('replayed');expect(count(f)).toBe(1);
  });
  it('rolls the whole batch back when an unrelated final statement fails',async()=>{
    const f=await fixture(),store=d1UsTestLifecycleStore(intercepted(f,statements=>f.database.batch([...statements,f.database.prepare('INSERT INTO nonexistent_lifecycle_fixture(value)VALUES(1)')])));await expect(store.apply(f.binding,renew(f),check)).rejects.toMatchObject({status:503});expect(count(f)).toBe(0);expect(count(f,'international_us_saas_test_periods')).toBe(0);
  });
  it.each(['paid_period','revoke'] as const)('rejects omitted %s effects through deferred FKs',async action=>{
    const f=await fixture(),store=d1UsTestLifecycleStore(intercepted(f,statements=>f.database.batch(statements.slice(0,1))));await expect(store.apply(f.binding,action==='paid_period'?renew(f):risk(f),check)).rejects.toMatchObject({status:503});expect(count(f)).toBe(0);expect(f.sql.prepare('SELECT revoked_at FROM international_saas_authorities').get()).toEqual({revoked_at:null});
  });
  it('recovers a committed batch response loss as an exact durable replay',async()=>{
    const f=await fixture(),store=d1UsTestLifecycleStore(intercepted(f,async statements=>{await f.database.batch(statements);throw new Error('Synthetic response lost after commit');}));expect(await store.apply(f.binding,renew(f),check)).toBe('replayed');expect(count(f)).toBe(1);expect(count(f,'international_us_saas_test_periods')).toBe(1);
  });
  it('preserves fresh Auth errors before writes and after a successful commit',async()=>{
    const f=await fixture(),v=renew(f),unauthorized=Object.assign(new Error('session changed'),{status:401});await expect(f.store.apply(f.binding,v,async()=>{throw unauthorized;})).rejects.toBe(unauthorized);expect(count(f)).toBe(0);let committed=false;const store=d1UsTestLifecycleStore(intercepted(f,async statements=>{const result=await f.database.batch(statements);committed=true;return result;}));await expect(store.apply(f.binding,v,async()=>{if(committed)throw unauthorized;})).rejects.toBe(unauthorized);expect(count(f)).toBe(1);expect(await f.store.apply(f.binding,v,check)).toBe('replayed');
  });
  it('rejects revocation between the JS check and SQL period commit',async()=>{
    const f=await fixture(),store=d1UsTestLifecycleStore(intercepted(f,async statements=>{f.sql.prepare('UPDATE international_saas_authorities SET revoked_at=unixepoch()').run();return f.database.batch(statements);}));await expect(store.apply(f.binding,renew(f),check)).rejects.toMatchObject({status:402});expect(count(f)).toBe(0);expect(count(f,'international_us_saas_test_periods')).toBe(0);
  });
  it('refuses stale Automation provenance when the effective invoice changes during fresh rights reads',async()=>{
    const f=await fixture(),v=renew(f);await f.store.apply(f.binding,v,check);const newer=f.paid({eventId:'evt_Change',invoiceId:'in_Changed',sourceId:'in_Changed',authority:{...v.authority!,evidence:{...v.authority!.evidence!,referenceId:'in_Changed',endsAt:v.authority!.evidence!.endsAt+1}}});let changed=false;const database={batch:f.database.batch.bind(f.database),prepare(sql:string){const statement=f.database.prepare(sql);if(!sql.startsWith('SELECT a.*,m.membership_id'))return statement;return {bind(...values:unknown[]){const bound=statement.bind(...values);return {async first(){const row=await bound.first();if(!changed){changed=true;await f.store.apply(f.binding,newer,check);}return row;}};}};}} as unknown as Pick<D1Database,'prepare'|'batch'>;await expect(d1UsAuthorityStore(database).automationAuthority(f.purchase.organizationId,f.actor,{...f.policy,now:f.now()})).rejects.toMatchObject({status:503});expect(changed).toBe(true);
  });
});
