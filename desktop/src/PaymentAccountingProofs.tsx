import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { Payment, PeriodFilter } from './types';
import { Button } from './ui';
import { formatDate, formatMoney } from './utils';

export type AccountingEntryFocus = {
  entryId: string;
  entryNumber: string;
  entryDate: string;
  paymentId: string;
  accountingState: PaymentAccountingState;
  reversalDepth?: number;
};

export type PaymentAccountingState =
  | 'active'
  | 'reversed'
  | 'restored'
  | 'unknown';

export type PaymentAccountingProof = AccountingEntryFocus & {
  amountCents: number;
  invoiceId: string;
  label: string;
};

export type InvoicePaymentAccountingState = {
  proofs: PaymentAccountingProof[];
  unlinkedCount: number;
};

function nonBlank(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function validIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function paymentAccountingProof(
  payment: Payment,
): PaymentAccountingProof | null {
  const entryId = nonBlank(payment.journalEntryId);
  const entryNumber = nonBlank(payment.journalEntryNumber);
  const sourceEvent = nonBlank(payment.journalSourceEvent);
  if (
    !entryId ||
    !entryNumber ||
    sourceEvent !== `invoice:${payment.invoiceId}`
  )
    return null;

  const reversalDepth = payment.journalReversalDepth;
  const validDepth = Number.isInteger(reversalDepth) && reversalDepth! >= 0;
  const parityIsConsistent =
    validDepth &&
    payment.journalEntryIsActive === (reversalDepth! % 2 === 0);
  const accountingState: PaymentAccountingState = !parityIsConsistent
    || payment.journalEntrySemanticallyValid !== true
    ? 'unknown'
    : reversalDepth === 0
      ? 'active'
      : payment.journalEntryIsActive
        ? 'restored'
        : 'reversed';
  const label = accountingState === 'active'
    ? `Comptabilisé · ${entryNumber}`
    : accountingState === 'reversed'
      ? `Écriture extournée · ${entryNumber}`
      : accountingState === 'restored'
        ? `Effet rétabli après ${reversalDepth} extournes · ${entryNumber}`
        : `État comptable à contrôler · ${entryNumber}`;

  return {
    paymentId: payment.id,
    invoiceId: payment.invoiceId,
    amountCents: payment.amountCents,
    entryDate: payment.date.trim(),
    entryId,
    entryNumber,
    accountingState,
    reversalDepth: validDepth ? reversalDepth : undefined,
    label,
  };
}

export function invoicePaymentAccountingState(
  invoiceId: string,
  payments: Payment[],
): InvoicePaymentAccountingState {
  const invoicePayments = payments.filter(
    (payment) => payment.invoiceId === invoiceId,
  );
  const proofs = invoicePayments
    .map(paymentAccountingProof)
    .filter((proof): proof is PaymentAccountingProof => proof !== null);

  return {
    proofs,
    unlinkedCount: invoicePayments.length - proofs.length,
  };
}

export function accountingEntryFocusFilter(
  focus: AccountingEntryFocus,
): PeriodFilter {
  return focus.accountingState === 'active' && validIsoDay(focus.entryDate)
    ? { dateFrom: focus.entryDate, dateTo: focus.entryDate }
    : {};
}

export function PaymentAccountingProofs({
  invoiceId,
  payments,
  onOpenJournal,
}: {
  invoiceId: string;
  payments: Payment[];
  onOpenJournal: (focus: AccountingEntryFocus) => void;
}) {
  const state = invoicePaymentAccountingState(invoiceId, payments);
  if (!state.proofs.length && !state.unlinkedCount) return null;

  return (
    <div
      className="payment-accounting-proofs"
      aria-label="Preuves comptables des encaissements"
    >
      {state.proofs.map((proof) => (
        <Button
          key={proof.paymentId}
          type="button"
          variant="ghost"
          size="small"
          className={proof.accountingState === 'active' ? '' : `is-${proof.accountingState}`}
          title={proof.accountingState === 'active'
            ? `Paiement du ${formatDate(proof.entryDate)} · ${formatMoney(proof.amountCents)}`
            : `${proof.label} · paiement du ${formatDate(proof.entryDate)} · ${formatMoney(proof.amountCents)} · contrôle de la chaîne requis`}
          aria-label={`${proof.accountingState === 'active' ? 'Ouvrir l’écriture comptable' : 'Contrôler la chaîne comptable de'} ${proof.entryNumber} liée au paiement du ${formatDate(proof.entryDate)}`}
          onClick={() => onOpenJournal(proof)}
        >
          {proof.accountingState === 'active'
            ? <CheckCircle2 size={14} aria-hidden="true" />
            : <AlertTriangle size={14} aria-hidden="true" />}
          {proof.label}
        </Button>
      ))}
      {state.unlinkedCount ? (
        <small role="status">
          {state.unlinkedCount} encaissement
          {state.unlinkedCount > 1 ? 's' : ''} sans preuve comptable liée ·
          contrôle requis
        </small>
      ) : null}
    </div>
  );
}
