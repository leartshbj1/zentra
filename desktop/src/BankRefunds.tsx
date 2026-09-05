import { useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, History, Link2, Search } from 'lucide-react';
import type { BankMovement } from './types';
import { Button, ErrorPanel, Field, FormActions, Modal } from './ui';
import { createId, errorMessage, formatDate, formatDateTime, formatMoney, searchText } from './utils';

export function BankRefundPicker({ movement, disabled, onConfirm }: {
  movement: BankMovement; disabled: boolean;
  onConfirm: (requestId: string, refundId: string, dateReason?: string) => Promise<void>;
}) {
  const [requestId] = useState(createId);
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState('');
  const [limit, setLimit] = useState(25);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState(false);
  const submitting = useRef(false);
  const candidates = movement.refundSuggestion?.candidates ?? [];
  const filtered = candidates.filter((candidate) => searchText([candidate.reference, candidate.supplier, candidate.expenseReference, candidate.paymentDate], query));
  const selected = candidates.find((candidate) => candidate.refundId === choice);
  const note = notes[choice] || '';
  const invalid = !selected?.confirmable || (selected.requiresDateReason && Array.from(note.trim()).length < 5);
  return <details className="bank-expense-picker bank-refund-picker">
    <summary>Rapprocher un remboursement <span>{candidates.length}</span><ChevronDown className="bank-expense-picker__chevron" size={16} /></summary>
    {completed ? <p role="status"><CheckCircle2 size={16} /> Association enregistrée. Actualisez les données pour afficher son résultat.</p> : <>
      <p>{movement.refundSuggestion?.reason || 'Choisissez un remboursement déjà enregistré dans une dépense.'}</p>
      {candidates.length ? <>
        <label className="bank-candidate-search"><Search size={14} /><span className="sr-only">Rechercher un remboursement</span><input type="search" value={query} disabled={disabled} onChange={(event) => {
          const value = event.target.value;
          setQuery(value); setLimit(25);
          if (selected && !searchText([selected.reference, selected.supplier, selected.expenseReference, selected.paymentDate], value)) { setChoice(''); setError(''); }
        }} placeholder="Référence, fournisseur ou achat…" /></label>
        <div className="bank-candidate-options" role="radiogroup" aria-label="Choisir le remboursement à rapprocher">{filtered.slice(0, limit).map((candidate) => <label className={`bank-candidate-option ${choice === candidate.refundId ? 'is-selected' : ''} ${candidate.confirmable ? '' : 'is-blocked'}`} key={candidate.refundId}>
          <input className="sr-only" type="radio" name={`refund-${movement.id}`} checked={choice === candidate.refundId} disabled={disabled || !candidate.confirmable} onChange={() => { setChoice(candidate.refundId); setError(''); }} />
          <span className="bank-candidate-option__identity"><strong>{candidate.reference}</strong><span>{candidate.supplier}</span><small>Achat {candidate.expenseReference || 'sans référence'} · reçu le {formatDate(candidate.paymentDate)}</small></span>
          <span className="bank-candidate-option__amount"><strong>{formatMoney(candidate.totalCents)}</strong></span><span className="bank-candidate-option__reason">{candidate.reason}</span>
        </label>)}</div>
        {!filtered.length ? <p role="status">Aucun remboursement ne correspond à cette recherche.</p> : null}
        {filtered.length > limit ? <Button type="button" variant="ghost" onClick={() => setLimit(limit + 25)}>Afficher les remboursements suivants</Button> : null}
        {selected?.requiresDateReason ? <Field label="Justification de l’écart de dates" required hint={`Remboursement enregistré le ${formatDate(selected.paymentDate)} ; relevé du ${formatDate(movement.bookingDate || movement.valueDate)}. Les dates comptables seront conservées.`}><textarea value={note} onChange={(event) => setNotes((previous) => ({ ...previous, [choice]: event.target.value }))} maxLength={500} minLength={5} rows={3} disabled={disabled} /></Field> : null}
        {error ? <ErrorPanel title="Association à contrôler" message={error} reveal /> : null}
        <Button type="button" size="small" disabled={disabled || invalid} onClick={async () => {
          if (disabled || invalid || submitting.current || !selected) return;
          submitting.current = true; setError('');
          try { await onConfirm(requestId, selected.refundId, selected.requiresDateReason ? note.trim() : undefined); setCompleted(true); }
          catch (cause) { setError(errorMessage(cause, 'L’association n’a pas pu être confirmée. Votre choix est conservé.')); }
          finally { submitting.current = false; }
        }}><Link2 size={14} /> Associer le remboursement</Button>
      </> : <p>Si le remboursement n’est pas encore enregistré, ouvrez la dépense dans Achats & fournisseurs, puis ajoutez le remboursement reçu.</p>}
    </>}
  </details>;
}

