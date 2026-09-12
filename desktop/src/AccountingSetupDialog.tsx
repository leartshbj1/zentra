import { useRef, useState } from 'react';
import type { Account, AccountingConfigurationResult, AccountingContinuity, AccountingSettings } from './types';
import type { MappingField } from './accountingSetup';
import { Button, ErrorPanel, Modal } from './ui';
import { errorMessage } from './utils';
import './accounting-setup.css';

export function AccountingSetupDialog({ mode, settings, accounts, fields, continuity, busy, readOnly, onClose, onCommit, onRefresh }: {
  mode: 'starter' | 'mapping'; settings: AccountingSettings; accounts: Account[]; fields: MappingField[]; continuity: AccountingContinuity; busy: boolean; readOnly: boolean;
  onClose: () => void; onCommit: () => Promise<AccountingConfigurationResult>; onRefresh: (result: AccountingConfigurationResult) => Promise<void>;
}) {
  const [result, setResult] = useState<AccountingConfigurationResult | null>(null), [complete, setComplete] = useState(false);
  const [error, setError] = useState(''), [working, setWorking] = useState(false);
  const inFlight = useRef(false), acknowledged = useRef<AccountingConfigurationResult | null>(null);
  const locked = busy || working;
  async function save() {
    if (locked || inFlight.current || complete || (readOnly && !acknowledged.current)) return;
    inFlight.current = true; setWorking(true); setError('');
    try {
      if (!acknowledged.current) { acknowledged.current = await onCommit(); setResult(acknowledged.current); }
      await onRefresh(acknowledged.current);
      setComplete(true);
    } catch (reason) { setError(errorMessage(reason, acknowledged.current ? 'L’affichage n’a pas pu être actualisé.' : 'La configuration n’a pas pu être enregistrée. Vos choix restent présents.')); }
    finally { inFlight.current = false; setWorking(false); }
  }
  const sync = result?.synchronization;
  return <Modal title={complete ? 'La configuration est enregistrée' : result ? 'Enregistré, affichage à actualiser' : mode === 'starter' ? 'Démarrer la comptabilité' : 'Vérifier les comptes choisis'} onClose={onClose} dismissible={!locked && (!result || complete)} className="accounting-setup-modal">
    <form className="accounting-setup-review" onSubmit={event => { event.preventDefault(); void save(); }}>
      {error && <ErrorPanel title={result ? 'L’enregistrement a réussi' : 'Vérifions ce point'} message={error} reveal />}
      {!result ? <>
        {mode === 'starter' ? <><p>Zentra préparera et activera une base de 12 comptes pour les ventes, les achats, la banque, la TVA et les salaires.</p><ul><li>Les comptes sont reliés automatiquement aux opérations.</li><li>Les opérations existantes des périodes ouvertes sont intégrées au journal.</li><li>La base pourra être complétée avec votre fiduciaire selon l’activité de votre entreprise.</li></ul></> : <><p>{settings.enabled ? 'Ces comptes seront utilisés pour enregistrer les prochaines opérations et intégrer les opérations historiques manquantes des périodes ouvertes.' : 'Les écritures automatiques seront désactivées si aucune écriture existante ne l’interdit.'}</p><dl>{fields.filter(field => settings[field.key]).map(field => <div key={field.key}><dt>{field.label}</dt><dd>{(() => { const account = accounts.find(row => row.id === settings[field.key]); return account ? `${account.code} · ${account.name}` : 'Compte indisponible'; })()}</dd></div>)}</dl></>}
        {continuity.totalMissing > 0 && <p className="accounting-setup-review__notice">{continuity.totalMissing} opération(s) de périodes ouvertes sont signalées comme manquantes avant l’enregistrement.</p>}
        {continuity.closedHistoryRequiresOpening > 0 && <p className="accounting-setup-review__notice">{continuity.closedHistoryRequiresOpening} opération(s) concernent des périodes fermées. Leur reprise demandera des soldes d’ouverture contrôlés ; elles ne sont pas déplacées dans l’exercice courant.</p>}
      </> : <><p>{complete ? 'Les comptes et les états ont été actualisés.' : 'Les réglages sont enregistrés. Le bouton ci-dessous relit uniquement les comptes et les états ; il ne répète pas la configuration.'}</p><dl><div><dt>Écritures intégrées</dt><dd>{sync!.createdTotal}</dd></div><div><dt>Opérations de périodes fermées à reprendre</dt><dd>{sync!.skippedClosedHistory}</dd></div><div><dt>Points de contrôle restants à l’enregistrement</dt><dd>{sync!.remaining.totalAnomalies}</dd></div></dl>{sync!.requiresOpeningBalanceReview && <p className="accounting-setup-review__notice">Faites contrôler la reprise des soldes d’ouverture avant de considérer l’historique comme complet.</p>}</>}
      {readOnly && !result && <p>L’application est en lecture seule. Revenez aux réglages pour consulter les comptes.</p>}
      <div className="form-actions">{!result && <Button type="button" variant="secondary" disabled={locked} onClick={onClose}>Revenir aux réglages</Button>}{complete ? <Button type="button" onClick={onClose}>Voir mes comptes</Button> : <Button type="submit" disabled={locked || (readOnly && !result)}>{locked ? 'En cours…' : result ? 'Actualiser les données' : mode === 'starter' ? 'Créer les comptes et activer' : 'Enregistrer ces réglages'}</Button>}</div>
    </form>
  </Modal>;
}
