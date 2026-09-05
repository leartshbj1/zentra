import { CircleDollarSign } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Quote } from './types';
import { formatMoney } from './utils';
import {
  DEFAULT_QUOTE_DEPOSIT_PERCENTAGE,
  quoteConversionPreview,
  quoteConversionSelection,
} from './quoteConversion';
import { Field, FormActions, Modal, submitForm } from './ui';

export function QuoteConversionModal({
  quote,
  busy,
  close,
  onConvert,
}: {
  quote: Quote;
  busy: boolean;
  close: () => void;
  onConvert: (quote: Quote, depositPercentageBp: number | null) => Promise<boolean>;
}) {
  const [depositEnabled, setDepositEnabled] = useState(false);
  const [percentage, setPercentage] = useState(DEFAULT_QUOTE_DEPOSIT_PERCENTAGE);
  const selection = quoteConversionSelection(depositEnabled, percentage);
  const preview = useMemo(
    () =>
      quoteConversionPreview(
        quote.lines,
        depositEnabled ? selection.depositPercentageBp : null,
      ),
    [depositEnabled, quote.lines, selection.depositPercentageBp],
  );
  const amountError =
    depositEnabled &&
    !selection.error &&
    preview.invoiceTotalCents <= 0
      ? 'Ce pourcentage produit un acompte de 0 CHF. Choisissez un pourcentage plus élevé.'
      : null;
  const validationError = selection.error ?? amountError;

  return (
    <Modal
      title="Créer la facture"
      description={`Devis ${quote.number || quote.title} : une facture complète ou un dossier avec acompte et solde.`}
      onClose={close}
    >
      <form
        onSubmit={submitForm(async () => {
          if (validationError) return;
          await onConvert(quote, selection.depositPercentageBp);
        })}
      >
        <div className="quote-conversion-intro">
          <span>Montant du devis</span>
          <strong>{formatMoney(preview.quoteTotalCents, quote.currency)}</strong>
        </div>

        <label className="module-toggle quote-conversion-toggle">
          <input
            type="checkbox"
            checked={depositEnabled}
            onChange={(event) => {
              setDepositEnabled(event.target.checked);
            }}
          />
          <span>
            <CircleDollarSign size={20} />
            <strong>Créer une facture d’acompte</strong>
            <small>
              Crée deux factures liées : l’acompte et le solde après déduction.
            </small>
          </span>
        </label>

        {depositEnabled ? (
          <div className="quote-conversion-percentage">
            <Field
              label="Pourcentage de l’acompte"
              hint="De 0,01 à 100 %, avec deux décimales au maximum."
              error={selection.error ?? undefined}
              required
            >
              <span className="percent-input">
                <input
                  name="depositPercentage"
                  type="text"
                  inputMode="decimal"
                  value={percentage}
                  onChange={(event) => setPercentage(event.target.value)}
                  aria-invalid={Boolean(selection.error)}
                  aria-label="Pourcentage de l’acompte"
                  autoFocus
                  required
                />
                <span>%</span>
              </span>
            </Field>
          </div>
        ) : null}

        <div className="quote-conversion-summary" aria-live="polite">
          <div>
            <span>{depositEnabled ? 'Facture d’acompte' : 'Facture créée'}</span>
            <strong>
              {depositEnabled && selection.error
                ? '—'
                : formatMoney(preview.invoiceTotalCents, quote.currency)}
            </strong>
          </div>
          <div>
            <span>{depositEnabled ? 'Facture de solde' : 'Type'}</span>
            <strong>
              {depositEnabled
                ? selection.error
                  ? '—'
                  : formatMoney(preview.remainingCents, quote.currency)
                : 'Facture complète'}
            </strong>
          </div>
        </div>

        <p className="quote-conversion-note">
          {depositEnabled ? 'Les deux factures seront créées en brouillon dans le même dossier. Complétez leurs dates puis émettez l’acompte avant le solde. Les montants restent liés au devis.' : 'La facture sera créée en brouillon. Vérifiez ses dates, ses lignes et son montant avant de l’émettre.'}
        </p>
        {amountError ? (
          <p className="form-error" role="alert">
            {amountError}
          </p>
        ) : null}

        <FormActions
          onCancel={close}
          busy={busy}
          disabled={Boolean(validationError)}
          submitLabel={
            depositEnabled
              ? 'Créer les deux factures'
              : 'Créer la facture complète'
          }
        />
      </form>
    </Modal>
  );
}
