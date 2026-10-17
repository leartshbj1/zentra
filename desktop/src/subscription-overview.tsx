/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Status regions contain block content and retain the existing semantic layout. */
'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import { Check,ChevronRight,Building2,Headphones,Workflow,TriangleAlert } from 'lucide-react';
import './subscription-overview.css';
import { getAppLocale, t, useAppLanguage } from './language';
import { usePlanCatalog } from './planCatalog';

export type JourneyView={organizationId:string;organizationName:string;owner:boolean;canManage:boolean;name:string;plan:string|null;monthlyChfCents:number;status:string;renewalAt:number|null;
  trial:{active:boolean;endsAt:number;analyses:number}|null;seats:{used:number;limit:number|null;reserved:number};
  products:{id:string;name:string;active:boolean;detail:string;until:number|null}[];
  support:{active:boolean;used:number;limit:number;remaining:number;periodEnd:number|null;alert:{level:string;message:string;remaining:number}|null}|null;
  change:{plan:string;name:string;effectiveAt:number;state:string}|null;canChange:boolean;portalAvailable:boolean;
  steps:{id:string;label:string;detail:string;done:boolean;optional:boolean;href:string;skipped:boolean}[];onboardingComplete:boolean;};
type RequestFn=(body?:Record<string,unknown>)=>Promise<JourneyView|Record<string,unknown>>;
const date=(v:number|null)=>v?new Intl.DateTimeFormat(getAppLocale(),{dateStyle:'long',timeZone:'Europe/Zurich'}).format(v*1000):'—';
const money=(v:number)=>`${new Intl.NumberFormat(getAppLocale(),{maximumFractionDigits:2}).format(v/100)} CHF`;
const number=(v:number)=>v.toLocaleString(getAppLocale());
// Packs come from the site's single price grid (bundled copy offline).
function usePacks(){return usePlanCatalog().complet.map(p=>({id:p.id,name:p.name,price:p.monthlyChfCents,people:p.people,analyses:p.supportAnalyses}));}
async function webRequest(organizationId:string,body?:Record<string,unknown>){
  const response=await fetch(`/api/account/subscription?organizationId=${encodeURIComponent(organizationId)}`,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify({...body,organizationId}):undefined,signal:AbortSignal.timeout(40000)});
  const data=await response.json() as JourneyView&{error?:string};if(!response.ok)throw new Error(data.error||t('Impossible de charger l’abonnement. Réessayez.'));return data;
}
export function GettingStarted({data,onSkip,onOpen}:{data:JourneyView;onSkip?:(id:string,skip:boolean)=>void;onOpen?:(url:string)=>void}){
  useAppLanguage();
  const [expanded,setExpanded]=useState(false);
  if(data.onboardingComplete&&!expanded)return <button className="zentra-subtle" onClick={()=>setExpanded(true)}><Check size={17}/>{t('Démarrage terminé · Revoir les étapes')}</button>;
  return <section className="zentra-sub-section" aria-label={t('Démarrage')}><div className="zentra-sub-heading"><h2>{t('Prenez vos repères')}</h2><span>{data.steps.filter(s=>s.done||s.skipped).length} / {data.steps.length}</span></div>
    <ol className="zentra-start-steps">{data.steps.map((step,index)=><li key={step.id} data-complete={step.done||step.skipped}><span className="zentra-step-mark" aria-hidden="true">{step.done?<Check size={17}/>:index+1}</span><div><strong>{step.label}</strong><p>{step.skipped&&!step.done?t('À faire plus tard'):step.detail}</p></div><div className="zentra-step-actions"><a href={step.href} onClick={onOpen?e=>{e.preventDefault();onOpen(step.href)}:undefined}>{t(step.done?'Ouvrir':step.skipped?'Configurer':'Continuer')}<ChevronRight size={16}/></a>{data.canManage&&step.optional&&!step.done&&onSkip&&<button onClick={()=>onSkip(step.id,!step.skipped)}>{t(step.skipped?'Remettre dans le parcours':'Plus tard')}</button>}</div></li>)}</ol>
  </section>;
}
type OverviewProps={initial?:JourneyView;organizationId:string;request?:RequestFn;onOpen?:(url:string)=>void;native?:boolean};
export function SubscriptionOverview(props:OverviewProps){return <SubscriptionContent key={props.organizationId} {...props}/>;}
function SubscriptionContent({initial,organizationId,request,onOpen,native=false}:OverviewProps){
  useAppLanguage();
  const plans=usePacks();
  const [data,setData]=useState(initial),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[chosen,setChosen]=useState(initial?.plan==='team'?'pro':'team'),[accepted,setAccepted]=useState(false),[quote,setQuote]=useState<{fingerprint:string;name:string;priceChfCents:number;effectiveAt:number;plan:string}|null>(null);
  const operation=useRef(0),inFlight=useRef(false);
  const call=useCallback((body?:Record<string,unknown>)=>request?request(body):webRequest(organizationId,body),[request,organizationId]);
  useEffect(()=>{let active=true;const id=++operation.current;
    const load=()=>void call().then(value=>{if(active&&id===operation.current)setData(value as JourneyView)},()=>{if(active)setError(t('Votre abonnement est momentanément indisponible. Réessayez.'));});
    if(!initial)load();const refresh=()=>{if(document.visibilityState==='visible')load()};window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{active=false;window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)};
  // The keyed parent resets all local state when switching companies.
  },[call,initial]);
  async function action(body:Record<string,unknown>){if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');setNotice('');const id=operation.current;
    try{const result=await call(body.action==='refresh'?undefined:body);if(id!==operation.current)return;
      if(body.action==='quote'){setQuote(result as typeof quote);setAccepted(false)}else{const refreshed=await call() as JourneyView;if(id!==operation.current)return;setData(refreshed);if(body.action==='change'){setQuote(null);setNotice(t('Le changement est programmé. Votre entreprise et vos documents restent au même endroit.'))}}
    }catch(e){if(id===operation.current)setError(e instanceof Error&&e.name!=='TimeoutError'?e.message:t('La réponse tarde. Rechargez l’écran pour vérifier le résultat avant de réessayer.'))}finally{inFlight.current=false;if(id===operation.current)setBusy(false)}
  }
  const link=(href:string,label:string,primary=false)=><a className={primary?'zentra-sub-primary':'zentra-sub-link'} href={href} onClick={onOpen?e=>{e.preventDefault();onOpen(href)}:undefined}>{label}<ChevronRight size={17}/></a>;
  if(!data)return <div className="zentra-subscription" role="status"><p>{error||t('Chargement de votre abonnement…')}</p>{error&&<button onClick={()=>void action({action:'refresh'})}>{t('Réessayer')}</button>}</div>;
  const status=t(data.status==='trial'?'Essai gratuit':data.status==='expired'?'Accès terminé':data.status==='cancelling'?'Résiliation programmée':data.status==='payment_due'?'Paiement à régulariser':'Actif');
  const icons=[Building2,Headphones,Workflow];
  const selectedPlan=plans.find(p=>p.id===(quote?.plan??data.change?.plan??chosen))??plans[1];
  const billingUrl=`/compte/abonnement?organizationId=${encodeURIComponent(organizationId)}`;
  return <div className="zentra-subscription" aria-busy={busy}>
    <section className="zentra-sub-section"><div className="zentra-sub-heading"><div><h2>{data.name}</h2><p>{data.organizationName}</p></div><span className="zentra-sub-status">{status}</span></div>
      <dl className="zentra-sub-facts"><div><dt>{t(data.trial?.active?'Pendant 14 jours':'Prix mensuel')}</dt><dd>{money(data.monthlyChfCents)}</dd></div><div><dt>{t(data.trial?.active?'Fin de l’essai':data.status==='cancelling'?'Fin de l’accès':'Prochaine échéance')}</dt><dd>{date(data.renewalAt)}</dd></div><div><dt>{t('Votre équipe')}</dt><dd>{t('{used} / {limit} personnes',{used:data.seats.used,limit:data.seats.limit??t('illimité')})}{data.seats.reserved>0&&<small>{t('{count} invitation(s) en attente',{count:data.seats.reserved})}</small>}</dd></div></dl>
      {data.trial?.active&&<p className="zentra-sub-caption">{t('Sans carte bancaire. Aucun paiement automatique à la fin de l’essai.')}</p>}
      <ul className="zentra-product-access">{data.products.map((p,i)=>{const Icon=icons[i]??Building2;return <li key={p.id}><Icon size={22}/><div><strong>{p.name}</strong><span>{p.detail}</span></div><span>{t(p.active?'Actif':'Non inclus')}</span></li>})}</ul>
      {data.support&&data.support.limit>0&&<div className="zentra-quota"><div><strong>{t('Analyses Support')}</strong><span>{t('{count} restantes',{count:number(data.support.remaining)})}</span></div><progress aria-label={t('Analyses Support utilisées')} value={Math.min(data.support.used,data.support.limit)} max={data.support.limit}/><p>{t('{used} sur {limit} · jusqu’au {date}',{used:number(data.support.used),limit:number(data.support.limit),date:date(data.support.periodEnd)})}</p>{data.support.alert&&<p className="zentra-quota-notice" role="status"><TriangleAlert size={18}/>{data.support.alert.message}</p>}</div>}
      {data.change&&<p className="zentra-quota-notice" role="status">{t('{state} : {name}, le {date}.',{state:t(data.change.state==='preparing'?'Programmation à terminer':'Changement programmé'),name:data.change.name,date:date(data.change.effectiveAt)})}</p>}
      <div className="zentra-sub-actions">{data.owner&&(native?link(billingUrl,t('Gérer mon abonnement'),true):data.portalAvailable?<form onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);try{const response=await fetch('/api/stripe/portal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({organizationId})});const result=await response.json() as {error?:string;url:string};if(!response.ok)throw new Error(result.error||t('Le portail est indisponible.'));const url=new URL(result.url);if(url.protocol!=='https:'||url.hostname!=='billing.stripe.com')throw new Error(t('Adresse de facturation invalide.'));window.location.assign(url.href)}catch(e){setError(e instanceof Error?e.message:t('Le portail est indisponible.'))}finally{setBusy(false)}}}><button disabled={busy} className="zentra-sub-link">{t('Factures et moyen de paiement')}<ChevronRight size={17}/></button></form>:link('/complet/abonnement',t('Choisir mon pack'),true))}{link(`/compte/equipe?organizationId=${encodeURIComponent(organizationId)}`,t('Gérer l’équipe'))}</div>
      {!data.owner&&<p className="zentra-sub-caption">{t('Le propriétaire de l’entreprise gère la formule et les paiements.')}</p>}
    </section>
    {data.owner&&!native&&data.canChange&&<details className="zentra-sub-section"><summary>{t('Changer de formule')}</summary><fieldset disabled={busy||!!data.change&&data.change.state!=='preparing'} className="zentra-plan-change"><label>{t('Votre prochain pack')}<select value={data.change?.plan??chosen} onChange={e=>{setChosen(e.target.value);setQuote(null);setAccepted(false)}}>{plans.map(p=><option key={p.id} value={p.id} disabled={p.id===data.plan}>{t('Complet {name} · {price} / mois · {people} personne(s)',{name:p.name,price:money(p.price),people:p.people})}</option>)}</select></label><p><strong>{t('{people} personne(s) · {count} analyses Support par mois',{people:selectedPlan.people,count:number(selectedPlan.analyses)})}</strong></p><p>{t('Les périodes déjà payées sont conservées. Aucun prélèvement aujourd’hui ; le pack commence après leur dernière échéance.')}</p>
      {!quote&&!data.change&&<button className="zentra-sub-primary" onClick={()=>void action({action:'quote',plan:chosen})}>{t(busy?'Vérification…':'Voir la date et le récapitulatif')}</button>}
      {(quote||data.change?.state==='preparing')&&<div className="zentra-plan-confirm"><strong>{quote?.name??data.change!.name}</strong><p>{t('{people} personne(s) et {count} analyses Support par mois, partagées par votre entreprise.',{people:selectedPlan.people,count:number(selectedPlan.analyses)})}</p><p>{t('{price} / mois à partir du {date}.',{price:money(quote?.priceChfCents??plans.find(p=>p.id===data.change?.plan)!.price),date:date(quote?.effectiveAt??data.change!.effectiveAt)})}</p><label className="zentra-sub-consent"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)}/><span>{t('Je confirme ce changement et accepte les')} <a href="/conditions" target="_blank" rel="noreferrer">{t('conditions du pack')}</a>.</span></label><button disabled={!accepted||busy} className="zentra-sub-primary" onClick={()=>void action({action:'change',plan:quote?.plan??data.change!.plan,fingerprint:quote?.fingerprint,acceptTerms:true,legalVersion:'complet-2026-09-23'})}>{t(busy?'Programmation…':data.change?'Terminer la programmation':'Confirmer le changement')}</button></div>}
    </fieldset></details>}
    {notice&&<p role="status" className="zentra-quota-notice">{notice}</p>}{error&&<p role="alert" className="zentra-quota-notice">{error}</p>}
    <GettingStarted data={data} onOpen={onOpen} onSkip={native?undefined:(id,skip)=>void action({action:'skip',step:id,skip})}/>
  </div>;
}
