import { useMemo, useState } from 'react';
import { cashBalance, localDate } from './cashBook';
import { t, useAppLanguage } from './language';
import { plusDays, saveStart, savedStart, treasuryForecast, type ForecastEvent } from './treasuryForecast';
import type { Workspace } from './types';
import { Button, Field } from './ui';
import { formatDate, formatMoney } from './utils';
import './erp-registers.css';

export const FORECAST_LABEL: Record<ForecastEvent['kind'], string> = {
  invoice: 'Facture {label}', overdue: 'Facture {label} en retard', supplier: 'Fournisseur {label}', expense: 'Dépense {label}',
  payroll: 'Salaires', recurring: 'Facture récurrente {label}', contract: 'Contrat {label}',
};

export function forecastLabel(event: ForecastEvent): string {
  return t(FORECAST_LABEL[event.kind], { label: event.label }).trim();
}

const centsFromText = (value: string) => {
  const match = /^\s*(-?\d{1,10})(?:[.,](\d{1,2}))?\s*$/.exec(value.replace(/['’\s]/g, ''));
  if (!match) return null;
  const cents = Math.abs(Number(match[1])) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return match[1].startsWith('-') ? -cents : cents;
};

/** Prévision de trésorerie : solde du compte + caisse, puis ce qui est déjà connu à 30, 60 et 90 jours. */
export function TreasuryPanel({ workspace, organizationId }: { workspace: Workspace; organizationId: string }) {
  useAppLanguage();
  const today = localDate(new Date());
  const saved = savedStart(organizationId);
  const [text, setText] = useState(saved ? (saved.cents / 100).toFixed(2) : '');
  const [start, setStart] = useState(saved);
  const [all, setAll] = useState(false);
  const cash = cashBalance(workspace, today);
  const forecast = useMemo(() => (start ? treasuryForecast(workspace, start.cents + cash, today) : null), [workspace, start, cash, today]);
  const shown = forecast ? forecast.events.filter((event) => all || event.date <= plusDays(today, 30)) : [];

  function save() {
    const cents = centsFromText(text);
    if (cents === null) return;
    saveStart(organizationId, cents, today);
    setStart({ cents, date: today });
  }

  return <section className="erp-register" aria-labelledby="treasury-title">
    <h2 id="treasury-title">{t('Trésorerie')}</h2>
    <p>{t('Ce qui entre et sort dans les 90 prochains jours, calculé d’après vos factures, salaires, factures récurrentes et contrats.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Indiquez le solde de votre compte bancaire aujourd’hui. Les espèces en caisse s’y ajoutent.')}</li>
        <li>{t('Les factures clients ouvertes entrent à leur échéance ; une facture en retard est comptée dans une semaine.')}</li>
        <li>{t('Les factures fournisseurs, dépenses à payer, salaires du dernier mois et contrats fournisseurs sortent à leur date.')}</li>
      </ol>
    </details>
    <div className="erp-register__form">
      <Field label={t('Solde du compte bancaire aujourd’hui (CHF)')} hint={saved && saved.date !== today ? t('Saisi le {date} : mettez-le à jour.', { date: formatDate(saved.date) }) : t('Espèces en caisse : {amount}', { amount: formatMoney(cash) })}>
        <input inputMode="decimal" placeholder="0.00" value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
      <div className="erp-register__actions"><Button variant="secondary" disabled={centsFromText(text) === null} onClick={save}>{t('Calculer')}</Button></div>
    </div>
    {forecast ? <>
      <dl className="erp-register__horizons">
        {([30, 60, 90] as const).map((days) => <div key={days}>
          <dt>{t('Dans {days} jours', { days })}</dt>
          <dd className={forecast.at[days] < 0 ? 'is-negative' : ''}>{formatMoney(forecast.at[days])}</dd>
        </div>)}
      </dl>
      <p>{forecast.low.cause
        ? t('Point le plus bas sur 30 jours : {amount} le {date} ({cause}).', { amount: formatMoney(forecast.low.cents), date: formatDate(forecast.low.date), cause: forecastLabel(forecast.low.cause) })
        : t('Aucun creux prévu sur 30 jours.')}</p>
      <h3>{all ? t('Les 90 prochains jours') : t('Les 30 prochains jours')}</h3>
      {shown.length ? <ul className="erp-register__list">
        {shown.map((event, index) => <li key={`${event.date}-${event.kind}-${index}`}>
          <span><strong>{forecastLabel(event)}</strong><small>{formatDate(event.date)}</small></span>
          <span className="erp-register__amount"><span className={event.amountCents < 0 ? 'is-negative' : ''}>{event.amountCents > 0 ? '+' : ''}{formatMoney(event.amountCents)}</span></span>
        </li>)}
      </ul> : <p>{t('Rien de prévu sur cette période.')}</p>}
      <div className="erp-register__actions"><Button variant="ghost" onClick={() => setAll(!all)}>{all ? t('Voir les 30 jours') : t('Voir les 90 jours')}</Button></div>
    </> : null}
  </section>;
}
