/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Status regions contain block content and retain the existing semantic layout. */
'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import { Check,ChevronRight,Building2,Headphones,Workflow,TriangleAlert } from 'lucide-react';
import './subscription-overview.css';

export type JourneyView={organizationId:string;organizationName:string;owner:boolean;canManage:boolean;name:string;plan:string|null;monthlyChfCents:number;status:string;renewalAt:number|null;
  trial:{active:boolean;endsAt:number;analyses:number}|null;seats:{used:number;limit:number|null;reserved:number};
  products:{id:string;name:string;active:boolean;detail:string;until:number|null}[];
  support:{active:boolean;used:number;limit:number;remaining:number;periodEnd:number|null;alert:{level:string;message:string;remaining:number}|null}|null;
  change:{plan:string;name:string;effectiveAt:number;state:string}|null;canChange:boolean;portalAvailable:boolean;
  steps:{id:string;label:string;detail:string;done:boolean;optional:boolean;href:string;skipped:boolean}[];onboardingComplete:boolean;};
type RequestFn=(body?:Record<string,unknown>)=>Promise<JourneyView|Record<string,unknown>>;
const date=(v:number|null)=>v?new Intl.DateTimeFormat('fr-CH',{dateStyle:'long',timeZone:'Europe/Zurich'}).format(v*1000):'—';
const money=(v:number)=>`${new Intl.NumberFormat('fr-CH',{maximumFractionDigits:2}).format(v/100)} CHF`;
const plans=[{id:'solo',name:'Solo',price:7900,people:1,analyses:2000},{id:'team',name:'Équipe',price:9900,people:3,analyses:5000},{id:'pro',name:'Pro',price:16900,people:10,analyses:15000}];
export function QuickStart({initial}:{initial:JourneyView}){
  const [data,setData]=useState(initial),[error,setError]=useState('');
  return <div className="zentra-subscription"><GettingStarted data={data} onSkip={(step,skip)=>{setError('');void webRequest(data.organizationId,{action:'skip',step,skip}).then(setData,e=>setError(e instanceof Error?e.message:'Réessayez.'))}}/>{error&&<p role="alert">{error}</p>}</div>;
}
async function webRequest(organizationId:string,body?:Record<string,unknown>){
  const response=await fetch(`/api/account/subscription?organizationId=${encodeURIComponent(organizationId)}`,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify({...body,organizationId}):undefined,signal:AbortSignal.timeout(40000)});
  const data=await response.json() as JourneyView&{error?:string};if(!response.ok)throw new Error(data.error||'Impossible de charger l’abonnement. Réessayez.');return data;
}
export function GettingStarted({data,onSkip,onOpen}:{data:JourneyView;onSkip?:(id:string,skip:boolean)=>void;onOpen?:(url:string)=>void}){
  const [expanded,setExpanded]=useState(false);
  if(data.onboardingComplete&&!expanded)return <button className="zentra-subtle" onClick={()=>setExpanded(true)}><Check size={17}/>Démarrage terminé · Revoir les étapes</button>;
  return <section className="zentra-sub-section" aria-label="Démarrage"><div className="zentra-sub-heading"><h2>Prenez vos repères</h2><span>{data.steps.filter(s=>s.done||s.skipped).length} / {data.steps.length}</span></div>
    <ol className="zentra-start-steps">{data.steps.map((step,index)=><li key={step.id} data-complete={step.done||step.skipped}><span className="zentra-step-mark" aria-hidden="true">{step.done?<Check size={17}/>:index+1}</span><div><strong>{step.label}</strong><p>{step.skipped&&!step.done?'À faire plus tard':step.detail}</p></div><div className="zentra-step-actions"><a href={step.href} onClick={onOpen?e=>{e.preventDefault();onOpen(step.href)}:undefined}>{step.done?'Ouvrir':step.skipped?'Configurer':'Continuer'}<ChevronRight size={16}/></a>{data.canManage&&step.optional&&!step.done&&onSkip&&<button onClick={()=>onSkip(step.id,!step.skipped)}>{step.skipped?'Remettre dans le parcours':'Plus tard'}</button>}</div></li>)}</ol>
  </section>;
}
type OverviewProps={initial?:JourneyView;organizationId:string;request?:RequestFn;onOpen?:(url:string)=>void;native?:boolean};
export function SubscriptionOverview(props:OverviewProps){return <SubscriptionContent key={props.organizationId} {...props}/>;}
function SubscriptionContent({initial,organizationId,request,onOpen,native=false}:OverviewProps){
  const [data,setData]=useState(initial),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[chosen,setChosen]=useState(initial?.plan==='team'?'pro':'team'),[accepted,setAccepted]=useState(false),[quote,setQuote]=useState<{fingerprint:string;name:string;priceChfCents:number;effectiveAt:number;plan:string}|null>(null);
  const operation=useRef(0),inFlight=useRef(false);
  const call=useCallback((body?:Record<string,unknown>)=>request?request(body):webRequest(organizationId,body),[request,organizationId]);
  useEffect(()=>{let active=true;const id=++operation.current;
    const load=()=>void call().then(value=>{if(active&&id===operation.current)setData(value as JourneyView)},()=>{if(active)setError('Votre abonnement est momentanément indisponible. Réessayez.');});
    if(!initial)load();const refresh=()=>{if(document.visibilityState==='visible')load()};window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{active=false;window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)};
  // The keyed parent resets all local state when switching companies.
  },[call,initial]);
  async function action(body:Record<string,unknown>){if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');setNotice('');const id=operation.current;
    try{const result=await call(body.action==='refresh'?undefined:body);if(id!==operation.current)return;
      if(body.action==='quote'){setQuote(result as typeof quote);setAccepted(false)}else{const refreshed=await call() as JourneyView;if(id!==operation.current)return;setData(refreshed);if(body.action==='change'){setQuote(null);setNotice('Le changement est programmé. Votre entreprise et vos documents restent au même endroit.')}}
    }catch(e){if(id===operation.current)setError(e instanceof Error&&e.name!=='TimeoutError'?e.message:'La réponse tarde. Rechargez l’écran pour vérifier le résultat avant de réessayer.')}finally{inFlight.current=false;if(id===operation.current)setBusy(false)}
  }
  const link=(href:string,label:string,primary=false)=><a className={primary?'zentra-sub-primary':'zentra-sub-link'} href={href} onClick={onOpen?e=>{e.preventDefault();onOpen(href)}:undefined}>{label}<ChevronRight size={17}/></a>;
  if(!data)return <div className="zentra-subscription" role="status"><p>{error||'Chargement de votre abonnement…'}</p>{error&&<button onClick={()=>void action({action:'refresh'})}>Réessayer</button>}</div>;
  const status=data.status==='trial'?'Essai gratuit':data.status==='expired'?'Accès terminé':data.status==='cancelling'?'Résiliation programmée':data.status==='payment_due'?'Paiement à régulariser':'Actif';
  const icons=[Building2,Headphones,Workflow];
  const selectedPlan=plans.find(p=>p.id===(quote?.plan??data.change?.plan??chosen))??plans[1];
  const billingUrl=`/compte/abonnement?organizationId=${encodeURIComponent(organizationId)}`;
  return <div className="zentra-subscription" aria-busy={busy}>
    <section className="zentra-sub-section"><div className="zentra-sub-heading"><div><h2>{data.name}</h2><p>{data.organizationName}</p></div><span className="zentra-sub-status">{status}</span></div>
      <dl className="zentra-sub-facts"><div><dt>{data.trial?.active?'Pendant 14 jours':'Prix mensuel'}</dt><dd>{money(data.monthlyChfCents)}</dd></div><div><dt>{data.trial?.active?'Fin de l’essai':data.status==='cancelling'?'Fin de l’accès':'Prochaine échéance'}</dt><dd>{date(data.renewalAt)}</dd></div><div><dt>Votre équipe</dt><dd>{data.seats.used} / {data.seats.limit??'illimité'} personnes{data.seats.reserved>0&&<small>{data.seats.reserved} invitation(s) en attente</small>}</dd></div></dl>
      {data.trial?.active&&<p className="zentra-sub-caption">Sans carte bancaire. Aucun paiement automatique à la fin de l’essai.</p>}
      <ul className="zentra-product-access">{data.products.map((p,i)=>{const Icon=icons[i]??Building2;return <li key={p.id}><Icon size={22}/><div><strong>{p.name}</strong><span>{p.detail}</span></div><span>{p.active?'Actif':'Non inclus'}</span></li>})}</ul>
      {data.support&&data.support.limit>0&&<div className="zentra-quota"><div><strong>Analyses Support</strong><span>{data.support.remaining.toLocaleString('fr-CH')} restantes</span></div><progress aria-label="Analyses Support utilisées" value={Math.min(data.support.used,data.support.limit)} max={data.support.limit}/><p>{data.support.used.toLocaleString('fr-CH')} sur {data.support.limit.toLocaleString('fr-CH')} · jusqu’au {date(data.support.periodEnd)}</p>{data.support.alert&&<p className="zentra-quota-notice" role="status"><TriangleAlert size={18}/>{data.support.alert.message}</p>}</div>}
      {data.change&&<p className="zentra-quota-notice" role="status">{data.change.state==='preparing'?'Programmation à terminer':'Changement programmé'} : {data.change.name}, le {date(data.change.effectiveAt)}.</p>}
      <div className="zentra-sub-actions">{data.owner&&(native?link(billingUrl,'Gérer mon abonnement',true):data.portalAvailable?<form onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);try{const response=await fetch('/api/stripe/portal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({organizationId})});const result=await response.json() as {error?:string;url:string};if(!response.ok)throw new Error(result.error||'Le portail est indisponible.');const url=new URL(result.url);if(url.protocol!=='https:'||url.hostname!=='billing.stripe.com')throw new Error('Adresse de facturation invalide.');window.location.assign(url.href)}catch(e){setError(e instanceof Error?e.message:'Le portail est indisponible.')}finally{setBusy(false)}}}><button disabled={busy} className="zentra-sub-link">Factures et moyen de paiement<ChevronRight size={17}/></button></form>:link('/complet/abonnement','Choisir mon pack',true))}{link(`/compte/equipe?organizationId=${encodeURIComponent(organizationId)}`,'Gérer l’équipe')}</div>
      {!data.owner&&<p className="zentra-sub-caption">Le propriétaire de l’entreprise gère la formule et les paiements.</p>}
    </section>
    {data.owner&&!native&&data.canChange&&<details className="zentra-sub-section"><summary>Changer de formule</summary><fieldset disabled={busy||!!data.change&&data.change.state!=='preparing'} className="zentra-plan-change"><label>Votre prochain pack<select value={data.change?.plan??chosen} onChange={e=>{setChosen(e.target.value);setQuote(null);setAccepted(false)}}>{plans.map(p=><option key={p.id} value={p.id} disabled={p.id===data.plan}>Complet {p.name} · {money(p.price)} / mois · {p.people} personne(s)</option>)}</select></label><p><strong>{selectedPlan.people} personne(s) · {selectedPlan.analyses.toLocaleString('fr-CH')} analyses Support par mois</strong></p><p>Les périodes déjà payées sont conservées. Aucun prélèvement aujourd’hui ; le pack commence après leur dernière échéance.</p>
      {!quote&&!data.change&&<button className="zentra-sub-primary" onClick={()=>void action({action:'quote',plan:chosen})}>{busy?'Vérification…':'Voir la date et le récapitulatif'}</button>}
      {(quote||data.change?.state==='preparing')&&<div className="zentra-plan-confirm"><strong>{quote?.name??data.change!.name}</strong><p>{selectedPlan.people} personne(s) et {selectedPlan.analyses.toLocaleString('fr-CH')} analyses Support par mois, partagées par votre entreprise.</p><p>{money(quote?.priceChfCents??plans.find(p=>p.id===data.change?.plan)!.price)} / mois à partir du {date(quote?.effectiveAt??data.change!.effectiveAt)}.</p><label className="zentra-sub-consent"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)}/><span>Je confirme ce changement et accepte les <a href="/conditions" target="_blank" rel="noreferrer">conditions du pack</a>.</span></label><button disabled={!accepted||busy} className="zentra-sub-primary" onClick={()=>void action({action:'change',plan:quote?.plan??data.change!.plan,fingerprint:quote?.fingerprint,acceptTerms:true,legalVersion:'complet-2026-09-23'})}>{busy?'Programmation…':data.change?'Terminer la programmation':'Confirmer le changement'}</button></div>}
    </fieldset></details>}
    {notice&&<p role="status" className="zentra-quota-notice">{notice}</p>}{error&&<p role="alert" className="zentra-quota-notice">{error}</p>}
    <GettingStarted data={data} onOpen={onOpen} onSkip={native?undefined:(id,skip)=>void action({action:'skip',step:id,skip})}/>
  </div>;
}
