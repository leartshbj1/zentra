import { useState } from 'react';
import { RotateCcw, WalletCards } from 'lucide-react';
import { desktopApi } from './bridge';
import { expenseRefundTotals } from './expenseRefunds';
import type { Expense, ExpenseRefund, Workspace } from './types';
import { Button, ErrorPanel, Field, FormActions, Modal } from './ui';
import { createId, errorMessage, formatDate, formatMoney, todayIso } from './utils';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (error: unknown) => void) => Promise<boolean>;
const amount = (value: string) => Math.round(Number(value.replace(',', '.')) * 100);

export function ExpenseRefundForm({ expense, reverse, busy, close, act }: { expense: Expense; reverse?: ExpenseRefund; busy: boolean; close: () => void; act: ActionRunner }) {
  const totals = expenseRefundTotals(expense);
  const [requestId] = useState(createId);
  const [creditDate, setCreditDate] = useState(todayIso);
  const [paymentDate, setPaymentDate] = useState(todayIso);
  const [reference, setReference] = useState(reverse?.reference ?? '');
  const [reason, setReason] = useState('');
  const [gross, setGross] = useState(((reverse?.totalCents ?? expense.totalCents - totals.totalCents) / 100).toFixed(2));
  const [tax, setTax] = useState(((reverse?.vatCents ?? expense.vatCents - totals.vatCents) / 100).toFixed(2));
  const [error, setError] = useState('');
  const grossCents = amount(gross);
  const vatCents = amount(tax);
  const netCents = grossCents - vatCents;
  const invalidAmounts = !Number.isSafeInteger(grossCents) || !Number.isSafeInteger(vatCents) || grossCents <= 0 || vatCents < 0 || netCents < 0;
  return <Modal title={reverse ? 'Corriger un remboursement' : 'Enregistrer un remboursement'} description={`${expense.supplier || 'Fournisseur'} · ${expense.reference || 'Dépense sans référence'}`} onClose={busy ? () => {} : close} wide>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      setError('');
      if (invalidAmounts || (!reverse && (netCents > expense.netCents - totals.netCents || vatCents > expense.vatCents - totals.vatCents))) { setError('Le remboursement dépasse le solde HT ou TVA de cet achat, ou ses montants sont incohérents.'); return; }
      if (paymentDate < creditDate) { setError('La date du remboursement ne peut pas précéder celle de l’avoir.'); return; }
      await act(async () => {
        try { return await desktopApi.recordExpenseRefund({ requestId, expenseId: expense.id, creditDate, paymentDate, reference: reference.trim(), reason: reason.trim(), netCents, vatCents, reversesId: reverse?.id ?? null }); }
        catch (failure) { if (!(failure instanceof WorkspaceRefreshAfterMutationError)) setError(errorMessage(failure, 'Le remboursement n’a pas pu être confirmé. Réessayez cette même saisie.')); throw failure; }
      }, reverse ? 'La saisie du remboursement a été corrigée. L’historique est conservé.' : 'Le remboursement reçu a été enregistré et les coûts du projet ont été actualisés.', true, () => {});
    }}>
      <div className="info-strip"><WalletCards size={18} /><span>{reverse ? 'Utilisez cette correction uniquement pour une saisie erronée. Les écritures inverses rétablissent le coût, la TVA et le montant bancaire aux dates indiquées.' : 'Enregistrez un remboursement effectivement reçu du fournisseur. L’achat initial est conservé et la TVA reprend son traitement historique.'}</span></div>
      <div className="form-grid">
        <Field label={reverse ? 'Date de correction de l’avoir' : 'Date de l’avoir'} required hint="Date de comptabilisation de la correction du prix."><input type="date" value={creditDate} min={[expense.paidAt ?? expense.date, reverse?.creditDate ?? expense.date].sort().at(-1)} max={todayIso()} onChange={(event) => setCreditDate(event.target.value)} disabled={busy} required /></Field>
        <Field label={reverse ? 'Date de correction bancaire' : 'Date du remboursement reçu'} required hint={reverse ? 'Date de la correction du montant enregistré en banque.' : 'Date à laquelle le fournisseur vous a remboursé.'}><input type="date" value={paymentDate} min={[creditDate, reverse?.paymentDate ?? expense.paidAt ?? expense.date].sort().at(-1)} max={todayIso()} onChange={(event) => setPaymentDate(event.target.value)} disabled={busy} required /></Field>
        <Field label="Référence de l’avoir" required wide><input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={255} disabled={busy || Boolean(reverse)} required autoFocus /></Field>
        <Field label="Montant TTC remboursé (CHF)" required hint={!reverse ? `Solde remboursable : ${formatMoney(expense.totalCents - totals.totalCents)}` : undefined}><input type="number" inputMode="decimal" min="0.01" step="0.01" value={gross} onChange={(event) => setGross(event.target.value)} disabled={busy || Boolean(reverse)} required /></Field>
        <Field label="Dont TVA selon l’avoir (CHF)" required hint="Reprenez le montant du justificatif, sans recalculer un taux moyen."><input type="number" inputMode="decimal" min="0" step="0.01" value={tax} onChange={(event) => setTax(event.target.value)} disabled={busy || Boolean(reverse)} required /></Field>
        <Field label="Montant hors TVA"><output className="field-output">{invalidAmounts ? 'Montants à vérifier' : formatMoney(netCents)}</output></Field>
        <Field label={reverse ? 'Motif de la correction' : 'Motif du remboursement'} required wide><textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={1000} rows={3} disabled={busy} required placeholder={reverse ? 'Expliquez pourquoi la saisie était erronée' : 'Ex. retour de marchandises ou réduction de prix'} /></Field>
      </div>
      {error ? <ErrorPanel title="Remboursement à contrôler" message={error} reveal /> : null}
      <FormActions onCancel={close} busy={busy} submitLabel={reverse ? 'Corriger la saisie' : 'Enregistrer le remboursement reçu'} />
    </form>
  </Modal>;
}

export function ExpenseRefundHistory({ expense, disabled, onReverse }: { expense: Expense; disabled: boolean; onReverse: (refund: ExpenseRefund) => void }) {
  const refunds = expense.refunds ?? [];
  if (!refunds.length) return null;
  return <section className="expense-refund-history" aria-label="Historique des remboursements"><h3>Remboursements et corrections</h3>{refunds.map((refund) => {
    const corrected = refunds.some((row) => row.reversesId === refund.id);
    return <article key={refund.id}><header><strong>{refund.eventType === 'reverse' ? 'Correction' : corrected ? 'Remboursement corrigé' : 'Remboursement reçu'} · {refund.reference}</strong><strong>{formatMoney(refund.totalCents)}</strong></header><p>Avoir : {formatDate(refund.creditDate)} · Banque : {formatDate(refund.paymentDate)}</p><p>{refund.reason}</p>{refund.eventType === 'refund' && !corrected ? <Button type="button" variant="secondary" size="small" disabled={disabled} onClick={() => onReverse(refund)}><RotateCcw size={14} /> Corriger une saisie erronée</Button> : null}</article>;
  })}</section>;
}
