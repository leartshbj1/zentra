import type Stripe from 'stripe';
import { database, runtimeValue } from '@/lib/runtime';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { automationStripe } from '@/lib/automation/billing';
import { stripeReferenceId, stripeSecretKeyLivemode } from '@/lib/stripe-event';
import { completePlan, COMPLETE_PRODUCT } from './plans';
import { ensureCompletePrice } from './stripe';
import { linkCompleteProducts } from './access';

const now=()=>Math.floor(Date.now()/1000);
const ref=(v:unknown)=>stripeReferenceId(v as string|{id:string}|null);
type Source={id:string;customer:string;kind:'gestion'|'support'|'automation';until:number;invoice:string;price:string;start:number;metadata:Record<string,string>;automaticTax:boolean;supportPlan?:string;paidFrom?:number};
export type ChangeSnapshot={sources:Source[];primary:string;oldSubscription:string;gestionPlan:string;seats:number;supportPlan:string|null;supportFrom:number;automation:boolean;effectiveAt:number;plan:string;priceId:string;live:boolean};
export type PlanChange={organization_id:string;operation_id:string;user_id:string;subscription_id:string;target_plan:string;effective_at:number;state:string;source_json:string;schedule_id:string|null;created_at:number;updated_at:number};
export async function pendingPlanChange(organizationId:string){return database().prepare('SELECT * FROM complete_plan_changes WHERE organization_id=?').bind(organizationId).first<PlanChange>();}

