import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileUp, LoaderCircle } from 'lucide-react';
import { desktopApi } from './bridge';
import type { CamtImportResult } from './types';
import { Button, Modal } from './ui';
import { bankProblemHelp, bankFileName } from './bankWorkflow';
import { errorMessage } from './utils';
import './bank-workflow.css';

function Problem({ message, busy }: { message: string; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message && !busy) { ref.current?.focus(); ref.current?.scrollIntoView({ block: 'nearest' }); }
  }, [message, busy]);
  if (!message) return null;
  const help = bankProblemHelp(message);
  return <div ref={ref} tabIndex={-1} role="alert" className="bank-workflow-problem"><strong>{help.title}</strong><p>{help.text}</p><details><summary>Voir le message complet</summary><p>{message}</p></details></div>;
}

export function BankActionDialog({ title, description, rows, note, action, disabled, busy, onClose, onConfirm, onAccounting }: {
  title: string; description: string; rows: [string, string][]; note: string; action: string;
  disabled: boolean; busy: boolean; onClose: () => void; onConfirm: () => Promise<void>; onAccounting: (section: 'accounts' | 'periods') => void;
}) {
  const [message, setMessage] = useState(''), [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const locked = busy || saving;
  const accountingProblem = Boolean(message && /clôtur|clotur|liaison|comptabilité|exercice fermé/i.test(message));
  return <Modal title={title} description={description} onClose={onClose} dismissible={!locked} className="bank-workflow-modal">
    <form className="bank-workflow" onSubmit={async event => {
      event.preventDefault();
      if (locked || disabled || inFlight.current) return;
      inFlight.current = true; setSaving(true); setMessage('');
      try { await onConfirm(); }
      catch (reason) { setMessage(errorMessage(reason, 'L’opération n’a pas abouti. Vos choix sont conservés.')); }
      finally { inFlight.current = false; setSaving(false); }
    }}>
      <Problem message={message} busy={locked} />
      {accountingProblem && <Button type="submit" variant="ghost" disabled={locked || disabled}>{action}</Button>}
      <dl className="bank-workflow-summary">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p>{note}</p>
      {disabled && <p className="bank-workflow-hint">Revenez aux mouvements pour actualiser les données ou vérifier l’accès en écriture avant de poursuivre.</p>}
      <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={onClose}>Revenir aux mouvements</Button>{accountingProblem ? <Button type="button" disabled={locked} onClick={() => onAccounting(/clôtur|clotur|exercice fermé/i.test(message) ? 'periods' : 'accounts')}>Vérifier la comptabilité</Button> : <Button type="submit" disabled={locked || disabled}>{locked && <LoaderCircle size={16} className="spin" />}{action}</Button>}</div>
    </form>
  </Modal>;
}

export type BankImportOutcome = { result: CamtImportResult; refreshWarnings: string[] };

export function BankImportWizard({ automatic, onAutomaticChange, disabled, accountingReady, onClose, onImport, onReview, onAccounts, onAccounting, onRefresh }: {
  automatic: boolean; onAutomaticChange: (value: boolean) => void; disabled: boolean; accountingReady: boolean;
  onClose: () => void; onImport: (path: string, automatic: boolean) => Promise<BankImportOutcome>;
  onReview: () => void; onAccounts: () => void; onAccounting: () => void; onRefresh: () => Promise<string[]>;
}) {
  const [path, setPath] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [outcome, setOutcome] = useState<BankImportOutcome>();
  const inFlight = useRef(false), resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (outcome && !busy) { resultRef.current?.focus(); resultRef.current?.scrollIntoView({ block: 'start' }); } }, [outcome, busy]);
  async function choose() {
    if (busy || disabled || inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    try {
      const selected = await desktopApi.chooseCamtFile();
      const next = Array.isArray(selected) ? selected[0] : selected;
      if (next) setPath(next);
    } catch (reason) { setMessage(errorMessage(reason, 'Le choix du fichier a été interrompu. Réessayez.')); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const result = outcome?.result;
  const warnings = result ? [...result.warnings, ...(result.automaticReconciliation?.failures ?? [])] : [];
  return <Modal title="Importer un relevé bancaire" description="Retrouvez les paiements de vos clients à partir du fichier fourni par votre banque." onClose={onClose} dismissible={!busy} className="bank-workflow-modal">
    <form className="bank-workflow" onSubmit={async event => {
      event.preventDefault();
      if (busy || disabled || !path || outcome || inFlight.current) return;
      inFlight.current = true; setBusy(true); setMessage('');
      try { setOutcome(await onImport(path, automatic)); }
      catch (reason) { setMessage(errorMessage(reason, 'L’import a été interrompu. Vous pouvez reprendre le même fichier ; les mouvements déjà connus sont reconnus.')); }
      finally { inFlight.current = false; setBusy(false); }
    }}>
      <Problem message={message} busy={busy} />
      {!result ? <>
        <ol className="bank-import-steps" aria-label="Préparer le relevé"><li><strong>Depuis votre e-banking</strong><p>Ouvrez les mouvements ou documents du compte de votre entreprise. Téléchargez le relevé au format <b>XML camt.053</b> pour la période souhaitée.</p></li><li><strong>Choisissez le fichier téléchargé</strong><p>Il se trouve souvent dans Téléchargements. Un PDF, une photo ou un tableau Excel ne convient pas à cet import.</p></li></ol>
        <div className="bank-import-file"><FileUp size={22} /><div><strong>{path ? bankFileName(path) : 'Aucun fichier choisi'}</strong><small>{path ? 'Prêt à être importé. Vous pouvez encore changer de fichier.' : 'Choisir un fichier ne lance pas encore l’import.'}</small></div><Button type="button" variant="secondary" disabled={busy || disabled} onClick={() => void choose()}>{path ? 'Changer de fichier' : 'Choisir le relevé XML'}</Button></div>
        <label className="bank-import-option"><input type="checkbox" checked={automatic} disabled={busy || disabled} onChange={event => onAutomaticChange(event.target.checked)} /><span><strong>Enregistrer les paiements clients reconnus</strong><small>Zentra utilise la référence QR ou RF, le compte de l’entreprise et le montant. Un versement partiel laisse le reste à payer. Les autres mouvements restent à vérifier.</small></span></label>
        {!accountingReady && <p className="bank-workflow-hint">Vous pouvez importer maintenant. Il faudra terminer la configuration comptable avant d’enregistrer les paiements.</p>}
        <details className="bank-workflow-details"><summary>Quel fichier demander à ma banque ?</summary><p>Demandez un relevé camt.053 XML avec les détails des mouvements. Zentra accepte les versions 001.04 et 001.08. Les avis camt.054 des mêmes versions peuvent être importés ; le rapprochement automatique de Zentra attend le relevé camt.053 définitif.</p><p>Un mouvement déjà importé est reconnu : réimporter le même relevé ne crée pas un second paiement.</p></details>
        <div className="form-actions"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Annuler</Button><Button type="submit" disabled={busy || disabled || !path}>{busy && <LoaderCircle size={16} className="spin" />}Importer ce relevé</Button></div>
      </> : <div className="bank-import-result" ref={resultRef} tabIndex={-1}>
        <CheckCircle2 size={28} /><h3>{result.duplicate ? 'Ce relevé est déjà enregistré' : 'Le relevé est enregistré'}</h3>
        <p>{bankFileName(result.import.sourceName || path)}</p>
        <dl className="bank-workflow-summary"><div><dt>Nouveaux mouvements</dt><dd>{result.importedCount}</dd></div><div><dt>Mouvements déjà connus</dt><dd>{result.skippedDuplicateCount}</dd></div>{result.automaticReconciliation?.enabled && <><div><dt>Factures entièrement payées</dt><dd>{result.automaticReconciliation.paidCount}</dd></div><div><dt>Versements partiels enregistrés</dt><dd>{result.automaticReconciliation.partialCount}</dd></div><div><dt>Encaissements à vérifier</dt><dd>{result.automaticReconciliation.reviewCount}</dd></div></>}</dl>
        {result.ignoredCount > 0 && <p className="bank-workflow-hint">{result.ignoredCount} entrée(s) n’ont pas pu être utilisées. Consultez les détails avant de considérer la période comme complète.</p>}
        {warnings.length > 0 && <details className="bank-workflow-details"><summary>Points signalés pendant l’import ({warnings.length})</summary><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
        {outcome!.refreshWarnings.length > 0 ? <div className="bank-workflow-hint"><strong>Import enregistré, affichage à actualiser</strong><p>Il reste à relire les factures et les mouvements. Ce bouton reprend uniquement la lecture.</p><Button type="button" disabled={busy} onClick={async () => { if (inFlight.current) return; inFlight.current = true; setBusy(true); try { const next = await onRefresh(); setOutcome(current => current && ({ ...current, refreshWarnings: next })); } finally { inFlight.current = false; setBusy(false); } }}>Actualiser les données</Button></div> : <>
          <p>Vérifiez les comptes détectés, puis les mouvements restants. Les règlements fournisseurs se confirment séparément.</p>
          {!accountingReady && <Button type="button" variant="secondary" onClick={onAccounting}>Terminer la configuration comptable</Button>}
          <Button type="button" variant="secondary" onClick={onAccounts}>Vérifier les comptes du relevé</Button>
          <Button type="button" onClick={onReview}>Voir les mouvements à vérifier</Button>
        </>}
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Fermer</Button>
      </div>}
    </form>
  </Modal>;
}
