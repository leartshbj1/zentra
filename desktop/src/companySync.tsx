import { useEffect,useLayoutEffect,useState } from 'react';
import { flushSync } from 'react-dom';
import { Cloud, CloudCheck, CloudOff, CloudUpload, CloudDownload, CircleAlert } from 'lucide-react';
import { companySyncPresentation, validCompanySyncTime } from './companySyncPresentation';
import { desktopApi } from './bridge';
import { Button } from './ui';
import { errorMessage } from './utils';
import { t, getAppLocale } from './language';
import './companySync.css';

export type DuplicateReceipt={localId:string;remoteId:string;invoiceId:string;invoiceNumber:string;amountCents:number;currency:string;date:string;fingerprint:string};
export type CompanySyncState={enabled:boolean;organizationId?:string;revision:number;pending:boolean;conflict:boolean;conflictReason?:string|null;duplicateReceipt?:DuplicateReceipt|null;ready?:boolean;lastSyncedAt?:string;changed?:boolean;remoteRevision?:number};
let current:CompanySyncState={enabled:false,revision:0,pending:false,conflict:false};
let error='';let receiving=false;let checkedAt=0;let checkingSince=0;
let statusSubscribers=0;let statusTimer:number|undefined;
const notify=()=>window.dispatchEvent(new Event('zentra-company-sync-status'));
export function publishCompanySync(value:CompanySyncState,message='',verified=false){
  if(current.organizationId!==value.organizationId||current.enabled!==value.enabled){checkedAt=0;checkingSince=value.enabled?Date.now():0;}
  current=value;error=message;
  if(verified&&value.enabled&&!message)checkedAt=Date.now();
  notify();
}
export function companyReceiveAllowed(){
  // Hidden settings can retain a draft. Never let a category change erase it.
  if (document.querySelector('[data-company-draft="true"], [data-company-receive-busy="true"]')) return false;
  const blockers=document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal-backdrop, [contenteditable="true"]:focus, input:not([type="search"]):focus, textarea:focus, select:focus, .editor-panel, .document-editor, .settings-form, .desktop-app main form:not([data-company-receive-safe="true"])');
  return !Array.from(blockers).some(node=>{
    if(node.closest('[hidden], [inert], [aria-hidden="true"]'))return false;
    const style=getComputedStyle(node);
    return style.display!=='none'&&style.visibility!=='hidden'&&node.getClientRects().length>0;
  });
}
export function setCompanyReceiving(value:boolean){receiving=value;flushSync(notify);}
export async function refreshReceivedCompany(){
  try {
    const workspace=await desktopApi.loadWorkspace();
    flushSync(()=>window.dispatchEvent(new CustomEvent('zentra-company-workspace-received',{detail:workspace})));
  } catch(reason) {
    // Never leave controls bound to the pre-reception workspace after a swap.
    window.location.reload();
    throw reason;
  }
}
export function watchCompanyReceiveOpportunity(wake:()=>void){
  let requested=false;
  const check=()=>{
    if(!current.ready){requested=false;return;}
    if(!requested&&!receiving&&!current.conflict&&companyReceiveAllowed()) { requested=true;wake(); }
  };
  // A finished/discarded editor or closed preview should release a waiting
  // update immediately, even if no new database write is made on this device.
  const observer=new MutationObserver(check);
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','inert','aria-hidden','data-company-draft','data-company-receive-busy']});
  window.addEventListener('zentra-company-sync-status',check);
  window.addEventListener('focusout',check);
  window.addEventListener('pointerup',check);
  return()=>{observer.disconnect();window.removeEventListener('zentra-company-sync-status',check);window.removeEventListener('focusout',check);window.removeEventListener('pointerup',check);};
}
function useStatus(){
  const [,render]=useState(0);
  useEffect(()=>{
    const update=()=>render(v=>v+1);
    const events=['zentra-company-sync-status','online','offline'];
    events.forEach(event=>window.addEventListener(event,update));
    // All visible status surfaces age together, including panels opened later.
    if(statusSubscribers++===0)statusTimer=window.setInterval(notify,30_000);
    return()=>{
      events.forEach(event=>window.removeEventListener(event,update));
      if(--statusSubscribers===0){window.clearInterval(statusTimer);statusTimer=undefined;}
    };
  },[]);
  return {...current,error,receiving,settingsDraft:Boolean(document.querySelector('.company-settings-sync[data-company-draft="true"], .company-settings-sync [data-company-draft="true"]')),checkedAt:checkedAt||undefined,checkingSince:checkingSince||undefined,online:navigator.onLine,now:Date.now()};
}
export function CompanySyncIndicator({ organizationId, onOpen }: { organizationId?: string | null; onOpen: () => void }) {
  const status = useStatus();
  if (!organizationId) return null;
  const info = companySyncPresentation(status, organizationId, status.online, status.now);
  const Icon = info.kind === 'current' ? CloudCheck : info.kind === 'offline' ? CloudOff : info.kind === 'sending' ? CloudUpload : info.kind === 'receiving' ? CloudDownload : info.kind === 'attention' || info.kind === 'delayed' ? CircleAlert : Cloud;
  return <button type="button" className="company-sync-indicator" data-sync-state={info.kind} onClick={onOpen} title={t(info.detail)} aria-label={`${t(info.label)}. ${t(info.detail)}`}><Icon size={17} aria-hidden="true" /><span>{t(info.label)}</span></button>;
}
export function CompanyAccountShortcut({ organizationId, companyName, onOpen }: { organizationId?: string | null; companyName: string; onOpen: () => void }) {
  const status = useStatus();
  const info = organizationId ? companySyncPresentation(status, organizationId, status.online, status.now) : null;
  const Icon = info?.kind === 'offline' ? CloudOff : info?.kind === 'attention' || info?.kind === 'delayed' ? CircleAlert : info?.kind === 'current' ? CloudCheck : Cloud;
  const label = info ? t(info.label) : t('Sur cet appareil');
  return <button type="button" className="mobile-company-shortcut" data-sync-state={info?.kind || 'local'} onClick={onOpen} title={`${companyName} — ${label}${info ? `. ${t(info.detail)}` : ''}`} aria-label={`${t('Ouvrir le compte de {company}',{company:companyName})}. ${label}${info ? `. ${t(info.detail)}` : ''}`}>
    <strong>{companyName}</strong><span><Icon size={12} aria-hidden="true" />{label}</span>
  </button>;
}
export function CompanyReceivingGuard(){
  const {receiving}=useStatus();
  useLayoutEffect(()=>{
    if(!receiving)return;
    const root=document.getElementById('root');const previous=root?.inert;
    const focused=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const settingsSearch=focused instanceof HTMLInputElement&&focused.type==='search'&&focused.closest('[data-settings-navigation]')
      ? {start:focused.selectionStart,end:focused.selectionEnd,direction:focused.selectionDirection}:null;
    // Downloads and preparation stay interactive. Only the final local swap
    // and its React refresh exclude edits bound to the previous workspace.
    // Keep the screen visible without a portal, backdrop or spinner.
    if(root)root.inert=true;
    return()=>{
      if(root)root.inert=Boolean(previous);
      // A received workspace recreates pristine settings. The original search
      // input no longer exists, but navigation and its cursor still belong here.
      const target=focused?.isConnected?focused:settingsSearch?root?.querySelector<HTMLInputElement>('[data-settings-navigation] input[type="search"]'):null;
      if(!previous&&target&&root?.contains(target)&&
        (!document.activeElement||document.activeElement===document.body)) {
        target.focus({preventScroll:true});
        if(settingsSearch&&target instanceof HTMLInputElement)target.setSelectionRange(settingsSearch.start,settingsSearch.end,settingsSearch.direction||undefined);
      }
    };
  },[receiving]);
  return null;
}
export function CompanySyncPanel(){
  const status=useStatus();
  const info=companySyncPresentation(status,status.organizationId||'',status.online,status.now);
  const [busy,setBusy]=useState(false);
  const lastCheck=validCompanySyncTime(status.checkedAt,status.now);
  const lastExchange=validCompanySyncTime(status.lastSyncedAt,status.now);
  const formatTime=(time:number)=>new Intl.DateTimeFormat(getAppLocale(),{dateStyle:'short',timeStyle:'medium'}).format(time);
  const duplicate=status.conflict?status.duplicateReceipt:null;
  const amount=duplicate?new Intl.NumberFormat(getAppLocale(),{style:'currency',currency:duplicate.currency}).format(duplicate.amountCents/100):'';
  async function resolveReceipt(){
    if(!duplicate||busy)return;
    if(!window.confirm(t('Confirmer un seul encaissement de {amount} pour la facture {number} ? Les deux saisies originales seront conservées dans l’historique.',{amount,number:duplicate.invoiceNumber})))return;
    setBusy(true);
    try{const result=await desktopApi.syncCompanyWorkspace(false,false,duplicate);publishCompanySync(result);window.dispatchEvent(new Event('zentra-project-documents-changed'));}
    catch(reason){publishCompanySync(current,errorMessage(reason,'La vérification n’a pas abouti. Les deux copies sont conservées.'));}
    finally{setBusy(false);}
  }
  if(!status.enabled)return null;
  return <section className={`company-sync-panel${status.conflict?'':' company-sync-panel--compact'}`} data-sync-state={info.kind} aria-label={t('Entreprise partagée')}>
    <header><Cloud size={22}/><div><h3>{t('Entreprise partagée')}</h3><p role="status">{t(info.label)}</p></div></header>
    <dl className="company-sync__times">
      <div><dt>{t('Dernière vérification')}</dt><dd>{lastCheck?<time dateTime={new Date(lastCheck).toISOString()}>{formatTime(lastCheck)}</time>:t('Pas encore vérifiée sur cet appareil')}</dd></div>
      {lastExchange&&<div><dt>{t('Dernier échange de données')}</dt><dd><time dateTime={new Date(lastExchange).toISOString()}>{formatTime(lastExchange)}</time></dd></div>}
    </dl>
    {info.kind!=='current'&&<p>{t(info.detail)}</p>}
    {status.pending&&info.kind!=='sending'&&<p>{t('Des modifications sont en attente d’envoi.')}</p>}
    {(status.conflict||status.error)&&<p role="alert">{t(status.conflictReason||status.error||'Les deux copies sont conservées. Contactez le support pour vérifier ce document.')}</p>}
    {duplicate&&<div className="company-sync__receipt"><strong>{duplicate.invoiceNumber} · {amount}</strong><p>{t('Ce montant a été saisi sur deux appareils. S’agit-il du même paiement ?')}</p><Button disabled={busy} onClick={()=>void resolveReceipt()}>{t(busy?'Vérification…':'Oui, un seul paiement')}</Button></div>}
  </section>;
}
