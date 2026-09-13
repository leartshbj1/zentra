import { getAppLanguage, t, type AppLanguage } from './language';
import { translations } from './translations';
import type { PurchaseIssue } from './supplierInvoicePreparation';

export function purchaseIssueText(issue: PurchaseIssue, language: AppLanguage = getAppLanguage()): string {
  const message = t(issue.message, undefined, language);
  return issue.line ? t('Ligne {number} : {message}', { number: issue.line, message }, language) : message;
}

/** Translate known guidance; retain the original native response separately for troubleshooting. */
export function purchaseNativeMessage(source: string, fallback: string, language: AppLanguage = getAppLanguage()): string {
  if (language === 'fr') return source;
  if (Object.hasOwn(translations, source.trim())) return t(source, undefined, language);
  let guidance = fallback;
  if (/période.{0,40}(fermée|clôturée)|exercice.{0,40}(fermé|clôturé)/iu.test(source)) guidance = 'La date de cette facture appartient à une période comptable fermée. Vérifiez la date ou consultez Comptabilité → Exercices avant de réessayer.';
  else if (/fournisseur.{0,40}archivé/iu.test(source)) guidance = 'Ce fournisseur est archivé. Choisissez un fournisseur actif ou réactivez sa fiche dans les achats.';
  else if (/compte.{0,20}charge/iu.test(source)) guidance = 'Vérifiez le compte de charges dans Comptabilité → Plan & liaisons, puis reprenez cette facture. Votre saisie est conservée.';
  else if (/justificatif.{0,30}(introuvable|absent)|fichier.{0,30}(introuvable|absent)/iu.test(source)) guidance = 'Le fichier n’est plus disponible à cet emplacement. Choisissez à nouveau le PDF ou la photo.';
  return t(guidance, undefined, language);
}
