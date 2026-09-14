import { useRef, useState } from 'react';
import { RotateCcw, ShieldCheck } from 'lucide-react';
import { desktopApi } from './bridge';
import { clearLocalAppPreferences } from './resetApp';
import { t } from './language';
import { Button, ErrorPanel, Field, Modal } from './ui';
import { errorMessage } from './utils';
import { payrollLocalAi } from './payrollLocalAi';
import './resetApp.css';

export function ResetAppPanel({disabled = false}: {disabled?:boolean}) {
  const [open,setOpen] = useState(false), [confirmation,setConfirmation] = useState(''), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const running = useRef(false);
  async function reset() {
    if (running.current || confirmation !== 'REINITIALISER') return;
    running.current = true; setBusy(true); setError('');
    try {
      payrollLocalAi.cancel();
      await desktopApi.resetLocalApp(confirmation);
      await clearLocalAppPreferences();
      window.location.reload();
    } catch(reason) {
      setError(errorMessage(reason,'La remise à zéro n’a pas pu être terminée. Réessayez ou relancez Zentra.'));
      running.current = false; setBusy(false);
    }
  }
  return <section className="panel settings-card settings-card--wide reset-app">
    <div><h3>{t('Recommencer à zéro')}</h3><p>{t('Retrouvez le premier écran pour créer, importer ou rejoindre une entreprise.')}</p></div>
    <Button variant="secondary" disabled={disabled} onClick={()=>{setOpen(true);setConfirmation('');setError('');}}><RotateCcw size={18}/>{t('Réinitialiser cette application')}</Button>
    {open && <Modal title={t('Recommencer à zéro ?')} onClose={()=>setOpen(false)} dismissible={!busy} className="reset-app-dialog">
      <p>{t('L’entreprise locale, ses documents et vos préférences seront retirés de cet appareil. Vous serez déconnecté du compte Zentra.')}</p>
      <div className="reset-app__notice"><ShieldCheck size={22}/><p>{t('L’entreprise en ligne et les autres appareils restent intacts. Votre identité de licence et les sauvegardes de sécurité locales sont conservées.')}</p></div>
      <p>{t('Une sauvegarde complète sera créée avant la remise à zéro. Les changements qui n’ont pas été partagés resteront récupérables dans cette sauvegarde.')}</p>
      <Field label={t('Écrivez REINITIALISER pour confirmer')}><input autoComplete="off" autoCapitalize="characters" spellCheck={false} value={confirmation} disabled={busy} onChange={e=>setConfirmation(e.target.value)} /></Field>
      {error && <ErrorPanel message={error}/>}
      <div className="reset-app__actions"><Button variant="secondary" disabled={busy} onClick={()=>setOpen(false)}>{t('Annuler')}</Button><Button variant="danger" disabled={busy||confirmation!=='REINITIALISER'} onClick={()=>void reset()}>{t(busy?'Remise à zéro…':'Effacer cet espace et recommencer')}</Button></div>
    </Modal>}
  </section>;
}
