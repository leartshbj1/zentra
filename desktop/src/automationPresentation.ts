const labels = {
  activity: ['Activité', 'Aktivität', 'Attività', 'Activity'],
  followup: ['À suivre', 'Offen', 'Da seguire', 'Follow-up'],
  settings: ['Réglages', 'Einstellungen', 'Impostazioni', 'Settings'],
  journal: ['Journal d’activité', 'Aktivitätsverlauf', 'Registro attività', 'Activity log'],
  all: ['Tout', 'Alle', 'Tutto', 'All'],
  invoices: ['Factures', 'Rechnungen', 'Fatture', 'Invoices'],
  rules: ['Automatismes', 'Automatisierungen', 'Automatismi', 'Workflows'],
  search: ['Rechercher dans l’activité', 'Aktivität durchsuchen', 'Cerca nelle attività', 'Search activity'],
  noResults: ['Aucun résultat pour cette recherche.', 'Keine Ergebnisse für diese Suche.', 'Nessun risultato per questa ricerca.', 'No results for this search.'],
  clear: ['Effacer la recherche', 'Suche löschen', 'Cancella ricerca', 'Clear search'],
  recent: ['Dernières opérations disponibles', 'Letzte verfügbare Vorgänge', 'Ultime operazioni disponibili', 'Latest available operations'],
  imported: ['Enregistrée dans Gestion', 'In Gestion erfasst', 'Registrata in Gestion', 'Recorded in Gestion'],
  automatic: ['Comptabilisée automatiquement', 'Automatisch verbucht', 'Contabilizzata automaticamente', 'Posted automatically'],
  review: ['À vérifier', 'Zu prüfen', 'Da verificare', 'To review'],
  received: ['Reçue', 'Eingegangen', 'Ricevuta', 'Received'],
  waiting: ['En attente', 'Ausstehend', 'In attesa', 'Pending'],
  unavailableDate: ['Date non disponible', 'Datum nicht verfügbar', 'Data non disponibile', 'Date unavailable'],
  showMore: ['Afficher la suite', 'Weitere anzeigen', 'Mostra altro', 'Show more'],
  today: ['Aujourd’hui', 'Heute', 'Oggi', 'Today'],
  empty: ['Vos prochaines opérations apparaîtront ici.', 'Ihre nächsten Vorgänge erscheinen hier.', 'Le prossime operazioni appariranno qui.', 'Your next operations will appear here.'],
  amountRead: ['Montant lu sur la facture', 'Ausgelesener Rechnungsbetrag', 'Importo letto sulla fattura', 'Amount read from the invoice'],
  supplier: ['Fournisseur', 'Lieferant', 'Fornitore', 'Supplier'],
  reference: ['Référence', 'Referenz', 'Riferimento', 'Reference'],
  source: ['E-mail reçu de', 'E-Mail erhalten von', 'E-mail ricevuta da', 'Email received from'],
  file: ['Pièce jointe', 'Anhang', 'Allegato', 'Attachment'],
  openInvoice: ['Ouvrir la facture', 'Rechnung öffnen', 'Apri fattura', 'Open invoice'],
  openInbox: ['Ouvrir les factures reçues', 'Eingegangene Rechnungen öffnen', 'Apri fatture ricevute', 'Open received invoices'],
  invoiceDetails: ['Détails de la facture', 'Rechnungsdetails', 'Dettagli della fattura', 'Invoice details'],
  activityUnavailable: ['L’activité n’est pas disponible pour le moment.', 'Die Aktivität ist zurzeit nicht verfügbar.', 'Le attività non sono disponibili al momento.', 'Activity is currently unavailable.'],
  availableActivity: ['Activité disponible', 'Verfügbare Aktivität', 'Attività disponibili', 'Available activity'],
  run_completed: ['Terminé', 'Abgeschlossen', 'Completato', 'Completed'],
  run_running: ['En cours', 'In Bearbeitung', 'In corso', 'In progress'],
  run_waiting: ['Planifié', 'Geplant', 'Pianificato', 'Scheduled'],
  run_observed: ['Observé sans agir', 'Ohne Aktion beobachtet', 'Osservato senza agire', 'Observed without action'],
  run_skipped: ['Conditions non remplies', 'Bedingungen nicht erfüllt', 'Condizioni non soddisfatte', 'Conditions not met'],
  run_failed: ['À reprendre', 'Erneut prüfen', 'Da riprendere', 'Needs attention'],
  run_cancelled: ['Annulé', 'Abgebrochen', 'Annullato', 'Cancelled'],
  run_undone: ['Annulation effectuée', 'Rückgängig gemacht', 'Annullamento effettuato', 'Undone'],
} as const;
export function automationLabel(key: keyof typeof labels, language: string = 'fr') {
  return labels[key][Math.max(0, ['fr', 'de', 'it', 'en'].indexOf(language))];
}

export function automationRunStatus(state: string, language: string) {
  const keys = {completed:'run_completed',running:'run_running',waiting:'run_waiting',observed:'run_observed',skipped:'run_skipped',failed:'run_failed',cancelled:'run_cancelled',undone:'run_undone',queued:'waiting',review:'review'} as const;
  return automationLabel(keys[state as keyof typeof keys] ?? 'review', language);
}

/** Sorting is presentation-only. Zero/invalid timestamps must never be presented as today's work. */
export function activityTimestamp(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8640000000000 ? value : 0;
}

export function activityTimeZone(value?: string) {
  try { new Intl.DateTimeFormat('en', {timeZone:value || 'Europe/Zurich'}); return value || 'Europe/Zurich'; }
  catch { return 'Europe/Zurich'; }
}

/** Server day, not device day: retained or historical results must not become today's work. */
export function activityDayLabel(date: string | undefined, timeZone: string | undefined, language: string, now = new Date()) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return automationLabel('availableActivity',language);
  const parsed = new Date(date + 'T12:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date) return automationLabel('availableActivity',language);
  const today = new Intl.DateTimeFormat('sv-SE',{timeZone:activityTimeZone(timeZone)}).format(now);
  return date === today ? automationLabel('today',language) : new Intl.DateTimeFormat(`${language}-CH`,{dateStyle:'long',timeZone:'UTC'}).format(parsed);
}

export function activityInvoiceAmount(cents: number | null | undefined, currency: string | null | undefined, language: string) {
  if (!Number.isSafeInteger(cents) || Number(cents) < 0 || !currency || !/^[A-Z]{3}$/.test(currency)) return null;
  return new Intl.NumberFormat(`${language}-CH`,{style:'currency',currency}).format(Number(cents)/100);
}

export function invoiceActivityStatus(state: string, automatic: number) {
  return state === 'imported' ? (automatic === 1 ? 'automatic' : 'imported') : ['review','needs_review'].includes(state) ? 'review' : 'waiting';
}
