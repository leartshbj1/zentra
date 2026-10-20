import { useState } from 'react';
import './erp-registers.css';
import { desktopApi } from './bridge';
import { t, useAppLanguage } from './language';
import { Button } from './ui';
import { errorMessage, formatDate, formatMoney } from './utils';

/** Début du libellé de la retenue : la ligne recalculée remplace l'ancienne. */
export const SOURCE_TAX_PREFIX = 'Impôt à la source';
const KEY = 'zentra.payroll.source-tax.v1';

function remembered(employeeId: string): { canton: string; code: string } {
  try {
    return (JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, { canton: string; code: string }>)[employeeId] ?? { canton: '', code: '' };
  } catch {
    return { canton: '', code: '' };
  }
}

function remember(employeeId: string, value: { canton: string; code: string }) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, unknown>;
    all[employeeId] = value;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* saisi à nouveau la prochaine fois */ }
}

/** Calcule la retenue d'impôt à la source d'après le barème ESTV importé ; la ligne reste modifiable. */
export function SourceTaxHelper({ employeeId, period, incomeCents, onApply }: { employeeId: string; period: string; incomeCents: number; onApply: (label: string, amountCents: number) => void }) {
  useAppLanguage();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => remembered(employeeId));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const date = /^\d{4}-\d{2}$/.test(period) ? `${period}-01` : new Date().toISOString().slice(0, 10);
  async function compute() {
    setBusy(true);
    setMessage('');
    try {
      const result = await desktopApi.sourceTaxLookup(value.canton, value.code, incomeCents, date);
      remember(employeeId, value);
      const rate = (result.rateBp / 100).toFixed(2);
      onApply(`${SOURCE_TAX_PREFIX} ${result.canton} ${result.code} · ${rate} % · barème ESTV du ${result.validFrom}`, result.taxCents);
      setMessage(t('{amount} au taux de {rate} % (barème du {date}). Vérifiez la ligne avant de valider.', { amount: formatMoney(result.taxCents), rate, date: formatDate(result.validFrom) }));
    } catch (reason) {
      setMessage(errorMessage(reason, t('Le barème n’a pas pu être lu.')));
    } finally {
      setBusy(false);
    }
  }
  if (!open) return <div className="source-tax-helper"><Button type="button" variant="ghost" size="small" disabled={!employeeId} onClick={() => setOpen(true)}>{t('Calculer l’impôt à la source (barème ESTV)')}</Button></div>;
  return <div className="source-tax-helper source-tax-helper--open">
    <label><span>{t('Canton')}</span><input value={value.canton} maxLength={2} placeholder="GE" onChange={(event) => setValue({ ...value, canton: event.target.value.toUpperCase() })} /></label>
    <label><span>{t('Code tarifaire')}</span><input value={value.code} maxLength={10} placeholder="A0N" onChange={(event) => setValue({ ...value, code: event.target.value.toUpperCase() })} /></label>
    <Button type="button" variant="secondary" size="small" disabled={busy || value.canton.length !== 2 || !value.code || incomeCents <= 0} onClick={() => void compute()}>{busy ? t('Calcul…') : t('Calculer sur {amount}', { amount: formatMoney(incomeCents) })}</Button>
    {message ? <p role="status">{message}</p> : null}
  </div>;
}
