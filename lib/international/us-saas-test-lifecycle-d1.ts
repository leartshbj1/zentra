import { canonicalCreationJson } from './workspace-creation';
import { snapshotPrivateJson } from './private-json';
import { sha256Hex } from './canonical-hash';
import { parseUsSubscriptionAuthority, UsAuthorityError } from './saas-authority';
import { UsTestBillingError } from './us-saas-test-contract';
import { d1UsTestPurchaseStore } from './us-saas-test-d1';
import { assertUsTestLifecycleObservation, usTestLifecycleMaterial, validateUsTestLifecycleBinding, verifiedUsTestLifecycleObservation, type UsTestLifecycleBinding, type UsTestLifecycleObservation } from './us-saas-test-lifecycle-contract';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
type Disposition = 'paid_period' | 'observed' | 'revoked' | 'replayed';
interface BindingRow { actor_user_id:string; request_id:string; customer_id:string; subscription_id:string; invoice_id:string; authority_json:string; initial_authority_json:string; seat_limit:number; offer_json:string; environment:string; country:string; currency:string }
interface ReceiptRow { receipt_hash:string; purchase_id:string; organization_id:string; subscription_id:string; action:string; material_json:string; observed_at:number }
class RevalidationFailure { constructor(readonly error:unknown) {} }
function failure(error:unknown):never {
  if(error instanceof RevalidationFailure)throw error.error;
  if(error instanceof UsTestBillingError||error instanceof UsAuthorityError)throw error;
  throw new UsTestBillingError('service_unavailable',503);
}

/** Private sink only. Every period extends the immutable 0091 admission identity;
 * a verified event locator or a copied observation never grants rights. SQL
 * deferred FKs make receipt+period and receipt+terminal revocation atomic. */
