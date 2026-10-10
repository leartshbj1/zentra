'use client';

import { useEffect, useMemo, useRef, useState, type SubmitEvent } from 'react';
import { ArrowLeft, Check } from 'lucide-react';
import type { SiteLanguage } from '@/lib/site-language';
import type { CompanyAddress } from '@/lib/international/types';
import type { BrowserUsFinancialPilotSession, BrowserUsFinancialPilotState } from '@/lib/international/browser-us-financial-pilot-session';
import type { UsFinancialPilotEstimateDetail } from '@/lib/international/us-financial-pilot-commercial-projection';
import type { UsFinancialPilotOverview, UsFinancialPilotPage, UsFinancialPilotPeriodRow } from '@/lib/international/us-financial-pilot-contract';
import type { UsFinancialPilotInvoiceReceipt, UsFinancialPilotTaxCatalogue } from '@/lib/international/us-financial-pilot-invoice';
import { browserUsFinancialPilotInvoiceCopy, browserUsFinancialPilotInvoiceErrorCopy } from '@/lib/international/browser-us-financial-pilot-invoice-copy';
import { usTaxInvoiceLocalCandidates } from '@/lib/international/us-tax-invoice-time';
import { formatDateOnly } from '@/lib/international/localization';
import { formatMoney, money } from '@/lib/international/money';
import './us-financial-pilot-invoice.css';

