import type { AppLanguage } from './language';

type Localized = Readonly<Record<AppLanguage, string>>;
const copy = (fr: string, de: string, it: string, en: string): Localized => ({ fr, de, it, en });
export const releaseHistoryCopy = {
  title: copy('Les nouveautés de Zentra', 'Neues in Zentra', 'Le novità di Zentra', 'What’s new in Zentra'),
  current: copy('Voir les nouveautés de cette version', 'Neuerungen dieser Version ansehen', 'Vedi le novità di questa versione', 'See what’s new in this version'),
  older: copy('Voir les mises à jour précédentes', 'Frühere Updates ansehen', 'Vedi gli aggiornamenti precedenti', 'See previous updates'),
  installed: copy('Version installée', 'Installierte Version', 'Versione installata', 'Installed version'),
  unknown: copy('Les notes de cette version ne sont pas encore disponibles dans l’application.', 'Die Hinweise zu dieser Version sind in der App noch nicht verfügbar.', 'Le note di questa versione non sono ancora disponibili nell’app.', 'Notes for this version are not yet available in the app.'),
  loading: copy('Lecture de la version installée…', 'Installierte Version wird gelesen…', 'Lettura della versione installata…', 'Reading the installed version…'),
  archive: copy('Cet historique présente les versions documentées dans cette édition. Il reste consultable sans connexion.', 'Dieser Verlauf zeigt die in dieser Ausgabe dokumentierten Versionen. Er ist auch offline verfügbar.', 'Questa cronologia mostra le versioni documentate in questa edizione. È consultabile anche senza connessione.', 'This history lists the versions documented in this edition. It is also available offline.'),
  empty: copy('Aucune version précédente documentée pour cette installation.', 'Für diese Installation ist keine frühere Version dokumentiert.', 'Nessuna versione precedente documentata per questa installazione.', 'No earlier version is documented for this installation.'),
};

