import { database } from '@/lib/runtime';
import { teamSeats } from '@/lib/team-seats';
import { billingState } from '@/lib/support/billing';
import { supportPlan } from '@/lib/support/plans';
import { automationEntitlement } from '@/lib/automation/entitlement';
import { settingsFor } from '@/lib/automation/config';
import { completeSubscription } from './access';
import { completePlan } from './plans';
import { completeTrial } from './trial';
import { pendingPlanChange } from './change';
import { AccountPublicError } from '@/lib/account-security';
import type { AutomationActor } from '@/lib/automation/access';

export function quotaAlert(used:number,limit:number){
  if(limit<=0)return null;
  const remaining=Math.max(0,limit-used);
  if(used>=limit)return {level:'reached' as const,message:'Votre quota est atteint. Les nouvelles analyses reprendront au renouvellement ou après activation d’une nouvelle offre. Aucun supplément automatique.',remaining};
  if(used/limit>=.8)return {level:'near' as const,message:`Il reste ${remaining.toLocaleString('fr-CH')} analyses pour cette période.`,remaining};
  return null;
}
export async function subscriptionJourney(actor:AutomationActor){
  const db=database(),org=await db.prepare('SELECT name,subscription_id FROM organizations WHERE organization_id=?').bind(actor.organizationId).first<{name:string;subscription_id:string}>();
  if(!org)throw new AccountPublicError('Entreprise introuvable.',404);
  const [seats,bundle,trial,change,sub,workspace,settings,automation,skip]=await Promise.all([
    teamSeats(actor.organizationId),completeSubscription(actor.organizationId),completeTrial(actor.organizationId),pendingPlanChange(actor.organizationId),
    db.prepare('SELECT customer_id,status,current_period_end,cancel_at_period_end,last_paid_invoice_id FROM subscriptions WHERE subscription_id=?').bind(org.subscription_id).first<{customer_id:string;status:string;current_period_end:number;cancel_at_period_end:number;last_paid_invoice_id:string|null}>(),
    db.prepare('SELECT w.id,w.owner_id FROM support_workspaces w JOIN support_gestion_links l ON l.workspace_id=w.id WHERE l.organization_id=?').bind(actor.organizationId).first<{id:string;owner_id:string}>(),
    settingsFor(actor.organizationId),automationEntitlement(actor),
    db.prepare('SELECT skipped_json FROM complete_onboarding WHERE organization_id=?').bind(actor.organizationId).first<{skipped_json:string}>(),
  ]);
  const support=workspace?await billingState(workspace):null,pack=completePlan(bundle?.paid_plan_id??bundle?.plan_id);
  const connections=workspace?await db.prepare('SELECT COUNT(*) AS n FROM support_connections WHERE workspace_id=? AND active=1').bind(workspace.id).first<{n:number}>():null;
  const addon=await db.prepare('SELECT paid_until,cancel_at_period_end FROM automation_subscriptions WHERE organization_id=?').bind(actor.organizationId).first<{paid_until:number;cancel_at_period_end:number}>();
  const skipped=skip?JSON.parse(skip.skipped_json) as string[]:[];
  const query=`?organizationId=${encodeURIComponent(actor.organizationId)}`;
  const steps=[
    {id:'company',label:'Votre entreprise',detail:org.name,done:true,optional:false,href:`/compte/entreprise${query}`},
    {id:'connection',label:'Connecter votre messagerie',detail:connections?.n?'Connexion prête':'Retrouvez vos e-mails dans Support.',done:!!connections?.n,optional:true,href:`/support/espace${query}&section=connections`},
    {id:'team',label:'Inviter votre équipe',detail:seats.used>1||seats.reserved?'Votre équipe est invitée':'Travaillez dans le même espace.',done:seats.used>1||seats.reserved>0,optional:true,href:`/compte/equipe${query}`},
    {id:'automation',label:'Choisir vos automatismes',detail:settings.enabled&&settings.consent?'Vos choix sont enregistrés':'Vous gardez la main sur les actions.',done:!!(settings.enabled&&settings.consent&&settings.flags.length),optional:true,href:`/compte/automation${query}`},
  ].map(s=>({...s,skipped:skipped.includes(s.id)}));
  const trialActive=!!trial?.active;
  const products=[
    {id:'gestion',name:'Gestion',active:seats.subscriptionActive,detail:`${seats.used} / ${seats.limit??'∞'} personnes`,until:seats.trialUntil??seats.offeredUntil??sub?.current_period_end??null},
    {id:'support',name:'Support',active:!!support?.active,detail:support?.active?`${support.used.toLocaleString('fr-CH')} / ${support.limit.toLocaleString('fr-CH')} analyses`:'À activer',until:support?.periodEnd??null},
    {id:'automation',name:'Automation',active:automation,detail:automation?(settings.enabled?'Automatismes configurés':'Prête à configurer'):'À activer',until:trialActive?trial.ends_at:pack?bundle?.paid_until??null:addon?.paid_until??null},
  ];
  const monthly=trialActive?0:pack?pack.priceChfCents:(seats.priceChfCents+(support?.hasSubscription?(supportPlan(support.plan)?.priceChfCents??0):0)+(addon&&automation?1500:0));
  return {organizationId:actor.organizationId,organizationName:org.name,owner:actor.role==='owner',canManage:['owner','admin'].includes(actor.role),
    name:trialActive?'Essai Zentra Complet':pack?`Zentra Complet ${pack.name}`:seats.planName,plan:pack?.id??null,monthlyChfCents:monthly,
    status:trialActive?'trial':!seats.subscriptionActive?'expired':sub?.cancel_at_period_end?'cancelling':sub?.status==='past_due'?'payment_due':'active',
    renewalAt:trialActive?trial.ends_at:change&&change.state!=='completed'?change.effective_at:seats.offeredUntil??seats.trialUntil??sub?.current_period_end??null,
    trial:trial?{active:trialActive,endsAt:trial.ends_at,analyses:trial.analyses}:null,seats,products,
    support:support?{active:support.active,used:support.used,limit:support.limit,remaining:Math.max(0,support.limit-support.used),periodEnd:support.periodEnd,alert:quotaAlert(support.used,support.limit)}:null,
    change:change&&change.state!=='completed'?{plan:change.target_plan,name:`Complet ${completePlan(change.target_plan)?.name??''}`,effectiveAt:change.effective_at,state:change.state}:null,
    canChange:actor.role==='owner'&&(org.subscription_id.startsWith('sub_')||!!support?.hasSubscription),
    portalAvailable:actor.role==='owner'&&!!sub?.customer_id.startsWith('cus_'),steps,
    onboardingComplete:steps.every(s=>s.done||s.skipped)};
}
export type SubscriptionJourney=Awaited<ReturnType<typeof subscriptionJourney>>;
export async function skipJourneyStep(actor:AutomationActor,id:unknown,skip:boolean){
  if(!['owner','admin'].includes(actor.role))throw new AccountPublicError('Votre rôle ne permet pas de modifier le démarrage.',403);
  if(!['connection','team','automation'].includes(String(id)))throw new AccountPublicError('Étape inconnue.');
  // SQLite JSON updates avoid losing another collaborator's simultaneous choice.
  const time=Math.floor(Date.now()/1000),db=database();
  await db.prepare("INSERT INTO complete_onboarding(organization_id,skipped_json,updated_at) VALUES(?,'[]',?) ON CONFLICT DO NOTHING").bind(actor.organizationId,time).run();
  if(skip)await db.prepare(`UPDATE complete_onboarding SET skipped_json=json_insert(skipped_json,'$[#]',?),updated_at=? WHERE organization_id=? AND NOT EXISTS(SELECT 1 FROM json_each(skipped_json) WHERE value=?)`).bind(String(id),time,actor.organizationId,String(id)).run();
  else await db.prepare(`UPDATE complete_onboarding SET skipped_json=(SELECT COALESCE(json_group_array(value),'[]') FROM json_each(skipped_json) WHERE value<>?),updated_at=? WHERE organization_id=?`).bind(String(id),time,actor.organizationId).run();
}