export function BankRefundUnlink({ movement, busy, close, onConfirm }: {
  movement: BankMovement; busy: boolean; close: () => void;
  onConfirm: (requestId: string, matchId: string, reason: string) => Promise<void>;
}) {
  const [requestId] = useState(createId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const link = movement.refundMatch;
  return <Modal title="Dissocier le remboursement du relevé" description="Corrigez une association bancaire erronée." onClose={close} dismissible={!busy && !saving}>
    <form className="bank-expense-form" onSubmit={async (event) => {
      event.preventDefault();
      if (!link || busy || submitting.current || Array.from(reason.trim()).length < 5) return;
      submitting.current = true; setSaving(true); setError('');
      try { await onConfirm(requestId, link.id, reason.trim()); }
      catch (cause) { setError(errorMessage(cause, 'La dissociation a été refusée. Votre motif est conservé.')); }
      finally { submitting.current = false; setSaving(false); }
    }}>
      <div className="bank-expense-correction__summary"><strong>{link?.reference}</strong><span>{link?.supplier}</span><strong>{formatMoney(movement.amountCents)}</strong><span>Relevé du {formatDate(movement.bookingDate || movement.valueDate)}</span></div>
      <div className="info-strip"><History size={20} /><span>Le remboursement, la TVA et les écritures comptables restent enregistrés. Le crédit bancaire reviendra dans « À rapprocher ». Le motif de cette dissociation sera conservé.</span></div>
      <Field label="Motif de la dissociation" required hint="5 à 500 caractères."><textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={500} rows={4} disabled={busy || saving} required autoFocus /></Field>
      {error ? <ErrorPanel title="Dissociation à contrôler" message={error} reveal /> : null}
      <FormActions onCancel={close} busy={busy || saving} disabled={Array.from(reason.trim()).length < 5} submitLabel="Dissocier le remboursement" />
    </form>
  </Modal>;
}

export function BankRefundHistory({ movement }: { movement: BankMovement }) {
  const [limit, setLimit] = useState(5);
  const history = movement.refundHistory ?? [];
  if (!history.length) return null;
  return <details className="bank-expense-history bank-refund-history"><summary><History size={16} /> Historique des remboursements rapprochés <span>{history.length}</span><ChevronDown className="bank-history-chevron" size={14} /></summary><div className="bank-expense-history__entries">{history.slice(0, limit).map((entry) => <article key={entry.id}><strong>{entry.reference} · {formatMoney(entry.amountCents)}</strong><span>{entry.supplier}</span><small>Associé le {formatDateTime(entry.confirmedAt)}</small><small>Dissocié le {formatDateTime(entry.unlinkedAt)} · remboursement conservé</small><p>{entry.reason}</p>{entry.dateDifferenceReason ? <small>Écart de dates documenté : {entry.dateDifferenceReason}</small> : null}</article>)}</div>{history.length > limit ? <Button variant="ghost" size="small" onClick={() => setLimit(limit + 5)}>Afficher les dissociations suivantes</Button> : null}</details>;
}
