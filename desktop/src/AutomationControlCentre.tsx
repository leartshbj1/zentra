'use client';
import { withDiagnosticIntent } from './diagnosticIntent';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronDown,
  Plus,
  RotateCcw,
  Workflow,
  X,
} from 'lucide-react';
import type { WorkflowDefinition } from './automationWorkflowTypes';
import './AutomationControlCentre.css';
import { AutomationJournal } from './AutomationJournal';
import type { ConfirmedQuoteActivityPage } from './confirmedQuoteActivity';
import type { AutomationActivity } from './automation';
import type { BriefDestination } from './AutomationBrief';
import { t, useAppLanguage } from './language';
import { activityDateTime, activityTimestamp, automationLabel, automationRunStatus } from './automationPresentation';
import type { AppointmentInboxState } from './AppointmentInbox';

type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  revision: number;
  definition: WorkflowDefinition;
};
type Run = {
  id: string;
  sourceId?: string | null;
  title: string;
  state: string;
  revision: number;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  dueAt: number;
  definition: WorkflowDefinition;
  result: {
    choice?: string;
    approvedChoice?: string;
    confidence?: number;
    message?: string;
    summary?: {
      subject: string;
      sender: string;
      excerpts: { text: string }[];
      attachments: string[];
      truncated: boolean;
    };
    steps?: {
      index: number;
      title: string;
      type: string;
      state: string;
      at: number;
    }[];
  };
};
type WorkItem = {
  id: string;
  title: string;
  body: string;
  kind: string;
  state: string;
  revision: number;
  assigned_to: string | null;
  created_at: number;
};
export type AutomationCentreState = {
  organizationId: string;
  canManage: boolean;
  canWork: boolean;
  rules: Rule[];
  runs: Run[];
  items: WorkItem[];
  templates: {
    id: string;
    name: string;
    description: string;
    definition: WorkflowDefinition;
  }[];
  members: { user_id: string; name: string; role: string }[];
};
type Requester = (body: Record<string, unknown>) => Promise<unknown>;
const modes = {
  shadow: 'Observer sans agir',
  suggest: 'Me demander de confirmer',
  automatic: 'Exécuter si la confiance suffit',
  notify: 'Exécuter puis notifier',
};
const actions = {
  task: 'Créer une tâche',
  notify: 'Notifier dans Autopilote',
  reply_draft: 'Préparer une réponse',
  summary: 'Résumé du message reçu',
  review: 'Demander une vérification',
};
const categories = {
  supplier_invoice: 'Facture fournisseur',
  quote: 'Devis',
  order: 'Commande',
  after_sales: 'SAV',
  appointment: 'Rendez-vous',
  complaint: 'Réclamation',
  administration: 'Administratif',
  human_resources: 'Ressources humaines',
  spam: 'Indésirable',
  bug: 'Problème technique',
  billing: 'Facturation',
  credit_note: 'Avoir',
  payment_reminder: 'Rappel de paiement',
  receipt: 'Reçu',
  product: 'Question produit',
  refund: 'Remboursement',
  shipping: 'Livraison',
  account: 'Compte et accès',
  other: 'Autre',
};
const centreTranslations: Record<string, readonly [string, string, string]> = {
  'Centre Autopilote': ['Autopilote-Zentrale', 'Centro Autopilote', 'Autopilote centre'],
  'Votre centre Autopilote': ['Ihre Autopilote-Zentrale', 'Il tuo centro Autopilote', 'Your Autopilote centre'],
  'Les actions de votre équipe, au même endroit.': ['Die Aktionen Ihres Teams an einem Ort.', 'Le azioni del tuo team, in un solo posto.', 'Your team’s actions in one place.'],
  'Actualiser le centre Autopilote': ['Autopilote-Zentrale aktualisieren', 'Aggiorna il centro Autopilote', 'Refresh Autopilote centre'],
  'Vue du centre Autopilote': ['Ansicht der Autopilote-Zentrale', 'Vista del centro Autopilote', 'Autopilote centre view'],
  'À faire': ['Aufgaben', 'Da fare', 'Tasks'],
  'Règles': ['Regeln', 'Regole', 'Rules'],
  'Chargement du centre…': ['Zentrale wird geladen…', 'Caricamento del centro…', 'Loading the centre…'],
  'Rien à vérifier': ['Nichts zu prüfen', 'Nulla da verificare', 'Nothing to review'],
  'Les règles qui demandent votre accord apparaîtront ici.': ['Regeln, die Ihre Zustimmung benötigen, erscheinen hier.', 'Le regole che richiedono il tuo consenso appariranno qui.', 'Rules needing your approval will appear here.'],
  'Les factures et rendez-vous reçus conservent leurs contrôles dans les écrans de réception de Gestion.': ['Die Prüfungen für empfangene Rechnungen und Termine bleiben in den Eingangsschirmen von Gestion.', 'Le verifiche di fatture e appuntamenti ricevuti restano nelle schermate di ricezione di Gestion.', 'Received invoices and appointments keep their checks in Gestion’s inbox screens.'],
  'Aucune tâche à faire': ['Keine offenen Aufgaben', 'Nessuna attività da svolgere', 'No open tasks'],
  'Les tâches, notifications et brouillons créés par vos règles apparaîtront ici.': ['Aufgaben, Benachrichtigungen und Entwürfe Ihrer Regeln erscheinen hier.', 'Le attività, notifiche e bozze create dalle tue regole appariranno qui.', 'Tasks, notifications and drafts created by your rules will appear here.'],
  'Pour': ['Für', 'Per', 'For'],
  'un collaborateur': ['ein Teammitglied', 'un collaboratore', 'a team member'],
  'Relire la réponse': ['Antwort prüfen', 'Rileggi la risposta', 'Review reply'],
  'Voir le détail': ['Details ansehen', 'Vedi dettagli', 'View details'],
  'Lu': ['Gelesen', 'Letto', 'Read'],
  'Terminé': ['Erledigt', 'Completato', 'Done'],
  'Écarter': ['Verwerfen', 'Escludi', 'Dismiss'],
  'Vos règles': ['Ihre Regeln', 'Le tue regole', 'Your rules'],
  'Déclencheur actuel : un message classé dans Support. Les actions créent des tâches, notifications ou brouillons dans ce centre.': ['Auslöser: eine in Support eingeordnete Nachricht. Die Aktionen erstellen hier Aufgaben, Benachrichtigungen oder Entwürfe.', 'Attivazione: un messaggio classificato in Support. Le azioni creano attività, notifiche o bozze in questo centro.', 'Trigger: a message classified in Support. Actions create tasks, notifications or drafts in this centre.'],
  'En pause': ['Pausiert', 'In pausa', 'Paused'],
  'Modifier': ['Bearbeiten', 'Modifica', 'Edit'],
  'Commencer avec un modèle': ['Mit einer Vorlage beginnen', 'Inizia da un modello', 'Start with a template'],
  'Personnalisez-le et choisissez quand il peut agir.': ['Passen Sie die Vorlage an und legen Sie fest, wann sie handeln darf.', 'Personalizzalo e scegli quando può agire.', 'Customize it and choose when it can act.'],
  'Le titulaire ou un administrateur peut ajouter et modifier les règles de votre entreprise.': ['Der Inhaber oder ein Administrator kann Unternehmensregeln hinzufügen und bearbeiten.', 'Il titolare o un amministratore può aggiungere e modificare le regole aziendali.', 'The owner or an administrator can add and edit company rules.'],
  'Modification enregistrée.': ['Änderung gespeichert.', 'Modifica salvata.', 'Change saved.'],
  'Le centre Autopilote est indisponible. Réessayez.': ['Die Autopilote-Zentrale ist nicht verfügbar. Versuchen Sie es erneut.', 'Il centro Autopilote non è disponibile. Riprova.', 'The Autopilote centre is unavailable. Try again.'],
  'Règle enregistrée. Elle s’applique aux prochains messages classés.': ['Regel gespeichert. Sie gilt für die nächsten eingeordneten Nachrichten.', 'Regola salvata. Si applica ai prossimi messaggi classificati.', 'Rule saved. It applies to future classified messages.'],
  'La règle n’a pas pu être enregistrée.': ['Die Regel konnte nicht gespeichert werden.', 'Impossibile salvare la regola.', 'The rule could not be saved.'],
  'Réessayez.': ['Versuchen Sie es erneut.', 'Riprova.', 'Try again.'],
  'Brouillon à relire': ['Entwurf prüfen', 'Bozza da rileggere', 'Draft to review'],
  'Enregistrer pour l’équipe': ['Für das Team speichern', 'Salva per il team', 'Save for the team'],
  'Copié': ['Kopiert', 'Copiato', 'Copied'],
  'Copier la réponse': ['Antwort kopieren', 'Copia la risposta', 'Copy reply'],
  'Le brouillon n’a pas été enregistré. Votre texte reste ici.': ['Der Entwurf wurde nicht gespeichert. Ihr Text bleibt hier.', 'La bozza non è stata salvata. Il testo resta qui.', 'The draft was not saved. Your text remains here.'],
  'Sélectionnez le texte pour le copier.': ['Wählen Sie den Text aus, um ihn zu kopieren.', 'Seleziona il testo per copiarlo.', 'Select the text to copy it.'],
  'Un collègue a modifié ce brouillon. Copiez votre texte avant de recharger sa version.': ['Ein Teammitglied hat diesen Entwurf geändert. Kopieren Sie Ihren Text, bevor Sie die gespeicherte Version laden.', 'Un collega ha modificato la bozza. Copia il testo prima di caricare la sua versione.', 'A colleague changed this draft. Copy your text before loading their version.'],
  'Charger la version enregistrée': ['Gespeicherte Version laden', 'Carica la versione salvata', 'Load saved version'],
  'Aucun message n’est envoyé automatiquement.': ['Keine Nachricht wird automatisch versendet.', 'Nessun messaggio viene inviato automaticamente.', 'No message is sent automatically.'],
  'Modifier la règle': ['Regel bearbeiten', 'Modifica regola', 'Edit rule'],
  'Nouvelle règle': ['Neue Regel', 'Nuova regola', 'New rule'],
  'Fermer': ['Schliessen', 'Chiudi', 'Close'],
  'Nom de la règle': ['Regelname', 'Nome della regola', 'Rule name'],
  'Quand': ['Wenn', 'Quando', 'When'],
  'Un message est classé dans Zentra Support': ['Eine Nachricht wird in Zentra Support eingeordnet', 'Un messaggio viene classificato in Zentra Support', 'A message is classified in Zentra Support'],
  'Si': ['Falls', 'Se', 'If'],
  'Catégorie': ['Kategorie', 'Categoria', 'Category'],
  'Toutes les catégories': ['Alle Kategorien', 'Tutte le categorie', 'All categories'],
  'Priorité': ['Priorität', 'Priorità', 'Priority'],
  'Toutes les priorités': ['Alle Prioritäten', 'Tutte le priorità', 'All priorities'],
  'Urgente': ['Dringend', 'Urgente', 'Urgent'],
  'Élevée': ['Hoch', 'Alta', 'High'],
  'Normale': ['Normal', 'Normale', 'Normal'],
  'Basse': ['Niedrig', 'Bassa', 'Low'],
  'Expéditeur précis, facultatif': ['Bestimmter Absender, optional', 'Mittente specifico, facoltativo', 'Specific sender, optional'],
  'Seulement avec une pièce jointe': ['Nur mit Anhang', 'Solo con un allegato', 'Only with an attachment'],
  'Décision de Zentra': ['Entscheidung von Zentra', 'Decisione di Zentra', 'Zentra decision'],
  'Ajouter une décision pour choisir une branche': ['Entscheidung zur Zweigauswahl hinzufügen', 'Aggiungi una decisione per scegliere un ramo', 'Add a decision to choose a branch'],
  'Question': ['Frage', 'Domanda', 'Question'],
  'Branche Oui': ['Ja-Zweig', 'Ramo Sì', 'Yes branch'],
  'Branche Non': ['Nein-Zweig', 'Ramo No', 'No branch'],
  'Une réponse incertaine demande une validation. Cette décision ne valide jamais un paiement ni une décision RH.': ['Eine unsichere Antwort erfordert eine Bestätigung. Diese Entscheidung genehmigt niemals Zahlungen oder Personalentscheide.', 'Una risposta incerta richiede una conferma. Questa decisione non approva mai pagamenti o decisioni HR.', 'An uncertain answer needs approval. This decision never authorizes payments or HR decisions.'],
  'Alors': ['Dann', 'Allora', 'Then'],
  'Action': ['Aktion', 'Azione', 'Action'],
  'Branche': ['Zweig', 'Ramo', 'Branch'],
  'Dans tous les cas': ['In jedem Fall', 'In ogni caso', 'Always'],
  'Si Oui': ['Bei Ja', 'Se Sì', 'If yes'],
  'Si Non': ['Bei Nein', 'Se No', 'If no'],
  'Titre': ['Titel', 'Titolo', 'Title'],
  'Toute l’équipe': ['Gesamtes Team', 'Tutto il team', 'Whole team'],
  'Attendre, en heures': ['Warten, in Stunden', 'Attesa, in ore', 'Wait, in hours'],
  'Modèle de réponse': ['Antwortvorlage', 'Modello di risposta', 'Reply template'],
  'Note interne, facultative': ['Interne Notiz, optional', 'Nota interna, facoltativa', 'Internal note, optional'],
  'Instructions': ['Anweisungen', 'Istruzioni', 'Instructions'],
  'Champs disponibles :': ['Verfügbare Felder:', 'Campi disponibili:', 'Available fields:'],
  'et': ['und', 'e', 'and'],
  'Retirer cette action': ['Diese Aktion entfernen', 'Rimuovi questa azione', 'Remove this action'],
  'Ajouter une action': ['Aktion hinzufügen', 'Aggiungi azione', 'Add action'],
  'Autonomie': ['Autonomie', 'Autonomia', 'Autonomy'],
  'Comportement': ['Verhalten', 'Comportamento', 'Behaviour'],
  'Confiance minimale, en %': ['Mindestkonfidenz in %', 'Confidenza minima, in %', 'Minimum confidence, in %'],
  'Activer pour les prochains messages': ['Für künftige Nachrichten aktivieren', 'Attiva per i prossimi messaggi', 'Enable for future messages'],
  'Une règle arrêtée conserve son historique. Les demandes RH restent à confirmer. Les brouillons ne sont jamais envoyés.': ['Eine pausierte Regel behält ihren Verlauf. Personalangelegenheiten müssen bestätigt werden. Entwürfe werden nie versendet.', 'Una regola sospesa conserva la cronologia. Le richieste HR richiedono conferma. Le bozze non vengono mai inviate.', 'A paused rule keeps its history. HR requests still need approval. Drafts are never sent.'],
  'Enregistrer la règle': ['Regel speichern', 'Salva regola', 'Save rule'],
  'Simuler avec un exemple': ['Mit einem Beispiel simulieren', 'Simula con un esempio', 'Simulate with an example'],
  'Exemple fictif ·': ['Fiktives Beispiel ·', 'Esempio fittizio ·', 'Fictitious example ·'],
  'conditions remplies': ['Bedingungen erfüllt', 'condizioni soddisfatte', 'conditions met'],
  'conditions non remplies': ['Bedingungen nicht erfüllt', 'condizioni non soddisfatte', 'conditions not met'],
  'Vérifiez la règle.': ['Prüfen Sie die Regel.', 'Verifica la regola.', 'Check the rule.'],
  'Observer sans agir': ['Ohne Aktion beobachten', 'Osserva senza agire', 'Observe without acting'],
  'Me demander de confirmer': ['Bestätigung anfordern', 'Chiedimi conferma', 'Ask me to confirm'],
  'Exécuter si la confiance suffit': ['Bei ausreichender Konfidenz ausführen', 'Esegui con confidenza sufficiente', 'Run with sufficient confidence'],
  'Exécuter puis notifier': ['Ausführen und benachrichtigen', 'Esegui e notifica', 'Run then notify'],
  'Créer une tâche': ['Aufgabe erstellen', 'Crea attività', 'Create task'],
  'Notifier dans Autopilote': ['In Autopilote benachrichtigen', 'Notifica in Autopilote', 'Notify in Autopilote'],
  'Préparer une réponse': ['Antwort vorbereiten', 'Prepara risposta', 'Prepare reply'],
  'Résumé du message reçu': ['Zusammenfassung der Nachricht', 'Riepilogo del messaggio ricevuto', 'Received message summary'],
  'Demander une vérification': ['Prüfung anfordern', 'Richiedi verifica', 'Request review'],
  'action': ['Aktion', 'azione', 'action'],
  'actions': ['Aktionen', 'azioni', 'actions'],
  'Facture fournisseur': ['Lieferantenrechnung', 'Fattura fornitore', 'Supplier invoice'],
  'Devis': ['Offerte', 'Preventivo', 'Quote'],
  'Commande': ['Bestellung', 'Ordine', 'Order'],
  'SAV': ['Kundendienst', 'Assistenza post-vendita', 'After-sales'],
  'Rendez-vous': ['Termin', 'Appuntamento', 'Appointment'],
  'Réclamation': ['Reklamation', 'Reclamo', 'Complaint'],
  'Administratif': ['Verwaltung', 'Amministrazione', 'Administration'],
  'Ressources humaines': ['Personal', 'Risorse umane', 'Human resources'],
  'Indésirable': ['Spam', 'Spam', 'Spam'],
  'Problème technique': ['Technisches Problem', 'Problema tecnico', 'Technical issue'],
  'Facturation': ['Abrechnung', 'Fatturazione', 'Billing'],
  'Avoir': ['Gutschrift', 'Nota di credito', 'Credit note'],
  'Rappel de paiement': ['Zahlungserinnerung', 'Sollecito di pagamento', 'Payment reminder'],
  'Reçu': ['Beleg', 'Ricevuta', 'Receipt'],
  'Question produit': ['Produktfrage', 'Domanda sul prodotto', 'Product question'],
  'Remboursement': ['Rückerstattung', 'Rimborso', 'Refund'],
  'Livraison': ['Lieferung', 'Consegna', 'Delivery'],
  'Compte et accès': ['Konto und Zugang', 'Account e accesso', 'Account and access'],
  'Autre': ['Sonstiges', 'Altro', 'Other'],
};
function useCentreText() {
  const language = useAppLanguage();
  return (source: string) => language === 'fr' || !/\p{L}/u.test(source) ? source : centreTranslations[source]?.[['de', 'it', 'en'].indexOf(language)] ?? t(source, undefined, language);
}

