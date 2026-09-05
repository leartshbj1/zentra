import { useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Link2, Receipt, Search } from 'lucide-react';
import type { BankMovement } from './types';
import { Button } from './ui';
import { errorMessage, formatDate, formatMoney, searchText } from './utils';

export function BankExpensePicker({ movement, disabled, onConfirm }: {
  movement: BankMovement;
  disabled: boolean;
  onConfirm: (expenseId: string, dateDifferenceReason?: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState('');
  const [limit, setLimit] = useState(25);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState(false);
  const [dateReasons, setDateReasons] = useState<Record<string, string>>({});
  const submitting = useRef(false);
  const candidates = movement.expenseSuggestion?.candidates ?? [];
  const filtered = candidates.filter((candidate) => searchText([candidate.reference, candidate.supplier, candidate.category, candidate.date], query));
  const selected = candidates.find((candidate) => candidate.expenseId === choice);
  const dateReason = dateReasons[choice] || '';
  const reasonMissing = selected?.requiresDateReason && Array.from(dateReason.trim()).length < 5;
  async function confirm() {
    if (disabled || !selected?.confirmable || completed || submitting.current || reasonMissing) return;
    submitting.current = true;
    setError('');
    try { await onConfirm(selected.expenseId, selected.requiresDateReason ? dateReason.trim() : undefined); setCompleted(true); }
    catch (reason) { setError(errorMessage(reason, 'Le rapprochement a été refusé. Votre sélection est conservée.')); }
    finally { submitting.current = false; }
  }
  return <details className="bank-expense-picker">
    <summary>Rapprocher une dépense <span>{candidates.length}</span><ChevronDown className="bank-expense-picker__chevron" size={16} /></summary>
    {completed ? <p role="status"><CheckCircle2 size={16} /> Rapprochement enregistré. Actualisez les données si la liste n’a pas encore changé.</p> : <>
      <p>{movement.expenseSuggestion?.reason || 'Sélectionnez une dépense enregistrée dans les achats.'}</p>
      {candidates.length ? <>
        <label className="bank-candidate-search"><Search size={14} /><span className="sr-only">Rechercher une dépense</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(25); }} placeholder="Référence, fournisseur, catégorie…" /></label>
        <div className="bank-candidate-options" role="radiogroup" aria-label="Choisir la dépense à rapprocher">
          {filtered.slice(0, limit).map((candidate) => <label className={`bank-candidate-option ${choice === candidate.expenseId ? 'is-selected' : ''} ${candidate.confirmable ? '' : 'is-blocked'}`} key={candidate.expenseId}>
            <input type="radio" className="sr-only" name={`expense-${movement.id}`} checked={choice === candidate.expenseId} disabled={disabled || !candidate.confirmable} onChange={() => { setChoice(candidate.expenseId); setError(''); }} />
            <span className="bank-candidate-option__icon"><Receipt size={15} /></span>
            <span className="bank-candidate-option__identity"><strong>{candidate.reference || candidate.category || 'Dépense'}</strong><span>{candidate.supplier || candidate.category}</span><small>{formatDate(candidate.date)} · {candidate.paymentStatus === 'paid' ? 'Déjà payée' : 'À payer'}</small></span>
            <span className="bank-candidate-option__amount"><strong>{formatMoney(candidate.totalCents)}</strong><small>TTC</small></span>
            <span className="bank-candidate-option__reason">{candidate.reason}</span>
          </label>)}
        </div>
        {!filtered.length ? <p>Aucune dépense ne correspond à cette recherche.</p> : null}
        {filtered.length > limit ? <Button variant="ghost" onClick={() => setLimit(limit + 25)}>Afficher les dépenses suivantes</Button> : null}
        {selected ? <p className="bank-expense-picker__confirmation"><strong>{selected.reference || selected.category || 'Dépense sélectionnée'}</strong> · {formatMoney(selected.totalCents)}<br />{selected.paymentStatus === 'paid' ? 'Le paiement existant sera relié au relevé sans nouvelle écriture.' : `La dépense sera marquée payée et comptabilisée au ${formatDate(movement.bookingDate || movement.valueDate)}.`}</p> : null}
        {selected?.requiresDateReason ? <label className="field bank-expense-picker__date-reason"><span>Motif de l’écart de dates</span><small>Paiement comptabilisé le {formatDate(selected.paidAt)} ; relevé du {formatDate(movement.bookingDate || movement.valueDate)}. Le journal et sa période TVA sont conservés.</small><textarea value={dateReason} maxLength={500} rows={3} placeholder="Ex. ordre de paiement émis avant son inscription au relevé" onChange={(event) => setDateReasons((current) => ({ ...current, [choice]: event.target.value }))} /><small>Au moins 5 caractères.</small></label> : null}
        {error ? <p className="bank-expense-picker__error" role="alert">{error}</p> : null}
        <Button size="small" disabled={disabled || !selected?.confirmable || reasonMissing} onClick={() => void confirm()}><Link2 size={14} /> Confirmer la dépense</Button>
      </> : <p>Enregistrez la pièce dans Achats & fournisseurs, puis actualisez les mouvements. Seules les dépenses du même montant en CHF sont proposées.</p>}
    </>}
  </details>;
}
