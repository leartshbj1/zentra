import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FileText, LoaderCircle, RefreshCw } from 'lucide-react';
import { desktopApi } from './bridge';
import { Button, Modal } from './ui';
import { errorMessage } from './utils';
import { conflictFields, conflictLabel, conflictTechnicalField, conflictValue, type BusinessConflictChange, type BusinessConflictChanges, type BusinessConflictChoice,
  type BusinessConflictReview, type BusinessConflictText, type BusinessResolutionPreview, type BusinessResolutionSaved,
  type BusinessSavedResolutions } from './businessConflictReview';
import './businessConflictReview.css';

type Report = BusinessConflictReview | BusinessResolutionPreview | BusinessResolutionSaved;
type Choices = Record<string, BusinessConflictChoice>;
type TextSelection = { transaction: string; change: BusinessConflictChange; image: 'base' | 'local' | 'shared'; field: string };
const imageLabels = { base: 'Avant la modification', local: 'Modification sur cet appareil', shared: 'Version reçue' };

export default function BusinessConflictDialog({ transactionId, onClose, onApply }: { transactionId: string; onClose: () => void; onApply?: (resolutionId: string) => void }) {
  const [report, setReport] = useState<Report>();
  const [choices, setChoices] = useState<Choices>({});
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const [details, setDetails] = useState<BusinessConflictChanges>();
  const [detailCursor, setDetailCursor] = useState<string>();
  const [detailHistory, setDetailHistory] = useState<Array<string | undefined>>([]);
  const [text, setText] = useState<{ selection: TextSelection; page: BusinessConflictText; history: number[] }>();
  const [saved, setSaved] = useState<BusinessSavedResolutions['proposals']>([]);
  const [validated, setValidated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [savedId, setSavedId] = useState<string>();
  const active = useRef(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  // Reuse the same ID after an uncertain response; a new choice gets a new ID.
  const saveAttempt = useRef<{ decisions: string; id: string } | undefined>(undefined);

  const run = useCallback(async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    try { await action(); }
    catch (reason) { if (active.current) { setError(errorMessage(reason, 'La comparaison a été interrompue. Actualisez-la pour continuer.')); setValidated(false); } }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }, []);
  const refresh = useCallback(async () => {
    setReport(undefined); setDetails(undefined); setText(undefined); setChoices({}); setValidated(false);
    setCursor(undefined); setHistory([]); setSavedId(undefined); setSaved([]); saveAttempt.current = undefined;
    const next = await desktopApi.inspectBusinessConflicts(transactionId);
    if (!active.current) return;
    setReport(next);
    const list = await desktopApi.listSavedBusinessResolutions(transactionId, next.review_id);
    if (active.current && list.review_id === next.review_id) setSaved(list.proposals);
  }, [transactionId]);
  useEffect(() => {
    active.current = true;
    void run(refresh);
    return () => { active.current = false; };
  }, [run, refresh]);
  useEffect(() => {
    const dialog = toolbar.current?.closest<HTMLElement>('[role="dialog"]');
    // Disabling/removing the clicked button can send keyboard focus to body.
    // Keep Escape and the modal's Tab trap usable after asynchronous actions.
    if (!busy && dialog && (!dialog.contains(document.activeElement) || document.activeElement?.matches(':disabled'))) dialog.focus({ preventScroll: true });
  }, [busy, report, savedId]);

  function request(after = cursor) { return { review_id: report!.review_id, decisions: Object.entries(choices).map(([transaction_id, choice]) => ({ transaction_id, choice })), after_sequence: after }; }
  function accept(next: Report) {
    if (!active.current) return;
    if (next.review_id !== report?.review_id) throw new Error('La comparaison a changé. Actualisez-la avant de poursuivre.');
    setReport(next); setValidated(next.state === 'resolution_preview' || next.state === 'resolution_saved');
    setSavedId(next.state === 'resolution_saved' ? next.saved.resolution_id : undefined);
  }
  async function page(after: string | undefined, back = false) {
    const next = Object.keys(choices).length && report?.can_choose
      ? await desktopApi.previewBusinessResolution(transactionId, { ...request(), after_sequence: after })
      : await desktopApi.inspectBusinessConflicts(transactionId, { afterSequence: after, reviewId: report!.review_id });
    accept(next);
    if (!active.current) return;
    setHistory(old => back ? old.slice(0, -1) : [...old, cursor]); setCursor(after); setDetails(undefined); setText(undefined);
  }
  async function showDetails(localTransaction: string, after?: string, back = false) {
    const next = await desktopApi.inspectBusinessConflictChanges(transactionId, { review_id: report!.review_id, local_transaction_id: localTransaction, after_sequence: after });
    if (!active.current) return;
    if (next.review_id !== report?.review_id) throw new Error('La comparaison a changé. Actualisez-la.');
    setDetailHistory(old => !after ? [] : back ? old.slice(0, -1) : [...old, detailCursor]);
    setDetailCursor(after); setDetails(next); setText(undefined);
  }
  async function showText(selection: TextSelection, offset = 0, back = false) {
    const next = await desktopApi.readBusinessConflictText(transactionId, { review_id: report!.review_id, local_transaction_id: selection.transaction,
      sequence: selection.change.sequence, image: selection.image, field: selection.field, offset });
    if (!active.current) return;
    if (next.review_id !== report?.review_id) throw new Error('La comparaison a changé. Actualisez-la.');
    setText(old => ({ selection, page: next, history: offset === 0 ? [] : back ? old!.history.slice(0, -1) : [...(old?.history ?? []), old?.page.offset ?? 0] }));
  }
  function choose(id: string, value?: BusinessConflictChoice) {
    setChoices(old => { const next = { ...old }; if (value) next[id] = value; else delete next[id]; return next; });
    setValidated(false); setSavedId(undefined); saveAttempt.current = undefined;
  }
  async function save() {
    const decisions = JSON.stringify(request(undefined).decisions);
    if (saveAttempt.current?.decisions !== decisions) saveAttempt.current = { decisions, id: crypto.randomUUID() };
    const next = await desktopApi.saveBusinessResolution(transactionId, saveAttempt.current.id, { ...request(), after_sequence: undefined });
    accept(next);
    if (!active.current) return;
    setCursor(undefined); setHistory([]); setDetails(undefined); setText(undefined);
    if (next.state === 'resolution_saved') setSaved(old => [{ resolution_id: next.saved.resolution_id, created_at: next.saved.created_at }, ...old.filter(p => p.resolution_id !== next.saved.resolution_id)]);
  }
  async function loadSaved(id: string) {
    const next = await desktopApi.readSavedBusinessResolution(transactionId, id);
    accept(next);
    if (!active.current) return;
    setChoices(next.decisions); setDetails(undefined); setText(undefined); setCursor(undefined); setHistory([]);
    // Saved reports may contain another page. Refresh its first page with the
    // exact recovered choices, without silently editing the saved proposal.
    const first = await desktopApi.previewBusinessResolution(transactionId, { review_id: next.review_id, decisions: Object.entries(next.decisions).map(([transaction_id, choice]) => ({ transaction_id, choice })) });
    if (!active.current) return;
    accept(first); setSavedId(id);
  }

  return <Modal title="Rapprocher les modifications" description="Comparez le travail de cet appareil avec la version reçue de l’équipe." onClose={onClose} wide className="business-conflict-dialog">
    <div ref={toolbar} className="conflict-toolbar"><output>{busy ? <><LoaderCircle size={17} className="spin" /> Vérification…</> : report ? `${report.pending_changes} lignes à examiner · révision ${report.revision}` : 'Chargement de la comparaison'}</output><Button size="small" variant="ghost" disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={15} /> Actualiser</Button></div>
    {error && <p role="alert" className="conflict-error">{error}</p>}
    {report && <>
      <p className="conflict-explanation">Un choix concerne l’opération entière, y compris ses lignes et son historique. Les changements suivants sont examinés séparément.</p>
      {!report.can_choose && <p>Votre accès permet de consulter ces différences. Un membre autorisé doit enregistrer les choix.</p>}
      {saved.length > 0 && <details className="conflict-saved"><summary>Retrouver mes choix enregistrés ({saved.length})</summary>{saved.map(item => <Button key={item.resolution_id} size="small" variant="ghost" disabled={busy} onClick={() => void run(() => loadSaved(item.resolution_id))}>Reprendre les choix du {new Date(item.created_at).toLocaleString('fr-CH')}</Button>)}</details>}
      <div className="conflict-transactions">{report.transactions.map((transaction, index) => <section className="conflict-transaction" key={transaction.transaction_id}>
        <header><div><p className="conflict-kicker">Opération {history.length * 4 + index + 1}</p><h3>{transaction.tables.filter(t => t.table !== 'audit_log').map(t => conflictLabel(t.table)).join(' · ') || 'Historique'}</h3></div><span className={`conflict-badge ${transaction.conflict ? 'conflict-badge--attention' : ''}`}>{transaction.conflict ? 'À rapprocher' : choices[transaction.transaction_id] ? 'Choix préparé' : 'Liée au dossier'}</span></header>
        <p>{transaction.change_count} lignes concernées : {transaction.tables.map(t => `${t.change_count} ${conflictLabel(t.table).toLocaleLowerCase('fr')}`).join(', ')}.</p>
        <Button variant="ghost" size="small" disabled={busy} onClick={() => void run(() => showDetails(transaction.transaction_id))}><FileText size={16} /> Examiner les {transaction.change_count} lignes</Button>
        {details?.local_transaction_id === transaction.transaction_id && <div className="conflict-details">
          <p className="conflict-explanation">« Version reçue » désigne les données partagées à la révision {report.revision}. « Modification sur cet appareil » montre chaque ligne au moment de cette opération.</p>
          {details.changes.map(change => <Change key={change.sequence} change={change} busy={busy} onText={(image, field) => void run(() => showText({ transaction: transaction.transaction_id, change, image, field }))} />)}
          <nav className="conflict-pager" aria-label="Pages des lignes"><Button size="small" variant="ghost" disabled={busy || !detailHistory.length} onClick={() => void run(() => showDetails(transaction.transaction_id, detailHistory.at(-1), true))}><ArrowLeft size={16} /> Lignes précédentes</Button><Button size="small" variant="ghost" disabled={busy || !details.next_after_sequence} onClick={() => void run(() => showDetails(transaction.transaction_id, details.next_after_sequence!))}>Lignes suivantes <ArrowRight size={16} /></Button></nav>
          {text && <section className="conflict-full-text" aria-label="Texte complet"><h4>{conflictLabel(text.selection.field)} · {imageLabels[text.selection.image]}</h4><p>{text.page.total_characters} caractères · à partir du caractère {text.page.offset + 1}</p><pre>{text.page.text}</pre><nav className="conflict-pager"><Button size="small" variant="ghost" disabled={busy || !text.history.length} onClick={() => void run(() => showText(text.selection, text.history.at(-1)!, true))}>Texte précédent</Button><Button size="small" variant="ghost" disabled={busy || text.page.next_offset === null} onClick={() => void run(() => showText(text.selection, text.page.next_offset!))}>Suite du texte</Button></nav></section>}
        </div>}
        {report.can_choose && transaction.transaction_id !== report.confirmed_transaction_id && <fieldset className="conflict-choices" disabled={busy}><legend>Version à conserver pour cette opération</legend>{(['local', 'shared'] as const).map(value => <label key={value} aria-label={value === 'local' ? 'Garder ma modification' : 'Garder la version partagée'} className={choices[transaction.transaction_id] === value ? 'is-selected' : ''}><input type="radio" name={`choice-${transaction.transaction_id}`} value={value} checked={choices[transaction.transaction_id] === value} onChange={() => choose(transaction.transaction_id, value)} /><span><strong>{value === 'local' ? 'Garder ma modification' : 'Garder la version partagée'}</strong><small>{value === 'local' ? 'Reprendre les changements de cette opération.' : 'Écarter cette opération locale de la proposition.'}</small></span></label>)}{choices[transaction.transaction_id] && <Button size="small" variant="ghost" onClick={() => choose(transaction.transaction_id)}>Retirer ce choix</Button>}</fieldset>}
      </section>)}</div>
      <nav className="conflict-pager" aria-label="Pages des opérations"><Button size="small" variant="ghost" disabled={busy || !history.length} onClick={() => void run(() => page(history.at(-1), true))}><ArrowLeft size={16} /> Opérations précédentes</Button><Button size="small" variant="ghost" disabled={busy || !report.next_after_sequence} onClick={() => void run(() => page(report.next_after_sequence!))}>Opérations suivantes <ArrowRight size={16} /></Button></nav>
      {validated && 'documents' in report && report.documents && <output className="conflict-valid"><Check size={18} /> Proposition vérifiée avec {report.documents.final_count} documents, dont {report.documents.files_to_replace} à remplacer.</output>}
      {!validated && report.state === 'resolution_needs_review' && <output>Il reste {report.conflict_count} opérations à rapprocher. Consultez aussi les pages suivantes.</output>}
      <footer className="conflict-footer"><p>{savedId ? 'Vos choix et les documents sont enregistrés. Leur application actualisera le dossier ; les opérations d’origine resteront conservées dans l’historique.' : `${Object.keys(choices).length} choix préparés. Vérifiez-les puis enregistrez la proposition avant de l’appliquer.`}</p><div><Button variant="secondary" disabled={busy || !report.can_choose || !Object.keys(choices).length} onClick={() => void run(async () => accept(await desktopApi.previewBusinessResolution(transactionId, request())))}>Vérifier mes choix</Button><Button disabled={busy || !report.can_choose || !validated || Boolean(savedId)} onClick={() => void run(save)}>{savedId ? 'Choix enregistrés' : 'Enregistrer mes choix'}</Button>{savedId && onApply && <Button disabled={busy || !report.can_choose || !validated} onClick={() => onApply(savedId)}>Appliquer mes choix</Button>}</div></footer>
    </>}
  </Modal>;
}

function Change({ change, busy, onText }: { change: BusinessConflictChange; busy: boolean; onText: (image: 'base' | 'local' | 'shared', field: string) => void }) {
  const fields = conflictFields(change);
  const renderField = (key: string) => <div className="conflict-field" key={key}><h5>{conflictLabel(key)}</h5><div className="conflict-images">{(['base', 'local', 'shared'] as const).map(image => {
    const cell = change[image]?.fields[key];
    return <div key={image} className={`conflict-image conflict-image--${image}`}><span>{imageLabels[image]}</span><p>{!change[image] ? 'Ligne absente' : conflictValue(key, cell?.value)}</p>{cell?.truncated && <Button variant="ghost" size="small" disabled={busy} onClick={() => onText(image, key)}>Lire le texte complet</Button>}</div>;
  })}</div></div>;
  return <article className="conflict-change"><h4>{conflictLabel(change.table)} <span>{({ insert: 'Ajout', update: 'Modification', delete: 'Suppression' })[change.operation]}</span></h4>{fields.some(f => f.key.endsWith('_cents')) && <p className="conflict-explanation">Montants dans la devise du document.</p>}{fields.filter(f => f.changed && !conflictTechnicalField(change.table, f.key)).map(f => renderField(f.key))}<details><summary>Autres champs et identifiants</summary><p className="conflict-key">{change.key_json}</p>{fields.filter(f => !f.changed || conflictTechnicalField(change.table, f.key)).map(f => renderField(f.key))}</details></article>;
}
