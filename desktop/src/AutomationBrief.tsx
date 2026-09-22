import { ArrowUpRight, CalendarDays, Check, ChevronRight, FileText, Inbox, ListChecks, Settings2 } from 'lucide-react';
import './AutomationBrief.css';

export type BriefDestination = 'invoices' | 'appointments' | 'review' | 'work' | 'history' | 'settings' | 'support' | 'tools';
export type BriefActivity = {
  displayName?: string | null;
  totals: { analyzed: number; confirmed: number; needsReview: number; observed: number };
  supplierInbox?: { received: number; imported: number; automatic: number; needsReview: number };
  appointments?: { imported: number; pending: number };
  workflows?: { tasks: number; drafts: number; summaries: number; open: number; review: number; observed: number };
};
type Copy = [string,string,string,string];
const copy: Record<string, Copy> = {
  hello: ['Bonjour','Guten Tag','Buongiorno','Hello'],
  attention: ['À votre attention','Ihre nächsten Schritte','Alla tua attenzione','Needs your attention'],
  today: ['Aujourd’hui','Heute','Oggi','Today'],
  invoices: ['Factures à vérifier','Rechnungen prüfen','Fatture da verificare','Invoices to review'],
  appointments: ['Rendez-vous à compléter','Termine vervollständigen','Appuntamenti da completare','Appointments to complete'],
  review: ['Actions à valider','Aktionen bestätigen','Azioni da approvare','Actions to approve'],
  work: ['Tâches et réponses préparées','Vorbereitete Aufgaben und Antworten','Attività e risposte preparate','Prepared tasks and replies'],
  tools: ['Classements à vérifier','Zuordnungen prüfen','Classificazioni da verificare','Classifications to review'],
  imported: ['Factures enregistrées dans Gestion','In Gestion erfasste Rechnungen','Fatture registrate in Gestion','Invoices recorded in Gestion'],
  automatic: ['dont comptabilisées automatiquement','davon automatisch verbucht','di cui contabilizzate automaticamente','of which posted automatically'],
  calendar: ['Rendez-vous ajoutés à l’agenda','Im Kalender erfasste Termine','Appuntamenti aggiunti al calendario','Appointments added to the calendar'],
  drafts: ['Réponses préparées, à relire','Vorbereitete Antworten zur Prüfung','Risposte preparate da rileggere','Draft replies to review'],
  tasks: ['Tâches préparées pour l’équipe','Vorbereitete Teamaufgaben','Attività preparate per il team','Tasks prepared for the team'],
  summary: ['Résumés disponibles','Verfügbare Zusammenfassungen','Riepiloghi disponibili','Summaries available'],
  confirmed: ['Choix confirmés par l’équipe','Vom Team bestätigte Vorschläge','Scelte confermate dal team','Choices confirmed by the team'],
  clear: ['Aucune action en attente ici','Hier stehen keine Aktionen aus','Nessuna azione in attesa qui','No pending actions here'],
  empty: ['Les prochains résultats apparaîtront ici.','Die nächsten Ergebnisse erscheinen hier.','I prossimi risultati appariranno qui.','The next results will appear here.'],
  pause: ['Automation est en pause','Automation ist pausiert','Automation è in pausa','Automation is paused'],
  observe: ['Mode observation · aucune modification automatique','Beobachtungsmodus · keine automatischen Änderungen','Modalità osservazione · nessuna modifica automatica','Observation mode · no automatic changes'],
  live: ['Pour votre entreprise et votre équipe','Für Ihr Unternehmen und Ihr Team','Per la tua azienda e il tuo team','For your company and your team'],
  settings: ['Réglages','Einstellungen','Impostazioni','Settings'],
  history: ['Voir l’activité','Aktivität anzeigen','Vedi attività','View activity'],
  received: ['Factures reçues','Eingegangene Rechnungen','Fatture ricevute','Received invoices'],
  agenda: ['Rendez-vous','Termine','Appuntamenti','Appointments'],
  support: ['Ouvrir Support','Support öffnen','Apri Support','Open Support'],
};

