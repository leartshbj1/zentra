import { database,runtimeValue } from '@/lib/runtime';
import { stripeSecretKeyLivemode } from '@/lib/stripe-event';
import type { ChangeSnapshot } from './change';

/** Explicit, bounded transition offer; never rewritten as a paid Stripe invoice. */
export async function transitionAccess(organizationId:string) {
  const row=await database().prepare(`SELECT c.source_json,c.effective_at FROM complete_plan_changes c
    JOIN organizations o ON o.organization_id=c.organization_id AND o.created_by_user_id=c.user_id
    WHERE c.organization_id=? AND c.state='scheduled' AND c.effective_at>unixepoch()`)
    .bind(organizationId).first<{source_json:string;effective_at:number}>();
  if(!row)return null;
  const source=JSON.parse(row.source_json) as ChangeSnapshot;
  if(source.live!==stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')))return null;
  for(const s of source.sources){
    const table=s.kind==='gestion'?'subscriptions':s.kind==='support'?'support_subscriptions':'automation_subscriptions';
    const until=s.kind==='gestion'?'entitlement_valid_until':'paid_until';
    const current=await database().prepare(`SELECT last_paid_invoice_id,status,${until} AS until FROM ${table} WHERE subscription_id=? AND customer_id=? AND livemode=?`).bind(s.id,s.customer,Number(source.live)).first<{last_paid_invoice_id:string;status:string;until:number}>();
    if(!current||current.last_paid_invoice_id!==s.invoice||current.until<=0||(s.id===source.primary&&current.status==='canceled'))return null;
  }
  return {...source,until:row.effective_at};
}
export async function transitionLicense(subscriptionId:string,userId:string|null|undefined){
  if(!userId)return null;
  const org=await database().prepare(`SELECT o.organization_id,s.customer_name FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id
    JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=? AND m.revoked_at IS NULL WHERE o.subscription_id=?`)
    .bind(userId,subscriptionId).first<{organization_id:string;customer_name:string}>();
  const grant=org?await transitionAccess(org.organization_id):null;
  return grant?{customer_name:org!.customer_name,entitlement_valid_until:grant.until,entitlement_plan_id:grant.gestionPlan,seat_limit:grant.seats}:null;
}
