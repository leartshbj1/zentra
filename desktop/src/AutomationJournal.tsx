import { useMemo, useState, type ReactNode } from 'react';
import { ArrowUpRight, ChevronDown, FileText, Search, Workflow, X } from 'lucide-react';
import type { AutomationActivity } from './automation';
import { useAppLanguage } from './language';
import { activityInvoiceAmount, activityTimestamp, activityTimeZone, automationLabel, invoiceActivityStatus } from './automationPresentation';

type JournalRun = { id: string; title: string; state: string; createdAt: number; updatedAt: number };
type Invoice = NonNullable<AutomationActivity['supplierInbox']>['recent'][number];
type Entry<R> = { id: string; title: string; at: number } & ({ kind: 'workflow'; run: R } | { kind: 'invoice'; invoice: Invoice });

export function AutomationJournal<R extends JournalRun>({ runs, activity, renderRun, openInvoices, openInvoice }: {
  runs: R[]; activity?: AutomationActivity | null; renderRun: (run: R) => ReactNode; openInvoices?: () => void; openInvoice?: (id: string) => void;
}) {
  const language = useAppLanguage();
  const label = (key: Parameters<typeof automationLabel>[0]) => automationLabel(key, language);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'invoice' | 'workflow'>('all');
  const [limit, setLimit] = useState(30);
  const entries = useMemo<Entry<R>[]>(() => [
    ...runs.map(run => ({ kind: 'workflow' as const, id: `run:${run.id}`, title: run.title, at: activityTimestamp(run.updatedAt || run.createdAt), run })),
    ...(activity?.supplierInbox?.recent ?? []).map(invoice => ({ kind: 'invoice' as const, id: `invoice:${invoice.id}`, title: invoice.subject, at: activityTimestamp(invoice.imported_at) || activityTimestamp(invoice.created_at), invoice })),
  ].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)), [runs, activity?.supplierInbox?.recent]);
  const normalized = query.trim().toLocaleLowerCase(language);
  const filtered = entries.filter(entry => (filter === 'all' || entry.kind === filter) && (!normalized || [entry.title,...(entry.kind==='invoice'?[entry.invoice.reference,entry.invoice.supplierName,entry.invoice.sender,entry.invoice.fileName]:[])].filter(Boolean).join(' ').toLocaleLowerCase(language).includes(normalized)));
  const timeZone = activityTimeZone(activity?.timeZone);
  const day = (at: number) => at ? new Intl.DateTimeFormat(`${language}-CH`, {dateStyle: 'long', timeZone}).format(at * 1000) : label('unavailableDate');
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
      {entry.kind === 'workflow' ? renderRun(entry.run) : <details className="ac-run automation-journal__invoice">
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
          {entry.invoice.state === 'imported' && entry.invoice.invoiceId && openInvoice ? <button type="button" className="ac-quiet" onClick={()=>openInvoice(entry.invoice.invoiceId!)}>{label('openInvoice')}<ArrowUpRight size={16} aria-hidden="true"/></button> : openInvoices && <button type="button" className="ac-quiet" onClick={openInvoices}>{label('openInbox')}<ArrowUpRight size={16} aria-hidden="true"/></button>}
        </div>
      </details>}
    </li>)}</ol></section>)}
    {filtered.length > limit && <button type="button" className="ac-quiet" onClick={()=>setLimit(limit+30)}>{label('showMore')}</button>}
  </section>;
}
