import { useMemo, useState, type ReactNode } from 'react';
import { ArrowUpRight, CalendarDays, ChevronDown, FileText, RotateCcw, Search, Workflow, X } from 'lucide-react';
import type { AutomationActivity } from './automation';
import { useAppLanguage } from './language';
import { activityInvoiceAmount, activityTimestamp, activityTimeZone, automationLabel, invoiceActivityStatus } from './automationPresentation';
import type { AppointmentInboxItem, AppointmentInboxState } from './AppointmentInbox';
import { appointmentActivityStatus, appointmentSchedule, scopedAppointments } from './appointmentActivity';
import { confirmedQuoteActivityCopy, confirmedQuoteActivityKey, normalizeConfirmedQuoteActivityPage, type ConfirmedQuoteActivity, type ConfirmedQuoteActivityPage } from './confirmedQuoteActivity';
import './AutomationJournal.css';

type JournalRun = { id: string; title: string; state: string; createdAt: number; updatedAt: number };
type Invoice = NonNullable<AutomationActivity['supplierInbox']>['recent'][number];
type Entry<R> = { id: string; title: string; at: number } & ({ kind: 'workflow'; run: R } | { kind: 'invoice'; invoice: Invoice } | {kind:'appointment'; appointment:AppointmentInboxItem} | { kind: 'quote'; quote: ConfirmedQuoteActivity });

const journalCopy = {
  fr: { refresh: 'Actualiser', loading: 'Chargement de l’activité…', empty: 'Pas encore d’activité', results: 'Résultats disponibles' },
  de: { refresh: 'Aktualisieren', loading: 'Aktivität wird geladen…', empty: 'Noch keine Aktivität', results: 'Verfügbare Ergebnisse' },
  it: { refresh: 'Aggiorna', loading: 'Caricamento delle attività…', empty: 'Nessuna attività per ora', results: 'Risultati disponibili' },
  en: { refresh: 'Refresh', loading: 'Loading activity…', empty: 'No activity yet', results: 'Available results' },
} as const;