async function owned(userId:string,organizationId:string){
  const row=await database().prepare(`SELECT s.*,o.organization_id FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id
    JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=? AND m.role='owner' AND m.revoked_at IS NULL
    WHERE o.organization_id=? AND o.created_by_user_id=?`).bind(userId,organizationId,userId).first<Record<string,unknown>>();
  if(!row)throw new AccountPublicError('Seul le propriétaire peut changer cette formule.',403);
  return row;
}
/** Read-only quote. Every provider object is bound to a local company subscription. */
export async function quotePlanChange(userId:string,organizationId:string,target:unknown){
  const plan=completePlan(target);if(!plan)throw new AccountPublicError('Choisissez un pack.');
  const db=database(),gestion=await owned(userId,organizationId),time=now();
  const members=await db.prepare(`SELECT (SELECT COUNT(*) FROM organization_members WHERE organization_id=? AND revoked_at IS NULL)+
    (SELECT COUNT(*) FROM organization_invitations WHERE organization_id=? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>?) AS n`).bind(organizationId,organizationId,time).first<{n:number}>();
  if((members?.n??0)>plan.seats)throw new AccountPublicError(`Ce pack contient ${plan.seats} place(s). Retirez les accès ou invitations en trop avant de continuer.`,409);
  const complete=await db.prepare('SELECT paid_plan_id,paid_from FROM complete_subscriptions WHERE subscription_id=?').bind(gestion.subscription_id).first<{paid_plan_id:string;paid_from:number}>();
  if(complete?.paid_plan_id===plan.id)throw new AccountPublicError('Votre entreprise utilise déjà ce pack.',409);
  const linked=await db.prepare('SELECT w.id,w.owner_id FROM support_gestion_links l JOIN support_workspaces w ON w.id=l.workspace_id WHERE l.organization_id=?').bind(organizationId).first<{id:string;owner_id:string}>();
  const workspace=linked??await db.prepare('SELECT id,owner_id FROM support_workspaces WHERE owner_id=?').bind(userId).first<{id:string;owner_id:string}>();
  if(workspace && (workspace.owner_id!==userId || await db.prepare('SELECT 1 FROM support_gestion_links WHERE workspace_id=? AND organization_id<>?').bind(workspace.id,organizationId).first()))throw new AccountPublicError('Votre espace Support est relié à une autre entreprise. Choisissez cette entreprise avant de réunir les produits.',409);
  const support=workspace?await db.prepare('SELECT * FROM support_subscriptions WHERE workspace_id=?').bind(workspace.id).first<Record<string,unknown>>():null;
  const automation=await db.prepare('SELECT * FROM automation_subscriptions WHERE organization_id=?').bind(organizationId).first<Record<string,unknown>>();
  const pending=await db.prepare(`SELECT 1 FROM complete_checkouts WHERE user_id=? UNION ALL
    SELECT 1 FROM automation_checkouts WHERE organization_id=? AND expires_at>? UNION ALL
    SELECT 1 FROM support_checkouts WHERE workspace_id=? AND expires_at>? LIMIT 1`).bind(userId,organizationId,time,workspace?.id??'',time).first();
  if(pending)throw new AccountPublicError('Terminez ou annulez le paiement déjà ouvert avant de changer de formule.',409);
  const live=stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'));if(live===null)throw new AccountPublicError('Le paiement est temporairement indisponible.',503);
  const stripe=automationStripe(),sources:Source[]=[];
  for(const [kind,row] of [['gestion',gestion],['support',support],['automation',automation]] as const){
    if(!row||!String(row.subscription_id).startsWith('sub_'))continue;
    if(['canceled','incomplete_expired'].includes(String(row.status))&&Number(row.paid_until??row.entitlement_valid_until)<=time)continue;
    const until=Number(kind==='gestion'?row.entitlement_valid_until:row.paid_until);
    if(typeof row.last_paid_invoice_id!=='string'||!row.last_paid_invoice_id || until<=time || row.livemode!==Number(live))throw new AccountPublicError('Régularisez le paiement actuel avant de changer de formule.',409);
    const remote=await stripe.subscriptions.retrieve(String(row.subscription_id));
    const item=remote.items.data[0];
    if(remote.livemode!==live||ref(remote.customer)!==row.customer_id||remote.status!=='active'||remote.schedule||remote.pending_update||remote.items.has_more||remote.items.data.length!==1||item?.quantity!==1||item.price.currency!=='chf'||item.price.recurring?.interval!=='month'||item.price.recurring.interval_count!==1||item.current_period_end!==until||remote.discounts?.length||item.discounts?.length||remote.pause_collection)
      throw new AccountPublicError('Cet abonnement contient un changement ou un paiement en cours. Terminez-le dans la facturation avant de continuer.',409);
    sources.push({id:remote.id,customer:ref(remote.customer),kind,until,invoice:row.last_paid_invoice_id,price:item.price.id,start:item.current_period_start,metadata:remote.metadata,automaticTax:remote.automatic_tax.enabled,supportPlan:kind==='support'?String(row.paid_plan_id):undefined,paidFrom:kind==='support'?Number(row.paid_from):undefined});
  }
  if(!sources.length)throw new AccountPublicError('Choisissez votre pack depuis la page des offres pour activer votre premier abonnement.',409);
  const effectiveAt=Math.max(...sources.map(s=>s.until));
  if(effectiveAt<=time+3600||effectiveAt>time+35*86400)throw new AccountPublicError('Une échéance est trop proche ou doit être vérifiée. Réessayez après son renouvellement.',409);
  const primary=sources.find(s=>s.kind==='gestion')??sources[0];
  // Price creation is not part of a quote; the fixed catalog was prepared by the owner.
  const prices=await stripe.prices.list({lookup_keys:[plan.lookupKey],limit:2});
  if(prices.data.length!==1||!prices.data[0].active)throw new AccountPublicError('Le tarif doit être préparé par Zentra.',503);
  const snapshot:ChangeSnapshot={sources,primary:primary.id,oldSubscription:String(gestion.subscription_id),gestionPlan:String(gestion.entitlement_plan_id),seats:Number(gestion.seat_limit),supportPlan:complete?completePlan(complete.paid_plan_id)?.support??null:sources.find(s=>s.kind==='support')?.supportPlan??null,supportFrom:complete?.paid_from??sources.find(s=>s.kind==='support')?.paidFrom??0,automation:!!complete||sources.some(s=>s.kind==='automation'),effectiveAt,plan:plan.id,priceId:prices.data[0].id,live};
  const fingerprint=await sha256Hex(JSON.stringify(snapshot));
  return {plan:plan.id,name:`Complet ${plan.name}`,priceChfCents:plan.priceChfCents,effectiveAt,seats:plan.seats,analyses:plan.analyses,sourceCount:sources.length,fingerprint,snapshot};
}

/** Durable saga: stop add-on renewals before scheduling the one replacement.
 * Retrying a partial failure resumes the same operation; never creates a second subscription. */
