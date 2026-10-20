import { useEffect, useState } from 'react';
import { desktopApi } from './bridge';
import { t, useAppLanguage } from './language';
import { defaultChargeSettings, lateInterestCents, type ReminderChargeSettings } from './reminderCharges';
import { Button, Field } from './ui';
import { errorMessage, formatMoney } from './utils';
import './reminder-charges.css';

const centsFromText = (value: string) => {
  const match = /^\s*(\d{1,4})(?:[.,](\d{1,2}))?\s*$/.exec(value);
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
};
const textFromCents = (cents: number | undefined) => (cents ? (cents / 100).toFixed(2) : '');

/** Frais de rappel par niveau et intérêts moratoires, réclamés seulement s'ils sont activés. */
export function ReminderChargesSettings({ levels, disabled }: { levels: readonly { level: number; name: string }[]; disabled: boolean }) {
  useAppLanguage();
  const [settings, setSettings] = useState<ReminderChargeSettings>(defaultChargeSettings);
  const [fees, setFees] = useState<Record<number, string>>({});
  const [rate, setRate] = useState('5');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    desktopApi.getReminderChargeSettings().then((value) => {
      if (!live) return;
      setSettings(value);
      setRate(String(value.interestRateBp / 100).replace('.', ','));
      setFees(Object.fromEntries(Object.entries(value.fees).map(([level, cents]) => [Number(level), textFromCents(cents)])));
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const rateBp = Math.round(Number(rate.replace(',', '.')) * 100);
  const validRate = Number.isInteger(rateBp) && rateBp >= 0 && rateBp <= 2000;
  const example = validRate ? lateInterestCents(100_000, rateBp, 30) : 0;

  async function save() {
    const parsed: Record<number, number> = {};
    for (const { level } of levels) {
      const text = fees[level] ?? '';
      if (!text.trim()) continue;
      const cents = centsFromText(text);
      if (cents === null || cents > 100_000) { setMessage(t('Saisissez des frais entre 0 et 1000 francs.')); return; }
      parsed[level] = cents;
    }
    if (!validRate) { setMessage(t('Saisissez un taux entre 0 et 20 %.')); return; }
    setSaving(true); setMessage('');
    try {
      await desktopApi.saveReminderChargeSettings({ interestEnabled: settings.interestEnabled, interestRateBp: rateBp, fees: parsed });
      setMessage(t('Frais et intérêts enregistrés. Ils s’appliquent aux prochaines relances.'));
    } catch (reason) {
      setMessage(errorMessage(reason, t('Les frais n’ont pas pu être enregistrés.')));
    } finally { setSaving(false); }
  }

  return <section className="reminder-charges" aria-labelledby="reminder-charges-title">
    <h3 id="reminder-charges-title">{t('Frais et intérêts')}</h3>
    <p>{t('Les frais de rappel ne peuvent être réclamés que s’ils ont été convenus, par exemple dans vos conditions générales.')}</p>
    <div className="reminder-charges__fees">
      {levels.map(({ level, name }) => <Field key={level} label={name} hint={t('Niveau {level}', { level })}>
        <input inputMode="decimal" placeholder="0.00" value={fees[level] ?? ''} disabled={disabled || saving} onChange={(event) => setFees((current) => ({ ...current, [level]: event.target.value }))} />
      </Field>)}
    </div>
    <label className="reminder-charges__interest">
      <input type="checkbox" role="switch" aria-checked={settings.interestEnabled} checked={settings.interestEnabled} disabled={disabled || saving} onChange={(event) => setSettings((current) => ({ ...current, interestEnabled: event.target.checked }))} />
      <span><strong>{t('Intérêts moratoires')}</strong><small>{t('Dès le lendemain de l’échéance, au taux annuel ci-dessous (5 % selon l’art. 104 CO).')}</small></span>
    </label>
    {settings.interestEnabled && <Field label={t('Taux annuel (%)')} hint={validRate ? t('Exemple : sur {amount} en retard de 30 jours, {interest} d’intérêts.', { amount: formatMoney(100_000), interest: formatMoney(example) }) : undefined}>
      <input inputMode="decimal" value={rate} disabled={disabled || saving} onChange={(event) => setRate(event.target.value)} />
    </Field>}
    <div className="reminder-charges__actions">
      <Button type="button" variant="secondary" disabled={disabled || saving} onClick={() => void save()}>{saving ? t('Enregistrement…') : t('Enregistrer les frais et intérêts')}</Button>
      {message && <p role="status">{message}</p>}
    </div>
  </section>;
}
