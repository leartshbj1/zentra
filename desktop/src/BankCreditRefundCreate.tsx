import { useRef, useState } from 'react';
import { desktopApi } from './bridge';
import { RefundReceiptPicker } from './RefundAttachments';
import { supplierCreditAvailable } from './supplierCreditRefunds';
import type { BankMovement, Workspace } from './types';
import { ErrorPanel, Field, FormActions, Modal } from './ui';
import { createId, errorMessage, formatDate, formatMoney } from './utils';

export function BankCreditRefundCreate({
  movement,
  workspace,
  busy,
  readOnly,
  close,
  onSave,
}: {
  movement: BankMovement;
  workspace: Workspace;
  busy: boolean;
  readOnly: boolean;
  close: () => void;
  onSave: (
    input: Parameters<typeof desktopApi.createBankSupplierCreditRefund>[0],
  ) => Promise<void>;
}) {
  const [requestId] = useState(createId);
  const date = movement.bookingDate || movement.valueDate || '';
  const credits = workspace.supplierCreditNotes.filter(
    (credit) =>
      credit.status === 'validated' &&
      credit.currency === movement.currency &&
      credit.currency === 'CHF' &&
      credit.documentDate <= date &&
      supplierCreditAvailable(credit) >= movement.amountCents,
  );
  const [creditId, setCreditId] = useState(
    credits.length === 1 ? credits[0].id : '',
  );
  const [reference, setReference] = useState(movement.reference || '');
  const [reason, setReason] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const credit = credits.find((row) => row.id === creditId);
  const disabled = busy || readOnly || saving;
  const valid = Boolean(
    credit &&
    receipt &&
    reference.trim() &&
    reason.trim().length >= 5 &&
    movement.refundSuggestion?.canCreate &&
    movement.amountCents > 0,
  );
  return (
    <Modal
      title="Rembourser un avoir depuis le relevé"
      description={`${movement.counterpartyName || 'Virement fournisseur'} · ${formatMoney(movement.amountCents, movement.currency)} · ${formatDate(date)}`}
      onClose={close}
      dismissible={!busy && !saving}
    >
      <form
        className="bank-expense-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid || disabled || inFlight.current || !receipt) return;
          inFlight.current = true;
          setSaving(true);
          setError('');
          try {
            await onSave({
              requestId,
              movementId: movement.id,
              supplierCreditNoteId: creditId,
              reference,
              reason,
              receipt,
            });
          } catch (cause) {
            setError(
              errorMessage(
                cause,
                'Le remboursement n’a pas pu être enregistré.',
              ),
            );
          } finally {
            inFlight.current = false;
            setSaving(false);
          }
        }}
      >
        <p>
          Le montant et la date reprennent le virement du relevé. Choisissez
          l’avoir concerné et joignez son justificatif.
        </p>
        <Field label="Avoir à rembourser" required>
          <select
            value={creditId}
            onChange={(event) => setCreditId(event.target.value)}
            disabled={disabled}
            required
          >
            <option value="">Choisir un avoir…</option>
            {credits.map((row) => (
              <option key={row.id} value={row.id}>
                {row.number || row.reference} · {row.supplierName} · disponible{' '}
                {formatMoney(supplierCreditAvailable(row))}
              </option>
            ))}
          </select>
        </Field>
        {!credits.length ? (
          <p role="status">
            Aucun avoir validé ne dispose du montant nécessaire dans cette
            devise à la date du virement.
          </p>
        ) : null}
        <Field label="Référence du remboursement" required>
          <input
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            maxLength={255}
            disabled={disabled}
            required
          />
        </Field>
        <Field label="Motif" required>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={5}
            maxLength={1000}
            disabled={disabled}
            required
          />
        </Field>
        <RefundReceiptPicker
          supplierCredit
          receipt={receipt}
          onChange={setReceipt}
          disabled={disabled}
          onError={setError}
        />
        {credit ? (
          <div className="correction-preview">
            <strong>
              Disponible après remboursement :{' '}
              {formatMoney(
                supplierCreditAvailable(credit) - movement.amountCents,
              )}
            </strong>
            <small>
              Le remboursement, son justificatif et le rapprochement seront
              enregistrés ensemble.
            </small>
          </div>
        ) : null}
        {error ? <ErrorPanel message={error} reveal /> : null}
        <FormActions
          onCancel={close}
          busy={busy || saving}
          disabled={readOnly || !valid}
          submitLabel="Créer et rapprocher le remboursement"
        />
      </form>
    </Modal>
  );
}
