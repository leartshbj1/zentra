import { database } from '@/lib/runtime';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { planById } from '@/lib/plans';
export const TRIAL_DAYS = 14;
type Trial = {user_id:string;organization_id:string;subscription_id:string;started_at:number;ends_at:number;converted_subscription_id:string|null};
export async function trialForUser(userId:string){return database().prepare('SELECT * FROM account_trials WHERE user_id=?').bind(userId).first<Trial>();}
export async function startAccountTrial(user:{userId:string;email:string;displayName:string},name:string){
  const previous = await trialForUser(user.userId);
  if(previous) return previous; // Retries never restart or extend a trial.
  if(!name.trim()||name.trim().length>120) throw new AccountPublicError('Indiquez le nom de votre entreprise (120 caractères maximum).');
  const db=database();
  const owned = await db.prepare("SELECT organization_id FROM organizations WHERE created_by_user_id=? LIMIT 1").bind(user.userId).first();
  if(owned) throw new AccountPublicError('Votre compte possède déjà une entreprise. Retrouvez-la dans vos paramètres.',409);
  const now=Math.floor(Date.now()/1000),until=now+TRIAL_DAYS*86400;
  const fingerprint=await sha256Hex(user.userId),emailHash=await sha256Hex(user.email.trim().toLowerCase());
  const sub=`trial_${fingerprint.slice(0,32)}`,org=`org_trial_${fingerprint.slice(0,32)}`,plan=planById('solo')!;
  await db.batch([
    db.prepare('INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(user.userId,emailHash,org,sub,now,until),
    db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,customer_name,customer_email,price_id,plan_id,entitlement_plan_id,seat_limit,status,current_period_end,entitlement_valid_until,livemode,updated_at)
      SELECT ?,?,?,?,'free_trial',?,?,1,'trialing',ends_at,ends_at,0,? FROM account_trials WHERE user_id=? AND subscription_id=? ON CONFLICT(subscription_id) DO NOTHING`).bind(sub,sub,name.trim(),user.email,plan.licensePlan,plan.licensePlan,now,user.userId,sub),
    db.prepare(`INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)
      SELECT ?,?,?,?, ?,? FROM account_trials WHERE user_id=? AND subscription_id=? ON CONFLICT(subscription_id) DO NOTHING`).bind(org,name.trim(),sub,user.userId,now,now,user.userId,sub),
    db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at)
      SELECT ?,?,?,?,?, 'owner',? FROM account_trials t WHERE user_id=? AND subscription_id=?
      AND NOT EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=t.organization_id AND m.user_id=t.user_id)
      ON CONFLICT(organization_id,user_id) DO NOTHING`).bind(`mem_${fingerprint.slice(0,32)}`,org,user.userId,user.email,user.displayName,now,user.userId,sub),
  ]);
  const created=await trialForUser(user.userId);
  if(!created) throw new AccountPublicError('Un essai a déjà été utilisé avec cette adresse. Choisissez une formule pour continuer.',409);
  return created;
}
export async function trialLicenseEntitlement(subscriptionId:string,userId:string|null|undefined){
  if(!userId||!subscriptionId.startsWith('trial_'))return null;
  const row=await database().prepare(`SELECT s.customer_name,s.entitlement_plan_id,s.seat_limit,t.ends_at AS entitlement_valid_until
    FROM account_trials t JOIN subscriptions s ON s.subscription_id=t.subscription_id
    JOIN organizations o ON o.organization_id=t.organization_id AND o.subscription_id=t.subscription_id
    JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=? AND m.revoked_at IS NULL
    WHERE t.subscription_id=? AND t.ends_at>? AND t.converted_subscription_id IS NULL`).bind(userId,subscriptionId,Math.floor(Date.now()/1000))
    .first<{customer_name:string;entitlement_plan_id:string;seat_limit:number;entitlement_valid_until:number}>();
  return row;
}
