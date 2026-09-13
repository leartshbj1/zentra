import { t, getAppLanguage } from './language';
import type { OnboardingIssue } from './onboardingValidation';

/** Translate validation only at display time; routing and native error matching keep the source message. */
export function setupIssueText(issue: OnboardingIssue): string {
  const field = t(issue.label), source = issue.message;
  if (getAppLanguage() === 'fr') return source;
  if (source === `${issue.label} est obligatoire.`) return t('{field} : ce champ est obligatoire.', { field });
  if (source.startsWith(`${issue.label} `)) {
    const rest = source.slice(issue.label.length + 1);
    const max = /^doit contenir au maximum (\d+) caractères\.$/.exec(rest);
    if (max) return t('{field} : {max} caractères maximum.', { field, max:max[1] });
    if (rest === 'accepte uniquement lettres, chiffres et tirets, sur 12 caractères maximum.') return t('{field} : lettres, chiffres et tirets uniquement, 12 caractères maximum.', { field });
    if (rest === 'doit être un nombre entier supérieur à zéro.') return t('{field} : saisissez un nombre entier supérieur à zéro.', { field });
    if (rest === 'doit être compris entre 1 et 365 jours.') return t('{field} : choisissez entre 1 et 365 jours.', { field });
  }
  const iban = /^(\d+) caractères détectés : un IBAN CH ou LI doit en contenir exactement 21\.$/.exec(source);
  if (iban) return t('{count} caractères détectés : l’IBAN suisse ou liechtensteinois doit en contenir 21.', { count:iban[1] });
  return t(source);
}
