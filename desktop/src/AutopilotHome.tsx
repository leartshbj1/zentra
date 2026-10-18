import { ArrowRight, CalendarDays, Check, ChevronRight, FileText, Inbox, ListChecks } from 'lucide-react';
import { useCompanyAutomation } from './AutomationCompany';
import { useAppLanguage } from './language';
import { openAutomationHub } from './automationExperience';
import type { BriefActivity } from './AutomationBrief';
import './autopilot-home.css';

type Copy = [string, string, string, string];
const copy: Record<string, Copy> = {
  hello: ['Bonjour', 'Guten Tag', 'Buongiorno', 'Hello'],
  running: ['Autopilote est en marche', 'Autopilote läuft', 'Autopilote è attivo', 'Autopilote is running'],
  paused: ['Autopilote est en pause', 'Autopilote ist pausiert', 'Autopilote è in pausa', 'Autopilote is paused'],
  observing: ['Autopilote observe, sans rien modifier', 'Autopilote beobachtet, ohne etwas zu ändern', 'Autopilote osserva, senza modificare nulla', 'Autopilote is observing, without changing anything'],
  pendingOne: ['Une chose attend votre validation.', 'Eine Sache wartet auf Ihre Bestätigung.', 'Una cosa attende la tua conferma.', 'One thing is waiting for your approval.'],
  pendingMany: ['{n} choses attendent votre validation.', '{n} Dinge warten auf Ihre Bestätigung.', '{n} cose attendono la tua conferma.', '{n} things are waiting for your approval.'],
  clear: ['Tout est à jour.', 'Alles ist erledigt.', 'Tutto è in ordine.', 'You are all caught up.'],
  doneOne: ['Autopilote a déjà traité un élément aujourd’hui.', 'Autopilote hat heute bereits einen Vorgang erledigt.', 'Autopilote ha già gestito un elemento oggi.', 'Autopilote has already handled one item today.'],
  doneMany: ['Autopilote a déjà traité {n} éléments aujourd’hui.', 'Autopilote hat heute bereits {n} Vorgänge erledigt.', 'Autopilote ha già gestito {n} elementi oggi.', 'Autopilote has already handled {n} items today.'],
  doneNone: ['Autopilote prépare le travail. Vous gardez la décision.', 'Autopilote bereitet die Arbeit vor. Sie entscheiden.', 'Autopilote prepara il lavoro. La decisione resta tua.', 'Autopilote prepares the work. You keep the decision.'],
  validate: ['Valider maintenant', 'Jetzt bestätigen', 'Conferma ora', 'Review now'],
  activity: ['Voir l’activité', 'Aktivität anzeigen', 'Vedi attività', 'View activity'],
  resume: ['Ouvrir les réglages', 'Einstellungen öffnen', 'Apri impostazioni', 'Open settings'],
  toValidate: ['À valider', 'Zu bestätigen', 'Da confermare', 'To approve'],
  doneToday: ['Fait aujourd’hui', 'Heute erledigt', 'Fatto oggi', 'Done today'],
  nothingPending: ['Rien en attente', 'Nichts ausstehend', 'Niente in attesa', 'Nothing pending'],
  nothingDone: ['Les prochains résultats apparaîtront ici.', 'Die nächsten Ergebnisse erscheinen hier.', 'I prossimi risultati appariranno qui.', 'The next results will appear here.'],
  invoices: ['Factures à vérifier', 'Rechnungen prüfen', 'Fatture da verificare', 'Invoices to review'],
  appointments: ['Rendez-vous à compléter', 'Termine vervollständigen', 'Appuntamenti da completare', 'Appointments to complete'],
  review: ['Actions à valider', 'Aktionen bestätigen', 'Azioni da approvare', 'Actions to approve'],
  work: ['Tâches et réponses préparées', 'Vorbereitete Aufgaben und Antworten', 'Attività e risposte preparate', 'Prepared tasks and replies'],
  tools: ['Classements à vérifier', 'Zuordnungen prüfen', 'Classificazioni da verificare', 'Classifications to review'],
  imported: ['Factures enregistrées', 'Rechnungen erfasst', 'Fatture registrate', 'Invoices recorded'],
  calendar: ['Rendez-vous ajoutés à l’agenda', 'Termine im Kalender erfasst', 'Appuntamenti aggiunti al calendario', 'Appointments added to the calendar'],
  drafts: ['Réponses préparées', 'Antworten vorbereitet', 'Risposte preparate', 'Replies prepared'],
  tasks: ['Tâches préparées', 'Aufgaben vorbereitet', 'Attività preparate', 'Tasks prepared'],
  summary: ['Résumés disponibles', 'Zusammenfassungen verfügbar', 'Riepiloghi disponibili', 'Summaries available'],
  confirmed: ['Choix confirmés', 'Vorschläge bestätigt', 'Scelte confermate', 'Choices confirmed'],
  offerTitle: ['Laissez Autopilote faire le travail.', 'Lassen Sie Autopilote die Arbeit machen.', 'Lascia che Autopilote faccia il lavoro.', 'Let Autopilote do the work.'],
  offerText: ['Factures fournisseurs, rendez-vous et demandes de devis sont préparés pour vous. Vous n’avez plus qu’à valider.', 'Lieferantenrechnungen, Termine und Offertanfragen werden für Sie vorbereitet. Sie bestätigen nur noch.', 'Fatture fornitori, appuntamenti e richieste di preventivo vengono preparati per te. Devi solo confermare.', 'Supplier invoices, appointments and quote requests are prepared for you. You only approve.'],
  discover: ['Découvrir Autopilote', 'Autopilote entdecken', 'Scopri Autopilote', 'Discover Autopilote'],
};

