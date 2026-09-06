import { useState } from 'react';
import type { SupplierCreditNote, SupplierCreditRefund } from './types';
import { Button, ErrorPanel, Field, Modal } from './ui';
import { formatMoney, todayIso } from './utils';
import { supplierCreditAvailable, supplierRefundAmount, supplierRefundDateError } from './supplierCreditRefunds';

export function SupplierCreditRefundModal({ credit, reverse, busy, readOnly = false, actionError, onClose, onConfirm }: {
  credit: SupplierCreditNote; reverse?: SupplierCreditRefund; busy: boolean; actionError: string;
  readOnly?: boolean;
  onClose: () => void;
  onConfirm: (input: {date: string; amountCents: number; reference: string; reason: string}) => void;
}) {
  const available = supplierCreditAvailable(credit);
  const [amount, setAmount] = useState(((reverse?.amountCents ?? available) / 100).toFixed(2));
  const [date, setDate] = useState(todayIso);
  const [reference, setReference] = useState(reverse?.reference || '');
  const [reason, setReason] = useState('');
  const amountCents = reverse?.amountCents ?? supplierRefundAmount(amount);
  const minimum = [credit.documentDate, reverse?.date || ''].sort().at(-1)!;
  const error = !amountCents ? 'Saisissez un montant positif avec au maximum deux décimales.'
    : !reverse && amountCents > available ? 'Le montant dépasse le solde de l’avoir après compensations et remboursements.'
    : supplierRefundDateError(date, minimum, todayIso());
  const valid = !error && reference.trim().length > 0 && reason.trim().length >= 5;
  return <Modal title={reverse ? 'Corriger le remboursement fournisseur' : 'Remboursement reçu du fournisseur'} description={`${credit.supplierName} · ${credit.number || credit.reference}`} onClose={busy ? () => {} : onClose}>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy && !readOnly && valid && amountCents) onConfirm({date, amountCents, reference, reason}); }}>
      <p>{reverse ? 'La correction conserve le remboursement initial dans l’historique et rétablit son montant disponible sur l’avoir.' : 'Enregistrez le virement effectivement reçu. Le montant réduit le solde disponible de cet avoir.'}</p>
      <fieldset className="form-grid" disabled={busy || readOnly} style={{border: 0, padding: 0, margin: 0, minWidth: 0}}>
        <Field label="Montant reçu (CHF)" required><input inputMode="decimal" required value={amount} readOnly={Boolean(reverse)} onChange={(event) => setAmount(event.target.value)} /></Field>
        <Field label={reverse ? 'Date de correction' : 'Date de réception'} required><input type="date" required min={minimum} max={todayIso()} value={date} onChange={(event) => setDate(event.target.value)} /></Field>
        <Field label="Référence bancaire" required><input required maxLength={255} value={reference} readOnly={Boolean(reverse)} onChange={(event) => setReference(event.target.value)} /></Field>
        <Field label="Motif" required><textarea required minLength={5} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      </fieldset>
      {error ? <ErrorPanel message={error} /> : <div className="correction-preview"><strong>Disponible après {reverse ? 'correction' : 'remboursement'} : {formatMoney(available + (reverse ? amountCents! : -amountCents!), credit.currency)}</strong><small>Les compensations déjà enregistrées sont prises en compte.</small></div>}
      {actionError ? <ErrorPanel message={actionError} reveal /> : null}
      <div className="form-actions"><Button variant="secondary" disabled={busy} onClick={onClose}>Annuler</Button><Button type="submit" disabled={busy || readOnly || !valid}>{reverse ? 'Confirmer la correction' : 'Enregistrer le remboursement'}</Button></div>
    </form>
  </Modal>;
}
