import { useLayoutEffect, useRef, useState } from 'react';
import { RotateCcw, ShieldCheck } from 'lucide-react';
import { desktopApi } from './bridge';
import { clearLocalAppPreferences } from './resetApp';
import { t } from './language';
import { Button, ErrorPanel, Field, Modal } from './ui';
import { errorMessage } from './utils';
import { payrollLocalAi } from './payrollLocalAi';
import { diagnosticOperation } from './diagnostics';
import './resetApp.css';

export function ResetAppPanel({disabled = false}: {disabled?:boolean}) {
  const [open,setOpen] = useState(false), [confirmation,setConfirmation] = useState(''), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const running = useRef(false);
  const resetCompleted = useRef(false);
  const mounted = useRef(true);
  const context = useRef({ disabled, confirmation });
  context.current = { disabled, confirmation };
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function reset() {
    if (!mounted.current || context.current.disabled || running.current || context.current.confirmation !== 'REINITIALISER') return;
    running.current = true; setBusy(true); setError('');
    try {
      payrollLocalAi.cancel();
      // A cache cleanup error must never create a second (empty) recovery backup on retry.
      if (!resetCompleted.current) {
        await desktopApi.resetLocalApp(context.current.confirmation);
        resetCompleted.current = true;
      }
      // An admitted device reset must finish its cleanup even if this screen leaves.
      // The fixed operation name records failures without logging any preferences.
      await diagnosticOperation('app', 'reset.preferences_clear', clearLocalAppPreferences);
      window.location.reload();
    } catch(reason) {
      running.current = false;
      if (mounted.current) { setError(errorMessage(reason,'La remise à zéro n’a pas pu être terminée. Réessayez ou relancez Zentra.')); setBusy(false); }
    }
  }
  return <section className="panel settings-card settings-card--wide reset-app">
    <div><h3>{t('Recommencer à zéro')}</h3><p>{t('Retrouvez le premier écran pour créer, importer ou rejoindre une entreprise.')}</p></div>
    <Button variant="secondary" disabled={disabled} onClick={()=>{if(!mounted.current || context.current.disabled)return;setOpen(true);setConfirmation('');setError('');}}><RotateCcw size={18}/>{t('Réinitialiser cette application')}</Button>
    {open && <Modal title={t('Recommencer à zéro ?')} onClose={()=>setOpen(false)} dismissible={!busy} className="reset-app-dialog">
      <p>{t('L’entreprise locale, ses documents et vos préférences seront retirés de cet appareil. Vous serez déconnecté du compte Zentra.')}</p>
      <div className="reset-app__notice"><ShieldCheck size={22}/><p>{t('L’entreprise en ligne et les autres appareils restent intacts. Votre identité de licence et les sauvegardes de sécurité locales sont conservées.')}</p></div>
      <p>{t('Une sauvegarde complète sera créée avant la remise à zéro. Les changements qui n’ont pas été partagés resteront récupérables dans cette sauvegarde.')}</p>
      <Field label={t('Écrivez REINITIALISER pour confirmer')}><input autoComplete="off" autoCapitalize="characters" spellCheck={false} value={confirmation} disabled={busy||disabled} onChange={e=>setConfirmation(e.target.value)} /></Field>
      {error && <ErrorPanel message={error}/>}
      <div className="reset-app__actions"><Button variant="secondary" disabled={busy} onClick={()=>setOpen(false)}>{t('Annuler')}</Button><Button variant="danger" disabled={busy||disabled||confirmation!=='REINITIALISER'} onClick={()=>void reset()}>{t(busy?'Remise à zéro…':'Effacer cet espace et recommencer')}</Button></div>
    </Modal>}
  </section>;
}