// Append a version with every shipped correction; never rewrite an older entry
// to describe work that was added later. See docs/RELEASE-*.md for release evidence.
export const releaseHistory = [
  { version: '1.63.0', title: copy('Navigation Apple et suivi des améliorations', 'Apple-Navigation und Neuerungen', 'Navigazione Apple e novità', 'Apple navigation and update history'), changes: [
    copy('iPhone et Mac : les commandes Apple gardent leur connexion lors des changements d’écran et après la fermeture d’une fenêtre.', 'iPhone und Mac: Apple-Steuerelemente behalten ihre Verbindung beim Bildschirmwechsel und nach dem Schliessen eines Dialogs.', 'iPhone e Mac: i controlli Apple mantengono la connessione durante i cambi di schermata e dopo la chiusura di una finestra.', 'iPhone and Mac: Apple controls stay connected across screen changes and after closing a dialog.'),
    copy('Paramètres : consultez les nouveautés de la version installée et les mises à jour précédentes, même hors ligne.', 'Einstellungen: Neuerungen der installierten Version und frühere Updates sind auch offline einsehbar.', 'Impostazioni: consulta le novità della versione installata e gli aggiornamenti precedenti, anche offline.', 'Settings: view changes in the installed version and previous updates, even offline.'),
    copy('Achats : préparation, vérification et paiement des factures fournisseurs guidés, avec reprise après une interruption et explication du solde.', 'Einkäufe: geführte Erfassung, Prüfung und Zahlung von Lieferantenrechnungen, mit Wiederaufnahme nach Unterbrechungen und Erklärung des Restbetrags.', 'Acquisti: preparazione, verifica e pagamento guidati delle fatture fornitori, con ripresa dopo un’interruzione e spiegazione del saldo.', 'Purchases: guided supplier invoice preparation, review and payment, with recovery after interruptions and a clear balance breakdown.'),
  ] },
  { version: '1.62.1', title: copy('Activation de l’édition iPhone personnelle', 'Aktivierung der persönlichen iPhone-Ausgabe', 'Attivazione dell’edizione iPhone personale', 'Personal iPhone edition activation'), changes: [
    copy('L’écran d’activation indique la cause du blocage et l’identifiant de l’appareil. Il permet de réessayer ou de saisir une licence fournie par l’assistance.', 'Der Aktivierungsbildschirm zeigt den Grund der Sperre und die Gerätekennung. Ein erneuter Versuch oder die Eingabe einer vom Support bereitgestellten Lizenz ist möglich.', 'La schermata di attivazione mostra la causa del blocco e l’identificativo del dispositivo. Permette di riprovare o inserire una licenza fornita dall’assistenza.', 'The activation screen shows the reason for the problem and the device ID. It lets you retry or enter a licence provided by support.'),
  ] },
  { version: '1.62.0', title: copy('Langues et présentation des documents', 'Sprachen und Dokumentgestaltung', 'Lingue e presentazione dei documenti', 'Languages and document design'), changes: [
    copy('Choix du français, de l’allemand, de l’italien et de l’anglais au démarrage et dans les paramètres. Configuration, tutoriel et parcours de paie traduits ; certains écrans et PDF restent en français.', 'Französisch, Deutsch, Italienisch und Englisch beim Start und in den Einstellungen wählbar. Einrichtung, Einführung und Lohnabläufe übersetzt; einige Ansichten und PDFs bleiben auf Französisch.', 'Scelta di francese, tedesco, italiano e inglese all’avvio e nelle impostazioni. Configurazione, tutorial e percorsi salari tradotti; alcune schermate e PDF restano in francese.', 'Choose French, German, Italian or English at startup or in settings. Setup, tutorial and payroll flows translated; some screens and PDFs remain in French.'),
    copy('Atelier de documents plus spacieux avec outils de mise en page et aperçu.', 'Mehr Platz im Dokumenteditor mit Layoutwerkzeugen und Vorschau.', 'Editor documenti più spazioso con strumenti di impaginazione e anteprima.', 'A roomier document editor with layout tools and a preview.'),
  ] },
  { version: '1.61.0', title: copy('Polices et factures liées', 'Schriftarten und verknüpfte Rechnungen', 'Caratteri e fatture collegate', 'Fonts and linked invoices'), changes: [
    copy('Polices Inter et Literata incluses pour les documents et PDF, utilisables hors ligne en normal, gras et italique.', 'Inter und Literata für Dokumente und PDFs enthalten, offline in normaler, fetter und kursiver Schrift nutzbar.', 'Caratteri Inter e Literata inclusi per documenti e PDF, disponibili offline in normale, grassetto e corsivo.', 'Inter and Literata fonts included for documents and PDFs, available offline in regular, bold and italic.'),
    copy('Préparation des factures d’acompte et de solde en trois étapes : prestation, paiement, vérification. Les erreurs renvoient au champ à corriger.', 'Anzahlungs- und Schlussrechnungen in drei Schritten: Leistung, Zahlung, Prüfung. Fehler führen zum betroffenen Feld.', 'Fatture di acconto e saldo in tre passaggi: prestazione, pagamento, verifica. Gli errori rimandano al campo da correggere.', 'Deposit and final invoices in three steps: service, payment, review. Errors point to the field that needs attention.'),
  ] },
  { version: '1.60.0', title: copy('Documents, paiements et projets', 'Dokumente, Zahlungen und Projekte', 'Documenti, pagamenti e progetti', 'Documents, payments and projects'), changes: [
    copy('Modèles de documents réutilisables, portrait ou paysage, couleurs des tableaux, listes et réglages des paragraphes.', 'Wiederverwendbare Dokumentvorlagen, Hoch- oder Querformat, Tabellenfarben, Listen und Absatzeinstellungen.', 'Modelli riutilizzabili, formato verticale o orizzontale, colori delle tabelle, elenchi e impostazioni dei paragrafi.', 'Reusable document templates, portrait or landscape, table colours, lists and paragraph settings.'),
    copy('Paiements, remboursements, réceptions et mouvements de stock guidés. Réparation d’une copie locale de document et reprise de la synchronisation des projets.', 'Geführte Zahlungen, Rückzahlungen, Wareneingänge und Lagerbewegungen. Wiederherstellung lokaler Dokumentkopien und Wiederaufnahme der Projektsynchronisierung.', 'Pagamenti, rimborsi, ricezioni e movimenti di magazzino guidati. Riparazione della copia locale di un documento e ripresa della sincronizzazione dei progetti.', 'Guided payments, refunds, receipts and stock movements. Repair local document copies and resume project syncing.'),
  ] },
] as const;

function versionParts(value: string): number[] | null {
  if (!/^\d+\.\d+\.\d+$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
export function compareReleaseVersions(left: string, right: string): number | null {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
export function releaseNotesFor(version: string) {
  return {
    current: releaseHistory.find(entry => entry.version === version),
    older: releaseHistory.filter(entry => compareReleaseVersions(entry.version, version) === -1),
  };
}
