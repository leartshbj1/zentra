import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AutopilotQuoteAdjustment, AutopilotQuoteExtras } from './autopilotQuote';
import { useAppLanguage } from './language';

/**
 * Before "Créer le devis": a one-line question, a discount or a deposit?
 * "Non" creates the quote as before; "Oui" opens two small fields.
 */
const copy = {
  fr: { ask: 'Rabais ou acompte ?', no: 'Non', yes: 'Oui', discount: 'Rabais', deposit: 'Acompte', create: 'Créer le devis', cancel: 'Annuler',
    unit: 'Unité', invalid: 'Entre 0 et 100 %, ou un montant positif.', depositInvoice: 'Créer la facture d’acompte' },
  de: { ask: 'Rabatt oder Anzahlung?', no: 'Nein', yes: 'Ja', discount: 'Rabatt', deposit: 'Anzahlung', create: 'Offerte erstellen', cancel: 'Abbrechen',
    unit: 'Einheit', invalid: 'Zwischen 0 und 100 % oder ein positiver Betrag.', depositInvoice: 'Anzahlungsrechnung erstellen' },
  it: { ask: 'Sconto o acconto?', no: 'No', yes: 'Sì', discount: 'Sconto', deposit: 'Acconto', create: 'Crea il preventivo', cancel: 'Annulla',
    unit: 'Unità', invalid: 'Tra 0 e 100 %, o un importo positivo.', depositInvoice: 'Crea la fattura d’acconto' },
  en: { ask: 'Discount or deposit?', no: 'No', yes: 'Yes', discount: 'Discount', deposit: 'Deposit', create: 'Create the quote', cancel: 'Cancel',
    unit: 'Unit', invalid: 'Between 0 and 100 %, or a positive amount.', depositInvoice: 'Create the deposit invoice' },
};
export function autopilotQuoteExtrasCopy(language: string) { return copy[language as keyof typeof copy] ?? copy.fr; }

type Unit = AutopilotQuoteAdjustment['unit'];
/** "10", "12,5", "1'250.50" or "1 250" as a number; empty is "none". */
export function readAdjustment(text: string, unit: Unit): AutopilotQuoteAdjustment | null | undefined {
  const clean = text.replace(/[\s'’]/g, '').replace(',', '.');
  if (!clean) return undefined;
  const value = Number(clean);
  if (!/^\d+(\.\d{1,2})?$/.test(clean) || !Number.isFinite(value) || value <= 0) return null;
  const hundredths = Math.round(value * 100);
  if (unit === 'percent' && hundredths > 10_000) return null;
  return { unit, value: hundredths };
}

export function AutopilotQuoteAsk({ disabled, onNo, onYes }: { disabled: boolean; onNo: () => void; onYes: () => void }) {
  const say = autopilotQuoteExtrasCopy(useAppLanguage());
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  return <div className="quote-extras__ask" role="group" aria-label={say.ask}>
    <span>{say.ask}</span>
    <button ref={first} type="button" className="quote-extras__primary" data-primary disabled={disabled} onClick={onNo}>{say.no}</button>
    <button type="button" className="quote-extras__secondary" disabled={disabled} onClick={onYes}>{say.yes}</button>
  </div>;
}

function Field({ label, value, unit, currency, onValue, onUnit, invalid, autoFocus }: { label: string; value: string; unit: Unit; currency: string;
  onValue: (value: string) => void; onUnit: (unit: Unit) => void; invalid: boolean; autoFocus?: boolean }) {
  const say = autopilotQuoteExtrasCopy(useAppLanguage());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);
  return <div className="quote-extras__field">
    <label>
      <span>{label}</span>
      <input ref={input} inputMode="decimal" autoComplete="off" value={value} placeholder="0" aria-invalid={invalid || undefined}
        onChange={event => onValue(event.target.value)} />
    </label>
    <div className="quote-extras__units" role="group" aria-label={`${label} · ${say.unit}`}>
      {(['percent', 'amount'] as const).map(option => <button key={option} type="button" aria-pressed={unit === option}
        onClick={() => onUnit(option)}>{option === 'percent' ? '%' : currency}</button>)}
    </div>
  </div>;
}

export function AutopilotQuoteExtrasForm({ currency, disabled, onCreate, onCancel }: { currency: string; disabled: boolean;
  onCreate: (extras: AutopilotQuoteExtras) => void; onCancel: () => void }) {
  const say = autopilotQuoteExtrasCopy(useAppLanguage());
  const [discount, setDiscount] = useState({ text: '', unit: 'percent' as Unit });
  const [deposit, setDeposit] = useState({ text: '', unit: 'percent' as Unit });
  const readDiscount = readAdjustment(discount.text, discount.unit), readDeposit = readAdjustment(deposit.text, deposit.unit);
  const invalid = readDiscount === null || readDeposit === null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid || disabled) return;
    onCreate({ ...(readDiscount ? { discount: readDiscount } : {}), ...(readDeposit ? { deposit: readDeposit } : {}) });
  };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } };
  return <form className="quote-extras" onSubmit={submit} onKeyDown={escape}>
    <Field label={say.discount} value={discount.text} unit={discount.unit} currency={currency} invalid={readDiscount === null} autoFocus
      onValue={text => setDiscount(current => ({ ...current, text }))} onUnit={unit => setDiscount(current => ({ ...current, unit }))} />
    <Field label={say.deposit} value={deposit.text} unit={deposit.unit} currency={currency} invalid={readDeposit === null}
      onValue={text => setDeposit(current => ({ ...current, text }))} onUnit={unit => setDeposit(current => ({ ...current, unit }))} />
    {invalid && <p className="quote-extras__error" role="status">{say.invalid}</p>}
    <div className="quote-extras__actions">
      <button type="submit" className="quote-extras__primary" data-primary disabled={disabled || invalid}>{say.create}</button>
      <button type="button" className="quote-extras__secondary" onClick={onCancel}>{say.cancel}</button>
    </div>
  </form>;
}
