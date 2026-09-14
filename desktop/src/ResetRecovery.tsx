import { useEffect, useState } from 'react';
import { desktopApi } from './bridge';
import { Button, ErrorPanel } from './ui';
import type { Workspace } from './types';
import { t } from './language';
import { errorMessage } from './utils';
export function ResetRecovery({onRestored}:{onRestored:(workspace:Workspace)=>void}) {
  const [available,setAvailable]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let active=true;desktopApi.getResetRecovery().then(result=>{if(active)setAvailable(result.available);}).catch(()=>{});return()=>{active=false;};},[]);
  if(!available)return null;
  return <section className="reset-app__notice" style={{marginTop:20}}><div><h3>{t('Votre sauvegarde de sécurité')}</h3><p>{t('Vous avez remis cet appareil à zéro. Vous pouvez retrouver les données précédentes sans choisir de fichier.')}</p>{error&&<ErrorPanel message={error}/>}<Button variant="secondary" disabled={busy} onClick={()=>{if(busy)return;setBusy(true);setError('');void desktopApi.restoreResetRecovery().then(onRestored).catch(reason=>setError(errorMessage(reason,'La sauvegarde de sécurité n’a pas pu être restaurée.'))).finally(()=>setBusy(false));}}>{t(busy?'Récupération…':'Retrouver mon entreprise précédente')}</Button></div></section>;
}
