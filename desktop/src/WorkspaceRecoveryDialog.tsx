import { knownErrorIncident } from './diagnostics';
import { useRef, useState } from 'react';
import { CheckCircle2, Search, RefreshCw } from 'lucide-react';
import { Button, ErrorPanel, Modal } from './ui';
import { errorMessage } from './utils';
import { t, useAppLanguage } from './language';
import './WorkspaceRecoveryDialog.css';
import { ErrorDetails } from './ErrorGuidance';

export function WorkspaceRecoveryDialog({ reason, incidentCode, checkingCreation = false, onReload }: { reason: string; incidentCode?: string; checkingCreation?: boolean; onReload: () => Promise<void> }) {
  useAppLanguage();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState('');
  const retryIncidentCode = useRef<string | undefined>(undefined);
  return <Modal title={t(checkingCreation ? 'Vérifier l’enregistrement' : 'Enregistrement effectué')} description={t(checkingCreation ? 'La réponse a été interrompue. Votre saisie est conservée dans cette fenêtre.' : 'Les données doivent être actualisées avant de continuer.')} dismissible={false} onClose={() => {}}>
    <form className="workspace-recovery" onSubmit={async (event) => {
      event.preventDefault();
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      retryIncidentCode.current = undefined; setRetryError('');
      try { await onReload(); }
      catch (cause) { retryIncidentCode.current = knownErrorIncident(cause)?.code; setRetryError(errorMessage(cause, 'La lecture des données reste indisponible.')); }
      finally { inFlight.current = false; setBusy(false); }
    }}>
      <div className={`workspace-recovery__saved${checkingCreation ? ' workspace-recovery__checking' : ''}`}>{checkingCreation ? <Search size={28} /> : <CheckCircle2 size={28} />}<p>{t(checkingCreation ? 'Votre opération a peut-être déjà été enregistrée. La vérification contrôlera les données sans répéter l’opération.' : 'Votre opération est sauvegardée. L’actualisation relira les données sans recommencer l’enregistrement.')}</p></div>
      <p>{t(checkingCreation ? 'Si l’enregistrement est confirmé, vous pourrez continuer. Sinon, vous retrouverez votre formulaire avec les informations à corriger.' : 'La consultation et les modifications reprendront dès que les données enregistrées seront chargées.')}</p>
      <ErrorDetails error={reason} incidentCode={incidentCode} />
      {retryError ? <ErrorPanel title={t(checkingCreation ? 'Vérification encore indisponible' : 'Actualisation impossible')} message={retryError} incidentCode={retryIncidentCode.current} fallback={t('La lecture des données reste indisponible.')} operation="read" reveal /> : null}
      <div className="form-actions"><Button type="submit" disabled={busy} data-modal-initial-focus><RefreshCw size={18} className={busy ? 'spin' : undefined} />{t(checkingCreation ? busy ? 'Vérification…' : 'Vérifier maintenant' : busy ? 'Actualisation…' : 'Actualiser les données')}</Button></div>
    </form>
  </Modal>;
}
