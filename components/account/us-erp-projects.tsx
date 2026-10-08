'use client';

import { useId, useState, type SubmitEvent } from 'react';
import type { AccountRole } from '@/lib/account-security';
import type { SiteLanguage } from '@/lib/site-language';
import { browserProjectsCopy } from '@/lib/international/browser-projects-copy';
import { browserWorkbenchCopy } from '@/lib/international/browser-workbench-copy';
import { browserDocumentAnchor, browserLegacyProjectReferences, browserProjectDraft, browserProjectFigures, buildBrowserProjectsCommand, canUseBrowserProjects, emptyBrowserProject, type BrowserProjectDraft } from '@/lib/international/browser-projects';
import { formatDateOnly } from '@/lib/international/localization';
import { formatMoney } from '@/lib/international/money';
import { invoiceBalance, estimateTotals } from '@/lib/international/invoicing';
import { vendorBillBalance } from '@/lib/international/purchasing';
import type { ErpCommand, ErpState } from '@/lib/international/runtime-types';
import { UsDocumentExports } from './us-erp-reports';
import './us-erp-projects.css';

const locales: Record<SiteLanguage, string> = { en: 'en-US', fr: 'fr-US', de: 'de-US', it: 'it-US' };
type ProjectCommand = Extract<ErpCommand, { type: 'save_projects' }>;
type Row = { id: string; draft: BrowserProjectDraft; expectedProjectRevision: number };
type Editor = { kind: 'project' | 'legacy'; rows: readonly Row[] };
type ExportAccess = Omit<Parameters<typeof UsDocumentExports>[0], 'selector' | 'revision'>;

