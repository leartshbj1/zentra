import { useEffect, useState } from 'react';
import { desktopApi } from './bridge';
import { formatRate, parseRate, suggestedRateDate, type ExchangeRatesState } from './currencies';
import { t, useAppLanguage } from './language';
import { Button, Field } from './ui';
import { errorMessage, formatDate, formatMoney, todayIso } from './utils';
import './erp-registers.css';

/** Cours de change : la contre-valeur CHF des écritures en EUR et la différence de change au paiement. */
export function CurrenciesPanel({ readOnly, onChanged }: { readOnly: boolean; onChanged?: () => void }) {
  useAppLanguage();
  const [state, setState] = useState<ExchangeRatesState | null>(null);
  const [rateDate, setRateDate] = useState('');
  const [rateText, setRateText] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const next = await desktopApi.listExchangeRates();
    setState(next);
    setRateDate(current => current || suggestedRateDate(next.pending, todayIso()));
  };
  useEffect(() => { void refresh().catch(() => undefined); }, []);
  const micro = parseRate(rateText);
  async function save() {
    if (!micro || !rateDate) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await desktopApi.saveExchangeRate('EUR', rateDate, micro);
      setMessage(result.converted
        ? t('Cours enregistré : {n} écriture(s) en EUR ont maintenant leur contre-valeur CHF.', { n: result.converted })
        : t('Cours enregistré.'));
      setRateText('');
      setRateDate('');
      await refresh();
      onChanged?.();
    } catch (reason) {
      setMessage(errorMessage(reason, t('Le cours n’a pas pu être enregistré.')));
    } finally {
      setBusy(false);
    }
  }
  async function remove(currency: string, date: string) {
    setBusy(true);
    setMessage('');
    try {
      await desktopApi.deleteExchangeRate(currency, date);
      await refresh();
    } catch (reason) {
      setMessage(errorMessage(reason, t('Le cours n’a pas pu être supprimé.')));
    } finally {
      setBusy(false);
    }
  }
  const pending = state?.pending ?? [];
  const realised = state?.realised[0];
  return <section className="erp-register" aria-labelledby="currencies-title">
    <h2 id="currencies-title">{t('Devises et cours de change')}</h2>
    <p>{t('Vos factures en EUR gardent leurs montants exacts. Saisissez le cours une fois par mois : Zentra calcule la contre-valeur CHF des écritures, puis la différence de change au paiement.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Prenez le cours mensuel publié par l’Administration fédérale des contributions (AFC), valable pour la TVA et la comptabilité.')}</li>
        <li>{t('Un cours vaut pour les {days} jours qui suivent sa date ; les écritures de cette période sont converties tout de suite.', { days: state?.validityDays ?? 31 })}</li>
        <li>{t('Au paiement, la créance est soldée au cours de la facture : l’écart avec le cours du jour est compté en gain (6950) ou en perte (6900) de change.')}</li>
      </ol>
    </details>
    {pending.length ? <div role="status">{pending.map(row => <p key={row.currency}>{t('{n} écriture(s) en {currency} attendent un cours, du {from} au {to}.', { n: row.entries, currency: row.currency, from: formatDate(row.firstDate), to: formatDate(row.lastDate) })}</p>)}</div>
      : state ? <p>{t('Toutes les écritures en devise ont leur contre-valeur CHF.')}</p> : null}
    <div className="erp-register__form">
      <Field label={t('Valable dès le')}><input type="date" value={rateDate} disabled={readOnly || busy} onChange={event => setRateDate(event.target.value)} /></Field>
      <Field label={t('CHF pour 1 EUR')}><input inputMode="decimal" placeholder="0.9412" value={rateText} disabled={readOnly || busy} aria-invalid={rateText !== '' && !micro} onChange={event => setRateText(event.target.value)} /></Field>
      <div className="erp-register__actions">
        <Button type="button" disabled={readOnly || busy || !micro || !rateDate} onClick={() => void save()}>{busy ? t('Enregistrement…') : t('Enregistrer le cours')}</Button>
        {message ? <p role="status">{message}</p> : null}
      </div>
    </div>
    {realised ? <p>{t('Différences de change {year} : gain {gain}, perte {loss}.', { year: realised.year, gain: formatMoney(realised.gainCents), loss: formatMoney(realised.lossCents) })}</p> : null}
    {state?.rates.length ? <ul className="erp-register__list" aria-label={t('Cours saisis')}>
      {state.rates.map(rate => <li key={rate.currency + rate.rateDate}>
        <span><strong>{t('1 {currency} = {rate} CHF', { currency: rate.currency, rate: formatRate(rate.chfPerUnitMicro) })}</strong><small>{rate.used ? t('Dès le {date} · appliqué à des écritures', { date: formatDate(rate.rateDate) }) : t('Dès le {date}', { date: formatDate(rate.rateDate) })}</small></span>
        {rate.used || readOnly ? <span /> : <Button type="button" variant="ghost" size="small" disabled={busy} onClick={() => void remove(rate.currency, rate.rateDate)}>{t('Supprimer')}</Button>}
      </li>)}
    </ul> : null}
  </section>;
}