export function AutomationJournal<R extends JournalRun>({ runs, activity, renderRun, openInvoices, openInvoice, organizationId, appointments, appointmentsUnavailable, openAppointment, openAppointments, confirmedQuotes, openQuote, loading = false, unavailable = false, onRefresh }: {
  runs: R[]; activity?: AutomationActivity | null; renderRun: (run: R) => ReactNode; openInvoices?: () => void; openInvoice?: (id: string) => void;
  organizationId?: string; appointments?: AppointmentInboxState | null; appointmentsUnavailable?: boolean;
  openAppointment?: (id: string) => void; openAppointments?: () => void;
  confirmedQuotes?: ConfirmedQuoteActivityPage | null; openQuote?: (quoteId: string) => void;
  loading?: boolean; unavailable?: boolean; onRefresh?: () => void;
}) {
  const language = useAppLanguage();
  const label = (key: Parameters<typeof automationLabel>[0]) => automationLabel(key, language);
  const quoteCopy = confirmedQuoteActivityCopy(language);
  const copy = journalCopy[language as keyof typeof journalCopy] ?? journalCopy.fr;
  const quotePage = useMemo(() => normalizeConfirmedQuoteActivityPage(confirmedQuotes, organizationId), [confirmedQuotes, organizationId]);
  const quotesUnavailable = confirmedQuotes !== undefined && !quotePage;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'invoice' | 'appointment' | 'workflow' | 'quote'>('all');
  const effectiveFilter = filter === 'quote' && confirmedQuotes === undefined ? 'all' : filter;
  const [limit, setLimit] = useState(30);
  const entries = useMemo<Entry<R>[]>(() => [
    ...runs.map(run => ({ kind: 'workflow' as const, id: `run:${run.id}`, title: run.title, at: activityTimestamp(run.updatedAt) || activityTimestamp(run.createdAt), run })),
    ...(activity?.supplierInbox?.recent ?? []).map(invoice => ({ kind: 'invoice' as const, id: `invoice:${invoice.id}`, title: invoice.subject, at: activityTimestamp(invoice.imported_at) || activityTimestamp(invoice.created_at), invoice })),
    ...scopedAppointments(appointments, organizationId).map(appointment => ({kind:'appointment' as const, id:`appointment:${appointment.id}`,title:appointment.extraction.title || appointment.subject,at:activityTimestamp(appointment.updatedAt) || activityTimestamp(appointment.importedAt),appointment})),
    ...(quotePage?.items ?? []).map(quote => ({kind:'quote' as const, id:confirmedQuoteActivityKey(quotePage!.organizationId,quote.proposalId),title:quoteCopy.prepared,at:quote.confirmedAt,quote})),
  ].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)), [runs, activity?.supplierInbox?.recent, appointments, organizationId, quotePage, quoteCopy.prepared]);
  const normalized = query.trim().toLocaleLowerCase(language);
  const filtered = entries.filter(entry => (effectiveFilter === 'all' || entry.kind === effectiveFilter) && (!normalized || [entry.title,...(entry.kind==='invoice'?[entry.invoice.reference,entry.invoice.supplierName,entry.invoice.sender,entry.invoice.fileName]:entry.kind==='appointment'?[entry.appointment.subject,entry.appointment.sender,entry.appointment.extraction.location,entry.appointment.extraction.startDate]:[])].filter(Boolean).join(' ').toLocaleLowerCase(language).includes(normalized)));
  const timeZone = activityTimeZone(activity?.timeZone);
  const day = (at: number) => at ? new Intl.DateTimeFormat(`${language}-CH`, {dateStyle: 'long', timeZone}).format(at * 1000) : label('unavailableDate');
  const groups = new Map<string, Entry<R>[]>();
  for (const entry of filtered.slice(0, limit)) { const key = day(entry.at); groups.set(key, [...(groups.get(key) || []), entry]); }
  return <section className="automation-journal" aria-label={label('journal')} aria-busy={loading || undefined}>
    <header className="automation-journal__heading"><div><h2>{label('journal')}</h2><p>{label('recent')}</p></div>{onRefresh && <button type="button" className="ac-quiet automation-journal__refresh" disabled={loading} aria-label={copy.refresh} onClick={onRefresh}><RotateCcw size={17} aria-hidden="true"/><span>{copy.refresh}</span></button>}</header>
    <div className="automation-journal__toolbar">
      <div className="automation-journal__filters" role="group" aria-label={label('journal')}>
        {(['all', 'invoice', 'appointment', 'workflow', ...(confirmedQuotes !== undefined ? ['quote' as const] : [])] as const).map(value => <button type="button" key={value} aria-pressed={effectiveFilter === value} onClick={() => { setFilter(value); setLimit(30); }}>{value === 'quote' ? quoteCopy.filter : label(value === 'all' ? 'all' : value === 'invoice' ? 'invoices' : value === 'appointment' ? 'appointments' : 'rules')}</button>)}
      </div>
      <label className="automation-journal__search"><Search size={17} aria-hidden="true"/><input type="search" value={query} placeholder={label('search')} aria-label={label('search')} onChange={e => { setQuery(e.target.value); setLimit(30); }}/>{query && <button type="button" aria-label={label('clear')} onClick={()=>setQuery('')}><X size={16}/></button>}</label>
    </div>
    {loading && <p className="automation-journal__availability" role="status">{copy.loading}</p>}
    {unavailable && <p className="automation-journal__availability" role="status">{label('activityUnavailable')}</p>}
    {appointmentsUnavailable && <p role="status">{label('appointmentsUnavailable')}</p>}
    {quotesUnavailable && <p role="status">{quoteCopy.unavailable}</p>}
    {filtered.length === 0 ? ((quotesUnavailable || unavailable) && !entries.length ? null : loading && !entries.length ? <div className="automation-journal__skeleton" aria-hidden="true"><span/><span/><span/></div> : <div className="automation-journal__empty"><Workflow size={26} aria-hidden="true"/>{!entries.length && <h3>{copy.empty}</h3>}<p>{entries.length ? label('noResults') : label('empty')}</p></div>) : Array.from(groups, ([date, items]) => <section className="automation-journal__group" key={date}><h3>{date}</h3><ol>{items.map(entry => <li key={entry.id} className="automation-journal__entry" data-kind={entry.kind}>
      <span className="automation-journal__symbol" aria-hidden="true">{entry.kind === 'invoice' || entry.kind === 'quote' ? <FileText size={19}/> : entry.kind === 'appointment' ? <CalendarDays size={19}/> : <Workflow size={19}/>}</span>
      {entry.kind === 'workflow' ? renderRun(entry.run) : entry.kind === 'quote' ? <>
        <div className="ac-run automation-journal__quote"><strong>{entry.title}</strong><small><time dateTime={new Date(entry.at*1000).toISOString()}>{new Intl.DateTimeFormat(`${language}-CH`,{timeStyle:'short',timeZone}).format(entry.at*1000)}</time></small></div>
        {openQuote && !unavailable && <div className="automation-journal__direct"><button type="button" className="ac-quiet" onClick={()=>openQuote(entry.quote.quoteId)}>{quoteCopy.open}<ArrowUpRight size={16} aria-hidden="true"/></button></div>}
      </> : entry.kind === 'appointment' ? <><details className="ac-run automation-journal__appointment">
        <summary>
          <span><strong>{entry.title}</strong><small>{entry.at ? new Intl.DateTimeFormat(`${language}-CH`,{timeStyle:'short',timeZone}).format(entry.at*1000) : label('unavailableDate')}</small></span>
          <span className="ac-status" data-state={entry.appointment.state === 'imported' ? 'completed' : ['review','needs_review'].includes(entry.appointment.state) ? 'review' : entry.appointment.state === 'ignored' ? 'cancelled' : 'queued'}>{label(appointmentActivityStatus(entry.appointment))}</span>
          <ChevronDown size={16} aria-hidden="true"/>
        </summary>
        <div className="ac-run__detail">
          <dl className="automation-journal__facts" aria-label={label('appointmentDetails')}>
            <div><dt>{label('appointmentWhen')}</dt><dd>{appointmentSchedule(entry.appointment,language)}</dd></div>
            {entry.appointment.extraction.location && <div><dt>{label('appointmentPlace')}</dt><dd>{entry.appointment.extraction.location}</dd></div>}
            {entry.appointment.sender && <div><dt>{label('source')}</dt><dd>{entry.appointment.sender}</dd></div>}
          </dl>
        </div>
      </details><div className="automation-journal__direct">{entry.appointment.state === 'imported' && openAppointment ? <button type="button" className="ac-quiet" onClick={()=>openAppointment(entry.appointment.id)}>{label('openAppointment')}<ArrowUpRight size={16} aria-hidden="true"/></button> : openAppointments && <button type="button" className="ac-quiet" onClick={openAppointments}>{label('openAppointments')}<ArrowUpRight size={16} aria-hidden="true"/></button>}</div></> : <><details className="ac-run automation-journal__invoice">
        <summary>
          <span><strong>{entry.invoice.reference ? `${entry.invoice.supplierName || entry.title} · ${entry.invoice.reference}` : entry.title}</strong><small>{entry.at ? new Intl.DateTimeFormat(`${language}-CH`,{timeStyle:'short',timeZone}).format(entry.at*1000) : label('unavailableDate')}</small></span>
          <span className="ac-status" data-state={entry.invoice.state === 'imported' ? 'completed' : ['review','needs_review'].includes(entry.invoice.state) ? 'review' : 'queued'}>{label(invoiceActivityStatus(entry.invoice.state,entry.invoice.automatic))}</span>
          <ChevronDown size={16} aria-hidden="true"/>
        </summary>
        <div className="ac-run__detail">
          <dl className="automation-journal__facts" aria-label={label('invoiceDetails')}>
            {entry.invoice.supplierName && <div><dt>{label('supplier')}</dt><dd>{entry.invoice.supplierName}</dd></div>}
            {entry.invoice.reference && <div><dt>{label('reference')}</dt><dd>{entry.invoice.reference}</dd></div>}
            {activityInvoiceAmount(entry.invoice.totalCents,entry.invoice.currency,language) && <div><dt>{label('amountRead')}</dt><dd>{activityInvoiceAmount(entry.invoice.totalCents,entry.invoice.currency,language)}</dd></div>}
            {entry.invoice.sender && <div><dt>{label('source')}</dt><dd>{entry.invoice.sender}</dd></div>}
            {entry.invoice.fileName && <div><dt>{label('file')}</dt><dd>{entry.invoice.fileName}</dd></div>}
          </dl>
        </div>
      </details><div className="automation-journal__direct">{entry.invoice.state === 'imported' && entry.invoice.invoiceId && openInvoice ? <button type="button" className="ac-quiet" onClick={()=>openInvoice(entry.invoice.invoiceId!)}>{label('openInvoice')}<ArrowUpRight size={16} aria-hidden="true"/></button> : openInvoices && <button type="button" className="ac-quiet" onClick={openInvoices}>{label('openInbox')}<ArrowUpRight size={16} aria-hidden="true"/></button>}</div></>}
    </li>)}</ol></section>)}
    {filtered.length > 0 && <footer className="automation-journal__footer"><span>{copy.results} · {new Intl.NumberFormat(language).format(Math.min(limit, filtered.length))} / {new Intl.NumberFormat(language).format(filtered.length)}</span>{filtered.length > limit && <button type="button" className="ac-quiet" onClick={()=>setLimit(limit+30)}>{label('showMore')}</button>}</footer>}
  </section>;
}
