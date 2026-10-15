import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { desktopApi } from './bridge';
import { clearLocalAppPreferences } from './resetApp';
import { isDemoWorkspace } from './demoWorkspace';
import { t, useAppLanguage } from './language';
import { Button, ErrorPanel, Modal } from './ui';
import { errorMessage } from './utils';
import { diagnosticOperation } from './diagnostics';

/** Shown only in the demo company created from the first-run screen. */
export function DemoWorkspaceBanner() {
  useAppLanguage();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!isDemoWorkspace()) return null;
  async function leave() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      // The same device reset as Settings: a safety backup is created first.
      await desktopApi.resetLocalApp('REINITIALISER');
      await diagnosticOperation('app', 'reset.preferences_clear', clearLocalAppPreferences);
      window.location.reload();
    } catch (reason) {
      setError(errorMessage(reason, 'La remise à zéro n’a pas pu être terminée. Réessayez ou relancez Zentra.'));
      setBusy(false);
    }
  }
  return <>
    <div className="demo-banner" role="note">
      <Sparkles size={18} aria-hidden="true" />
      <p><strong>{t('Entreprise de démonstration')}</strong> <span>{t('Les clients, devis et projets affichés sont fictifs.')}</span></p>
      <Button variant="secondary" size="small" onClick={() => { setError(''); setOpen(true); }}>{t('Créer ma vraie entreprise')}</Button>
    </div>
    {open && <Modal title={t('Quitter la démonstration ?')} onClose={() => setOpen(false)} dismissible={!busy}>
      <p>{t('Les données de démonstration seront retirées de cet appareil, puis vous retrouverez le premier écran pour créer votre entreprise.')}</p>
      {error && <ErrorPanel message={error} />}
      <div className="form-actions">
        <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>{t('Annuler')}</Button>
        <Button disabled={busy} onClick={() => void leave()}>{t('Créer ma vraie entreprise')}</Button>
      </div>
    </Modal>}
  </>;
}
