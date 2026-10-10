import type { SiteLanguage } from '../site-language';

const en = {
  download: 'Download', invoicePdf: 'Download PDF', estimatePdf: 'Download quote PDF',
  preparing: 'Preparing your file…', ready: 'File ready.', report: 'Report', format: 'Format',
  unavailable: 'The file could not be prepared. Try again.',
  changed: 'The figures have changed. Refresh the invoice or reports, then download again.',
  tooLarge: 'This export is too large. Choose a shorter report period.',
  glyph: 'Some characters cannot be printed with the document font. Review the text before downloading.',
  denied: 'Your access has changed. Sign in again.', timeout: 'Preparing the file took too long. Try again.',
  cashUnavailable: 'This report needs a cash-flow classification first.',
  identityCurrent: 'The PDF uses your current seller details and the customer details saved in this quote. Amounts are before sales tax.',
  sellerRequired: 'Complete your US seller profile before downloading the quote.',
  identityChanged: 'Your seller details or company settings changed. Download the quote again.',
  estimateChanged: 'The quote or financial figures changed. Refresh the saved quote, then download again.',
  ownerRequired: 'Open the saved quote in the financial workspace before downloading.',
  ownerChanged: 'Refresh the financial workspace. If an operation is pending, finish or resume it before downloading again.',
  estimateMissing: 'This saved quote is no longer available. Refresh the quote list before downloading.',
  estimateTooLarge: 'This quote exceeds the export limit. Contact support with its quote number.',
  inProgress: 'A file is already being prepared. Wait for it to finish.',
};
type Copy = { readonly [K in keyof typeof en]: string };
const fr: Copy = {
  download: 'Télécharger', invoicePdf: 'Télécharger le PDF', estimatePdf: 'Télécharger le devis PDF',
  preparing: 'Préparation du fichier…', ready: 'Fichier prêt.', report: 'Rapport', format: 'Format',
  unavailable: 'Le fichier n’a pas pu être préparé. Réessayez.',
  changed: 'Les montants ont changé. Actualisez la facture ou les rapports, puis téléchargez à nouveau.',
  tooLarge: 'Cet export est trop volumineux. Choisissez une période plus courte.',
  glyph: 'Certains caractères ne peuvent pas être imprimés avec la police du document. Vérifiez le texte avant de télécharger.',
  denied: 'Votre accès a changé. Reconnectez-vous.', timeout: 'La préparation du fichier a pris trop de temps. Réessayez.',
  cashUnavailable: 'Ce rapport nécessite d’abord une classification de trésorerie.',
  identityCurrent: 'Le PDF utilise vos coordonnées vendeur actuelles et celles du client enregistrées dans ce devis. Les montants sont avant sales tax.',
  sellerRequired: 'Complétez votre profil vendeur US avant de télécharger le devis.',
  identityChanged: 'Vos coordonnées vendeur ou les paramètres de l’entreprise ont changé. Téléchargez à nouveau le devis.',
  estimateChanged: 'Le devis ou les montants financiers ont changé. Actualisez le devis enregistré, puis téléchargez à nouveau.',
  ownerRequired: 'Ouvrez le devis enregistré dans l’espace financier avant de le télécharger.',
  ownerChanged: 'Actualisez l’espace financier. Si une opération est en attente, terminez-la ou reprenez-la avant de télécharger à nouveau.',
  estimateMissing: 'Ce devis enregistré n’est plus disponible. Actualisez la liste des devis avant de télécharger.',
  estimateTooLarge: 'Ce devis dépasse la limite d’export. Contactez l’assistance avec son numéro.',
  inProgress: 'Un fichier est déjà en préparation. Attendez la fin de cette préparation.',
};
const de: Copy = {
  download: 'Herunterladen', invoicePdf: 'PDF herunterladen', estimatePdf: 'Angebot als PDF herunterladen',
  preparing: 'Datei wird vorbereitet…', ready: 'Datei bereit.', report: 'Bericht', format: 'Format',
  unavailable: 'Die Datei konnte nicht erstellt werden. Versuchen Sie es erneut.',
  changed: 'Die Beträge haben sich geändert. Aktualisieren Sie Rechnung oder Berichte und laden Sie die Datei erneut herunter.',
  tooLarge: 'Dieser Export ist zu groß. Wählen Sie einen kürzeren Berichtszeitraum.',
  glyph: 'Einige Zeichen können mit der Dokumentenschrift nicht gedruckt werden. Prüfen Sie den Text vor dem Herunterladen.',
  denied: 'Ihr Zugriff hat sich geändert. Melden Sie sich erneut an.', timeout: 'Die Vorbereitung hat zu lange gedauert. Versuchen Sie es erneut.',
  cashUnavailable: 'Für diesen Bericht fehlt noch eine Geldflusskategorie.',
  identityCurrent: 'Das PDF verwendet Ihre aktuellen Verkäuferdaten und die im Angebot gespeicherten Kundendaten. Die Beträge verstehen sich vor Sales Tax.',
  sellerRequired: 'Vervollständigen Sie Ihr US-Verkäuferprofil, bevor Sie das Angebot herunterladen.',
  identityChanged: 'Ihre Verkäuferdaten oder Unternehmenseinstellungen haben sich geändert. Laden Sie das Angebot erneut herunter.',
  estimateChanged: 'Das Angebot oder die Finanzbeträge haben sich geändert. Aktualisieren Sie das gespeicherte Angebot und laden Sie es erneut herunter.',
  ownerRequired: 'Öffnen Sie das gespeicherte Angebot im Finanzbereich, bevor Sie es herunterladen.',
  ownerChanged: 'Aktualisieren Sie den Finanzbereich. Falls ein Vorgang aussteht, beenden Sie ihn oder setzen Sie ihn vor dem erneuten Download fort.',
  estimateMissing: 'Dieses gespeicherte Angebot ist nicht mehr verfügbar. Aktualisieren Sie die Angebotsliste vor dem Herunterladen.',
  estimateTooLarge: 'Dieses Angebot überschreitet die Exportgrenze. Kontaktieren Sie den Support mit der Angebotsnummer.',
  inProgress: 'Eine Datei wird bereits vorbereitet. Warten Sie, bis sie fertig ist.',
};
const it: Copy = {
  download: 'Scarica', invoicePdf: 'Scarica il PDF', estimatePdf: 'Scarica il preventivo PDF',
  preparing: 'Preparazione del file…', ready: 'File pronto.', report: 'Rapporto', format: 'Formato',
  unavailable: 'Non è stato possibile preparare il file. Riprova.',
  changed: 'Gli importi sono cambiati. Aggiorna la fattura o i rapporti, poi scarica nuovamente.',
  tooLarge: 'Questo export è troppo grande. Scegli un periodo più breve.',
  glyph: 'Alcuni caratteri non possono essere stampati con il font del documento. Verifica il testo prima di scaricare.',
  denied: 'Il tuo accesso è cambiato. Accedi di nuovo.', timeout: 'La preparazione ha richiesto troppo tempo. Riprova.',
  cashUnavailable: 'Questo rapporto richiede prima una categoria di flusso di cassa.',
  identityCurrent: 'Il PDF usa i dati attuali del venditore e quelli del cliente salvati nel preventivo. Gli importi sono prima della sales tax.',
  sellerRequired: 'Completa il profilo venditore US prima di scaricare il preventivo.',
  identityChanged: 'I dati del venditore o le impostazioni dell’azienda sono cambiati. Scarica nuovamente il preventivo.',
  estimateChanged: 'Il preventivo o gli importi finanziari sono cambiati. Aggiorna il preventivo salvato, poi scaricalo nuovamente.',
  ownerRequired: 'Apri il preventivo salvato nell’area finanziaria prima di scaricarlo.',
  ownerChanged: 'Aggiorna l’area finanziaria. Se un’operazione è in sospeso, completala o riprendila prima di scaricare nuovamente.',
  estimateMissing: 'Questo preventivo salvato non è più disponibile. Aggiorna l’elenco dei preventivi prima di scaricare.',
  estimateTooLarge: 'Questo preventivo supera il limite di esportazione. Contatta l’assistenza indicando il suo numero.',
  inProgress: 'Un file è già in preparazione. Attendi che sia pronto.',
};
export const browserUsFinancialPilotExportCopy: Readonly<Record<SiteLanguage, Copy>> = { en, fr, de, it };
const invoiceTooLarge: Readonly<Record<SiteLanguage, string>> = {
  en: 'This invoice exceeds the export limit. Contact support with its invoice number.',
  fr: 'Cette facture dépasse la limite d’export. Contactez l’assistance avec son numéro.',
  de: 'Diese Rechnung überschreitet die Exportgrenze. Kontaktieren Sie den Support mit der Rechnungsnummer.',
  it: 'Questa fattura supera il limite di esportazione. Contatta l’assistenza indicando il numero della fattura.',
};
export function browserUsFinancialPilotExportErrorCopy(language: SiteLanguage, code: string, documentKind: 'invoice' | 'estimate' | 'report' = 'report'): string {
  const c = browserUsFinancialPilotExportCopy[language];
  if (['financial_snapshot_changed', 'financial_source_changed', 'financial_configuration_changed'].includes(code)) return documentKind === 'estimate' ? c.estimateChanged : c.changed;
  if (['financial_pilot_export_too_large', 'export_too_large'].includes(code)) return documentKind === 'invoice' ? invoiceTooLarge[language] : documentKind === 'estimate' ? c.estimateTooLarge : c.tooLarge;
  if (code === 'financial_pilot_seller_required') return c.sellerRequired;
  if (code === 'financial_pilot_export_source_not_found' && documentKind === 'estimate') return c.estimateMissing;
  if (code === 'financial_pilot_quote_identity_changed') return c.identityChanged;
  if (code === 'financial_export_owner_required') return c.ownerRequired;
  if (code === 'financial_export_owner_changed') return c.ownerChanged;
  if (code === 'export_in_progress') return c.inProgress;
  if (code === 'unsupported_financial_pilot_export_glyph') return c.glyph;
  if (['unauthorized', 'session_changed'].includes(code)) return c.denied;
  if (['export_timeout', 'financial_export_timeout'].includes(code)) return c.timeout;
  if (code === 'financial_pilot_export_cash_flow_unavailable') return c.cashUnavailable;
  return c.unavailable;
}
