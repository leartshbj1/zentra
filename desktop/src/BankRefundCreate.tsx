import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, Search, WalletCards } from 'lucide-react';
import type { BankMovement, Expense, ExpenseRefundInput, Workspace } from './types';
import { expenseRefundTotals } from './expenseRefunds';
import { RefundReceiptPicker } from './RefundAttachments';
import { Button, ErrorPanel, Field, FormActions, Modal } from './ui';
import { createId, errorMessage, formatDate, formatMoney, searchText } from './utils';

export function bankRefundExpenseChoices(expenses: Expense[], movement: BankMovement) {
  const date = movement.bookingDate || movement.valueDate || '';
  return expenses.filter(expense => expense.paymentStatus === 'paid').map(expense => {
    const refunded = expenseRefundTotals(expense);
    const remaining = expense.totalCents - refunded.totalCents;
    const reason = !expense.paidAt ? 'Date du paiement initial à contrôler.'
      : expense.paidAt > date ? 'Cet achat a été payé après le crédit bancaire.'
      : expense.costReviewRequired !== false ? 'Classification TVA ou écritures à contrôler dans la dépense.'
      : remaining < movement.amountCents ? 'Le crédit dépasse le solde remboursable de cet achat.' : '';
    return { expense, refunded, remaining, reason };
  }).sort((a,b) => b.expense.date.localeCompare(a.expense.date) || a.expense.id.localeCompare(b.expense.id));
}

export function BankRefundCreate({ movement, workspace, busy, readOnly, close, onSave }: {
  movement: BankMovement; workspace: Workspace; busy: boolean; readOnly: boolean; close: () => void;
  onSave: (input: ExpenseRefundInput) => Promise<void>;
}) {
  const [choice, setChoice] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(25);
  const choices = useMemo(() => bankRefundExpenseChoices(workspace.expenses, movement), [workspace.expenses, movement]);
  const projectNames = useMemo(() => new Map(workspace.projects.map(project => [project.id, project.name])), [workspace.projects]);
  const selected = choices.find(item => item.expense.id === choice);
  const filtered = choices.filter(({ expense }) => searchText([expense.supplier, expense.reference, projectNames.get(expense.projectId || '')], query));
  if (selected && !selected.reason) return <BankRefundDetails key={choice} movement={movement} expense={selected.expense} busy={busy} readOnly={readOnly} close={close} onSave={onSave} onBack={() => setChoice('')} />;
  return <Modal title="Choisir l’achat remboursé" description={`Crédit reçu de ${formatMoney(movement.amountCents)} le ${formatDate(movement.bookingDate || movement.valueDate)}.`} onClose={close} dismissible={!busy}>
    <div className="bank-expense-form bank-refund-create">
      <p>Retrouvez la dépense payée qui a donné lieu à ce remboursement. Si l’avoir est déjà saisi, revenez aux remboursements existants.</p>
      <label className="bank-candidate-search"><Search size={16} /><span className="sr-only">Rechercher l’achat remboursé</span><input type="search" value={query} disabled={busy} onChange={event => { setQuery(event.target.value); setLimit(25); }} placeholder="Fournisseur, référence ou projet…" autoFocus /></label>
      <div className="bank-refund-create__choices">{filtered.slice(0,limit).map(({ expense, remaining, reason }) => <button type="button" className="bank-refund-create__choice" key={expense.id} disabled={busy || readOnly || Boolean(reason)} onClick={() => setChoice(expense.id)}>
        <strong>{expense.reference || 'Dépense sans référence'}</strong><span>{expense.supplier}</span><small>{formatDate(expense.date)}{expense.archivedAt ? ' · Archivée' : ''}</small><span>Solde remboursable : {formatMoney(remaining)}</span>{reason ? <small>{reason}</small> : null}
      </button>)}</div>
      {!filtered.length ? <p role="status">Aucune dépense payée ne correspond. Vérifiez l’achat dans Achats & fournisseurs.</p> : null}
      {filtered.length > limit ? <Button variant="ghost" onClick={() => setLimit(limit + 25)}>Afficher les achats suivants</Button> : null}
      <Button variant="ghost" onClick={close} disabled={busy}>Revenir au relevé</Button>
    </div>
  </Modal>;
}

