import { useMemo, useState, type ReactNode } from 'react';
import { ArrowUpRight, FileText, Search, Workflow, X } from 'lucide-react';
import type { AutomationActivity } from './automation';
import { useAppLanguage } from './language';
import { activityTimestamp, automationLabel } from './automationPresentation';

type JournalRun = { id: string; title: string; state: string; createdAt: number; updatedAt: number };
type Invoice = NonNullable<AutomationActivity['supplierInbox']>['recent'][number];
type Entry<R> = { id: string; title: string; at: number } & ({ kind: 'workflow'; run: R } | { kind: 'invoice'; invoice: Invoice });

export function AutomationJournal<R extends JournalRun>({ runs, activity, renderRun, openInvoices }: {
  runs: R[]; activity?: AutomationActivity | null; renderRun: (run: R) => ReactNode; openInvoices?: () => void;
}) {
  const language = useAppLanguage();
  const label = (key: Parameters<typeof automationLabel>[0]) => automationLabel(key, language);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'invoice' | 'workflow'>('all');
  const [limit, setLimit] = useState(30);
  const entries = useMemo<Entry<R>[]>(() => [
    ...runs.map(run => ({ kind: 'workflow' as const, id: `run:${run.id}`, title: run.title, at: activityTimestamp(run.updatedAt || run.createdAt), run })),
    ...(activity?.supplierInbox?.recent ?? []).map(invoice => ({ kind: 'invoice' as const, id: `invoice:${invoice.id}`, title: invoice.subject, at: activityTimestamp(invoice.imported_at), invoice })),
  ].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)), [runs, activity?.supplierInbox?.recent]);
  const normalized = query.trim().toLocaleLowerCase(language);
  const filtered = entries.filter(entry => (filter === 'all' || entry.kind === filter) && (!normalized || entry.title.toLocaleLowerCase(language).includes(normalized)));
  const day = (at: number) => at ? new Intl.DateTimeFormat(`${language}-CH`, {dateStyle: 'long', timeZone: activity?.timeZone || 'Europe/Zurich'}).format(at * 1000) : label('unavailableDate');
  const groups = new Map<string, Entry<R>[]>();
  for (const entry of filtered.slice(0, limit)) { const key = day(entry.at); groups.set(key, [...(groups.get(key) || []), entry]); }
  return <section className="automation-journal" aria-label={label('journal')}>
    <header className="automation-journal__heading"><div><h2>{label('journal')}</h2><p>{label('recent')}</p></div></header>
    <div className="automation-journal__toolbar">
      <div className="automation-journal__filters" aria-label={label('journal')}>
        {(['all', 'invoice', 'workflow'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setLimit(30); }}>{label(value === 'all' ? 'all' : value === 'invoice' ? 'invoices' : 'rules')}</button>)}
      </div>
      <label className="automation-journal__search"><Search size={17} aria-hidden="true"/><input type="search" value={query} placeholder={label('search')} aria-label={label('search')} onChange={e => { setQuery(e.target.value); setLimit(30); }}/>{query && <button type="button" aria-label={label('clear')} onClick={()=>setQuery('')}><X size={16}/></button>}</label>
    </div>
    {filtered.length === 0 ? <div className="automation-journal__empty"><Workflow size={26} aria-hidden="true"/><p>{entries.length ? label('noResults') : label('empty')}</p></div> : Array.from(groups, ([date, items]) => <section className="automation-journal__group" key={date}><h3>{date}</h3><ol>{items.map(entry => <li key={entry.id} className="automation-journal__entry">
      <span className="automation-journal__symbol" aria-hidden="true">{entry.kind === 'invoice' ? <FileText size={19}/> : <Workflow size={19}/>}</span>
      {entry.kind === 'workflow' ? renderRun(entry.run) : <button type="button" className="automation-journal__invoice" onClick={openInvoices} disabled={!openInvoices}>
        <span><strong>{entry.title}</strong><small>{entry.at ? new Intl.DateTimeFormat(`${language}-CH`,{timeStyle:'short',timeZone:activity?.timeZone || 'Europe/Zurich'}).format(entry.at*1000) : label('invoices')}</small></span>
        <span className="ac-status" data-state={entry.invoice.state === 'imported' ? 'completed' : entry.invoice.state === 'needs_review' ? 'review' : 'queued'}>{label(entry.invoice.state === 'imported' ? (entry.invoice.automatic ? 'automatic' : 'imported') : entry.invoice.state === 'needs_review' ? 'review' : 'waiting')}</span>
        <ArrowUpRight size={16} aria-hidden="true"/>
      </button>}
    </li>)}</ol></section>)}
    {filtered.length > limit && <button type="button" className="ac-quiet" onClick={()=>setLimit(limit+30)}>{label('showMore')}</button>}
  </section>;
}