export function UsErpProjects({ state, organizationId, language, role, disabled, onWrite, exportAccess }: {
  state: ErpState; organizationId: string; language: SiteLanguage; role: AccountRole; disabled: boolean;
  onWrite: (command: ProjectCommand) => void; exportAccess?: ExportAccess;
}) {
  const c = browserProjectsCopy[language], common = browserWorkbenchCopy[language], prefix = useId(), locale = locales[language];
  const allowed = canUseBrowserProjects(role, 3), projects = state.projects ?? [], legacy = browserLegacyProjectReferences(state);
  const [selectedId, setSelectedId] = useState<string | null>(null), [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [page, setPage] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null), [legacyPage, setLegacyPage] = useState(0);
  const [review, setReview] = useState<{ command: ProjectCommand; revision: number; kind: 'save' | 'archive' | 'restore' | 'legacy' } | null>(null), [error, setError] = useState<'invalid' | 'stale' | null>(null);
  // Mask before effects run: a prior review is never actionable after another commit.
  const activeReview = review?.revision === state.revision ? review : null;
  const selected = projects.find(project => project.id === selectedId);
  const figures = selected ? browserProjectFigures(state, selected) : null;
  const matched = projects.filter(project => (filter === 'all' || project.status === filter) && `${project.name}\n${project.number}\n${state.customers.find(customer => customer.id === project.customerId)?.name ?? ''}`.toLocaleLowerCase(locales[language]).includes(query.toLocaleLowerCase(locales[language]))).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number.localeCompare(a.number));
  const count = Math.max(1, Math.ceil(matched.length / 20)), visiblePage = Math.min(page, count - 1);
  const money = (value: Parameters<typeof formatMoney>[0]) => formatMoney(value, locale);
  const date = (value: string | null) => value === null ? c.noBudget : formatDateOnly(value, locale);
  const update = (id: string, patch: Partial<BrowserProjectDraft>) => { setReview(null); setError(null); setEditor(previous => previous ? { ...previous, rows: previous.rows.map(row => row.id === id ? { ...row, draft: { ...row.draft, ...patch } } : row) } : null); };
  const close = () => { setEditor(null); setReview(null); setError(null); };
  const open = (id: string | null) => { close(); setSelectedId(id); };
  const begin = () => { close(); setEditor({ kind: 'project', rows: [{ id: crypto.randomUUID(), expectedProjectRevision: 0, draft: emptyBrowserProject() }] }); };
  function prepare(rows: readonly Row[], kind: 'save' | 'archive' | 'restore' | 'legacy') {
    if (disabled || !allowed) return;
    try { setReview({ command: buildBrowserProjectsCommand(organizationId, state, rows), revision: state.revision, kind }); setError(null); }
    catch { setReview(null); setError('invalid'); }
  }
  const submit = (event: SubmitEvent<HTMLFormElement>) => { event.preventDefault(); if (editor) prepare(editor.rows, editor.kind === 'legacy' ? 'legacy' : 'save'); };
  const confirm = () => {
    if (disabled || !allowed || !activeReview) return;
    // This exact validated command goes through the shared financial write lock.
    const command = activeReview.command; setReview(null); onWrite(command);
  };
  const billsFor = (id: string) => (state.vendorBills ?? []).filter(bill => !projects.some(project => project.id !== id && project.vendorBillIds.includes(bill.id)));
  const field = (row: Row, key: 'name' | 'startDate' | 'targetDate' | 'budget', label: string) => <label htmlFor={`${prefix}-${encodeURIComponent(row.id)}-${key}`}>{label}<input id={`${prefix}-${encodeURIComponent(row.id)}-${key}`} value={row.draft[key]} required={key === 'name'} maxLength={key === 'name' ? 200 : key === 'budget' ? 39 : undefined} type={key === 'startDate' || key === 'targetDate' ? 'date' : 'text'} inputMode={key === 'budget' ? 'decimal' : undefined} onChange={event => update(row.id, { [key]: event.target.value })} /></label>;
  const editRows = editor?.kind === 'legacy' ? editor.rows.slice(legacyPage * 10, legacyPage * 10 + 10) : editor?.rows ?? [];
  const legacyBlocked = legacy.length > 1000 || legacy.some(reference => reference.customerIds.length !== 1 || !state.customers.some(customer => customer.id === reference.customerIds[0]));
  return <section className="us-erp-section us-erp-projects" aria-label={c.title}>
    <header className="us-erp-record-heading"><div><h2>{selected ? selected.name : c.title}</h2><p className="us-erp-muted">{selected ? `${selected.number} · ${state.customers.find(customer => customer.id === selected.customerId)?.name ?? selected.customerId}` : c.introduction}</p></div>
      {selected ? <button type="button" className="account-button secondary" onClick={() => open(null)}>{c.back}</button> : allowed && !legacy.length && <button type="button" className="account-button" disabled={disabled || !state.customers.length} onClick={begin}>{c.newProject}</button>}
    </header>
    {!allowed && <p className="us-erp-muted">{c.readOnly}</p>}
    {error && <p className="us-erp-notice error" role="alert">{c[error]}</p>}
    {legacy.length > 0 && <details className="us-project-legacy"><summary>{c.legacyTitle} · {legacy.length}</summary><p>{c.legacyHelp}</p>
      {legacy.length > 1000 ? <p role="alert">{c.legacyTooMany}</p> : legacyBlocked ? <p role="alert">{c.legacyConflict}</p> : allowed && <button type="button" className="account-button secondary" disabled={disabled} onClick={() => { close(); setLegacyPage(0); setEditor({ kind: 'legacy', rows: legacy.map(reference => ({ id: reference.id, expectedProjectRevision: 0, draft: { ...emptyBrowserProject(), customerId: reference.customerIds[0] } })) }); }}>{c.legacyReview}</button>}
      <ul>{legacy.slice(0, 20).map(reference => <li key={reference.id}><strong>{reference.id}</strong> · {c.legacyDocuments}: {reference.estimateIds.length + reference.invoiceIds.length}</li>)}</ul>
    </details>}
    {selected && figures ? <div className="us-project-folder">
      <dl className="us-project-overview"><div><dt>{c.customer}</dt><dd>{state.customers.find(customer => customer.id === selected.customerId)?.name ?? selected.customerId}</dd></div><div><dt>{c.filter}</dt><dd>{c[selected.status]}</dd></div><div><dt>{c.budget}</dt><dd>{selected.budget === null ? c.noBudget : money(selected.budget)}</dd></div><div><dt>{c.start}</dt><dd>{date(selected.startDate)}</dd></div><div><dt>{c.target}</dt><dd>{date(selected.targetDate)}</dd></div><div><dt>{c.revision}</dt><dd>{selected.revision}</dd></div></dl>
      {selected.notes && <div className="us-project-notes"><h3>{c.notes}</h3><p>{selected.notes}</p></div>}
      {allowed && <div className="us-erp-actions"><button type="button" className="account-button secondary" disabled={disabled} onClick={() => { close(); setEditor({ kind: 'project', rows: [{ id: selected.id, expectedProjectRevision: selected.revision, draft: browserProjectDraft(selected) }] }); }}>{c.edit}</button><button type="button" className="account-button secondary" disabled={disabled} onClick={() => { close(); prepare([{ id: selected.id, expectedProjectRevision: selected.revision, draft: { ...browserProjectDraft(selected), status: selected.status === 'active' ? 'archived' : 'active' } }], selected.status === 'active' ? 'archive' : 'restore'); }}>{selected.status === 'active' ? c.archive : c.restore}</button></div>}
      <section className="us-project-documents" aria-label={c.sales}><h3>{c.sales}</h3><dl className="us-project-balances">{(['estimatedNet', 'invoicedNet', 'invoicedTotal', 'received', 'receivable'] as const).map(key => <div key={key}><dt>{c[key]}</dt><dd>{money(figures[key])}</dd></div>)}</dl>
        {!figures.estimates.length && !figures.invoices.length && <p className="us-erp-muted">{c.noSales}</p>}
        <ul className="us-project-document-list">{figures.estimates.map(document => <li key={document.id}><a href={`#${browserDocumentAnchor('estimate', document.id)}`}>{c.estimates} · {document.number}</a><span>{formatDateOnly(document.date, locale)}</span><strong>{money(estimateTotals(document).net)}</strong></li>)}{figures.invoices.map(document => <li key={document.id}><a href={`#${browserDocumentAnchor('invoice', document.id)}`}>{c.invoices} · {document.number}</a><span>{formatDateOnly(document.date, locale)}</span><div><strong>{money(document.total)}</strong><span>{c.balance}: {money(invoiceBalance(document))}</span></div></li>)}</ul>
      </section>
      <section className="us-project-documents" aria-label={c.purchases}><h3>{c.purchases}</h3><dl className="us-project-balances">{(['purchasedNet', 'purchasedTotal', 'payable'] as const).map(key => <div key={key}><dt>{c[key]}</dt><dd>{money(figures[key])}</dd></div>)}</dl>
        {!figures.bills.length && <p className="us-erp-muted">{c.noPurchases}</p>}<ul className="us-project-document-list">{figures.bills.map(bill => <li key={bill.id}><a href={`#${browserDocumentAnchor('vendor_bill', bill.id)}`}>{bill.vendorSnapshot.name} · {bill.reference}</a><span>{formatDateOnly(bill.date, locale)}</span><div><strong>{money(bill.total)}</strong><span>{c.balance}: {money(vendorBillBalance(bill, (state.vendorPayments ?? []).filter(payment => payment.billId === bill.id)))}</span></div></li>)}</ul>
      </section><p className="us-erp-muted">{c.figuresHelp}</p>
      {exportAccess && <div className="us-project-exports"><h3>{c.export}</h3><UsDocumentExports {...exportAccess} selector={{ kind: 'document', documentType: 'project', id: selected.id }} revision={state.revision} /></div>}
    </div> : <>
      {!!projects.length && <div className="us-project-filters"><label htmlFor={`${prefix}-search`}>{c.search}<input id={`${prefix}-search`} type="search" value={query} maxLength={200} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label><label htmlFor={`${prefix}-status`}>{c.filter}<select aria-label={c.filter} id={`${prefix}-status`} value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }}><option value="all">{c.all}</option><option value="active">{c.active}</option><option value="archived">{c.archived}</option></select></label></div>}
      {!projects.length && !legacy.length && <p className="us-erp-muted">{state.customers.length ? c.empty : c.noCustomer}</p>}
      {!!projects.length && !matched.length && <p className="us-erp-muted">{c.noResult}</p>}
      <ul className="us-project-list">{matched.slice(visiblePage * 20, visiblePage * 20 + 20).map(project => <li key={project.id}><button type="button" onClick={() => open(project.id)}><strong>{project.name}</strong><span>{project.number} · {state.customers.find(customer => customer.id === project.customerId)?.name ?? project.customerId}</span></button><span className="us-project-status">{c[project.status]}</span></li>)}</ul>
      {count > 1 && <div className="us-erp-actions us-project-pagination"><button type="button" className="account-button secondary" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>{c.previous}</button><span>{visiblePage + 1} / {count}</span><button type="button" className="account-button secondary" disabled={visiblePage + 1 >= count} onClick={() => setPage(visiblePage + 1)}>{c.next}</button></div>}
    </>}
    {editor && allowed && <section className="us-project-editor" aria-label={editor.kind === 'legacy' ? c.legacyTitle : c.edit}><div className="us-erp-record-heading"><h3>{editor.kind === 'legacy' ? c.legacyTitle : editor.rows[0].expectedProjectRevision === 0 ? c.newProject : c.edit}</h3><button type="button" className="account-button secondary" disabled={disabled} onClick={close}>{c.close}</button></div><form onSubmit={submit}><fieldset className="us-erp-form" disabled={disabled}>
      {editRows.map(row => {
        const customerLocked = [...state.estimates, ...state.invoices].some(document => document.projectId === row.id), bills = billsFor(row.id);
        return <div className="us-project-fields" key={row.id}>{editor.kind === 'legacy' && <p>{c.legacyId}: <strong>{row.id}</strong></p>}
          {field(row, 'name', c.name)}<div className="us-erp-select-field"><label htmlFor={`${prefix}-${encodeURIComponent(row.id)}-customer`}>{c.customer}</label><select id={`${prefix}-${encodeURIComponent(row.id)}-customer`} required disabled={customerLocked} value={row.draft.customerId} onChange={event => update(row.id, { customerId: event.target.value })}><option value="">{common.choose}</option>{state.customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></div>{customerLocked && <p className="us-erp-muted">{c.lockedCustomer}</p>}
          <div className="us-erp-grid">{field(row, 'startDate', `${c.start} · ${c.optional}`)}{field(row, 'targetDate', `${c.target} · ${c.optional}`)}</div>{field(row, 'budget', `${c.budget} · ${c.optional}`)}<p className="us-erp-muted">{common.decimalHelp}</p>
          <div className="us-erp-select-field"><label htmlFor={`${prefix}-${encodeURIComponent(row.id)}-notes`}>{c.notes}</label><textarea id={`${prefix}-${encodeURIComponent(row.id)}-notes`} rows={4} maxLength={20000} value={row.draft.notes} onChange={event => update(row.id, { notes: event.target.value })} /></div>
          <details className="us-project-purchase-picker"><summary>{c.linkPurchases} · {row.draft.vendorBillIds.length}</summary><p className="us-erp-muted">{c.linksHelp}</p>{!bills.length && <p>{c.noAvailablePurchases}</p>}{bills.map(bill => <label key={bill.id}><input type="checkbox" checked={row.draft.vendorBillIds.includes(bill.id)} onChange={event => update(row.id, { vendorBillIds: event.target.checked ? [...row.draft.vendorBillIds, bill.id] : row.draft.vendorBillIds.filter(id => id !== bill.id) })} /><span>{bill.vendorSnapshot.name} · {bill.reference}<strong>{money(bill.total)}</strong></span></label>)}</details>
        </div>;
      })}
      {editor.kind === 'legacy' && editor.rows.length > 10 && <div className="us-erp-actions"><button type="button" className="account-button secondary" disabled={legacyPage === 0} onClick={() => setLegacyPage(value => value - 1)}>{c.previous}</button><span>{legacyPage + 1} / {Math.ceil(editor.rows.length / 10)}</span><button type="button" className="account-button secondary" disabled={(legacyPage + 1) * 10 >= editor.rows.length} onClick={() => setLegacyPage(value => value + 1)}>{c.next}</button></div>}
      <button type="submit" className="account-button">{editor.kind === 'legacy' ? c.legacyReview : c.save}</button>
    </fieldset></form></section>}
    {activeReview && allowed && <section className="us-erp-confirm us-project-confirm" aria-label={c.reviewTitle}><h3>{c.reviewTitle}</h3>{activeReview.command.projects.map(project => <div key={project.id}><h4>{project.name}</h4><dl className="us-project-overview"><div><dt>{c.customer}</dt><dd>{state.customers.find(customer => customer.id === project.customerId)?.name}</dd></div><div><dt>{c.filter}</dt><dd>{c[project.status]}</dd></div><div><dt>{c.budget}</dt><dd>{project.budgetMinor === null ? c.noBudget : money({ currency: 'USD', minorUnits: project.budgetMinor })}</dd></div><div><dt>{c.start}</dt><dd>{date(project.startDate)}</dd></div><div><dt>{c.target}</dt><dd>{date(project.targetDate)}</dd></div><div><dt>{c.purchases}</dt><dd>{project.vendorBillIds.length}</dd></div></dl>{project.notes && <details><summary>{c.notes}</summary><p className="us-erp-notes">{project.notes}</p></details>}</div>)}<div className="us-erp-actions"><button type="button" className="account-button" disabled={disabled} onClick={confirm}>{activeReview.kind === 'archive' ? c.confirmArchive : activeReview.kind === 'restore' ? c.confirmRestore : activeReview.kind === 'legacy' ? c.legacyConfirm : c.confirm}</button><button type="button" className="account-button secondary" disabled={disabled} onClick={() => setReview(null)}>{c.cancel}</button></div></section>}
  </section>;
}
