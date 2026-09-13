import { t } from './language';
import { translations } from './translations';

/** Keep unknown native diagnostics in the details while the main message explains how to proceed. */
export function employeeSaveMessage(message: string): string {
  return translations[message.trim()] ? t(message) : t('L’enregistrement n’a pas abouti. Vos informations sont conservées dans ce formulaire. Réessayez ; si le problème persiste, consultez le message détaillé pour contacter le support.');
}

export function employeeDocumentErrorMessage(message: string): string {
  return translations[message.trim()] ? t(message) : t('Impossible de lire ce document. Les informations déjà saisies sont conservées. Essayez une image plus nette ou complétez le formulaire.');
}

/** Show understandable progress; worker filenames and token counters are not instructions to the user. */
export function employeeDocumentProgress(label: string): string {
  if (/télécharg|telecharg|download/i.test(label)) return t('Téléchargement de Qwen sur cet appareil…');
  if (/OCR|page|document|image/i.test(label)) return t('Lecture du document…');
  if (/ouverture|prépar|prepar|charg|load/i.test(label)) return t('Préparation de la lecture locale…');
  return t('Analyse des informations du collaborateur…');
}
