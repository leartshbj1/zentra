import { CircleDollarSign } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { Quote } from './types';
import { errorMessage, formatMoney } from './utils';
import {
  DEFAULT_QUOTE_DEPOSIT_PERCENTAGE,
  quoteConversionPreview,
  quoteConversionSelection,
} from './quoteConversion';
import { ErrorPanel, Field, FormActions, Modal, submitForm } from './ui';

export function QuoteConversionModal({
  quote,
  busy,
  close,
  onConvert,
}: {
  quote: Quote;
  busy: boolean;
  close: () => void;
  onConvert: (quote: Quote, depositPercentageBp: number | null, onError?: (reason: unknown) => void) => Promise<boolean>;
}) {
  const [depositEnabled, setDepositEnabled] = useState(false);
  const [percentage, setPercentage] = useState(DEFAULT_QUOTE_DEPOSIT_PERCENTAGE);
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const locked = busy || saving;
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
      dismissible={!locked}
    >
      <form
        onSubmit={submitForm(async () => {
          if (validationError || locked || inFlight.current) return;
          inFlight.current = true; setSaving(true); setError('');
          let reason: unknown;
          try { const converted = await onConvert(quote, selection.depositPercentageBp, value => { reason = value; }); if (!converted) setError(errorMessage(reason, 'Les factures n’ont pas pu être créées. Votre choix est conservé ; réessayez.')); }
          catch (value) { setError(errorMessage(value, 'Les factures n’ont pas pu être créées. Votre choix est conservé ; réessayez.')); }
          finally { inFlight.current = false; setSaving(false); }
        })}
      >
        {error && <ErrorPanel title="La création demande une vérification" message={error} reveal />}
        <div className="quote-conversion-intro">
          <span>Montant du devis</span>
          <strong>{formatMoney(preview.quoteTotalCents, quote.currency)}</strong>
        </div>

        <label className="module-toggle quote-conversion-toggle">
          <input
            type="checkbox"
            disabled={locked}
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
                  disabled={locked}
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
          busy={locked}
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
