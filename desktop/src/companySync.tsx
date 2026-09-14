import { useEffect,useState } from 'react';
import { createPortal,flushSync } from 'react-dom';
import { Cloud,RefreshCw } from 'lucide-react';
import { desktopApi } from './bridge';
import { Button,ErrorPanel } from './ui';
import { errorMessage } from './utils';
import { t } from './language';
import './companySync.css';

export type CompanySyncState={enabled:boolean;organizationId?:string;revision:number;pending:boolean;conflict:boolean;ready?:boolean;lastSyncedAt?:string;changed?:boolean;remoteRevision?:number};
let current:CompanySyncState={enabled:false,revision:0,pending:false,conflict:false};
let error='';let receiving=false;
const notify=()=>window.dispatchEvent(new Event('zentra-company-sync-status'));
export function publishCompanySync(value:CompanySyncState,message=''){current=value;error=message;notify();}
export function companyReceiveAllowed(){
  return !document.querySelector('[role="dialog"], [aria-modal="true"], .modal-backdrop, [contenteditable="true"]:focus, input:focus, textarea:focus, select:focus, .editor-panel, .document-editor, .settings-form, .desktop-app main form, .desktop-app[data-view="settings"]');
}
export function setCompanyReceiving(value:boolean){receiving=value;notify();}
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
function useStatus(){const [,render]=useState(0);useEffect(()=>{const update=()=>render(v=>v+1);window.addEventListener('zentra-company-sync-status',update);return()=>window.removeEventListener('zentra-company-sync-status',update);},[]);return {...current,error,receiving};}
export function CompanyReceivingOverlay(){
  const {receiving}=useStatus();
  useEffect(()=>{
    if(!receiving)return;
    const root=document.getElementById('root');const previous=root?.inert;
    if(root)root.inert=true;
    return()=>{if(root)root.inert=Boolean(previous);};
  },[receiving]);
  return receiving?createPortal(<div className="company-receiving" role="status" aria-live="polite"><div><RefreshCw className="company-sync__spinner"/><strong>{t('Réception des changements de l’équipe…')}</strong><p>{t('Vos documents et les informations de l’entreprise se mettent à jour.')}</p></div></div>,document.body):null;
}
export function CompanySyncPanel(){
  const status=useStatus();const [busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false);
  async function synchronize(acceptRemote=false){
    setBusy(true);
    try{
      if(acceptRemote)setCompanyReceiving(true);
      let result=await desktopApi.syncCompanyWorkspace(acceptRemote,acceptRemote);
      if(result.ready&&!result.conflict){setCompanyReceiving(true);result=await desktopApi.applyCompanyUpdate();}
      publishCompanySync(result);
      if(result.changed)await refreshReceivedCompany();
      setConfirm(false);
    }catch(reason){publishCompanySync(current,errorMessage(reason,'La synchronisation reprendra automatiquement.'));}
    finally{setBusy(false);setCompanyReceiving(false);}
  }
  if(!status.enabled)return null;
  return <section className="company-sync-panel" aria-label={t('Entreprise partagée')}>
    <header><Cloud size={22}/><div><h3>{t('Entreprise partagée')}</h3><p>{status.conflict?t('Des changements existent sur les deux appareils.'):status.pending?t('Vos changements attendent leur envoi.'):status.ready?t('Des changements de l’équipe sont prêts.'):t('Clients, documents, logo et réglages partagés avec votre équipe.')}</p></div></header>
    {status.lastSyncedAt&&<small>{t('Dernière synchronisation')} : {new Date(status.lastSyncedAt).toLocaleString()}</small>}
    {status.error&&<ErrorPanel message={status.error}/>}
    {status.conflict?<><p>{t('Personne n’a perdu son travail. Pour recevoir la version de l’équipe, Zentra sauvegarde d’abord votre copie locale. Vos changements non envoyés resteront dans cette sauvegarde et devront être repris après la réception.')}</p>
      <label className="company-sync__consent"><input type="checkbox" checked={confirm} onChange={event=>setConfirm(event.target.checked)}/>{t('Conserver ma copie en sauvegarde, puis utiliser la version de l’équipe.')}</label>
      <Button disabled={busy||!confirm} onClick={()=>void synchronize(true)}>{t('Sauvegarder ma copie et recevoir celle de l’équipe')}</Button>
    </>:<Button variant="secondary" disabled={busy} onClick={()=>void synchronize()}><RefreshCw size={16}/>{t(busy?'Synchronisation…':'Synchroniser maintenant')}</Button>}
  </section>;
}