type Pending = 'invoices' | 'appointments' | 'review' | 'work' | 'tools';

function counts(activity?: BriefActivity | null) {
  const pending = ([
    ['invoices', activity?.supplierInbox?.needsReview ?? 0, FileText],
    ['appointments', activity?.appointments?.pending ?? 0, CalendarDays],
    ['review', activity?.workflows?.review ?? 0, ListChecks],
    ['work', activity?.workflows?.open ?? 0, Inbox],
    ['tools', activity?.totals.needsReview ?? 0, ListChecks],
  ] as const).filter(([, count]) => count > 0);
  const done = ([
    ['imported', activity?.supplierInbox?.imported ?? 0, 'invoices'],
    ['calendar', activity?.appointments?.imported ?? 0, 'appointments'],
    ['drafts', activity?.workflows?.drafts ?? 0, 'work'],
    ['tasks', activity?.workflows?.tasks ?? 0, 'work'],
    ['summary', activity?.workflows?.summaries ?? 0, 'work'],
    ['confirmed', activity?.totals.confirmed ?? 0, 'tools'],
  ] as const).filter(([, count]) => count > 0);
  return { pending, done };
}

/** The first thing on the home screen: what Autopilote did, and what is left for a person to approve. */
export function AutopilotHome() {
  const language = useAppLanguage();
  const { state } = useCompanyAutomation();
  const index = Math.max(0, ['fr', 'de', 'it', 'en'].indexOf(language));
  const label = (key: string, n?: number) => copy[key][index].replace('{n}', String(n ?? ''));
  const hub = (page: Pending | 'history' | 'settings' | 'overview') => openAutomationHub(page === 'review' ? 'centre' : page as never);

  if (!state?.active || !state.activity) {
    return <section className="autopilot-home autopilot-home--offer" aria-label="Zentra Autopilote">
      <div className="autopilot-home__lead">
        <p className="autopilot-home__status"><span className="autopilot-home__orb" aria-hidden="true" />Zentra Autopilote</p>
        <h2>{label('offerTitle')}</h2>
        <p className="autopilot-home__sentence">{label('offerText')}</p>
        <div className="autopilot-home__actions">
          <button type="button" className="autopilot-home__primary" onClick={() => hub('overview')}>{label('discover')}<ArrowRight size={17} aria-hidden="true" /></button>
        </div>
      </div>
    </section>;
  }

  const activity = state.activity;
  const paused = !state.settings.enabled || !state.settings.consent || !state.available.some(f => state.settings.flags.includes(f));
  const observing = state.settings.mode === 'shadow';
  const { pending, done } = counts(activity);
  const pendingTotal = pending.reduce((sum, [, count]) => sum + count, 0);
  const doneTotal = done.reduce((sum, [, count]) => sum + count, 0);
  const name = activity.displayName ? `, ${activity.displayName}` : '';
  return <section className="autopilot-home" data-state={paused ? 'paused' : 'running'} aria-label="Zentra Autopilote">
    <div className="autopilot-home__lead">
      <p className="autopilot-home__status"><span className="autopilot-home__orb" aria-hidden="true" />{paused ? label('paused') : observing ? label('observing') : label('running')}</p>
      <h2><span>{label('hello')}{name}.</span> {pendingTotal ? (pendingTotal === 1 ? label('pendingOne') : label('pendingMany', pendingTotal)) : label('clear')}</h2>
      <p className="autopilot-home__sentence">{doneTotal ? (doneTotal === 1 ? label('doneOne') : label('doneMany', doneTotal)) : label('doneNone')}</p>
      <div className="autopilot-home__actions">
        {paused
          ? <button type="button" className="autopilot-home__primary" onClick={() => hub('settings')}>{label('resume')}<ArrowRight size={17} aria-hidden="true" /></button>
          : pendingTotal
            ? <button type="button" className="autopilot-home__primary" onClick={() => hub(pending[0][0])}>{label('validate')}<ArrowRight size={17} aria-hidden="true" /></button>
            : null}
        <button type="button" className="autopilot-home__secondary" onClick={() => hub('history')}>{label('activity')}<ChevronRight size={16} aria-hidden="true" /></button>
      </div>
    </div>
    <div className="autopilot-home__columns">
      <div>
        <h3>{label('toValidate')}</h3>
        {pending.length ? <ul>{pending.map(([id, count, Icon]) => <li key={id}><button type="button" onClick={() => hub(id)}>
          <Icon size={18} aria-hidden="true" /><span>{label(id)}</span><strong>{count}</strong><ChevronRight size={16} aria-hidden="true" />
        </button></li>)}</ul> : <p className="autopilot-home__empty"><Check size={18} aria-hidden="true" />{label('nothingPending')}</p>}
      </div>
      <div>
        <h3>{label('doneToday')}</h3>
        {done.length ? <ul>{done.slice(0, 4).map(([key, count, target]) => <li key={key}><button type="button" onClick={() => hub(target)}>
          <Check size={18} aria-hidden="true" /><span>{label(key)}</span><strong>{count}</strong><ChevronRight size={16} aria-hidden="true" />
        </button></li>)}</ul> : <p className="autopilot-home__empty">{label('nothingDone')}</p>}
      </div>
    </div>
  </section>;
}
