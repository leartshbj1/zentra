import type { SiteLanguage } from '../site-language';
const en={download:'Download',invoicePdf:'Download PDF',preparing:'Preparing your file…',ready:'File ready.',report:'Report',format:'Format',unavailable:'The file could not be prepared. Try again.',changed:'The figures have changed. Refresh the invoice or reports, then download again.',tooLarge:'This export is too large. Choose a shorter report period.',glyph:'Some characters cannot be printed with the document font. Review the text before downloading.',denied:'Your access has changed. Sign in again.',timeout:'Preparing the file took too long. Try again.',cashUnavailable:'This report needs a cash-flow classification first.'};
type Copy={readonly[K in keyof typeof en]:string};
const fr:Copy={download:'Télécharger',invoicePdf:'Télécharger le PDF',preparing:'Préparation du fichier…',ready:'Fichier prêt.',report:'Rapport',format:'Format',unavailable:'Le fichier n’a pas pu être préparé. Réessayez.',changed:'Les montants ont changé. Actualisez la facture ou les rapports, puis téléchargez à nouveau.',tooLarge:'Cet export est trop volumineux. Choisissez une période plus courte.',glyph:'Certains caractères ne peuvent pas être imprimés avec la police du document. Vérifiez le texte avant de télécharger.',denied:'Votre accès a changé. Reconnectez-vous.',timeout:'La préparation du fichier a pris trop de temps. Réessayez.',cashUnavailable:'Ce rapport nécessite d’abord une classification de trésorerie.'};
const de:Copy={download:'Herunterladen',invoicePdf:'PDF herunterladen',preparing:'Datei wird vorbereitet…',ready:'Datei bereit.',report:'Bericht',format:'Format',unavailable:'Die Datei konnte nicht erstellt werden. Versuchen Sie es erneut.',changed:'Die Beträge haben sich geändert. Aktualisieren Sie Rechnung oder Berichte und laden Sie die Datei erneut herunter.',tooLarge:'Dieser Export ist zu groß. Wählen Sie einen kürzeren Berichtszeitraum.',glyph:'Einige Zeichen können mit der Dokumentenschrift nicht gedruckt werden. Prüfen Sie den Text vor dem Herunterladen.',denied:'Ihr Zugriff hat sich geändert. Melden Sie sich erneut an.',timeout:'Die Vorbereitung hat zu lange gedauert. Versuchen Sie es erneut.',cashUnavailable:'Für diesen Bericht fehlt noch eine Geldflusskategorie.'};
const it:Copy={download:'Scarica',invoicePdf:'Scarica il PDF',preparing:'Preparazione del file…',ready:'File pronto.',report:'Rapporto',format:'Formato',unavailable:'Non è stato possibile preparare il file. Riprova.',changed:'Gli importi sono cambiati. Aggiorna la fattura o i rapporti, poi scarica nuovamente.',tooLarge:'Questo export è troppo grande. Scegli un periodo più breve.',glyph:'Alcuni caratteri non possono essere stampati con il font del documento. Verifica il testo prima di scaricare.',denied:'Il tuo accesso è cambiato. Accedi di nuovo.',timeout:'La preparazione ha richiesto troppo tempo. Riprova.',cashUnavailable:'Questo rapporto richiede prima una categoria di flusso di cassa.'};
export const browserUsFinancialPilotExportCopy:Readonly<Record<SiteLanguage,Copy>>={en,fr,de,it};
const invoiceTooLarge:Readonly<Record<SiteLanguage,string>>={
  en:'This invoice exceeds the export limit. Contact support with its invoice number.',
  fr:'Cette facture dépasse la limite d’export. Contactez l’assistance avec son numéro.',
  de:'Diese Rechnung überschreitet die Exportgrenze. Kontaktieren Sie den Support mit der Rechnungsnummer.',
  it:'Questa fattura supera il limite di esportazione. Contatta l’assistenza indicando il numero della fattura.',
};
export function browserUsFinancialPilotExportErrorCopy(language:SiteLanguage,code:string,documentKind:'invoice'|'report'='report'):string{
  const c=browserUsFinancialPilotExportCopy[language];
  if(['financial_snapshot_changed','financial_source_changed','financial_configuration_changed'].includes(code))return c.changed;
  if(['financial_pilot_export_too_large','export_too_large'].includes(code))return documentKind==='invoice'?invoiceTooLarge[language]:c.tooLarge;
  if(code==='unsupported_financial_pilot_export_glyph')return c.glyph;
  if(['unauthorized','session_changed'].includes(code))return c.denied;
  if(['export_timeout','financial_export_timeout'].includes(code))return c.timeout;
  if(code==='financial_pilot_export_cash_flow_unavailable')return c.cashUnavailable;
  return c.unavailable;
}
