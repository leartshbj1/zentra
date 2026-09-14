import { useEffect, useRef, useState } from 'react';
import { Building2, LoaderCircle } from 'lucide-react';
import { CloudAccountPanel } from './CloudAccountPanel';
import { desktopApi, type CloudAccountState } from './bridge';
import type { Workspace } from './types';
import { Button, ErrorPanel, Modal } from './ui';
import { t, getAppLocale } from './language';
import { errorMessage } from './utils';
import type { CloudTeam } from './CloudTeamPanel';

export function JoinCompany({onClose,onJoined,onAccountChange}: {onClose:()=>void;onJoined:(workspace:Workspace)=>void;onAccountChange?:(account:CloudAccountState)=>void}) {
  const [account,setAccount]=useState<CloudAccountState|null>(null),[team,setTeam]=useState<CloudTeam|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const revision=useRef(0), running=useRef(false), attempted=useRef('');
  async function load() {
    const current=++revision.current;
    try { const value=await desktopApi.getCloudTeam(); if(current!==revision.current)return;setTeam(value);setError(''); }
    catch(reason){if(current===revision.current)setError(errorMessage(reason,'L’entreprise n’a pas pu être chargée. Vérifiez la connexion puis réessayez.'));}
  }
  async function join() {
    if(running.current)return;
    running.current=true;setBusy(true);setError('');
    try { onJoined(await desktopApi.joinCloudCompany()); }
    catch(reason){setError(errorMessage(reason,'La récupération n’a pas abouti. Votre espace reste intact. Réessayez avec une connexion Internet.'));}
    finally{running.current=false;setBusy(false);}
  }
  useEffect(()=>{setTeam(null);setError('');if(account?.status==='connected')void load();return()=>{++revision.current;};},[account?.status,account?.organizationId]);
  useEffect(()=>{
    if(team?.companyCopy && account?.status==='connected' && account.organizationId===team.organizationId && attempted.current!==team.organizationId) {
      attempted.current=team.organizationId; void join();
    }
  },[team,account]);
  return <Modal title={t('Rejoindre une entreprise')} onClose={onClose} dismissible={!busy} wide className="join-company-dialog">
    <p>{t('Acceptez le lien d’invitation avec votre adresse e-mail, puis connectez cet appareil avec le même compte. L’entreprise partagée sera récupérée automatiquement.')}</p>
    <div hidden={busy}><CloudAccountPanel joining onAccountChange={next=>{setAccount(next);onAccountChange?.(next);}}/></div>
    {error && <ErrorPanel message={error} onRetry={()=>void (team?.companyCopy?join():load())}/>}
    {team && <div className="cloud-team__profile"><Building2 size={26}/><div><h3>{team.organizationName}</h3>
      {team.companyCopy ? <><p>{t('Clients, devis, factures, projets, comptabilité, salaires et documents seront disponibles sur cet appareil.')}</p><p>{t('Copie partagée le {date}',{date:new Date(team.companyCopy.publishedAt).toLocaleString(getAppLocale())})}</p><p>{t(team.continuous?'Les changements de votre équipe se synchroniseront automatiquement avec Supabase.':'Demandez au titulaire d’activer le partage continu pour recevoir aussi les prochains changements.')}</p></> : <p>{t('Le titulaire doit choisir « Partager l’entreprise complète » dans Paramètres → Compte et équipe. Actualisez ensuite cet écran.')}</p>}
      {busy && <p role="status"><LoaderCircle className="spin" size={20}/>{t(' Récupération de l’entreprise et vérification des documents… Gardez Zentra ouvert.')}</p>}
    </div>
      {!busy && <Button disabled={!team.companyCopy} onClick={()=>void join()}>{t('Recevoir et ouvrir l’entreprise')}</Button>}
      {!busy && !team.companyCopy && <Button variant="secondary" onClick={()=>void load()}>{t('Actualiser')}</Button>}
    </div>}
  </Modal>;
}