function BankRefundDetails({ movement, expense, busy, readOnly, close, onSave, onBack }: {
  movement: BankMovement; expense: Expense; busy: boolean; readOnly: boolean; close: () => void; onBack: () => void;
  onSave: (input: ExpenseRefundInput) => Promise<void>;
}) {
  const [requestId] = useState(createId);
  const paymentDate = movement.bookingDate || movement.valueDate || '';
  const [creditDate,setCreditDate] = useState(paymentDate);
  const [reference,setReference] = useState('');
  const [tax,setTax] = useState('');
  const [reason,setReason] = useState('');
  const [receipt,setReceipt] = useState<File | null>(null);
  const [error,setError] = useState('');
  const [saving,setSaving] = useState(false);
  const submitting = useRef(false);
  const disabled = busy || saving || readOnly;
  const vatCents = /^\d+(?:[.,]\d{1,2})?$/.test(tax.trim()) ? Math.round(Number(tax.replace(',','.')) * 100) : NaN;
  const netCents = movement.amountCents - vatCents;
  const totals = expenseRefundTotals(expense);
  const valid = Number.isSafeInteger(vatCents) && vatCents >= 0 && netCents >= 0 && netCents <= expense.netCents - totals.netCents && vatCents <= expense.vatCents - totals.vatCents;
  return <Modal title="Créer le remboursement reçu" description={`${expense.supplier} · ${expense.reference || 'Dépense sans référence'}`} onClose={close} dismissible={!busy && !saving} wide>
    <form className="bank-expense-form bank-refund-create" onSubmit={async event => {
      event.preventDefault();
      if (disabled || submitting.current) return;
      if (!valid) { setError('Reprenez la TVA de l’avoir. Le remboursement ne peut pas dépasser le solde HT ou TVA de l’achat.'); return; }
      if (creditDate < (expense.paidAt || expense.date) || creditDate > paymentDate) { setError('La date de l’avoir doit suivre le paiement initial et précéder ou égaler le crédit bancaire.'); return; }
      submitting.current = true; setSaving(true); setError('');
      try { await onSave({ requestId, expenseId: expense.id, creditDate, paymentDate, reference: reference.trim(), reason: reason.trim(), netCents, vatCents, reversesId: null, ...(receipt ? { receipt } : {}) }); }
      catch (failure) { setError(errorMessage(failure, 'Le remboursement n’a pas pu être confirmé. Votre saisie est conservée pour réessayer.')); }
      finally { submitting.current = false; setSaving(false); }
    }}>
      <Button type="button" variant="ghost" disabled={disabled} onClick={onBack}><ArrowLeft size={16} /> Choisir un autre achat</Button>
      <div className="bank-expense-form__total"><span>Montant reçu<strong>{formatMoney(movement.amountCents)}</strong></span><span>Date bancaire<strong>{formatDate(paymentDate)}</strong></span></div>
      <div className="info-strip"><WalletCards size={20} /><span>Le montant et la date viennent du relevé. Le remboursement, ses écritures et son association au crédit seront enregistrés ensemble. Le traitement TVA de l’achat est conservé.</span></div>
      <div className="form-grid">
      <Field label="Date de l’avoir" required hint="Reprenez la date du justificatif fournisseur."><input type="date" value={creditDate} min={expense.paidAt || expense.date} max={paymentDate} onChange={event => setCreditDate(event.target.value)} disabled={disabled} required /></Field>
      <Field label="Référence de l’avoir" required><input value={reference} onChange={event => setReference(event.target.value)} maxLength={255} disabled={disabled} required autoFocus /></Field>
      <Field label="Dont TVA selon l’avoir (CHF)" required hint="Saisissez le montant exact du justificatif, ou 0 s’il n’en comporte pas."><input type="text" inputMode="decimal" value={tax} onChange={event => setTax(event.target.value)} disabled={disabled} required /></Field>
      <Field label="Montant hors TVA"><output className="field-output">{valid ? formatMoney(netCents) : 'Montants à vérifier'}</output></Field>
      <Field label="Motif du remboursement" required wide><textarea value={reason} onChange={event => setReason(event.target.value)} minLength={5} maxLength={1000} rows={3} disabled={disabled} required placeholder="Ex. retour de marchandises" /></Field>
      </div>
      <RefundReceiptPicker receipt={receipt} onChange={setReceipt} disabled={disabled} onError={setError} />
      {!receipt ? <p className="field__hint">Le justificatif pourra aussi être ajouté depuis l’historique de la dépense.</p> : null}
      {error ? <ErrorPanel title="Remboursement à contrôler" message={error} reveal /> : null}
      {readOnly ? <p role="status">La création est indisponible en lecture seule ou pendant une actualisation incomplète. Vous pouvez revenir au relevé.</p> : null}
      <FormActions onCancel={close} busy={busy || saving} disabled={readOnly} submitLabel="Créer et rapprocher" />
    </form>
  </Modal>;
}
