import { t, useAppLanguage } from './language';
import { useState } from 'react';
import { Button, Field } from './ui';
import { formatMoney } from './utils';
import { hourlySalaryCents, payrollDecimal } from './payrollSalaryEntry';

export function PayrollHourlySalary({ busy, onApply, onPendingChange }: {
  busy: boolean;
  onApply: (amountCents: number, label: string) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  useAppLanguage();
  const [hours, setHours] = useState('');
  const [rate, setRate] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [applied, setApplied] = useState(false);
  const result = hourlySalaryCents(hours, rate);
  return <details className="payroll-details payroll-hourly" open>
    <summary>{t("Calculer le salaire avec les heures travaillées")}</summary>
    <p>{t("Recopiez les heures du mois et le tarif brut du contrat. Le coût horaire utilisé pour vos projets n’est pas le salaire horaire.")}</p>
    <div className="payroll-hourly__fields">
      <Field label={t("Heures à payer ce mois")} error={attempted && !payrollDecimal(hours) ? t('Indiquez les heures à payer, par exemple 160 ou 152,50.') : undefined}>
        <input aria-label={t("Heures à payer ce mois")} type="text" inputMode="decimal" value={hours} disabled={busy}
          onChange={e => { setHours(e.target.value); setApplied(false); onPendingChange(Boolean(e.target.value.trim() || rate.trim())); }} placeholder={t("Ex. 160")} />
      </Field>
      <Field label={t("Tarif brut par heure (CHF)")} error={attempted && !payrollDecimal(rate) ? t('Recopiez le tarif brut, par exemple 30,50 CHF.') : undefined}>
        <input aria-label={t("Tarif brut par heure (CHF)")} type="text" inputMode="decimal" value={rate} disabled={busy}
          onChange={e => { setRate(e.target.value); setApplied(false); onPendingChange(Boolean(e.target.value.trim() || hours.trim())); }} placeholder={t("Ex. 30,50")} />
      </Field>
    </div>
    <p className="payroll-hourly__result" aria-live="polite">
      {result !== undefined ? <>{t("Salaire pour ces heures : ")}<strong>{formatMoney(result)}</strong></> : t("Le total apparaîtra quand les deux montants seront renseignés.")}
    </p>
    {attempted && result === undefined && payrollDecimal(hours) && payrollDecimal(rate) ? <p role="alert">{t("Le total doit être supérieur à zéro et rester calculable. Vérifiez les heures et le tarif saisis.")}</p> : null}
    <Button type="button" variant="secondary" disabled={busy} onClick={() => {
      setAttempted(true);
      if (result === undefined) return;
      onApply(result, `Salaire horaire · ${hours.trim()} h × ${rate.trim()} CHF`);
      onPendingChange(false);
      setApplied(true);
    }}>{t("Utiliser ce montant")}</Button>
    <p role="status">{applied ? t("Montant repris dans le salaire brut ci-dessous. Vous pouvez continuer.") : t("Les éventuels compléments, comme les vacances, restent à ajouter séparément selon votre contrat.")}</p>
  </details>;
}