export async function changePlan(userId:string,organizationId:string,target:unknown,fingerprint:unknown){
  await owned(userId,organizationId);
  let row=await pendingPlanChange(organizationId);
  if(row && row.state==='completed') {await database().prepare("DELETE FROM complete_plan_changes WHERE organization_id=? AND state='completed'").bind(organizationId).run();row=null;}
  if(!row){
    const quote=await quotePlanChange(userId,organizationId,target);
    if(fingerprint!==quote.fingerprint)throw new AccountPublicError('Les échéances ont changé. Relisez le nouveau récapitulatif.',409);
    const time=now();
    try { await database().prepare(`INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'preparing',?,?,?) ON CONFLICT(organization_id) DO NOTHING`).bind(organizationId,crypto.randomUUID(),userId,quote.snapshot.primary,quote.plan,quote.effectiveAt,JSON.stringify(quote.snapshot),time,time).run(); } catch(error) { if(String(error).includes('zentra seat limit reached'))throw new AccountPublicError('Votre équipe a changé. Retirez les accès ou invitations en trop et relisez le récapitulatif.',409);throw error; }
    row=await pendingPlanChange(organizationId);
  }
  if(!row||row.target_plan!==target||row.user_id!==userId)throw new AccountPublicError('Un autre changement est déjà en cours.',409);
  return resumePlanChange(row);
}
export async function resumePlanChange(row:PlanChange){
  if(row.state==='scheduled'||row.state==='completed')return {effectiveAt:row.effective_at,state:row.state};
  const snapshot=JSON.parse(row.source_json) as ChangeSnapshot,plan=completePlan(row.target_plan)!;
  if(snapshot.live!==stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')))throw new AccountPublicError('La configuration des paiements a changé.',409);
  if(row.effective_at<=now()+300)throw new AccountPublicError('Le changement n’a pas pu être terminé avant l’échéance. Contactez info@zentraapp.ch pour vérifier les renouvellements.',409);
  const stripe=automationStripe();
  const price=await ensureCompletePrice(plan);
  if(price.id!==snapshot.priceId)throw new AccountPublicError('Le tarif a changé. Contactez Zentra avant de reprendre ce changement.',409);
  // Recheck provider identity on every retry, never trust an arbitrary id from the browser.
  for(const s of snapshot.sources.filter(s=>s.id!==snapshot.primary)){
    const current=await stripe.subscriptions.retrieve(s.id);
    if(ref(current.customer)!==s.customer||current.livemode!==snapshot.live||current.items.data.length!==1||current.items.data[0].price.id!==s.price)throw new AccountPublicError('Un abonnement a changé pendant la préparation.',409);
    if(current.status==='canceled')continue;
    if(!current.cancel_at_period_end)await stripe.subscriptions.update(s.id,{cancel_at_period_end:true,proration_behavior:'none'},{idempotencyKey:`complete-change-${row.operation_id}-${s.id}`});
    const verified=await stripe.subscriptions.retrieve(s.id);
    if(!verified.cancel_at_period_end&&verified.status!=='canceled')throw new AccountPublicError('La fin de l’ancien abonnement doit encore être confirmée. Réessayez.',503);
  }
  const primary=snapshot.sources.find(s=>s.id===snapshot.primary)!;
  const current=await stripe.subscriptions.retrieve(primary.id);
  if(ref(current.customer)!==primary.customer||current.livemode!==snapshot.live)throw new AccountPublicError('L’abonnement a changé.',409);
  if(!current.schedule && (current.status!=='active'||current.items.data.length!==1||current.items.data[0].price.id!==primary.price||current.items.data[0].current_period_end!==primary.until))throw new AccountPublicError('La formule ou son échéance a changé dans Stripe. Rechargez l’abonnement avant de continuer.',409);
  // Replay our own idempotent creation after a lost response; never adopt an
  // unrelated schedule merely because it appeared on the same subscription.
  let scheduleId=row.schedule_id;
  if(!scheduleId){
    const schedule=await stripe.subscriptionSchedules.create({from_subscription:primary.id},{idempotencyKey:`complete-schedule-${row.operation_id}`});
    scheduleId=schedule.id;
  }
  const schedule=await stripe.subscriptionSchedules.retrieve(scheduleId);
  if(ref(schedule.subscription)!==primary.id||(schedule.metadata?.zentra_change && schedule.metadata?.zentra_change!==row.operation_id)||schedule.created<row.created_at-5||!['active','not_started'].includes(schedule.status))throw new AccountPublicError('Un autre changement est programmé dans Stripe. Aucun second abonnement ne sera créé.',409);
  await database().prepare('UPDATE complete_plan_changes SET schedule_id=?,updated_at=? WHERE organization_id=? AND operation_id=?').bind(scheduleId,now(),row.organization_id,row.operation_id).run();
  const phases:Stripe.SubscriptionScheduleUpdateParams.Phase[]=[{
    start_date:primary.start,end_date:row.effective_at,items:[{price:primary.price,quantity:1}],metadata:primary.metadata,
    proration_behavior:'none',automatic_tax:{enabled:primary.automaticTax},
    // Gift the gap between different paid renewal dates; never invoice overlapping products.
    ...(row.effective_at>primary.until?{trial_end:row.effective_at}:{}),
  },{
    start_date:row.effective_at,duration:{interval:'month',interval_count:1},items:[{price:price.id,quantity:1}],proration_behavior:'none',billing_cycle_anchor:'phase_start',automatic_tax:{enabled:primary.automaticTax},
    metadata:{...primary.metadata,service:COMPLETE_PRODUCT,bundle_plan:plan.id,plan:plan.licensePlan,account_user_id:row.user_id,organization_id:row.organization_id,zentra_change:row.operation_id},
  }];
  const updated=await stripe.subscriptionSchedules.update(scheduleId,{metadata:{zentra_change:row.operation_id,organization_id:row.organization_id},end_behavior:'release',proration_behavior:'none',phases},{idempotencyKey:`complete-phases-${row.operation_id}`});
  if(updated.phases[1]?.start_date!==row.effective_at||ref(updated.phases[1]?.items[0]?.price)!==price.id)throw new AccountPublicError('La programmation doit être confirmée. Réessayez.',503);
  await database().prepare("UPDATE complete_plan_changes SET state='scheduled',updated_at=? WHERE organization_id=? AND operation_id=?").bind(now(),row.organization_id,row.operation_id).run();
  await linkCompleteProducts(row.organization_id,row.user_id);
  return {effectiveAt:row.effective_at,state:'scheduled'};
}

/** Only verified full monthly settlement switches the company's paid rights. */
export async function finishPlanChange(subscriptionId:string){
  const db=database(),row=await db.prepare(`SELECT c.* FROM complete_plan_changes c JOIN complete_subscriptions p ON p.subscription_id=c.subscription_id
    JOIN subscriptions s ON s.subscription_id=c.subscription_id WHERE c.subscription_id=? AND c.state IN ('preparing','scheduled')
    AND p.paid_plan_id=c.target_plan AND c.effective_at<=unixepoch() AND p.paid_from<=unixepoch() AND p.paid_from>=c.effective_at AND p.paid_until>unixepoch() AND s.entitlement_valid_until>unixepoch()`)
    .bind(subscriptionId).first<PlanChange>();
  if(!row)return;
  const source=JSON.parse(row.source_json) as ChangeSnapshot;
  await db.batch([
    db.prepare('UPDATE organizations SET subscription_id=?,updated_at=? WHERE organization_id=? AND created_by_user_id=? AND subscription_id IN (?,?)').bind(subscriptionId,now(),row.organization_id,row.user_id,source.oldSubscription,subscriptionId),
    db.prepare('UPDATE license_activations SET subscription_id=? WHERE subscription_id=? AND EXISTS(SELECT 1 FROM organizations WHERE organization_id=? AND subscription_id=?)').bind(subscriptionId,source.oldSubscription,row.organization_id,subscriptionId),
    db.prepare('UPDATE account_trials SET converted_subscription_id=? WHERE organization_id=? AND converted_subscription_id IS NULL').bind(subscriptionId,row.organization_id),
    db.prepare("UPDATE complete_plan_changes SET state='completed',updated_at=? WHERE organization_id=? AND EXISTS(SELECT 1 FROM organizations WHERE organization_id=? AND subscription_id=?)").bind(now(),row.organization_id,row.organization_id,subscriptionId),
  ]);
  await linkCompleteProducts(row.organization_id,row.user_id);
}
