import { useEffect, useRef, useState } from 'react';
import { Building2 } from 'lucide-react';
import { CloudAccountPanel } from './CloudAccountPanel';
import { desktopApi, type CloudAccountState } from './bridge';
import type { Workspace } from './types';
import { Button, ErrorPanel, Modal } from './ui';
import { t } from './language';
import { errorMessage } from './utils';
import type { CloudTeam } from './CloudTeamPanel';

export function JoinCompany({onClose,onJoined,onAccountChange}: {onClose:()=>void;onJoined:(workspace:Workspace)=>void;onAccountChange?:(account:CloudAccountState)=>void}) {
  const [account,setAccount]=useState<CloudAccountState|null>(null),[team,setTeam]=useState<CloudTeam|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const revision = useRef(0);
  async function load() { const current=++revision.current; try {const value=await desktopApi.getCloudTeam();if(current!==revision.current)return;setTeam(value);setError('');}catch(reason){if(current===revision.current)setError(errorMessage(reason,'Les coordonnées partagées n’ont pas pu être chargées.'));} }
  useEffect(()=>{setTeam(null);setError('');if(account?.status==='connected')void load();return()=>{++revision.current;};},[account?.status,account?.organizationId]);
  return <Modal title={t('Rejoindre une entreprise')} onClose={onClose} dismissible={!busy} wide className="join-company-dialog">
    <p>{t('Acceptez d’abord le lien d’invitation avec votre adresse e-mail, puis connectez cet appareil avec le même compte.')}</p>
    <CloudAccountPanel joining onAccountChange={next=>{setAccount(next);onAccountChange?.(next);}}/>
    {error && <ErrorPanel message={error} onRetry={()=>void load()}/>}
    {team && <div className="cloud-team__profile"><Building2 size={26}/><div><h3>{team.organizationName}</h3><p>{t('Les coordonnées et les fichiers des projets sont partagés. Les autres données métier restent locales sur chaque appareil.')}</p>{!team.profile && <p>{t('Le titulaire doit partager les coordonnées dans Paramètres → Compte et équipe. Actualisez ensuite cet écran.')}</p>}</div>
      <Button disabled={busy||!team.profile} onClick={()=>{if(busy)return;setBusy(true);setError('');void desktopApi.joinCloudCompany().then(onJoined).catch(reason=>setError(errorMessage(reason,'L’entreprise n’a pas pu être ouverte.'))).finally(()=>setBusy(false));}}>{t(busy?'Ouverture…':'Ouvrir cette entreprise')}</Button>
      {!team.profile&&<Button variant="secondary" onClick={()=>void load()}>{t('Actualiser')}</Button>}
    </div>}
  </Modal>;
}
