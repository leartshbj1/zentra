import { t, type AppLanguage } from './language';

/** A snapshot is kept with the diagnostic so changing language never changes validation. */
export type PayrollFieldValidation = {
  type: string; name: string; value: string; min: string; max: string;
  required: boolean; select: boolean;
  typeMismatch: boolean; valueMissing: boolean; rangeUnderflow: boolean;
  rangeOverflow: boolean; stepMismatch: boolean;
};

/** Some webviews render date inputs as text. Match the native ISO-date contract there too. */
export function payrollDateValidity(value: string, min: string, max: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : null;
  const real = parsed !== null && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  return {
    typeMismatch: Boolean(value) && !real,
    rangeUnderflow: real && Boolean(min) && value < min,
    rangeOverflow: real && Boolean(max) && value > max,
  };
}

export function payrollFieldMessage(field: PayrollFieldValidation, language: AppLanguage): string {
  const text = (source: string, values?: Record<string, string>) => t(source, values, language);
  if (field.type === 'date' && field.typeMismatch)
    return text('Indiquez une date réelle au format AAAA-MM-JJ, par exemple 2026-09-30. Recopiez la date de votre document.');
  if (field.type === 'email' && field.typeMismatch)
    return text(field.required
      ? 'Indiquez une adresse e-mail complète, par exemple nom@exemple.ch.'
      : 'Indiquez une adresse e-mail complète, par exemple nom@exemple.ch. Vous pouvez aussi laisser ce champ facultatif vide.');
  if (field.type === 'date' && (field.rangeUnderflow || field.rangeOverflow)) {
    const date = (value: string) => value.split('-').reverse().join('.');
    const range = field.min && field.max
      ? 'La date saisie est le {value}. Choisissez une date à partir du {min} et au plus tard le {max}.'
      : field.min ? 'La date saisie est le {value}. Choisissez une date à partir du {min}.'
      : 'La date saisie est le {value}. Choisissez une date au plus tard le {max}.';
    return text(range, { value: date(field.value), min: date(field.min), max: date(field.max) }) + ' ' + text(field.name === 'decisionDate'
      ? 'Recopiez le jour où le choix de cotisation a été confirmé sur votre déclaration ou confirmation écrite pour cette année.'
      : 'Recopiez la date indiquée sur votre document.');
  }
  if (field.valueMissing) return text(field.select
    ? 'Choisissez une réponse dans la liste pour continuer.'
    : 'Complétez ce champ pour continuer. Les autres informations restent conservées.');
  if (field.rangeUnderflow || field.rangeOverflow) {
    const range = field.min && field.max
      ? 'La valeur doit respecter le minimum {min} et le maximum {max}. Vérifiez votre document avant de la corriger.'
      : field.min ? 'La valeur doit respecter le minimum {min}. Vérifiez votre document avant de la corriger.'
      : 'La valeur doit respecter le maximum {max}. Vérifiez votre document avant de la corriger.';
    return text(range, { min: field.min, max: field.max });
  }
  return text(field.stepMismatch
    ? 'Indiquez le montant ou la valeur avec la précision demandée sous ce champ. Ne changez pas un taux de contrat pour le faire accepter.'
    : 'Vérifiez le format de cette information. Pour une date, utilisez le calendrier ; pour un montant, saisissez uniquement un nombre.');
}