/** Real company activity only. A review count is never presented as a completed action. */
export function AutomationBrief({ activity, paused = false, observation = false, compact = false, language = 'fr', onOpen }: {
  activity?: BriefActivity | null; paused?: boolean; observation?: boolean; compact?: boolean;
  language?: string; onOpen: (destination: BriefDestination) => void;
}) {
  const index = Math.max(0, ['fr','de','it','en'].indexOf(language));
  const label = (key: string) => copy[key][index];
  const pending = [
    { id: 'invoices' as const, count: activity?.supplierInbox?.needsReview ?? 0, icon: FileText },
    { id: 'appointments' as const, count: activity?.appointments?.pending ?? 0, icon: CalendarDays },
    { id: 'review' as const, count: activity?.workflows?.review ?? 0, icon: ListChecks },
    { id: 'work' as const, count: activity?.workflows?.open ?? 0, icon: Inbox },
    { id: 'tools' as const, count: activity?.totals.needsReview ?? 0, icon: ListChecks },
  ].filter(row => row.count > 0);
  const done = [
    { key: 'imported', count: activity?.supplierInbox?.imported ?? 0, target: 'invoices' as const },
    { key: 'calendar', count: activity?.appointments?.imported ?? 0, target: 'appointments' as const },
    { key: 'drafts', count: activity?.workflows?.drafts ?? 0, target: 'work' as const },
    { key: 'tasks', count: activity?.workflows?.tasks ?? 0, target: 'work' as const },
    { key: 'summary', count: activity?.workflows?.summaries ?? 0, target: 'work' as const },
    { key: 'confirmed', count: activity?.totals.confirmed ?? 0, target: 'tools' as const },
  ].filter(row => row.count > 0);
  return <section className={`automation-brief${compact ? ' automation-brief--compact' : ''}`} aria-label="Zentra Automation">
    <header className="automation-brief__intro">
      <div><h2>{compact ? 'Zentra Automation' : `${label('hello')}${activity?.displayName ? ', ' + activity.displayName : ''}.`}</h2>
      <p>{paused ? label('pause') : observation ? label('observe') : label('live')}</p></div>
      <button className="automation-brief__icon" type="button" onClick={() => onOpen('settings')} aria-label={label('settings')}><Settings2 size={19}/></button>
    </header>
    <div className="automation-brief__work">
      <h3>{label('attention')}</h3>
      {pending.length ? <div className="automation-brief__list">{pending.map(({id,count,icon:Icon}) => <button type="button" key={id} onClick={() => onOpen(id)}>
        <Icon size={20}/><span>{label(id)}</span><strong>{count}</strong><ChevronRight size={17}/>
      </button>)}</div> : <p className="automation-brief__empty"><Check size={20}/>{label('clear')}</p>}
    </div>
    <div className="automation-brief__day"><h3>{label('today')}</h3>
      {done.length ? <ul>{done.slice(0, compact ? 2 : 6).map(row => <li key={row.key}><Check size={16}/><span><strong>{row.count}</strong> {label(row.key)}{row.key === 'imported' && !!activity?.supplierInbox?.automatic && <small>{activity.supplierInbox.automatic} {label('automatic')}</small>}</span></li>)}</ul> : <p>{label('empty')}</p>}
      <button type="button" className="automation-brief__text" onClick={() => onOpen('history')}>{label('history')}<ChevronRight size={16}/></button>
    </div>
    {!compact && <nav className="automation-brief__destinations" aria-label="Gestion & Support">
      <button type="button" onClick={()=>onOpen('invoices')}><FileText size={18}/>{label('received')}</button>
      <button type="button" onClick={()=>onOpen('appointments')}><CalendarDays size={18}/>{label('agenda')}</button>
      <button type="button" onClick={()=>onOpen('support')}>{label('support')}<ArrowUpRight size={17}/></button>
    </nav>}
  </section>;
}