export function d1UsTestLifecycleStore(database:Database) {
  const purchases=d1UsTestPurchaseStore(database);
  async function bySubscription(subscriptionId:string):Promise<UsTestLifecycleBinding|null> {
    try {
      if(!/^sub_[A-Za-z0-9_]{1,124}$/.test(subscriptionId))throw new UsTestBillingError('lifecycle_mismatch',422);
      const source=await database.prepare(`SELECT p.actor_user_id,p.request_id,proof.customer_id,proof.subscription_id,proof.invoice_id,proof.authority_json,
        a.authority_json AS initial_authority_json,a.seat_limit,a.offer_json,a.environment,a.country,a.currency
        FROM international_us_saas_test_paid_proofs proof JOIN international_us_saas_test_purchases p ON p.purchase_id=proof.purchase_id
        JOIN international_saas_authorities a ON a.organization_id=proof.organization_id AND a.creation_id=proof.creation_id AND a.owner_user_id=proof.actor_user_id AND a.subscription_id=proof.subscription_id
        JOIN international_effective_saas_authorities capability ON capability.organization_id=a.organization_id
        JOIN international_workspace_creation_intents i ON i.creation_id=p.creation_id AND i.organization_id=p.organization_id
        WHERE proof.subscription_id=? AND p.actor_user_id=proof.actor_user_id AND p.organization_id=proof.organization_id
          AND p.provider_account_id=proof.provider_account_id AND i.state='ready' AND i.own_subscription_id=a.subscription_id
          AND i.actor_user_id=p.actor_user_id AND i.pg_receipt_json=p.receipt_json AND i.configuration_fingerprint=p.configuration_fingerprint`).bind(subscriptionId).first<BindingRow>();
      if(!source)return null;
      const row=snapshotPrivateJson(source) as BindingRow;
      const purchase=await purchases.find(row.actor_user_id,row.request_id);
      if(!purchase)throw new UsTestBillingError('service_unavailable',503);
      const session=await purchases.session(purchase.purchaseId);
      const authority=parseUsSubscriptionAuthority(JSON.parse(row.authority_json));
      if(!session||row.authority_json!==row.initial_authority_json||row.environment!=='TEST'||row.country!=='US'||row.currency!=='USD'
        ||row.seat_limit!==purchase.seatLimit||canonicalCreationJson(JSON.parse(row.offer_json))!==canonicalCreationJson(purchase.offer)
        ||authority.organizationId!==purchase.organizationId||authority.subscriptionId!==subscriptionId||authority.evidence?.referenceId!==row.invoice_id
        ||canonicalCreationJson(authority.offer)!==canonicalCreationJson(purchase.offer))throw new UsTestBillingError('service_unavailable',503);
      return validateUsTestLifecycleBinding({purchase,session,customerId:row.customer_id,subscriptionId:row.subscription_id,initialInvoiceId:row.invoice_id});
    }catch(error){return failure(error);}
  }
  async function revokedAt(organizationId:string):Promise<number|null> {
    const row=await database.prepare('SELECT revoked_at FROM international_saas_authorities WHERE organization_id=?').bind(organizationId).first<{revoked_at:number|null}>();
    if(!row||row.revoked_at!==null&&(!Number.isSafeInteger(row.revoked_at)||row.revoked_at<1))throw new UsTestBillingError('service_unavailable',503);
    return row.revoked_at;
  }
  async function receipt(hash:string,binding:UsTestLifecycleBinding,material:string):Promise<boolean> {
    const source=await database.prepare('SELECT receipt_hash,purchase_id,organization_id,subscription_id,action,material_json,observed_at FROM international_us_saas_test_lifecycle_receipts WHERE receipt_hash=?').bind(hash).first<ReceiptRow>();
    if(!source)return false;
    const row=snapshotPrivateJson(source) as ReceiptRow;
    if(row.receipt_hash!==hash||row.purchase_id!==binding.purchase.purchaseId||row.organization_id!==binding.purchase.organizationId||row.subscription_id!==binding.subscriptionId||row.material_json!==material
      ||!Number.isSafeInteger(row.observed_at)||row.observed_at<binding.purchase.createdAt)throw new UsTestBillingError('lifecycle_conflict',409);
    return true;
  }
  return {
    bySubscription,
    async apply(input:UsTestLifecycleBinding,observed:UsTestLifecycleObservation,revalidate:()=>Promise<void>):Promise<Disposition> {
      const check=async()=>{try{await revalidate();}catch(error){throw new RevalidationFailure(error);}};
      try {
        assertUsTestLifecycleObservation(observed);
        const binding=validateUsTestLifecycleBinding(input);
        const value=verifiedUsTestLifecycleObservation(binding,snapshotPrivateJson(observed) as UsTestLifecycleObservation);
        const material=usTestLifecycleMaterial(value),hash=await sha256Hex(material),org=binding.purchase.organizationId;
        await check();
        const durable=await bySubscription(binding.subscriptionId);
        if(!durable||canonicalCreationJson(durable)!==canonicalCreationJson(binding))throw new UsTestBillingError('lifecycle_conflict',409);
        const revocation=await revokedAt(org);
        if(value.action==='paid_period'&&revocation!==null)throw new UsTestBillingError('subscription_required',402);
        if(await receipt(hash,binding,material)){await check();return 'replayed';}
        const appliedRevokedAt=value.action==='revoke'?revocation??value.observedAt:null;
        const statements=[database.prepare(`INSERT INTO international_us_saas_test_lifecycle_receipts(receipt_hash,purchase_id,organization_id,subscription_id,customer_id,provider_account_id,event_id,source_type,source_id,action,reason,invoice_id,material_json,observed_at,period_invoice_id,applied_revoked_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(hash,binding.purchase.purchaseId,org,binding.subscriptionId,binding.customerId,binding.purchase.providerAccountId,value.eventId,value.sourceType,value.sourceId,value.action,value.reason,value.invoiceId,material,value.observedAt,value.action==='paid_period'?value.invoiceId:null,appliedRevokedAt)];
        if(value.action==='paid_period') {
          const authority=canonicalCreationJson(value.authority),proof=value.authority!.evidence!;
          const existing=await database.prepare('SELECT organization_id,purchase_id,subscription_id,customer_id,authority_json FROM international_us_saas_test_periods WHERE provider_account_id=? AND invoice_id=?').bind(value.providerAccountId,value.invoiceId).first<{organization_id:string;purchase_id:string;subscription_id:string;customer_id:string;authority_json:string}>();
          if(existing&&(existing.organization_id!==org||existing.purchase_id!==binding.purchase.purchaseId||existing.subscription_id!==binding.subscriptionId||existing.customer_id!==binding.customerId||existing.authority_json!==authority))throw new UsTestBillingError('lifecycle_conflict',409);
          if(!existing)statements.push(database.prepare(`INSERT INTO international_us_saas_test_periods(provider_account_id,invoice_id,organization_id,purchase_id,subscription_id,customer_id,starts_at,ends_at,authority_json,observed_at,receipt_hash)VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(value.providerAccountId,value.invoiceId,org,binding.purchase.purchaseId,binding.subscriptionId,binding.customerId,proof.startsAt,proof.endsAt,authority,value.observedAt,hash));
        }else if(value.action==='revoke')statements.push(database.prepare('UPDATE international_saas_authorities SET revoked_at=COALESCE(revoked_at,?) WHERE organization_id=? AND subscription_id=?').bind(appliedRevokedAt,org,binding.subscriptionId));
        try {await check();await database.batch(statements);}
        catch(error) {
          if(error instanceof RevalidationFailure)throw error;
          await check();
          if(value.action==='paid_period'&&await revokedAt(org)!==null)throw new UsTestBillingError('subscription_required',402);
          if(await receipt(hash,binding,material))return 'replayed';
          throw error;
        }
        await check();
        if(value.action==='paid_period'&&await revokedAt(org)!==null)throw new UsTestBillingError('subscription_required',402);
        if(!await receipt(hash,binding,material))throw new UsTestBillingError('service_unavailable',503);
        return value.action==='observe'?'observed':value.action==='revoke'?'revoked':'paid_period';
      }catch(error){return failure(error);}
    },
  };
}
