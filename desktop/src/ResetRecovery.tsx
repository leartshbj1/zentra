import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { desktopApi } from './bridge';
import { Button, ErrorPanel } from './ui';
import type { Workspace } from './types';
import { t } from './language';
import { errorMessage } from './utils';
import { refreshWorkspaceAfterMutation, WorkspaceRefreshAfterMutationError } from './workspaceMutation';
export function ResetRecovery({onRestored}:{onRestored:(workspace:Workspace)=>void}) {
  const [available,setAvailable]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const mounted=useRef(true),running=useRef(false),restored=useRef(false),callback=useRef(onRestored);
  callback.current=onRestored;
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{let active=true;desktopApi.getResetRecovery().then(result=>{if(active&&mounted.current)setAvailable(result.available);}).catch(()=>{});return()=>{active=false;};},[]);
  async function restore() {
    if(!mounted.current||running.current)return;
    running.current=true;setBusy(true);setError('');
    try {
      const workspace=restored.current?await refreshWorkspaceAfterMutation(desktopApi.loadWorkspace):await desktopApi.restoreResetRecovery();
      restored.current=true;
      if(mounted.current)callback.current(workspace);
    }
    catch(reason){
      if(reason instanceof WorkspaceRefreshAfterMutationError)restored.current=true;
      if(mounted.current)setError(errorMessage(reason,'La sauvegarde de sécurité n’a pas pu être restaurée.'));
    }
    finally{running.current=false;if(mounted.current)setBusy(false);}
  }
  if(!available)return null;
  return <section className="reset-app__notice" style={{marginTop:20}}><div><h3>{t('Votre sauvegarde de sécurité')}</h3><p>{t('Vous avez remis cet appareil à zéro. Vous pouvez retrouver les données précédentes sans choisir de fichier.')}</p>{error&&<ErrorPanel message={error}/>}<Button variant="secondary" disabled={busy} onClick={()=>void restore()}>{t(restored.current?(busy?'Actualisation…':'Actualiser les données'):(busy?'Récupération…':'Retrouver mon entreprise précédente'))}</Button></div></section>;
}
