import type { SiteLanguage } from '../site-language';

type Copy = Readonly<{
  title: string; notice: string; history: string; name: string; email: string; phone: string; optional: string;
  notProvided: string; current: string; revision: string; edit: string; cancel: string; review: string;
  before: string; after: string; approve: string; save: string; saving: string; loading: string; load: string;
  changed: string; unchanged: string; saved: string; readOnly: string; pending: string; retry: string;
  otherPending: string; resume: string; invalid: string; unavailable: string; writesDisabled: string; approvalRequired: string;
  limit: string; reloadWarning: string;
}>;
const en: Copy = {
  title: 'Seller presentation', notice: 'Change the commercial display name and contact details printed on documents. The legal entity, address and tax settings remain unchanged.',
  history: 'New quotes and invoice preparations use these details. Existing invoices and saved invoice preparations keep their original seller details.',
  name: 'Commercial display name', email: 'Contact email', phone: 'Contact phone', optional: 'Optional', notProvided: 'Not provided',
  current: 'Currently saved', revision: 'Seller revision', edit: 'Edit presentation', cancel: 'Cancel', review: 'Review changes', before: 'Currently saved', after: 'After this change',
  approve: 'I approve this commercial display name and these contact details.', save: 'Save presentation', saving: 'Saving…', loading: 'Loading seller details…', load: 'Read current details',
  changed: 'The workspace or seller has changed. Your entry is preserved. Read the current details before reviewing it again.', unchanged: 'There are no changes to save.', saved: 'Seller presentation saved.',
  readOnly: 'Seller details are available to view. Only the owner can edit them when changes are enabled.',
  pending: 'The result is still unconfirmed. Check this same approved request before making another change.', retry: 'Check this request',
  otherPending: 'Finish checking the pending request before opening or editing seller details.', resume: 'Resume seller presentation', invalid: 'Check the display name, email and phone. Remove leading or trailing spaces; leave a contact empty to remove it.',
  unavailable: 'Seller details are temporarily unavailable. Try again.', writesDisabled: 'New seller changes are disabled. A pending request can still be checked.',
  approvalRequired: 'Approve the reviewed changes before saving.', limit: 'The seller change limit has been reached. Contact support.',
  reloadWarning: 'Reloading removes the pending request and unsaved entries from this browser. It does not cancel a change already saved on the server. Check the current seller details before trying again.',
};
const fr: Copy = {
  title: 'Présentation du vendeur', notice: 'Modifiez le nom d’affichage commercial et les contacts imprimés sur les documents. L’entité légale, l’adresse et les paramètres fiscaux restent inchangés.',
  history: 'Les nouveaux devis et préparations de facture utilisent ces coordonnées. Les factures existantes et les préparations déjà enregistrées conservent leur vendeur d’origine.',
  name: 'Nom d’affichage commercial', email: 'Email de contact', phone: 'Téléphone de contact', optional: 'Facultatif', notProvided: 'Non renseigné',
  current: 'Actuellement enregistré', revision: 'Révision du vendeur', edit: 'Modifier la présentation', cancel: 'Annuler', review: 'Vérifier les changements', before: 'Actuellement enregistré', after: 'Après cette modification',
  approve: 'Je valide ce nom d’affichage commercial et ces coordonnées.', save: 'Enregistrer la présentation', saving: 'Enregistrement…', loading: 'Chargement du vendeur…', load: 'Lire les coordonnées actuelles',
  changed: 'L’espace ou le vendeur a changé. Votre saisie est conservée. Lisez les coordonnées actuelles avant de la vérifier à nouveau.', unchanged: 'Aucun changement à enregistrer.', saved: 'Présentation du vendeur enregistrée.',
  readOnly: 'Les coordonnées du vendeur sont consultables. Seul le propriétaire peut les modifier lorsque les changements sont activés.',
  pending: 'Le résultat reste à confirmer. Vérifiez cette même demande approuvée avant toute autre modification.', retry: 'Vérifier cette demande',
  otherPending: 'Terminez la vérification de la demande en attente avant d’ouvrir ou de modifier le vendeur.', resume: 'Reprendre la présentation', invalid: 'Vérifiez le nom d’affichage, l’email et le téléphone. Retirez les espaces au début ou à la fin ; laissez un contact vide pour le retirer.',
  unavailable: 'Les coordonnées du vendeur sont momentanément indisponibles. Réessayez.', writesDisabled: 'Les nouvelles modifications du vendeur sont désactivées. Une demande en attente reste vérifiable.',
  approvalRequired: 'Validez les changements vérifiés avant d’enregistrer.', limit: 'La limite de modifications du vendeur est atteinte. Contactez le support.',
  reloadWarning: 'Recharger retire de ce navigateur la demande en attente et les saisies non enregistrées. Cela n’annule aucune modification déjà enregistrée sur le serveur. Vérifiez les coordonnées actuelles du vendeur avant de réessayer.',
};
const de: Copy = {
  title: 'Verkäuferangaben', notice: 'Ändern Sie den geschäftlichen Anzeigenamen und die Kontaktdaten auf Dokumenten. Rechtliche Identität, Adresse und Steuereinstellungen bleiben unverändert.',
  history: 'Neue Angebote und Rechnungsvorbereitungen verwenden diese Angaben. Bestehende Rechnungen und bereits gespeicherte Rechnungsvorbereitungen behalten ihre ursprünglichen Verkäuferangaben.',
  name: 'Geschäftlicher Anzeigename', email: 'Kontakt-E-Mail', phone: 'Kontakttelefon', optional: 'Optional', notProvided: 'Nicht angegeben',
  current: 'Aktuell gespeichert', revision: 'Verkäuferversion', edit: 'Angaben bearbeiten', cancel: 'Abbrechen', review: 'Änderungen prüfen', before: 'Aktuell gespeichert', after: 'Nach dieser Änderung',
  approve: 'Ich bestätige diesen geschäftlichen Anzeigenamen und diese Kontaktdaten.', save: 'Angaben speichern', saving: 'Wird gespeichert…', loading: 'Verkäuferangaben werden geladen…', load: 'Aktuelle Angaben lesen',
  changed: 'Der Arbeitsbereich oder Verkäufer hat sich geändert. Ihre Eingaben bleiben erhalten. Lesen Sie die aktuellen Angaben, bevor Sie erneut prüfen.', unchanged: 'Es gibt keine Änderungen zu speichern.', saved: 'Verkäuferangaben gespeichert.',
  readOnly: 'Die Verkäuferangaben können gelesen werden. Nur der Inhaber kann sie bei aktivierter Bearbeitung ändern.',
  pending: 'Das Ergebnis ist noch unbestätigt. Prüfen Sie dieselbe bestätigte Anfrage, bevor Sie weitere Änderungen vornehmen.', retry: 'Diese Anfrage prüfen',
  otherPending: 'Prüfen Sie zunächst die ausstehende Anfrage, bevor Sie Verkäuferangaben öffnen oder bearbeiten.', resume: 'Verkäuferangaben fortsetzen', invalid: 'Prüfen Sie Anzeigename, E-Mail und Telefon. Entfernen Sie Leerzeichen am Anfang und Ende. Leere Kontaktfelder entfernen den jeweiligen Kontakt.',
  unavailable: 'Die Verkäuferangaben sind vorübergehend nicht verfügbar. Versuchen Sie es erneut.', writesDisabled: 'Neue Verkäuferänderungen sind deaktiviert. Eine ausstehende Anfrage kann weiterhin geprüft werden.',
  approvalRequired: 'Bestätigen Sie die geprüften Änderungen vor dem Speichern.', limit: 'Das Limit für Verkäuferänderungen ist erreicht. Wenden Sie sich an den Support.',
  reloadWarning: 'Beim Neuladen werden die ausstehende Anfrage und ungespeicherte Eingaben aus diesem Browser entfernt. Bereits gespeicherte Änderungen werden nicht rückgängig gemacht. Prüfen Sie die aktuellen Verkäuferangaben, bevor Sie es erneut versuchen.',
};
const it: Copy = {
  title: 'Presentazione del venditore', notice: 'Modifica il nome commerciale visualizzato e i contatti stampati sui documenti. L’entità legale, l’indirizzo e le impostazioni fiscali restano invariati.',
  history: 'Nuovi preventivi e preparazioni di fattura usano questi dati. Le fatture esistenti e le preparazioni già salvate conservano i dati originali del venditore.',
  name: 'Nome commerciale visualizzato', email: 'Email di contatto', phone: 'Telefono di contatto', optional: 'Facoltativo', notProvided: 'Non indicato',
  current: 'Attualmente salvato', revision: 'Revisione del venditore', edit: 'Modifica presentazione', cancel: 'Annulla', review: 'Verifica le modifiche', before: 'Attualmente salvato', after: 'Dopo questa modifica',
  approve: 'Confermo questo nome commerciale visualizzato e questi contatti.', save: 'Salva presentazione', saving: 'Salvataggio…', loading: 'Caricamento del venditore…', load: 'Leggi i dati attuali',
  changed: 'Lo spazio o il venditore è cambiato. I tuoi dati sono conservati. Leggi i dati attuali prima di verificarli di nuovo.', unchanged: 'Nessuna modifica da salvare.', saved: 'Presentazione del venditore salvata.',
  readOnly: 'I dati del venditore sono consultabili. Solo il proprietario può modificarli quando le modifiche sono abilitate.',
  pending: 'Il risultato deve ancora essere confermato. Verifica questa stessa richiesta approvata prima di apportare altre modifiche.', retry: 'Verifica questa richiesta',
  otherPending: 'Completa la verifica della richiesta in attesa prima di aprire o modificare i dati del venditore.', resume: 'Riprendi la presentazione', invalid: 'Verifica nome visualizzato, email e telefono. Rimuovi gli spazi iniziali o finali; lascia vuoto un contatto per rimuoverlo.',
  unavailable: 'I dati del venditore sono momentaneamente indisponibili. Riprova.', writesDisabled: 'Le nuove modifiche del venditore sono disabilitate. Una richiesta in attesa può ancora essere verificata.',
  approvalRequired: 'Conferma le modifiche verificate prima di salvare.', limit: 'È stato raggiunto il limite di modifiche del venditore. Contatta il supporto.',
  reloadWarning: 'Ricaricare rimuove da questo browser la richiesta in attesa e i dati non salvati. Non annulla le modifiche già salvate sul server. Verifica i dati attuali del venditore prima di riprovare.',
};
export const browserUsFinancialPilotSellerCopy: Readonly<Record<SiteLanguage, Copy>> = { en, fr, de, it };
export function browserUsFinancialPilotSellerErrorCopy(language: SiteLanguage, code: string): string {
  const c = browserUsFinancialPilotSellerCopy[language];
  if (['seller_read_required', 'seller_review_changed', 'seller_review_required', 'seller_revision_conflict', 'financial_snapshot_changed', 'financial_revision_conflict', 'revision_conflict', 'read_required'].includes(code)) return c.changed;
  if (['invalid_seller_input', 'invalid_financial_pilot_request', 'invalid_request'].includes(code)) return c.invalid;
  if (code === 'seller_approval_required' || code === 'approval_required') return c.approvalRequired;
  if (code === 'seller_writes_disabled') return c.writesDisabled;
  if (code === 'seller_limit_reached') return c.limit;
  if (code === 'seller_no_changes') return c.unchanged;
  return c.unavailable;
}
