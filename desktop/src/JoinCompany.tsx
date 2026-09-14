import { useEffect, useRef, useState } from 'react';
import { Building2, LoaderCircle } from 'lucide-react';
import { CloudAccountPanel } from './CloudAccountPanel';
import { desktopApi, type CloudAccountState } from './bridge';
import type { Workspace } from './types';
import { Button, ErrorPanel, Modal } from './ui';
import { t } from './language';
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
    <p>{t('Connectez-vous avec l’adresse qui a reçu l’invitation.')}</p>
    <div hidden={busy}><CloudAccountPanel joining onAccountChange={next=>{setAccount(next);onAccountChange?.(next);}}/></div>
    {error && <ErrorPanel message={error} onRetry={()=>void (team?.companyCopy?join():load())}/>}
    {team && <div className="cloud-team__profile"><Building2 size={26}/><div><h3>{team.organizationName}</h3>
      {team.companyCopy ? <p>{t(team.continuous?'Toute votre entreprise se synchronise automatiquement.':'Le titulaire doit mettre à jour le partage pour synchroniser les prochains changements.')}</p> : <p>{t('Demandez au titulaire d’activer le partage dans Compte et équipe.')}</p>}
      {busy && <p role="status"><LoaderCircle className="spin" size={20}/>{t(' Récupération de l’entreprise et vérification des documents… Gardez Zentra ouvert.')}</p>}
    </div>
      {!busy && <Button disabled={!team.companyCopy} onClick={()=>void join()}>{t('Recevoir et ouvrir l’entreprise')}</Button>}
      {!busy && !team.companyCopy && <Button variant="secondary" onClick={()=>void load()}>{t('Actualiser')}</Button>}
    </div>}
  </Modal>;
}
