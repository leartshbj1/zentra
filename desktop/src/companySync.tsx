import { useEffect,useLayoutEffect,useState } from 'react';
import { flushSync } from 'react-dom';
import { Cloud } from 'lucide-react';
import { desktopApi } from './bridge';
import { Button } from './ui';
import { errorMessage } from './utils';
import { t, getAppLocale } from './language';
import './companySync.css';

export type DuplicateReceipt={localId:string;remoteId:string;invoiceId:string;invoiceNumber:string;amountCents:number;currency:string;date:string;fingerprint:string};
export type CompanySyncState={enabled:boolean;organizationId?:string;revision:number;pending:boolean;conflict:boolean;conflictReason?:string|null;duplicateReceipt?:DuplicateReceipt|null;ready?:boolean;lastSyncedAt?:string;changed?:boolean;remoteRevision?:number};
let current:CompanySyncState={enabled:false,revision:0,pending:false,conflict:false};
let error='';let receiving=false;
const notify=()=>window.dispatchEvent(new Event('zentra-company-sync-status'));
export function publishCompanySync(value:CompanySyncState,message=''){current=value;error=message;notify();}
export function companyReceiveAllowed(){
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
  observer.observe(document.body,{childList:true,subtree:true});
  window.addEventListener('zentra-company-sync-status',check);
  window.addEventListener('focusout',check);
  window.addEventListener('pointerup',check);
  return()=>{observer.disconnect();window.removeEventListener('zentra-company-sync-status',check);window.removeEventListener('focusout',check);window.removeEventListener('pointerup',check);};
}
function useStatus(){const [,render]=useState(0);useEffect(()=>{const update=()=>render(v=>v+1);window.addEventListener('zentra-company-sync-status',update);return()=>window.removeEventListener('zentra-company-sync-status',update);},[]);return {...current,error,receiving};}
export function CompanyReceivingGuard(){
  const {receiving}=useStatus();
  useLayoutEffect(()=>{
    if(!receiving)return;
    const root=document.getElementById('root');const previous=root?.inert;
    const focused=document.activeElement instanceof HTMLElement?document.activeElement:null;
    // Downloads and preparation stay interactive. Only the final local swap
    // and its React refresh exclude edits bound to the previous workspace.
    // Keep the screen visible without a portal, backdrop or spinner.
    if(root)root.inert=true;
    return()=>{
      if(root)root.inert=Boolean(previous);
      if(!previous&&focused?.isConnected&&root?.contains(focused)&&
        (!document.activeElement||document.activeElement===document.body))focused.focus({preventScroll:true});
    };
  },[receiving]);
  return null;
}
export function CompanySyncPanel(){
  const status=useStatus();
  const [busy,setBusy]=useState(false);
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
  return <section className={`company-sync-panel${status.conflict?'':' company-sync-panel--compact'}`} aria-label={t('Entreprise partagée')}>
    <header><Cloud size={22}/><div><h3>{t('Entreprise partagée')}</h3><p role="status">{status.conflict?t('Un document nécessite une vérification.'):status.error?t('Reconnexion en cours…'):status.pending?t('Envoi automatique…'):status.ready?t('Réception automatique…'):t('À jour avec votre équipe.')}</p></div></header>
    {status.lastSyncedAt&&<small>{t('Dernière synchronisation')} : {new Date(status.lastSyncedAt).toLocaleString()}</small>}
    {(status.conflict||status.error)&&<p role="alert">{t(status.conflictReason||status.error||'Les deux copies sont conservées. Contactez le support pour vérifier ce document.')}</p>}
    {duplicate&&<div className="company-sync__receipt"><strong>{duplicate.invoiceNumber} · {amount}</strong><p>{t('Ce montant a été saisi sur deux appareils. S’agit-il du même paiement ?')}</p><Button disabled={busy} onClick={()=>void resolveReceipt()}>{t(busy?'Vérification…':'Oui, un seul paiement')}</Button></div>}
  </section>;
}