interface Props {
  session: BrowserUsFinancialPilotSession; state: BrowserUsFinancialPilotState; snapshot: UsFinancialPilotOverview;
  initialSource: UsFinancialPilotEstimateDetail; language: SiteLanguage; active: boolean;
  onCancel: () => void; onInvoice: (id: string) => void;
}
type Classification = { lineId: string; taxCode: string; confirmedService: boolean };
type Draft = { revision: number; date: string; accountingDate: string; dueDate: string; periodId: string; localTime: string; instant: string; addressSource: 'billing' | 'shipping'; classifications: Classification[] };
type TaxCode = UsFinancialPilotTaxCatalogue['taxCodes'][number];
const usd = (minor: string) => formatMoney(money('USD', minor), 'en-US');
const date = (value: string) => formatDateOnly(value, 'en-US');
function today(timeZone: string): string { const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-'); }
function dueDate(day: string, days: number): string { const value = new Date(`${day}T12:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function quantity(units: string, scale: number): string { const digits = units.padStart(scale + 1, '0'); return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits; }
function supported(source: UsFinancialPilotEstimateDetail): boolean { return source.estimate.status === 'accepted' && source.lines.length <= 100 && source.lines.every(line => line.taxTreatment === 'taxable' && BigInt(line.quantityUnits) % (BigInt(10) ** BigInt(line.quantityScale)) === BigInt(0)); }
function Address({ value }: { value: CompanyAddress }) { return <address>{value.line1}<br/>{value.line2 && <>{value.line2}<br/></>}{value.city}, {value.subdivision} {value.postalCode}<br/>{value.country}</address>; }

export function UsFinancialPilotInvoice({ session, state, snapshot, initialSource, language, active, onCancel, onInvoice }: Props) {
  const c = browserUsFinancialPilotInvoiceCopy[language], epoch = useRef(0);
  const [source, setSource] = useState(initialSource);
  const [draft, setDraft] = useState<Draft>(() => { const now = today(snapshot.company.timeZone); return { revision: initialSource.revision, date: now, accountingDate: now, dueDate: dueDate(now, initialSource.paymentTermsDays), periodId: snapshot.periods.items.find(period => period.status === 'open' && period.start <= now && period.end >= now)?.id ?? '', localTime: '09:00', instant: '', addressSource: 'billing', classifications: initialSource.lines.map(line => ({ lineId: line.id, taxCode: '', confirmedService: false })) }; });
  const [currentSource, setCurrentSource] = useState<UsFinancialPilotEstimateDetail | null>(null);
  const [periods, setPeriods] = useState<UsFinancialPilotPage<UsFinancialPilotPeriodRow> | null>(null);
  const [codes, setCodes] = useState<readonly TaxCode[]>([]), [catalogue, setCatalogue] = useState<UsFinancialPilotTaxCatalogue | null>(null);
  const [codeDrafts, setCodeDrafts] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [errorCode, setErrorCode] = useState('');
  const [issued, setIssued] = useState<UsFinancialPilotInvoiceReceipt | null>(null);
  const [expiredReview, setExpiredReview] = useState<string | null>(null);
  const locked = state.pending || state.writing || busy, preview = state.invoiceReview;
  const ownPending = state.pendingKind === 'invoice_prepare' || state.pendingKind === 'invoice_issue';
  const changed = draft.revision !== snapshot.revision || state.requiresRefresh;
  const periodPage = periods?.revision === snapshot.revision ? periods : snapshot.periods;
  const periodItems = [...new Map([...snapshot.periods.items, ...(periods?.revision === snapshot.revision ? periods.items : [])].map(period => [period.id, period])).values()];
  const openPeriods = periodItems.filter(period => period.status === 'open');
  const candidates = useMemo(() => { try { return usTaxInvoiceLocalCandidates(`${draft.date}T${draft.localTime}:00`, snapshot.company.timeZone); } catch { return []; } }, [draft.date, draft.localTime, snapshot.company.timeZone]);
  const validInstant = candidates.some(candidate => candidate.instant === draft.instant);
  const destination = draft.addressSource === 'shipping' ? source.customer.shippingAddress : source.customer.billingAddress;
  const previewDestination = preview?.addressSource === 'shipping' ? source.customer.shippingAddress : source.customer.billingAddress;
  const ready = supported(source) && validInstant && destination?.country === 'US' && draft.classifications.every(line => line.confirmedService && /^txcd_[0-9]{8}$/.test(line.taxCode)) && openPeriods.some(period => period.id === draft.periodId && period.start <= draft.accountingDate && period.end >= draft.accountingDate);
  const currentUsable = currentSource && currentSource.revision === snapshot.revision && supported(currentSource) && currentSource.lines.length === source.lines.length && currentSource.lines.every((line, index) => line.id === source.lines[index].id);
  useEffect(() => () => { epoch.current++; }, []);
  useEffect(() => { if (!preview) return; const remaining = Date.parse(preview.expiresAt) - Date.now(); if (remaining <= 2_147_483_647) { const timer = setTimeout(() => setExpiredReview(preview.expiresAt), Math.max(0, remaining)); return () => clearTimeout(timer); } }, [preview]);
  async function task<T>(work: () => Promise<T>, done: (value: T) => void) { const at = epoch.current; setBusy(true); setErrorCode(''); try { const value = await work(); if (at === epoch.current) done(value); } catch (error) { if (at === epoch.current && !['stale_read','session_disposed'].includes((error as { code?: string }).code ?? '')) setErrorCode((error as { code?: string }).code ?? 'service_unavailable'); } finally { if (at === epoch.current) setBusy(false); } }
  function choose(lineId: string, patch: Partial<Classification>) { setDraft(old => ({ ...old, classifications: old.classifications.map(line => line.lineId === lineId ? { ...line, ...patch } : line) })); }
  function addCodes(value: UsFinancialPilotTaxCatalogue) { setCodes(old => [...new Map([...old, ...value.taxCodes].map(code => [code.id, code])).values()]); }
  function loadCatalogue(cursor?: string) { if (locked) return; void task(() => session.readTaxCodes(cursor ? { cursor } : {}), value => { addCodes(value); setCatalogue(value); }); }
  function lookup(lineId: string) { if (locked) return; const code = codeDrafts[lineId] ?? ''; void task(() => session.readTaxCodes({ code }), value => { addCodes(value); choose(lineId, { taxCode: value.taxCodes[0].id }); }); }
  function readCurrent() { if (locked) return; void task(async () => { const overview = await session.refresh(); if (!overview) throw Error('read_required'); return session.readEstimate(source.estimate.id, overview.revision); }, setCurrentSource); }
  function acceptCurrent() { if (locked || !currentUsable || !currentSource) return; session.clearInvoiceReview(); setSource(currentSource); setDraft(old => ({ ...old, revision: currentSource.revision })); setCurrentSource(null); setErrorCode(''); }
  function prepare(event: SubmitEvent) { event.preventDefault(); if (locked || changed || !ready) return; void task(() => session.prepareInvoice({ type: 'issue_invoice', estimateId: source.estimate.id, expectedEstimateRevision: source.estimate.revision, date: draft.date, accountingDate: draft.accountingDate, dueDate: draft.dueDate, periodId: draft.periodId }, { classifications: draft.classifications.map(line => ({ lineId: line.lineId, taxCode: line.taxCode, confirmedService: true })), taxDateInstant: draft.instant, addressSource: draft.addressSource }, draft.revision), () => {}); }
  function issue() { if (locked || changed) return; void task(() => session.issueInvoice(), setIssued); }
  function retry() { if (state.writing || busy || !ownPending) return; void task(() => session.retryInvoice(), value => { if ('action' in value) setIssued(value); }); }
  function edit() { if (locked) return; session.clearInvoiceReview(); setErrorCode(''); }
  function cancel() { if (locked) return; session.clearInvoiceReview(); onCancel(); }
  function openInvoice(id: string) { if (locked) return; session.clearInvoiceReview(); onInvoice(id); }
  function morePeriods() { if (locked || !periodPage.nextCursor) return; void task(() => session.readList('periods', periodPage.nextCursor!, snapshot.revision), value => { const typed = value as UsFinancialPilotPage<UsFinancialPilotPeriodRow>; setPeriods(old => ({ ...typed, items: [...(old?.revision === typed.revision ? old.items : []), ...typed.items] })); }); }
  const invoiceId = issued?.entityId ?? (preview?.financialStatus === 'issued' ? preview.invoiceId : null);
  const previewExpired = preview !== null && expiredReview === preview.expiresAt;
  const previewPeriod = preview ? periodItems.find(period => period.id === preview.periodId) : null;
  return <section className="fpi-workspace" hidden={!active} aria-label={c.title}>
    <button type="button" className="fp-back" disabled={locked} onClick={cancel}><ArrowLeft size={18} aria-hidden/>{c.back}</button>
    <div className="fp-detail-heading"><div><h2>{invoiceId ? c.issued : preview ? c.review : c.title}</h2><p>{source.estimate.number} · {source.customer.name}</p></div></div>
    {invoiceId ? <div className="fpi-complete" aria-live="polite"><p className="fp-success"><Check size={18} aria-hidden/>{issued ? c.issued : c.alreadyIssued}</p><button type="button" className="account-button fp-primary" onClick={() => openInvoice(invoiceId)}>{c.openInvoice}</button><button type="button" className="fp-link" onClick={cancel}>{c.back}</button></div> : <>
      <p className="fp-context">{c.notice}</p>
      {ownPending && <div className="fp-notice fpi-notice" aria-live="polite"><p>{c.pending}</p>{errorCode && <p>{browserUsFinancialPilotInvoiceErrorCopy(language, errorCode)}</p>}<button type="button" className="account-button secondary" disabled={state.writing || busy} onClick={retry}>{state.writing || busy ? state.pendingKind === 'invoice_prepare' ? c.preparing : c.issuing : c.retry}</button></div>}
      {!ownPending && errorCode && <p className="fpi-error" role="alert">{browserUsFinancialPilotInvoiceErrorCopy(language, errorCode)}</p>}
      {changed && !ownPending && <div className="fp-notice fpi-notice"><p>{c.changed}</p><button type="button" className="account-button secondary" disabled={locked} onClick={readCurrent}>{c.reviewCurrent}</button></div>}
      {currentSource && <article className="fpi-current"><h3>{c.currentSource} · {currentSource.estimate.number}</h3><p>{currentSource.customer.name} · {c.net}: {usd(currentSource.netMinor)}</p><div className="fpi-destination"><h3>{c.address} · {draft.addressSource === 'billing' ? c.billing : c.shipping}</h3>{(draft.addressSource === 'shipping' ? currentSource.customer.shippingAddress : currentSource.customer.billingAddress) && <Address value={(draft.addressSource === 'shipping' ? currentSource.customer.shippingAddress : currentSource.customer.billingAddress)!}/>}</div><ul>{currentSource.lines.map(line => <li key={line.id}><strong>{line.description}</strong><span>{c.quantity}: {quantity(line.quantityUnits,line.quantityScale)} · {usd(line.netMinor)}</span></li>)}</ul>{currentUsable ? <button type="button" className="account-button secondary" disabled={locked} onClick={acceptCurrent}>{c.keepChoices}</button> : <p>{c.sourceUnavailable}</p>}</article>}
      {preview ? <article className="fp-document fpi-preview" aria-label={c.review}>
        <p className="fp-context">{c.reviewNotice}</p>
        {preview.sellerPresentation&&<section className="fpi-destination"><h3>{c.sellerHeading}</h3><p><strong>{preview.sellerPresentation.profile.displayName}</strong></p>{preview.sellerPresentation.profile.contactEmail&&<p>{preview.sellerPresentation.profile.contactEmail}</p>}{preview.sellerPresentation.profile.contactPhone&&<p>{preview.sellerPresentation.profile.contactPhone}</p>}<p className="fp-context">{c.sellerVersion}: {preview.sellerPresentation.sellerRevision}</p>{state.seller?.head&&state.seller.head.sellerRevision!==preview.sellerPresentation.sellerRevision&&<p className="fp-context">{c.preparedEarlier}</p>}</section>}
        <dl className="fp-document-dates fpi-dates">{[{ label:c.source,value:preview.estimateNumber },{ label:c.date,value:date(preview.date) },{ label:c.accountingDate,value:date(preview.accountingDate) },{ label:c.dueDate,value:date(preview.dueDate) },{ label:c.period,value:previewPeriod ? `${date(previewPeriod.start)} – ${date(previewPeriod.end)}` : preview.periodId }].map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
        <div className="fpi-destination"><h3>{c.address} · {preview.addressSource === 'billing' ? c.billing : c.shipping}</h3>{previewDestination && <Address value={previewDestination}/>}<p>{c.zone}: {preview.timeZone}</p><p>{c.instant}: {preview.taxDateInstant}</p></div>
        <ul className="fp-lines">{preview.lines.map(line => <li key={line.id}><div><strong>{line.description}</strong><span>{c.quantity}: {quantity(line.quantityUnits,line.quantityScale)}</span><span>{line.taxCode}</span></div><dl><div><dt>{c.net}</dt><dd>{usd(line.netMinor)}</dd></div><div><dt>{c.tax}</dt><dd>{usd(line.taxMinor)}</dd></div><div><dt>{c.total}</dt><dd>{usd(line.totalMinor)}</dd></div></dl></li>)}</ul>
        <dl className="fp-document-total">{[{ label:c.net,value:preview.netMinor },{ label:c.tax,value:preview.taxMinor },{ label:c.total,value:preview.totalMinor }].map(item => <div key={item.label}><dt>{item.label}</dt><dd>{usd(item.value)}</dd></div>)}</dl><p className="fp-context">{c.expires}: {preview.expiresAt}</p>{previewExpired && <p className="fpi-error">{c.expired}</p>}
        <div className="fp-actions"><button type="button" className="account-button fp-primary" disabled={locked || changed || !!previewExpired} onClick={issue}>{state.writing && state.pendingKind === 'invoice_issue' ? c.issuing : c.issue}</button><button type="button" className="account-button secondary" disabled={locked} onClick={edit}>{c.edit}</button></div>
      </article> : <form className="fp-payment fpi-form" onSubmit={prepare}>
        <fieldset className="fpi-fields" disabled={locked}><div className="fp-form-grid">
          <label>{c.date}<input required type="date" value={draft.date} onChange={event => setDraft({ ...draft,date:event.target.value,instant:'' })}/></label>
          <label>{c.accountingDate}<input required type="date" value={draft.accountingDate} onChange={event => setDraft({ ...draft,accountingDate:event.target.value })}/></label>
          <label>{c.dueDate}<input required type="date" min={draft.date} value={draft.dueDate} onChange={event => setDraft({ ...draft,dueDate:event.target.value })}/></label>
          <label>{c.period}<select required value={draft.periodId} onChange={event => setDraft({ ...draft,periodId:event.target.value })}><option value="">{c.period}</option>{openPeriods.map(period => <option key={period.id} value={period.id}>{date(period.start)} – {date(period.end)}</option>)}</select></label>
          {periodPage.nextCursor && <button type="button" className="fp-link fpi-wide" onClick={morePeriods}>{c.morePeriods}</button>}{!openPeriods.length && <p className="fpi-wide">{c.noPeriod}</p>}
          <label className="fpi-wide">{c.address}<select required value={draft.addressSource} onChange={event => setDraft({ ...draft,addressSource:event.target.value as Draft['addressSource'] })}><option value="billing">{c.billing}</option>{source.customer.shippingAddress && <option value="shipping">{c.shipping}</option>}</select></label>
          {destination && <div className="fpi-wide fpi-destination"><Address value={destination}/></div>}
          <label>{c.localTime}<input required type="time" step="60" value={draft.localTime} onChange={event => setDraft({ ...draft,localTime:event.target.value,instant:'' })}/></label>
          <label>{c.instant}<select required value={validInstant ? draft.instant : ''} onChange={event => setDraft({ ...draft,instant:event.target.value })}><option value="">{c.chooseInstant}</option>{candidates.map(candidate => <option key={candidate.instant} value={candidate.instant}>UTC{candidate.offset} · {candidate.instant}</option>)}</select></label>
          <p className="fpi-wide fp-context">{c.zone}: {snapshot.company.timeZone}. {c.timeHint}</p>{!candidates.length && <p className="fpi-wide fpi-error">{c.invalidTime}</p>}
        </div><div className="fpi-classifications"><h3>{c.classification}</h3><p className="fp-context">{c.scope}</p><p className="fp-context">{c.codeHint}</p><button type="button" className="fp-link" onClick={() => loadCatalogue()}>{c.catalogue}</button>
          {source.lines.map((line,index) => { const choice = draft.classifications[index], selectedCode = codes.find(code => code.id === choice.taxCode); return <fieldset className="fpi-line" key={line.id}><legend>{line.description}</legend><p>{c.quantity}: {quantity(line.quantityUnits,line.quantityScale)} · {c.net}: {usd(line.netMinor)}</p><div className="fp-form-grid"><label>{c.code}<input maxLength={13} pattern="txcd_[0-9]{8}" value={codeDrafts[line.id] ?? ''} onChange={event => setCodeDrafts({ ...codeDrafts,[line.id]:event.target.value })}/></label><button type="button" className="account-button secondary fpi-lookup" disabled={!/^txcd_[0-9]{8}$/.test(codeDrafts[line.id] ?? '')} onClick={() => lookup(line.id)}>{c.lookup}</button><label className="fpi-wide">{c.classification}<select required value={choice.taxCode} onChange={event => choose(line.id,{ taxCode:event.target.value })}><option value="">{c.chooseCode}</option>{codes.map(code => <option key={code.id} value={code.id}>{code.id} · {code.name}</option>)}</select></label></div>{selectedCode && <p className="fp-context">{selectedCode.description}</p>}<label className="fpi-service"><input type="checkbox" required checked={choice.confirmedService} onChange={event => choose(line.id,{ confirmedService:event.target.checked })}/><span>{c.service}</span></label></fieldset>; })}
          {catalogue?.hasMore && catalogue.nextCursor && <button type="button" className="account-button secondary" onClick={() => loadCatalogue(catalogue.nextCursor!)}>{c.moreCodes}</button>}
        </div></fieldset>
        <div className="fp-actions"><button type="submit" className="account-button fp-primary" disabled={locked || changed || !ready}>{state.writing && state.pendingKind === 'invoice_prepare' ? c.preparing : c.prepare}</button><button type="button" className="account-button secondary" disabled={locked} onClick={cancel}>{c.cancel}</button></div>
      </form>}
    </>}
  </section>;
}
