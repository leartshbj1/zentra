import { database } from './runtime';
import { AccountPublicError } from './account-security';
import { provisionCompleteCompany } from '@/lib/complete/access';

type Owner = { userId: string; email: string; displayName: string };
type Company = { organization_id: string; name: string; created_by_user_id: string };

/** Called only after verified Stripe settlement, with the account recorded by
 * the server before redirecting to Checkout. Email alone never grants access.
 */
export async function linkPaidCompany(subscriptionId: string, owner: Owner) {
  const db=database(),now=Math.floor(Date.now()/1000);
  const paid=await db.prepare(`SELECT customer_name FROM subscriptions
    WHERE subscription_id=? AND last_paid_invoice_id IS NOT NULL AND entitlement_valid_until>?`)
    .bind(subscriptionId,now).first<{customer_name:string|null}>();
  if(!paid)throw new AccountPublicError('Le paiement est encore en cours de confirmation. Réessayez dans quelques instants.',402);
  const find=()=>db.prepare('SELECT organization_id,name,created_by_user_id FROM organizations WHERE subscription_id=? LIMIT 1')
    .bind(subscriptionId).first<Company>();
  const existing=await find();
  if(existing && existing.created_by_user_id!==owner.userId)throw new AccountPublicError('Cet abonnement appartient déjà à un autre compte Zentra.',409);
  if(existing){await provisionCompleteCompany(subscriptionId,existing.organization_id,owner.userId);return {id:existing.organization_id,name:existing.name};}
  // A verified purchase upgrades the existing trial workspace, preserving its documents.
  const trial=await db.prepare(`SELECT t.organization_id,t.subscription_id FROM account_trials t
    JOIN organizations o ON o.organization_id=t.organization_id AND o.subscription_id=t.subscription_id
    JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=t.user_id AND m.role='owner' AND m.revoked_at IS NULL
    WHERE t.user_id=? AND t.converted_subscription_id IS NULL`).bind(owner.userId).first<{organization_id:string;subscription_id:string}>();
  if(trial){
    await db.batch([
      db.prepare('UPDATE organizations SET subscription_id=?,updated_at=? WHERE organization_id=? AND subscription_id=? AND created_by_user_id=?')
        .bind(subscriptionId,now,trial.organization_id,trial.subscription_id,owner.userId),
      db.prepare('UPDATE account_trials SET converted_subscription_id=? WHERE user_id=? AND converted_subscription_id IS NULL AND EXISTS(SELECT 1 FROM organizations WHERE organization_id=? AND subscription_id=?)')
        .bind(subscriptionId,owner.userId,trial.organization_id,subscriptionId),
      db.prepare('UPDATE license_activations SET subscription_id=? WHERE subscription_id=? AND EXISTS(SELECT 1 FROM organizations WHERE organization_id=? AND subscription_id=?)')
        .bind(subscriptionId,trial.subscription_id,trial.organization_id,subscriptionId),
    ]);
    const upgraded=await find();
    if(!upgraded||upgraded.created_by_user_id!==owner.userId)throw new AccountPublicError('Une autre activation est en cours. Rechargez votre compte.',409);
    await provisionCompleteCompany(subscriptionId,upgraded.organization_id,owner.userId);
    return {id:upgraded.organization_id,name:upgraded.name};
  }
  const name=(paid.customer_name || owner.displayName || 'Mon entreprise').trim().slice(0,160);
  // Both statements use the unique subscription binding. Concurrent webhook,
  // return-page and account requests create exactly one company and owner.
  await db.batch([
    db.prepare(`INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(subscription_id) DO NOTHING`)
      .bind(`org_${crypto.randomUUID()}`,name,subscriptionId,owner.userId,now,now),
    db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at)
      SELECT ?,organization_id,?,?,?,'owner',? FROM organizations WHERE subscription_id=? AND created_by_user_id=?
      ON CONFLICT(organization_id,user_id) DO NOTHING`)
      .bind(`mem_${crypto.randomUUID()}`,owner.userId,owner.email.trim().toLowerCase(),owner.displayName.slice(0,160),now,subscriptionId,owner.userId),
  ]);
  const company=await find();
  if(!company || company.created_by_user_id!==owner.userId)throw new AccountPublicError('Cet abonnement appartient déjà à un autre compte Zentra.',409);
  await provisionCompleteCompany(subscriptionId,company.organization_id,owner.userId);
  return {id:company.organization_id,name:company.name};
}

export async function linkPaidCheckoutAccount(subscriptionId:string) {
  const row=await database().prepare(`SELECT attempt.account_user_id,attempt.account_email,attempt.account_name
    FROM subscriptions subscription JOIN checkout_attempts attempt ON attempt.checkout_session_id=subscription.checkout_session_id
    WHERE subscription.subscription_id=? AND subscription.last_paid_invoice_id IS NOT NULL
      AND subscription.entitlement_valid_until>? AND attempt.account_user_id IS NOT NULL AND attempt.account_email IS NOT NULL LIMIT 1`)
    .bind(subscriptionId,Math.floor(Date.now()/1000)).first<{account_user_id:string;account_email:string;account_name:string|null}>();
  if(!row)return null; // Pending payments and legacy checkouts do not create access.
  return linkPaidCompany(subscriptionId,{userId:row.account_user_id,email:row.account_email,displayName:row.account_name || row.account_email});
}