export function AutomationControlCentre({
  organizationId,
  request, initialTab = 'history', embedded = false, hideNavigation = false, hideRules = false,
  activity, onOpen, onOpenInvoice, appointments, appointmentsUnavailable, onOpenAppointment, onOpenSourceMessage,
  confirmedQuotes, onOpenQuote,
}: {
  organizationId: string;
  request: Requester;
  initialTab?: 'review' | 'work' | 'history' | 'rules';
  embedded?: boolean; hideNavigation?: boolean; hideRules?: boolean;
  activity?: AutomationActivity | null; onOpen?: (destination: BriefDestination) => void;
  onOpenInvoice?: (id: string) => void;
  appointments?: AppointmentInboxState | null;
  appointmentsUnavailable?: boolean;
  onOpenAppointment?: (id: string) => void;
  onOpenSourceMessage?: (id: string) => Promise<unknown>;
  confirmedQuotes?: ConfirmedQuoteActivityPage | null;
  onOpenQuote?: (id: string) => void;
}) {
  const language = useAppLanguage();
  const c = useCentreText();
  const [loadedData, setData] = useState<AutomationCentreState | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState<'review' | 'work' | 'history' | 'rules'>(initialTab);
  const data = loadedData?.organizationId === organizationId ? loadedData : null;
  useEffect(() => { setTab(initialTab); setEditing(null); }, [initialTab]);
  const [editing, setEditing] = useState<Rule | null>(null),
    [notice, setNotice] = useState('');
  const api = useRef(request),
    alive = useRef(true),
    inflight = useRef(false),
    sequence = useRef(0),
    acting = useRef(false);
  api.current = request;
  const load = useCallback(async (force = false) => {
    if (inflight.current && !force) return;
    const requestNumber = ++sequence.current;
    inflight.current = true;
    setLoading(true);
    try {
      const next = (await api.current(withDiagnosticIntent({
        action: 'centre',
      }, 'automation_request', 'centre'))) as AutomationCentreState;
      if (alive.current && requestNumber === sequence.current && next.organizationId === organizationId) {
        setData(next);
        setError('');
      } else if (alive.current && requestNumber === sequence.current) {
        setData(null);
        setError('Le compte et l’entreprise ne correspondent pas');
      }
    } catch (e) {
      if (alive.current && requestNumber === sequence.current)
        setError(
          e instanceof Error
            ? e.message
            : 'Le centre Autopilote est indisponible. Réessayez.',
        );
    } finally {
      if (requestNumber === sequence.current) {
        inflight.current = false;
        if (alive.current) setLoading(false);
      }
    }
  }, [organizationId]);
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, 30000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load]);
  async function action(body: Record<string, unknown>) {
    if (acting.current) return false;
    acting.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.current(body);
      if (alive.current) {
        setNotice('Modification enregistrée.');
        await load(true);
      }
      return true;
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Réessayez.');
      return false;
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const review =
      data?.runs.filter((r) => r.state === 'review' || r.state === 'failed') ||
      [],
    work = data?.items.filter((i) => i.state === 'open') || [];
  return (
    <section className={`automation-centre${embedded ? " automation-centre--embedded" : ""}`} aria-label={c('Centre Autopilote')} aria-busy={busy || undefined}>
      {!embedded && <header className="automation-centre__heading">
        <div>
          <h2>{c("Votre centre Autopilote")}</h2>
          <p>{c("Les actions de votre équipe, au même endroit.")}</p>
        </div>
        <button
          type="button"
          className="ac-quiet"
          onClick={() => void load()}
          disabled={busy}
          aria-label={c("Actualiser le centre Autopilote")}
        >
          <RotateCcw size={18} />
        </button>
      </header>}
      {!hideNavigation && <nav
        className="automation-centre__tabs"
        aria-label={c('Vue du centre Autopilote')}
      >
        {(
          [
            ['history', automationLabel('activity', language), 0],
            ['review', automationLabel('review', language), review.length],
            ['work', c('À faire'), work.length],
            ['rules', 'Règles', 0],
          ] as const
        ).filter(([id]) => !hideRules || id !== 'rules').map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => {
              setTab(id);
              setEditing(null);
            }}
          >
            {c(label)}
            {count > 0 && <span>{count}</span>}
          </button>
        ))}
      </nav>}
      {error && (
        <div className="ac-message ac-message--error" role="alert"><AlertCircle size={18} aria-hidden="true"/><p>{c(error)}</p><button type="button" className="ac-quiet" disabled={loading || busy} onClick={() => void load()}>{automationLabel('retry', language)}</button></div>
      )}
      {notice && (
        <p className="ac-message" role="status">
          <Check size={17} aria-hidden="true"/>{c(notice)}
        </p>
      )}
      {!data && !error && tab !== 'history' && <p role="status">{c('Chargement du centre…')}</p>}
      {data && tab === 'review' && (
        <div className="ac-list">
          {review.length === 0 ? (
            !error && <div className="ac-empty">
              <Check size={24} />
              <h3>{c("Rien à vérifier")}</h3>
              <p>{c("Les règles qui demandent votre accord apparaîtront ici.")}</p>
            </div>
          ) : (
            review.map((run) => (
              <AutomationRunRow
                key={run.id}
                run={run}
                canManage={data.canManage && !error}
                busy={busy || loading}
                act={action}
                onOpenSourceMessage={onOpenSourceMessage}
              />
            ))
          )}
          <p className="ac-footnote">
            {c("Les factures et rendez-vous reçus conservent leurs contrôles dans les écrans de réception de Gestion.")}</p>
        </div>
      )}
      {data && tab === 'work' && (
        <div className="ac-list">
          {work.length === 0 ? (
            !error && <div className="ac-empty">
              <Check size={24} />
              <h3>{c("Aucune tâche à faire")}</h3>
              <p>
                {c("Les tâches, notifications et brouillons créés par vos règles apparaîtront ici.")}</p>
            </div>
          ) : (
            work.map((item) => (
              <article key={item.id} className="ac-item">
                <div className="ac-item__body">
                  <span className="ac-meta">
                    {c(actions[item.kind as keyof typeof actions] || 'Action')} {c("·")}{' '}
                    {activityDateTime(item.created_at, language)}
                  </span>
                  <h3>{item.title}</h3>
                  {item.assigned_to && (
                    <p className="ac-meta">
                      {c("Pour")}{' '}
                      {data.members.find((m) => m.user_id === item.assigned_to)
                        ?.name || 'un collaborateur'}
                    </p>
                  )}
                  <details className="ac-item__details"><summary>{c(item.kind === 'reply_draft' ? 'Relire la réponse' : 'Voir le détail')}</summary>
                  {item.kind === 'reply_draft' ? (
                    <ReplyDraft
                      item={item}
                      busy={busy || loading || !!error || !data.canWork}
                      save={action}
                    />
                  ) : (
                    <p className="ac-preserve">{item.body}</p>
                  )}</details>
                </div>
                <div className="ac-actions">
                  <button
                    type="button"
                    onClick={() =>
                      void action(withDiagnosticIntent({
                        action: 'work_item_update',
                        id: item.id,
                        revision: item.revision,
                        state: 'done',
                      }, 'automation_request', 'work_item_update'))
                    }
                    disabled={busy || loading || !!error || !data.canWork}
                  >
                    <Check size={16} />
                    {c(item.kind === 'notify' ? 'Lu' : 'Terminé')}
                  </button>
                  <button
                    type="button"
                    className="ac-quiet"
                    aria-label={`${c('Écarter')} · ${item.title}`}
                    disabled={busy || loading || !!error || !data.canWork}
                    onClick={() =>
                      void action(withDiagnosticIntent({
                        action: 'work_item_update',
                        id: item.id,
                        revision: item.revision,
                        state: 'dismissed',
                      }, 'automation_request', 'work_item_update'))
                    }
                  >
                    <X size={16} />
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      )}
      {tab === 'history' && <AutomationJournal organizationId={organizationId} appointments={appointments} appointmentsUnavailable={appointmentsUnavailable} openAppointment={onOpenAppointment} openAppointments={onOpen ? () => onOpen('appointments') : undefined} runs={data?.runs ?? []} activity={activity} confirmedQuotes={confirmedQuotes} openQuote={onOpenQuote} loading={loading} unavailable={!!error} onRefresh={() => void load()} openInvoice={onOpenInvoice} openInvoices={onOpen ? () => onOpen('invoices') : undefined} renderRun={run => <AutomationRunRow run={run} canManage={!!data?.canManage && !error} busy={busy || loading} act={action} onOpenSourceMessage={onOpenSourceMessage} quickMessage/>}/>}
      {data &&
        tab === 'rules' &&
        (editing ? (
          <RuleEditor
            rule={editing}
            members={data.members}
            busy={busy}
            request={api.current}
            onClose={() => setEditing(null)}
            onSave={async (value) => {
              if (acting.current) return;
              acting.current = true;
              setBusy(true);
              setError('');
              try {
                await api.current(withDiagnosticIntent({ action: 'workflow_save', ...value }, 'automation_request', 'workflow_save'));
                if (alive.current) {
                  setEditing(null);
                  setNotice(
                    'Règle enregistrée. Elle s’applique aux prochains messages classés.',
                  );
                  await load(true);
                }
              } catch (e) {
                if (alive.current)
                  setError(
                    e instanceof Error
                      ? e.message
                      : 'La règle n’a pas pu être enregistrée.',
                  );
              } finally {
                acting.current = false;
                if (alive.current) setBusy(false);
              }
            }}
          />
        ) : (
          <>
            <div className="ac-section">
              <h3>{c("Vos règles")}</h3>
              <p>
                {c("Déclencheur actuel : un message classé dans Support. Les actions créent des tâches, notifications ou brouillons dans ce centre.")}</p>
            </div>
            {data.rules.map((rule) => (
              <article className="ac-rule" key={rule.id}>
                <div>
                  <h4>{rule.name}</h4>
                  <p>
                    {c(rule.enabled ? modes[rule.definition.mode] : 'En pause')} {c("·")}{' '}
                    {new Intl.NumberFormat(language).format(rule.definition.actions.length)} {c(rule.definition.actions.length === 1 ? 'action' : 'actions')}
                  </p>
                </div>
                {data.canManage && (
                  <button
                    className="ac-quiet"
                    type="button"
                    onClick={() => setEditing(structuredClone(rule))}
                  >
                    {c("Modifier")}</button>
                )}
              </article>
            ))}
            {data.canManage ? (
              <>
                <div className="ac-section">
                  <h3>{c("Commencer avec un modèle")}</h3>
                  <p>{c("Personnalisez-le et choisissez quand il peut agir.")}</p>
                </div>
                <div className="ac-templates">
                  {data.templates.map((template) => (
                    <button
                      type="button"
                      className="ac-template"
                      key={template.id}
                      onClick={() =>
                        setEditing({
                          id: '',
                          revision: 0,
                          enabled: false,
                          name: template.name,
                          definition: structuredClone(template.definition),
                        })
                      }
                    >
                      <Workflow size={20} />
                      <span>
                        <strong>{template.name}</strong>
                        <small>{template.description}</small>
                      </span>
                      <Plus size={18} />
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p>
                {c("Le titulaire ou un administrateur peut ajouter et modifier les règles de votre entreprise.")}</p>
            )}
          </>
        ))}
    </section>
  );
}
function ReplyDraft({
  item,
  busy,
  save,
}: {
  item: WorkItem;
  busy: boolean;
  save: (v: Record<string, unknown>) => Promise<unknown>;
}) {
  const c = useCentreText();
  const [value, setValue] = useState(item.body),
    [copied, setCopied] = useState(false),
    [problem, setProblem] = useState('');
  const base = useRef({ body: item.body, revision: item.revision });
  useEffect(() => {
    if (value === base.current.body) {
      setValue(item.body);
      base.current = { body: item.body, revision: item.revision };
    }
  }, [item.body, item.revision, value]);
  const changed = value !== base.current.body,
    conflict = !busy && item.revision !== base.current.revision && changed;
  return (
    <div className="ac-draft">
      <label htmlFor={'draft-' + item.id}>{c("Brouillon à relire")}</label>
      <textarea
        id={'draft-' + item.id}
        value={value}
        maxLength={8000}
        onChange={(e) => {
          setValue(e.target.value);
          setCopied(false);
        }}
        rows={6}
      />
      <div className="ac-actions">
        <button
          type="button"
          disabled={busy || !changed || conflict}
          onClick={() => {
            setProblem('');
            void save(withDiagnosticIntent({
              action: 'work_item_update',
              id: item.id,
              revision: base.current.revision,
              body: value,
            }, 'automation_request', 'work_item_update'))
              .then((saved) => {
                if (saved === false) {
                  setProblem(
                    'Le brouillon n’a pas été enregistré. Votre texte reste ici.',
                  );
                  return;
                }
                base.current = {
                  body: value,
                  revision: base.current.revision + 1,
                };
              })
              .catch(() =>
                setProblem(
                  'Le brouillon n’a pas été enregistré. Votre texte reste ici.',
                ),
              );
          }}
        >
          {c("Enregistrer pour l’équipe")}</button>
        <button
          type="button"
          className="ac-quiet"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(value)
              .then(() => setCopied(true))
              .catch(() => setProblem('Sélectionnez le texte pour le copier.'));
          }}
        >
          {c(copied ? 'Copié' : 'Copier la réponse')}
        </button>
      </div>
      {conflict && (
        <p role="alert">
          {c("Un collègue a modifié ce brouillon. Copiez votre texte avant de recharger sa version.")}<button
            className="ac-quiet"
            type="button"
            onClick={() => {
              setValue(item.body);
              base.current = { body: item.body, revision: item.revision };
            }}
          >
            {c("Charger la version enregistrée")}</button>
        </p>
      )}
      {problem && <p role="alert">{c(problem)}</p>}
      <small>{c("Aucun message n’est envoyé automatiquement.")}</small>
    </div>
  );
}
export function AutomationRunRow({
  run,
  canManage,
  busy,
  act,
  quickMessage = false,
  onOpenSourceMessage,
}: {
  run: Run;
  canManage: boolean;
  busy: boolean;
  act: (v: Record<string, unknown>) => Promise<unknown>;
  quickMessage?: boolean;
  onOpenSourceMessage?: (id: string) => Promise<unknown>;
}) {
  const [choice, setChoice] = useState('');
  const [openingMessage, setOpeningMessage] = useState(false);
  const [messageProblem, setMessageProblem] = useState(false);
  const messageOpening = useRef(false);
  const messageOpeningGeneration = useRef(0);
  const runDetail = useRef<HTMLDetailsElement>(null);
  const messageDetail = useRef<HTMLDetailsElement>(null);
  const language = useAppLanguage();
  const label = (key: Parameters<typeof automationLabel>[0]) => automationLabel(key, language);
  const at = activityTimestamp(run.updatedAt) || activityTimestamp(run.createdAt);
  const confidence = run.result.confidence;
  const hasConfidence = typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
  const sourceId = typeof run.sourceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(run.sourceId) && run.sourceId !== '00000000-0000-0000-0000-000000000000' ? run.sourceId : undefined;
  const canOpenMessage = !!sourceId && !!onOpenSourceMessage;
  useEffect(() => {
    messageOpeningGeneration.current += 1;
    messageOpening.current = false;
    setOpeningMessage(false);
    setMessageProblem(false);
    return () => { messageOpeningGeneration.current += 1; };
  }, [run.id, sourceId]);
  function showExcerpt() {
    if (runDetail.current) runDetail.current.open = true;
    if (messageDetail.current) {
      messageDetail.current.open = true;
      messageDetail.current.querySelector('summary')?.focus();
    }
  }
  async function openMessage() {
    if (!canOpenMessage) { showExcerpt(); return; }
    if (messageOpening.current) return;
    messageOpening.current = true;
    const generation = messageOpeningGeneration.current;
    setOpeningMessage(true);
    setMessageProblem(false);
    try {
      await onOpenSourceMessage!(sourceId!);
    } catch {
      if (generation === messageOpeningGeneration.current) {
        setMessageProblem(true);
        showExcerpt();
      }
    } finally {
      if (generation === messageOpeningGeneration.current) {
        messageOpening.current = false;
        setOpeningMessage(false);
      }
    }
  }
  const messageButton = <button type="button" className="ac-quiet" disabled={openingMessage} aria-busy={openingMessage || undefined} onClick={() => void openMessage()}>
    {label(canOpenMessage ? 'openReceivedMessage' : 'receivedMessage')}
    {canOpenMessage ? <ArrowUpRight size={16} aria-hidden="true"/> : <ChevronDown size={16} aria-hidden="true"/>}
  </button>;
  return (
    <><details className="ac-run" ref={runDetail}>
      <summary>
        <span>
          <strong>{run.title}</strong>
          <small>{activityDateTime(at, language)}</small>
        </span>
        <span className="ac-status" data-state={run.state}>
          {automationRunStatus(run.state, language)}
        </span>
        <ChevronDown size={16} />
      </summary>
      <div className="ac-run__detail">
        <p>{run.result.message}</p>
        {!quickMessage && canOpenMessage && messageButton}
        {run.result.summary && (
          <details className="ac-source" ref={messageDetail}>
            <summary>{label('receivedMessage')} · {run.result.summary.subject}</summary>
            <p className="ac-meta">
              {run.result.summary.sender || label('senderUnknown')}
            </p>
            {run.result.summary.excerpts.map((e, i) => (
              <blockquote key={i}>{e.text}</blockquote>
            ))}
            {run.result.summary.attachments.length > 0 && (
              <p>
                {label('attachments')} : {run.result.summary.attachments.join(', ')}
              </p>
            )}
            <small>
              {label(run.result.summary.truncated ? 'sourceExcerptShort' : 'sourceExcerpt')}
            </small>
          </details>
        )}
        {hasConfidence && (
          <p className="ac-meta">
            {label('confidence')} : {new Intl.NumberFormat(`${language}-CH`, {style:'percent', maximumFractionDigits:0}).format(confidence!)}
            {' · '}{label('attempts')} : {run.attempts}. {label('confidenceHint')}
          </p>
        )}
        {activityTimestamp(run.dueAt) > 0 && <p>{label('nextStep')} : {activityDateTime(run.dueAt, language)}</p>}
        <ol>
          {run.definition.actions.map((a, index) => {
            const s = run.result.steps?.find((s) => s.index === index);
            return (
              <li key={index}>
                <strong>{label(`action_${a.type}`)}</strong> ·{' '}
                {a.title.replace(
                  /\{\{objet\}\}/g,
                  () => run.result.summary?.subject || label('receivedMessage'),
                )}
                <span>
                  {s?.state === 'completed'
                    ? label('created')
                    : s?.state === 'skipped'
                      ? label('branchSkipped')
                      : run.state === 'observed'
                        ? label('simulationOnly')
                        : label('waiting')}
                </span>
              </li>
            );
          })}
        </ol>
        {canManage && (
          <div className="ac-actions">
            {run.state === 'review' &&
              run.result.choice === 'uncertain' &&
              run.definition.decision && (
                <fieldset className="ac-run__choice" disabled={busy}>
                  <legend>{label('chooseNext')}</legend>
                  <div>
                    {(['yes', 'no'] as const).map(value => <label key={value}>
                      <input type="radio" name={`workflow-choice-${run.id}`} value={value} checked={choice === value} onChange={() => setChoice(value)}/>
                      <span>{label(value)} · {run.definition.decision![value]}</span>
                    </label>)}
                  </div>
                </fieldset>
              )}
            {run.state === 'review' && (
              <button
                disabled={
                  busy || (run.result.choice === 'uncertain' && !choice)
                }
                type="button"
                onClick={() =>
                  void act(withDiagnosticIntent({
                    action: 'workflow_confirm',
                    id: run.id,
                    revision: run.revision,
                    choice: choice || undefined,
                  }, 'automation_request', 'workflow_confirm'))
                }
              >
                {label('confirmActions')}
              </button>
            )}
            {run.state === 'failed' && (
              <button
                disabled={busy || run.attempts >= 5}
                type="button"
                onClick={() =>
                  void act(withDiagnosticIntent({
                    action: 'workflow_retry',
                    id: run.id,
                    revision: run.revision,
                  }, 'automation_request', 'workflow_retry'))
                }
              >
                {label('retry')}
              </button>
            )}
            {['review', 'failed', 'waiting', 'queued'].includes(run.state) && (
              <button
                disabled={busy}
                className="ac-quiet"
                type="button"
                onClick={() =>
                  void act(withDiagnosticIntent({
                    action: 'workflow_cancel',
                    id: run.id,
                    revision: run.revision,
                  }, 'automation_request', 'workflow_cancel'))
                }
              >
                {label('cancelNext')}
              </button>
            )}
            {run.state === 'completed' && (
              <button
                disabled={busy}
                className="ac-quiet"
                type="button"
                onClick={() =>
                  void act(withDiagnosticIntent({
                    action: 'workflow_undo',
                    id: run.id,
                    revision: run.revision,
                  }, 'automation_request', 'workflow_undo'))
                }
              >
                {label('undoUnused')}
              </button>
            )}
          </div>
        )}
      </div>
    </details>{quickMessage && (canOpenMessage || run.result.summary) && <div className="automation-journal__direct">{messageButton}</div>}
    {messageProblem && <p className="ac-meta" role="alert">{label(run.result.summary ? 'openMessageExcerptFallback' : 'openMessageUnavailable')}</p>}</>
  );
}
function RuleEditor({
  rule,
  members,
  busy,
  onSave,
  onClose,
  request,
}: {
  rule: Rule;
  members: AutomationCentreState['members'];
  busy: boolean;
  onSave: (v: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
  request: Requester;
}) {
  const c = useCentreText();
  const [draft, setDraft] = useState(rule),
    [preview, setPreview] = useState<{
      matched: boolean;
      message: string;
      actions: { title: string; body: string }[];
    } | null>(null),
    [problem, setProblem] = useState(''),
    [testing, setTesting] = useState(false);
  const d = draft.definition;
  const edit = (change: Partial<WorkflowDefinition>) => {
    setDraft({ ...draft, definition: { ...d, ...change } });
    setPreview(null);
  };
  const changeAction = (
    i: number,
    change: Partial<WorkflowDefinition['actions'][number]>,
  ) =>
    edit({
      actions: d.actions.map((a, n) => (n === i ? { ...a, ...change } : a)),
    });
  return (
    <form
      className="ac-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ ...draft, id: draft.id || undefined });
      }}
    >
      <div className="ac-editor__heading">
        <h3>{c(draft.id ? 'Modifier la règle' : 'Nouvelle règle')}</h3>
        <button
          type="button"
          className="ac-quiet"
          onClick={onClose}
          disabled={busy}
        >
          {c("Fermer")}</button>
      </div>
      <label>
        {c("Nom de la règle")}<input
          value={draft.name}
          maxLength={120}
          required
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <fieldset>
        <legend>{c("Quand")}</legend>
        <p className="ac-trigger">{c("Un message est classé dans Zentra Support")}</p>
      </fieldset>
      <fieldset>
        <legend>{c("Si")}</legend>
        <div className="ac-fields">
          <label>
            {c("Catégorie")}<select
              value={d.conditions.category}
              onChange={(e) =>
                edit({
                  conditions: { ...d.conditions, category: e.target.value },
                })
              }
            >
              <option value="">{c("Toutes les catégories")}</option>
              {Object.entries(categories).map(([v, label]) => (
                <option key={v} value={v}>
                  {c(label)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {c("Priorité")}<select
              value={d.conditions.priority}
              onChange={(e) =>
                edit({
                  conditions: { ...d.conditions, priority: e.target.value },
                })
              }
            >
              <option value="">{c("Toutes les priorités")}</option>
              <option value="urgent">{c("Urgente")}</option>
              <option value="high">{c("Élevée")}</option>
              <option value="normal">{c("Normale")}</option>
              <option value="low">{c("Basse")}</option>
            </select>
          </label>
          <label>
            {c("Expéditeur précis, facultatif")}<input
              type="email"
              value={d.conditions.sender}
              placeholder="contact@exemple.ch"
              onChange={(e) =>
                edit({
                  conditions: { ...d.conditions, sender: e.target.value },
                })
              }
            />
          </label>
        </div>
        <label className="ac-check">
          <input
            type="checkbox"
            checked={d.conditions.attachment}
            onChange={(e) =>
              edit({
                conditions: { ...d.conditions, attachment: e.target.checked },
              })
            }
          />
          {c("Seulement avec une pièce jointe")}</label>
      </fieldset>
      <fieldset>
        <legend>{c("Décision de Zentra")}</legend>
        <label className="ac-check">
          <input
            type="checkbox"
            checked={!!d.decision}
            onChange={(e) =>
              edit({
                decision: e.target.checked
                  ? { question: '', yes: '', no: '' }
                  : null,
                actions: d.actions.map((a) => ({ ...a, branch: 'always' })),
              })
            }
          />
          {c("Ajouter une décision pour choisir une branche")}</label>
        {d.decision && (
          <div className="ac-fields">
            <label>
              {c("Question")}<textarea
                rows={2}
                required
                value={d.decision.question}
                maxLength={500}
                onChange={(e) =>
                  edit({
                    decision: { ...d.decision!, question: e.target.value },
                  })
                }
              />
            </label>
            <label>
              {c("Branche Oui")}<input
                required
                maxLength={200}
                value={d.decision.yes}
                onChange={(e) =>
                  edit({ decision: { ...d.decision!, yes: e.target.value } })
                }
              />
            </label>
            <label>
              {c("Branche Non")}<input
                required
                maxLength={200}
                value={d.decision.no}
                onChange={(e) =>
                  edit({ decision: { ...d.decision!, no: e.target.value } })
                }
              />
            </label>
          </div>
        )}
        <p className="ac-help">
          {c("Une réponse incertaine demande une validation. Cette décision ne valide jamais un paiement ni une décision RH.")}</p>
      </fieldset>
      <fieldset>
        <legend>{c("Alors")}</legend>
        {d.actions.map((a, i) => (
          <div className="ac-action-editor" key={i}>
            <div className="ac-fields">
              <label>
                {c("Action")}<select
                  value={a.type}
                  onChange={(e) =>
                    changeAction(i, { type: e.target.value as typeof a.type })
                  }
                >
                  {Object.entries(actions).map(([v, label]) => (
                    <option key={v} value={v}>
                      {c(label)}
                    </option>
                  ))}
                </select>
              </label>
              {d.decision && (
                <label>
                  {c("Branche")}<select
                    value={a.branch}
                    onChange={(e) =>
                      changeAction(i, {
                        branch: e.target.value as typeof a.branch,
                      })
                    }
                  >
                    <option value="always">{c("Dans tous les cas")}</option>
                    <option value="yes">{c("Si Oui")}</option>
                    <option value="no">{c("Si Non")}</option>
                  </select>
                </label>
              )}
              <label>
                {c("Titre")}<input
                  required
                  value={a.title}
                  maxLength={160}
                  onChange={(e) => changeAction(i, { title: e.target.value })}
                />
              </label>
              <label>
                {c("Pour")}<select
                  value={a.assignedTo}
                  onChange={(e) =>
                    changeAction(i, { assignedTo: e.target.value })
                  }
                >
                  <option value="">{c("Toute l’équipe")}</option>
                  {members.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {c("Attendre, en heures")}<input
                  type="number"
                  min={0}
                  max={720}
                  step={1}
                  value={a.delayHours}
                  onChange={(e) =>
                    changeAction(i, { delayHours: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <label>
              {c(a.type === 'reply_draft'
                ? 'Modèle de réponse'
                : a.type === 'summary'
                  ? 'Note interne, facultative'
                  : 'Instructions')}
              <textarea
                rows={3}
                maxLength={4000}
                required={a.type === 'reply_draft'}
                value={a.body}
                onChange={(e) => changeAction(i, { body: e.target.value })}
              />
            </label>
            <p className="ac-help">
              {c("Champs disponibles :")}{'{{objet}}'}{c(",")}{'{{expediteur}}'}{c(",")}{' '}
              {'{{categorie}}'} {c("et")}{'{{priorite}}'}{c(".")}</p>
            {d.actions.length > 1 && (
              <button
                className="ac-quiet"
                type="button"
                onClick={() =>
                  edit({ actions: d.actions.filter((_, n) => n !== i) })
                }
              >
                {c("Retirer cette action")}</button>
            )}
          </div>
        ))}
        {d.actions.length < 8 && (
          <button
            type="button"
            className="ac-quiet"
            onClick={() =>
              edit({
                actions: [
                  ...d.actions,
                  {
                    type: 'task',
                    title: 'Suivre · {{objet}}',
                    body: '',
                    delayHours: 0,
                    branch: 'always',
                    assignedTo: '',
                  },
                ],
              })
            }
          >
            <Plus size={16} />
            {c("Ajouter une action")}</button>
        )}
      </fieldset>
      <fieldset>
        <legend>{c("Autonomie")}</legend>
        <div className="ac-fields">
          <label>
            {c("Comportement")}<select
              value={d.mode}
              onChange={(e) => edit({ mode: e.target.value as typeof d.mode })}
            >
              {Object.entries(modes).map(([v, label]) => (
                <option value={v} key={v}>
                  {c(label)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {c("Confiance minimale, en %")}<input
              type="number"
              min={80}
              max={100}
              step={1}
              value={Math.round(d.threshold * 100)}
              onChange={(e) =>
                edit({ threshold: Number(e.target.value) / 100 })
              }
            />
          </label>
        </div>
        <label className="ac-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          {c("Activer pour les prochains messages")}</label>
        <p className="ac-help">
          {c("Une règle arrêtée conserve son historique. Les demandes RH restent à confirmer. Les brouillons ne sont jamais envoyés.")}</p>
      </fieldset>
      <div className="ac-editor__footer">
        <button type="submit" disabled={busy}>
          {c("Enregistrer la règle")}</button>
        <button
          type="button"
          className="ac-quiet"
          disabled={busy || testing}
          onClick={() => {
            setTesting(true);
            setProblem('');
            void request(withDiagnosticIntent({
              action: 'workflow_preview',
              definition: d,
              sample: {
                subject: 'Demande de test',
                sender: d.conditions.sender || 'contact@exemple.ch',
                category: d.conditions.category || 'after_sales',
                priority: d.conditions.priority || 'normal',
                attachments: d.conditions.attachment ? ['document.pdf'] : [],
              },
            }, 'automation_request', 'workflow_preview'))
              .then((v) => setPreview(v as typeof preview))
              .catch((e) =>
                setProblem(
                  e instanceof Error ? e.message : 'Vérifiez la règle.',
                ),
              )
              .finally(() => setTesting(false));
          }}
        >
          {c("Simuler avec un exemple")}</button>
      </div>
      {problem && <p role="alert">{c(problem)}</p>}
      {preview && (
        <div className="ac-preview">
          <h4>
            {c("Exemple fictif ·")}{' '}
            {c(preview.matched
              ? 'conditions remplies'
              : 'conditions non remplies')}
          </h4>
          <p>{preview.message}</p>
          {preview.actions.map((a, i) => (
            <div key={i}>
              <strong>{a.title}</strong>
              <p className="ac-preserve">{a.body}</p>
            </div>
          ))}
        </div>
      )}
    </form>
  );
}
