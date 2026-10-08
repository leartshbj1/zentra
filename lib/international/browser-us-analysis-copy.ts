import type { SiteLanguage } from '../site-language';

export const browserUsAnalysisCopy = {
  fr: {
    title: 'Analyse des factures reçues', active: 'Activée', paused: 'En pause', blocked: 'À configurer',
    description: 'Le texte est analysé. Vous validez avant son enregistrement.', activate: 'Activer', pause: 'Mettre en pause', refresh: 'Actualiser', loading: 'Vérification…', saving: 'Enregistrement…',
    confirmTitle: 'Activer pour cet espace', policy: 'Politique de traitement', consent: 'J’autorise l’analyse des documents de cet espace selon cette politique.', confirm: 'Activer l’analyse', cancel: 'Annuler', ownerOnly: 'Le propriétaire peut activer l’analyse. Les administrateurs peuvent la mettre en pause.',
    remaining: 'analyses restantes', limit: 'sur', renews: 'Renouvellement', reserved: 'analyses en cours', noQuota: 'Quota non configuré', quotaEmpty: 'Le quota est atteint. Les propositions déjà reçues restent accessibles.',
    providerMissing: 'Le service d’analyse doit encore être configuré pour cet espace.', consentRequired: 'Le propriétaire doit confirmer la politique de traitement.', configuration: 'La configuration de cet espace doit être vérifiée.', stale: 'Actualisez pour vérifier la disponibilité.', readonly: 'Consultation uniquement',
    pending: 'La réponse n’est pas confirmée. Réessayez la même demande avant toute autre modification.', retry: 'Réessayer la même demande', saved: 'Réglage enregistré.', replayed: 'La demande a déjà été enregistrée.',
    service: 'Le service est momentanément indisponible. Réessayez.', denied: 'L’accès à cet espace a changé. Rouvrez votre espace.', conflict: 'Le réglage a changé sur un autre appareil. Actualisez avant de le modifier.', invalid: 'Vérifiez le réglage et la confirmation de la politique.', limited: 'Patientez quelques instants avant de réessayer.', policyChanged: 'La politique a changé. Actualisez et confirmez la version actuelle.',
  },
  de: {
    title: 'Analyse eingegangener Rechnungen', active: 'Aktiv', paused: 'Pausiert', blocked: 'Einrichtung erforderlich',
    description: 'Der Text wird analysiert. Sie prüfen ihn vor dem Erfassen.', activate: 'Aktivieren', pause: 'Pausieren', refresh: 'Aktualisieren', loading: 'Wird geprüft…', saving: 'Wird gespeichert…',
    confirmTitle: 'Für diesen Arbeitsbereich aktivieren', policy: 'Verarbeitungsrichtlinie', consent: 'Ich erlaube die Analyse der Dokumente dieses Arbeitsbereichs gemäß dieser Richtlinie.', confirm: 'Analyse aktivieren', cancel: 'Abbrechen', ownerOnly: 'Der Inhaber kann die Analyse aktivieren. Administratoren können sie pausieren.',
    remaining: 'Analysen verbleibend', limit: 'von', renews: 'Erneuerung', reserved: 'laufende Analysen', noQuota: 'Kontingent nicht eingerichtet', quotaEmpty: 'Das Kontingent ist ausgeschöpft. Vorhandene Vorschläge bleiben verfügbar.',
    providerMissing: 'Der Analysedienst muss für diesen Arbeitsbereich noch eingerichtet werden.', consentRequired: 'Der Inhaber muss die Verarbeitungsrichtlinie bestätigen.', configuration: 'Die Einrichtung dieses Arbeitsbereichs muss geprüft werden.', stale: 'Aktualisieren Sie, um die Verfügbarkeit zu prüfen.', readonly: 'Nur Ansicht',
    pending: 'Die Antwort wurde nicht bestätigt. Wiederholen Sie dieselbe Anfrage vor weiteren Änderungen.', retry: 'Dieselbe Anfrage wiederholen', saved: 'Einstellung gespeichert.', replayed: 'Die Anfrage wurde bereits gespeichert.',
    service: 'Der Dienst ist vorübergehend nicht verfügbar. Versuchen Sie es erneut.', denied: 'Der Zugriff auf diesen Arbeitsbereich hat sich geändert. Öffnen Sie ihn erneut.', conflict: 'Die Einstellung wurde auf einem anderen Gerät geändert. Aktualisieren Sie zuerst.', invalid: 'Prüfen Sie die Einstellung und die Bestätigung der Richtlinie.', limited: 'Warten Sie kurz, bevor Sie es erneut versuchen.', policyChanged: 'Die Richtlinie hat sich geändert. Aktualisieren und bestätigen Sie die aktuelle Version.',
  },
  it: {
    title: 'Analisi delle fatture ricevute', active: 'Attiva', paused: 'In pausa', blocked: 'Da configurare',
    description: 'Il testo viene analizzato. Lo verifichi prima della registrazione.', activate: 'Attiva', pause: 'Metti in pausa', refresh: 'Aggiorna', loading: 'Verifica…', saving: 'Registrazione…',
    confirmTitle: 'Attiva per questo spazio', policy: 'Politica di trattamento', consent: 'Autorizzo l’analisi dei documenti di questo spazio secondo questa politica.', confirm: 'Attiva l’analisi', cancel: 'Annulla', ownerOnly: 'Il proprietario può attivare l’analisi. Gli amministratori possono metterla in pausa.',
    remaining: 'analisi rimanenti', limit: 'su', renews: 'Rinnovo', reserved: 'analisi in corso', noQuota: 'Quota non configurata', quotaEmpty: 'La quota è esaurita. Le proposte già ricevute restano disponibili.',
    providerMissing: 'Il servizio di analisi deve ancora essere configurato per questo spazio.', consentRequired: 'Il proprietario deve confermare la politica di trattamento.', configuration: 'La configurazione di questo spazio deve essere verificata.', stale: 'Aggiorna per verificare la disponibilità.', readonly: 'Solo consultazione',
    pending: 'La risposta non è confermata. Riprova la stessa richiesta prima di altre modifiche.', retry: 'Riprova la stessa richiesta', saved: 'Impostazione registrata.', replayed: 'La richiesta è già stata registrata.',
    service: 'Il servizio è temporaneamente indisponibile. Riprova.', denied: 'L’accesso a questo spazio è cambiato. Riapri il tuo spazio.', conflict: 'L’impostazione è cambiata su un altro dispositivo. Aggiorna prima di modificarla.', invalid: 'Verifica l’impostazione e la conferma della politica.', limited: 'Attendi qualche istante prima di riprovare.', policyChanged: 'La politica è cambiata. Aggiorna e conferma la versione attuale.',
  },
  en: {
    title: 'Received invoice analysis', active: 'Active', paused: 'Paused', blocked: 'Setup required',
    description: 'The text is analyzed. You review it before recording.', activate: 'Activate', pause: 'Pause', refresh: 'Refresh', loading: 'Checking…', saving: 'Saving…',
    confirmTitle: 'Activate for this workspace', policy: 'Processing policy', consent: 'I authorize analysis of this workspace’s documents under this policy.', confirm: 'Activate analysis', cancel: 'Cancel', ownerOnly: 'The owner can activate analysis. Administrators can pause it.',
    remaining: 'analyses remaining', limit: 'of', renews: 'Renews', reserved: 'analyses in progress', noQuota: 'Quota not configured', quotaEmpty: 'The quota has been reached. Existing proposals remain available.',
    providerMissing: 'The analysis service still needs to be configured for this workspace.', consentRequired: 'The owner must confirm the processing policy.', configuration: 'This workspace’s configuration needs to be reviewed.', stale: 'Refresh to check availability.', readonly: 'View only',
    pending: 'The response is unconfirmed. Retry the same request before making another change.', retry: 'Retry the same request', saved: 'Setting saved.', replayed: 'The request was already saved.',
    service: 'The service is temporarily unavailable. Try again.', denied: 'Access to this workspace has changed. Reopen your workspace.', conflict: 'The setting changed on another device. Refresh before editing.', invalid: 'Check the setting and policy confirmation.', limited: 'Wait a moment before trying again.', policyChanged: 'The policy changed. Refresh and confirm the current version.',
  },
} as const;

export function browserUsAnalysisError(language: SiteLanguage, code: string): string {
  const c = browserUsAnalysisCopy[language];
  if (['unauthorized', 'forbidden', 'session_changed', 'management_entitlement_required', 'automation_entitlement_required', 'feature_unavailable', 'edition_unavailable'].includes(code)) return c.denied;
  if (code === 'rate_limited') return c.limited;
  if (['automation_revision_conflict', 'automation_idempotency_conflict', 'read_required'].includes(code)) return c.conflict;
  if (code === 'automation_consent_required') return c.policyChanged;
  if (['invalid_request', 'invalid_automation_request', 'owner_required'].includes(code)) return c.invalid;
  if (code === 'automation_upgrade_required') return c.configuration;
  return c.service;
}
