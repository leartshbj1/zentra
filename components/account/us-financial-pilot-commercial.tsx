'use client';

import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { ArrowLeft, ChevronRight, Check } from 'lucide-react';
import type { SiteLanguage } from '@/lib/site-language';
import type { CompanyAddress } from '@/lib/international/types';
import { countrySubdivisions, validateAddress } from '@/lib/international/addresses';
import { formatDateOnly } from '@/lib/international/localization';
import { formatMoney, money } from '@/lib/international/money';
import type { BrowserUsFinancialPilotSession, BrowserUsFinancialPilotState } from '@/lib/international/browser-us-financial-pilot-session';
import type { UsFinancialPilotEstimateRow, UsFinancialPilotOverview, UsFinancialPilotPage, UsFinancialPilotParty } from '@/lib/international/us-financial-pilot-contract';
import { US_FINANCIAL_PILOT_COMMERCIAL_MAX_LINES, type UsFinancialPilotCommercialCommand, type UsFinancialPilotCommercialReceipt } from '@/lib/international/us-financial-pilot-commercial';
import type { UsFinancialPilotEstimateDetail } from '@/lib/international/us-financial-pilot-commercial-projection';
import { browserUsFinancialPilotCommercialCopy, browserUsFinancialPilotCommercialErrorCopy, browserUsFinancialPilotCommercialLimitCopy } from '@/lib/international/browser-us-financial-pilot-commercial-copy';
import { browserUsFinancialPilotCopy } from '@/lib/international/browser-us-financial-pilot-copy';
import { commercialDiscount, commercialLineNet, commercialMajor, commercialPrice, commercialQuantity, commercialQuantityText } from '@/lib/international/browser-us-financial-pilot-commercial-input';
import './us-financial-pilot-commercial.css';

interface Props {
  session: BrowserUsFinancialPilotSession; state: BrowserUsFinancialPilotState; snapshot: UsFinancialPilotOverview;
  language: SiteLanguage; tab: string; onTab: (tab: 'customers' | 'estimates') => void;
  recoveredReceipt: UsFinancialPilotCommercialReceipt | null;
}
type AddressDraft = { country: 'US' | 'CH'; line1: string; line2: string; city: string; subdivision: string; postalCode: string };
type CustomerDraft = { token: number; revision: number; kind: 'business' | 'individual'; name: string; contactName: string; email: string; phone: string; terms: string; billing: AddressDraft; shipping: AddressDraft | null };
type LineDraft = { key: number; id: string | null; description: string; quantity: string; price: string; discount: string; taxTreatment: 'taxable' | 'non_taxable' | 'exempt' };
type QuoteDraft = { token: number; revision: number; estimateId: string | null; expectedEstimateRevision: number; customerId: string; projectId: string | null; date: string; expiresAt: string; terms: string; lines: LineDraft[]; notes: string };
type AcceptanceDraft = { token: number; revision: number; estimateId: string; estimateRevision: number };
type Review = { kind: 'customer' | 'quote' | 'accept'; revision: number; detail: UsFinancialPilotEstimateDetail | null; customer: UsFinancialPilotParty | null };
const blankAddress = (): AddressDraft => ({ country: 'US', line1: '', line2: '', city: '', subdivision: '', postalCode: '' });
const usd = (minor: string) => formatMoney(money('USD', minor), 'en-US');
const exactInteger = BigInt;
const date = (value: string) => formatDateOnly(value, 'en-US');
function terms(value: string): number { if (!/^(0|[1-9][0-9]{0,2})$/.test(value) || Number(value) > 365) throw new TypeError('invalid_commercial_input'); return Number(value); }
function address(value: AddressDraft): CompanyAddress {
  return validateAddress({ country: value.country, line1: value.line1.trim(), ...(value.line2.trim() ? { line2: value.line2.trim() } : {}), city: value.city.trim(), subdivision: value.subdivision, postalCode: value.postalCode.trim() }, value.country);
}
function today(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}
function defaultExpiry(day: string): string { const expiry = new Date(`${day}T12:00:00.000Z`); expiry.setUTCDate(expiry.getUTCDate() + 30); return expiry.toISOString().slice(0, 10); }
function uniqueCustomers(items: readonly UsFinancialPilotParty[]): UsFinancialPilotParty[] { return [...new Map(items.map(item => [item.id, item])).values()]; }

function AddressFields({ value, onChange, language, legend }: { value: AddressDraft; onChange: (value: AddressDraft) => void; language: SiteLanguage; legend: string }) {
  const c = browserUsFinancialPilotCommercialCopy[language];
  return <fieldset className="fpc-address"><legend>{legend}</legend><div className="fp-form-grid">
    <label>{c.country}<select value={value.country} onChange={event => onChange({ ...value, country: event.target.value as AddressDraft['country'], subdivision: '', postalCode: '' })}>{(['US', 'CH'] as const).map(country => <option key={country} value={country}>{new Intl.DisplayNames([language], { type: 'region' }).of(country)}</option>)}</select></label>
    <label>{c.state}<select required value={value.subdivision} onChange={event => onChange({ ...value, subdivision: event.target.value })}><option value="">{c.state}</option>{countrySubdivisions[value.country].map(code => <option key={code} value={code}>{code}</option>)}</select></label>
    <label className="fpc-wide">{c.line1}<input required autoComplete="street-address" maxLength={200} value={value.line1} onChange={event => onChange({ ...value, line1: event.target.value })}/></label>
    <label className="fpc-wide">{c.line2} · {c.optional}<input maxLength={200} value={value.line2} onChange={event => onChange({ ...value, line2: event.target.value })}/></label>
    <label>{c.city}<input required autoComplete="address-level2" maxLength={120} value={value.city} onChange={event => onChange({ ...value, city: event.target.value })}/></label>
    <label>{c.postalCode}<input required autoComplete="postal-code" maxLength={10} pattern={value.country === 'US' ? '[0-9]{5}(-[0-9]{4})?' : '[1-9][0-9]{3}'} value={value.postalCode} onChange={event => onChange({ ...value, postalCode: event.target.value })}/></label>
  </div></fieldset>;
}
function PartyAddress({ party }: { party: UsFinancialPilotParty }) { const a = party.billingAddress; return <address>{a.line1}<br/>{a.line2 && <>{a.line2}<br/></>}{a.country === 'US' ? `${a.city}, ${a.subdivision} ${a.postalCode}` : `${a.postalCode} ${a.city}`}<br/>{a.country}</address>; }

export function UsFinancialPilotCommercial({ session, state, snapshot, language, tab, onTab, recoveredReceipt }: Props) {
  const c = browserUsFinancialPilotCommercialCopy[language], sequence = useRef(0), lifetime = useRef(0), detailGeneration = useRef(0);
  const [customerDraft, setCustomerDraft] = useState<CustomerDraft | null>(null), [quoteDraft, setQuoteDraft] = useState<QuoteDraft | null>(null);
  const [acceptance, setAcceptance] = useState<AcceptanceDraft | null>(null), [review, setReview] = useState<Review | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<UsFinancialPilotEstimateDetail | null>(null);
  const [minimumDetailRevision, setMinimumDetailRevision] = useState(0), [detailTick, setDetailTick] = useState(0);
  const [customerPage, setCustomerPage] = useState<UsFinancialPilotPage | null>(null), [quotePage, setQuotePage] = useState<UsFinancialPilotPage | null>(null);
  const [choices, setChoices] = useState<{ revision: number; items: readonly UsFinancialPilotParty[]; nextCursor: string | null } | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string; terms: number; revision: number } | null>(null);
  const [busy, setBusy] = useState(false), [errorCode, setErrorCode] = useState(''), [message, setMessage] = useState<'customerSaved' | 'quoteSaved' | 'accepted' | null>(null);
  const write = useRef<{ action: UsFinancialPilotCommercialCommand['type']; token: number } | null>(null), lastRecovered = useRef<UsFinancialPilotCommercialReceipt | null>(null);
  const locked = state.pending || state.writing || busy, active = tab === 'customers' || tab === 'estimates';
  const currentDetail = detail?.revision === snapshot.revision && detail.estimate.id === selected ? detail : null;
  const currentCustomers = customerPage?.revision === snapshot.revision ? customerPage : snapshot.customers;
  const currentQuotes = quotePage?.revision === snapshot.revision ? quotePage : snapshot.estimates;
  const customerChoices = uniqueCustomers([...snapshot.customers.items, ...currentCustomers.items as readonly UsFinancialPilotParty[], ...(choices?.revision === snapshot.revision ? choices.items : []), ...(currentDetail ? [currentDetail.customer] : [])]);
  const choicesCursor = customerChoices.length >= snapshot.customers.total ? null : choices?.revision === snapshot.revision ? choices.nextCursor : snapshot.customers.nextCursor;
  const draftChanged = (revision: number) => revision !== snapshot.revision || state.requiresRefresh;
  const shownError = errorCode || state.error?.code || '';
  const errorText = shownError ? browserUsFinancialPilotCommercialErrorCopy(language, shownError) : '';
  const tooManyLines = quoteDraft !== null && quoteDraft.lines.length > US_FINANCIAL_PILOT_COMMERCIAL_MAX_LINES;
  const lineLimit = browserUsFinancialPilotCommercialLimitCopy[language].legacyLines;
  useEffect(() => () => { lifetime.current++; detailGeneration.current++; }, []);
  useEffect(() => {
    const at = ++detailGeneration.current;
    if (!selected || snapshot.revision < minimumDetailRevision) return;
    void session.readEstimate(selected, snapshot.revision).then(value => { if (at === detailGeneration.current) setDetail(value); }).catch(error => { if (at === detailGeneration.current && !['stale_read', 'session_disposed'].includes(error?.code)) setErrorCode(error?.code ?? 'service_unavailable'); });
  }, [session, selected, snapshot.revision, minimumDetailRevision, detailTick]);
  function complete(receipt: UsFinancialPilotCommercialReceipt) {
    const operation = write.current;
    if (!operation || operation.action !== receipt.action) return;
    write.current = null; setErrorCode(''); setReview(null);
    if (receipt.action === 'create_customer') {
      if (customerDraft?.token === operation.token) setCreated({ id: receipt.entityId, name: customerDraft.name.trim(), terms: terms(customerDraft.terms), revision: receipt.revision });
      setCustomerDraft(old => old?.token === operation.token ? null : old);
      setMessage('customerSaved');
    } else if (receipt.action === 'save_estimate') {
      setQuoteDraft(old => old?.token === operation.token ? null : old); setSelected(receipt.entityId); setMinimumDetailRevision(receipt.revision); setDetail(null); setMessage('quoteSaved');
    } else {
      setAcceptance(old => old?.token === operation.token ? null : old); setMinimumDetailRevision(receipt.revision); setDetailTick(value => value + 1); setMessage('accepted');
    }
  }
  useEffect(() => {
    if (recoveredReceipt && recoveredReceipt !== lastRecovered.current) { lastRecovered.current = recoveredReceipt; complete(recoveredReceipt); }
  });
  async function submit(command: UsFinancialPilotCommercialCommand, token: number, expectedRevision: number) {
    const transport = session.getState();
    if (locked || state.requiresRefresh || transport.writing || transport.pending || transport.requiresRefresh) return;
    const at = lifetime.current; write.current = { action: command.type, token }; setErrorCode(''); setMessage(null);
    try { const receipt = await session.commercial(command, expectedRevision); if (at === lifetime.current) complete(receipt); }
    catch (error) { if (at === lifetime.current) { const failure = error as { code?: string; outcome?: string }; setErrorCode(failure.code ?? 'invalid_commercial_input'); if (failure.outcome === 'rejected') write.current = null; } }
  }
  function newCustomer() { if (customerDraft || locked) return; setCustomerDraft({ token: ++sequence.current, revision: snapshot.revision, kind: 'business', name: '', contactName: '', email: '', phone: '', terms: '30', billing: blankAddress(), shipping: null }); setCreated(null); setReview(null); setMessage(null); setErrorCode(''); }
  function newLine(): LineDraft { return { key: ++sequence.current, id: null, description: '', quantity: '1', price: '', discount: '0', taxTreatment: 'taxable' }; }
  function newQuote(customerId = '', paymentTerms = 30) {
    if (quoteDraft || locked) return;
    const day = today(snapshot.company.timeZone);
    setQuoteDraft({ token: ++sequence.current, revision: snapshot.revision, estimateId: null, expectedEstimateRevision: 0, customerId, projectId: null, date: day, expiresAt: defaultExpiry(day), terms: String(paymentTerms), lines: [newLine()], notes: '' });
    setSelected(null); setDetail(null); setAcceptance(null); setReview(null); setMessage(null); setErrorCode(''); onTab('estimates');
  }
  function editQuote() {
    if (!currentDetail || quoteDraft || locked) return;
    setQuoteDraft({ token: ++sequence.current, revision: snapshot.revision, estimateId: currentDetail.estimate.id, expectedEstimateRevision: currentDetail.estimate.revision, customerId: currentDetail.customer.id, projectId: currentDetail.projectId, date: currentDetail.estimate.date, expiresAt: currentDetail.estimate.expiresAt, terms: String(currentDetail.paymentTermsDays), notes: currentDetail.notes,
      lines: currentDetail.lines.map(line => ({ key: ++sequence.current, id: line.id, description: line.description, quantity: commercialQuantityText(line.quantityUnits, line.quantityScale), price: commercialMajor(line.unitPriceMinor), discount: commercialMajor(String(line.discountBasisPoints)), taxTreatment: line.taxTreatment })) });
    setAcceptance(null); setReview(null); setMessage(null); setErrorCode('');
  }
  async function saveCustomer(event: SubmitEvent) {
    event.preventDefault(); if (!customerDraft || draftChanged(customerDraft.revision)) return;
    try { await submit({ type: 'create_customer', customer: { kind: customerDraft.kind, name: customerDraft.name.trim(), contactName: customerDraft.contactName.trim() || null, email: customerDraft.email.trim() || null, phone: customerDraft.phone.trim() || null, paymentTermsDays: terms(customerDraft.terms), billingAddress: address(customerDraft.billing), shippingAddress: customerDraft.shipping ? address(customerDraft.shipping) : null } }, customerDraft.token, customerDraft.revision); }
    catch { setErrorCode('invalid_commercial_input'); }
  }
  async function saveQuote(event: SubmitEvent) {
    event.preventDefault(); if (!quoteDraft || tooManyLines || draftChanged(quoteDraft.revision)) return;
    try {
      const lines = quoteDraft.lines.map(line => ({ id: line.id, description: line.description, ...commercialQuantity(line.quantity), unitPriceMinor: commercialPrice(line.price), discountBasisPoints: commercialDiscount(line.discount), taxTreatment: line.taxTreatment }));
      await submit({ type: 'save_estimate', estimateId: quoteDraft.estimateId, expectedEstimateRevision: quoteDraft.expectedEstimateRevision, customerId: quoteDraft.customerId, projectId: quoteDraft.projectId, date: quoteDraft.date, expiresAt: quoteDraft.expiresAt, paymentTermsDays: terms(quoteDraft.terms), lines, notes: quoteDraft.notes }, quoteDraft.token, quoteDraft.revision);
    } catch { setErrorCode('invalid_commercial_input'); }
  }
  async function loadPage(kind: 'customers' | 'estimates', cursor: string) {
    if (locked) return; const at = lifetime.current, revision = snapshot.revision; setBusy(true); setErrorCode('');
    try { const page = await session.readList(kind, cursor, revision); if (at === lifetime.current) { if (kind === 'customers') setCustomerPage(page); else setQuotePage(page); } }
    catch (error) { if (at === lifetime.current) setErrorCode((error as { code?: string }).code ?? 'service_unavailable'); }
    finally { if (at === lifetime.current) setBusy(false); }
  }
  async function moreCustomerChoices() {
    if (locked || !choicesCursor) return; const at = lifetime.current, revision = snapshot.revision; setBusy(true); setErrorCode('');
    try { const page = await session.readList('customers', choicesCursor, revision); if (at === lifetime.current) setChoices({ revision, items: uniqueCustomers([...customerChoices, ...page.items as readonly UsFinancialPilotParty[]]), nextCursor: page.nextCursor }); }
    catch (error) { if (at === lifetime.current) setErrorCode((error as { code?: string }).code ?? 'service_unavailable'); }
    finally { if (at === lifetime.current) setBusy(false); }
  }
  async function currentCustomer(customerId: string, current: UsFinancialPilotOverview): Promise<UsFinancialPilotParty | null> {
    let page = current.customers, found = page.items.find(item => item.id === customerId); const gathered = [...page.items], seen = new Set<string>();
    while (!found && page.nextCursor) {
      if (seen.has(page.nextCursor)) throw new Error('invalid_response'); seen.add(page.nextCursor);
      page = await session.readList('customers', page.nextCursor, current.revision) as UsFinancialPilotPage<UsFinancialPilotParty>; gathered.push(...page.items); found = page.items.find(item => item.id === customerId);
    }
    setChoices({ revision: current.revision, items: gathered, nextCursor: page.nextCursor }); return found ?? null;
  }
  async function reviewDraft(kind: Review['kind']) {
    if (locked) return; const at = lifetime.current; setBusy(true); setErrorCode(''); setReview(null);
    try {
      const current = await session.refresh(); if (!current || at !== lifetime.current) return;
      const estimateId = kind === 'accept' ? acceptance?.estimateId : kind === 'quote' ? quoteDraft?.estimateId : null;
      const latest = estimateId ? await session.readEstimate(estimateId, current.revision) : null;
      const customer = kind === 'quote' && quoteDraft?.customerId ? await currentCustomer(quoteDraft.customerId, current) : null;
      if (at !== lifetime.current) return;
      if (kind === 'quote' && quoteDraft?.customerId && !customer) { setErrorCode('customer_not_found'); return; }
      if (latest) setDetail(latest);
      setReview({ kind, revision: current.revision, detail: latest, customer });
    } catch (error) { if (at === lifetime.current) setErrorCode((error as { code?: string }).code ?? 'service_unavailable'); }
    finally { if (at === lifetime.current) setBusy(false); }
  }
  function continueDraft() {
    if (!review || locked || review.revision !== snapshot.revision || state.requiresRefresh) return;
    if (review.kind === 'customer') setCustomerDraft(old => old ? { ...old, revision: review.revision } : old);
    if (review.kind === 'quote') setQuoteDraft(old => old ? { ...old, revision: review.revision, expectedEstimateRevision: review.detail?.estimate.revision ?? 0 } : old);
    if (review.kind === 'accept' && review.detail) setAcceptance(old => old ? { ...old, revision: review.revision, estimateRevision: review.detail!.estimate.revision } : old);
    setReview(null); setErrorCode('');
  }
  function updateLine(key: number, patch: Partial<LineDraft>) { setQuoteDraft(old => old ? { ...old, lines: old.lines.map(line => line.key === key ? { ...line, ...patch } : line) } : old); }
  function draftReview(kind: Review['kind'], revision: number) { return !state.writing && !state.pending && draftChanged(revision) ? <div className="fp-notice fpc-review"><p>{kind === 'accept' ? c.reviewAcceptance : c.changed}</p><button type="button" className="account-button secondary" disabled={locked} onClick={() => { void reviewDraft(kind); }}>{c.review}</button></div> : null; }
  function reviewPanel(kind: Review['kind']) {
    return review?.kind === kind && <div className="fp-notice fpc-review" aria-live="polite"><p>{c.reviewed}</p>{review.detail && <div className="fpc-current"><h3>{c.currentQuote} · {review.detail.estimate.number}</h3><p>{review.detail.customer.name} · {review.detail.estimate.status === 'accepted' ? c.acceptedStatus : c[review.detail.estimate.status]}</p><PartyAddress party={review.detail.customer}/><p>{c.quoteDate}: {date(review.detail.estimate.date)} · {c.expiry}: {date(review.detail.estimate.expiresAt)}</p><p>{c.terms}: {review.detail.paymentTermsDays}</p><p>{usd(review.detail.netMinor)} · {c.beforeTax}</p><ul>{review.detail.lines.map(line => <li key={line.id}>{line.description} · {commercialQuantityText(line.quantityUnits, line.quantityScale)} × {usd(line.unitPriceMinor)} · {c.discount}: {commercialMajor(String(line.discountBasisPoints))}% · {c[line.taxTreatment]} · {usd(line.netMinor)}</li>)}</ul>{review.detail.notes && <p className="fpc-preserve">{review.detail.notes}</p>}</div>}{review.customer && <div className="fpc-current"><h3>{c.currentCustomer}</h3><p>{review.customer.name}</p><PartyAddress party={review.customer}/></div>}<button type="button" className="account-button secondary" disabled={locked || review.revision !== snapshot.revision || state.requiresRefresh} onClick={continueDraft}>{c.continueDraft}</button></div>;
  }
  function pagination(kind: 'customers' | 'estimates', page: UsFinancialPilotPage) { return <div className="fp-pagination">{(kind === 'customers' ? customerPage : quotePage)?.revision === snapshot.revision && <button className="fp-link" type="button" disabled={locked} onClick={() => kind === 'customers' ? setCustomerPage(null) : setQuotePage(null)}><ArrowLeft size={17} aria-hidden/>{c.first}</button>}{page.nextCursor && <button type="button" className="account-button secondary" disabled={locked} onClick={() => { void loadPage(kind, page.nextCursor!); }}>{c.more}</button>}</div>; }
  let draftNet: string | null = null;
  if (quoteDraft) { try { draftNet = quoteDraft.lines.reduce((sum, line) => sum + exactInteger(commercialLineNet(line.quantity, line.price, line.discount)), exactInteger(0)).toString(); if (draftNet.length > 36) draftNet = null; } catch { /* Incomplete lines remain editable. */ } }
  return <>
    {!active && (customerDraft || quoteDraft || acceptance) && <div className="fp-notice"><p>{c.draftElsewhere}</p><button type="button" className="account-button secondary" onClick={() => onTab(quoteDraft || acceptance ? 'estimates' : 'customers')}>{c.resume}</button></div>}
    <div className="fpc-workspace" hidden={!active}>
      {message && <p className="fp-success" aria-live="polite"><Check size={18} aria-hidden/>{c[message]}</p>}
      {errorText && !state.pending && <div className="fp-notice" role="alert"><p>{errorText}</p><button type="button" className="account-button secondary" disabled={locked} onClick={() => { setErrorCode(''); setDetailTick(value => value + 1); void session.refresh().catch(() => setErrorCode('service_unavailable')); }}>{c.refresh}</button></div>}
      {state.pendingKind === 'payment' && <p className="fp-context">{c.paymentPending}</p>}
      <section hidden={tab !== 'customers'} className="fp-register">
        <div className="fp-register-title fpc-title"><h2>{browserUsFinancialPilotCopy[language].customers}</h2><span>{currentCustomers.total}</span>{!customerDraft && <button type="button" className="account-button fp-primary" disabled={locked} onClick={newCustomer}>{c.newCustomer}</button>}</div>
        {created && !customerDraft && <div className="fp-notice"><p><strong>{created.name}</strong> · {c.customerCreatedNext}</p><button type="button" className="account-button secondary" disabled={locked || !!quoteDraft || snapshot.revision < created.revision} onClick={() => newQuote(created.id, created.terms)}>{c.newQuote}</button></div>}
        {customerDraft && <form className="fp-payment fpc-form" onSubmit={saveCustomer}><h3>{c.customerTitle}</h3><fieldset disabled={locked} className="fpc-fields"><div className="fp-form-grid">
          <label>{c.kind}<select value={customerDraft.kind} onChange={event => setCustomerDraft({ ...customerDraft, kind: event.target.value as CustomerDraft['kind'] })}><option value="business">{c.business}</option><option value="individual">{c.individual}</option></select></label>
          <label>{c.name}<input required maxLength={160} autoComplete="organization" value={customerDraft.name} onChange={event => setCustomerDraft({ ...customerDraft, name: event.target.value })}/></label>
          <label>{c.contactName} · {c.optional}<input maxLength={160} autoComplete="name" value={customerDraft.contactName} onChange={event => setCustomerDraft({ ...customerDraft, contactName: event.target.value })}/></label>
          <label>{c.email} · {c.optional}<input type="email" maxLength={254} autoComplete="email" value={customerDraft.email} onChange={event => setCustomerDraft({ ...customerDraft, email: event.target.value })}/></label>
          <label>{c.phone} · {c.optional}<input type="tel" maxLength={80} autoComplete="tel" value={customerDraft.phone} onChange={event => setCustomerDraft({ ...customerDraft, phone: event.target.value })}/></label>
          <label>{c.terms}<input required type="number" min="0" max="365" step="1" value={customerDraft.terms} onChange={event => setCustomerDraft({ ...customerDraft, terms: event.target.value })}/></label>
        </div><AddressFields legend={c.billing} language={language} value={customerDraft.billing} onChange={billing => setCustomerDraft({ ...customerDraft, billing })}/>
        <label className="fpc-checkbox"><input type="checkbox" checked={!!customerDraft.shipping} onChange={event => setCustomerDraft({ ...customerDraft, shipping: event.target.checked ? blankAddress() : null })}/><span>{c.shipping}</span></label>
        {customerDraft.shipping && <AddressFields legend={c.shippingTitle} language={language} value={customerDraft.shipping} onChange={shipping => setCustomerDraft({ ...customerDraft, shipping })}/>}</fieldset>
        {draftReview('customer', customerDraft.revision)}{reviewPanel('customer')}<div className="fp-actions"><button type="submit" className="account-button fp-primary" disabled={locked || draftChanged(customerDraft.revision)}>{state.writing ? c.saving : c.saveCustomer}</button><button type="button" className="account-button secondary" disabled={locked} onClick={() => { setCustomerDraft(null); setReview(null); setErrorCode(''); }}>{c.cancel}</button></div></form>}
        {currentCustomers.items.length ? <ul className="fp-records">{(currentCustomers.items as readonly UsFinancialPilotParty[]).map(row => <li className="fp-record" key={row.id}><div><strong>{row.name}</strong><span>{row.contactName || row.billingAddress.city}</span>{row.email && <a href={`mailto:${encodeURIComponent(row.email)}`}>{row.email}</a>}</div><button type="button" className="fp-link" disabled={locked || !!quoteDraft} onClick={() => newQuote(row.id, row.paymentTermsDays)}>{c.newQuote}</button></li>)}</ul> : <p className="fp-empty">{c.emptyCustomers}</p>}{pagination('customers', currentCustomers)}
      </section>
      <section hidden={tab !== 'estimates'} className="fp-register">
        {selected && !quoteDraft ? <div className="fp-detail"><button type="button" className="fp-back" disabled={state.pending||state.writing} onClick={() => { setSelected(null); setDetail(null); setAcceptance(null); setReview(null); setErrorCode(''); }}><ArrowLeft size={18} aria-hidden/>{c.back}</button>{!currentDetail ? <p className="fp-empty" aria-live="polite">{c.loading}</p> : <>
          <div className="fp-detail-heading"><div><h2>{currentDetail.estimate.number}</h2><p>{currentDetail.customer.name}</p></div><span className="fp-status">{currentDetail.estimate.status === 'accepted' ? c.acceptedStatus : c[currentDetail.estimate.status]}</span></div>
          <div className="fp-document-actions"><button type="button" className="account-button secondary" disabled={locked || currentDetail.lines.length > US_FINANCIAL_PILOT_COMMERCIAL_MAX_LINES} onClick={editQuote}>{c.editQuote}</button>{currentDetail.estimate.status !== 'accepted' && !acceptance && <button type="button" className="account-button fp-primary" disabled={locked} onClick={() => setAcceptance({ token: ++sequence.current, revision: snapshot.revision, estimateId: currentDetail.estimate.id, estimateRevision: currentDetail.estimate.revision })}>{c.accept}</button>}</div>
          {currentDetail.lines.length > US_FINANCIAL_PILOT_COMMERCIAL_MAX_LINES && <p className="fp-context">{lineLimit}</p>}
          {acceptance && <div className="fp-payment"><h3>{c.acceptanceTitle}</h3><p>{c.acceptanceNotice}</p>{draftReview('accept', acceptance.revision)}{reviewPanel('accept')}<div className="fp-actions"><button type="button" className="account-button fp-primary" disabled={locked || draftChanged(acceptance.revision) || currentDetail.estimate.status === 'accepted'} onClick={() => { void submit({ type: 'accept_estimate', estimateId: acceptance.estimateId, expectedEstimateRevision: acceptance.estimateRevision }, acceptance.token, acceptance.revision); }}>{state.writing ? c.saving : c.accept}</button><button type="button" className="account-button secondary" disabled={locked} onClick={() => { setAcceptance(null); setReview(null); }}>{c.cancel}</button></div></div>}
          <article className="fp-document" aria-label={c.details}><div className="fp-parties"><div><h3>{currentDetail.customer.name}</h3><PartyAddress party={currentDetail.customer}/></div><div><h3>{c.terms}</h3><p>{currentDetail.paymentTermsDays}</p>{currentDetail.projectId && <><h3>{c.project}</h3><p>{currentDetail.projectId}</p></>}</div></div><dl className="fp-document-dates"><div><dt>{c.quoteDate}</dt><dd>{date(currentDetail.estimate.date)}</dd></div><div><dt>{c.expiry}</dt><dd>{date(currentDetail.estimate.expiresAt)}</dd></div></dl>
            <ul className="fp-lines">{currentDetail.lines.map(line => <li key={line.id}><div><strong>{line.description}</strong><span>{c.quantity}: {commercialQuantityText(line.quantityUnits, line.quantityScale)} · {usd(line.unitPriceMinor)}</span><span>{c[line.taxTreatment]} · {c.discount}: {commercialMajor(String(line.discountBasisPoints))}%</span></div><dl><div><dt>{c.beforeTax}</dt><dd>{usd(line.netMinor)}</dd></div></dl></li>)}</ul><dl className="fp-document-total"><div><dt>{c.subtotal}</dt><dd>{usd(currentDetail.subtotalMinor)}</dd></div><div><dt>{c.discountTotal}</dt><dd>{usd(currentDetail.discountMinor)}</dd></div><div><dt>{c.beforeTax}</dt><dd>{usd(currentDetail.netMinor)}</dd></div></dl><p className="fp-context">{c.noTax}</p>{currentDetail.notes && <div className="fp-notes"><h3>{c.notes}</h3><p>{currentDetail.notes}</p></div>}</article>
        </>}</div> : <><div className="fp-register-title fpc-title"><h2>{browserUsFinancialPilotCopy[language].estimates}</h2><span>{currentQuotes.total}</span>{!quoteDraft && <button type="button" className="account-button fp-primary" disabled={locked} onClick={() => newQuote()}>{c.newQuote}</button>}</div>
          {quoteDraft && <form className="fp-payment fpc-form" onSubmit={saveQuote}><h3>{quoteDraft.estimateId ? c.editQuote : c.quoteTitle}</h3><fieldset disabled={locked || tooManyLines} className="fpc-fields"><div className="fp-form-grid">
            <label className="fpc-wide">{c.customer}<select required value={quoteDraft.customerId} onChange={event => { const customer = customerChoices.find(item => item.id === event.target.value); setQuoteDraft({ ...quoteDraft, customerId: event.target.value, ...(customer ? { terms: String(customer.paymentTermsDays) } : {}) }); }}><option value="">{c.selectCustomer}</option>{!customerChoices.some(item => item.id === quoteDraft.customerId) && quoteDraft.customerId && <option value={quoteDraft.customerId}>{created?.id === quoteDraft.customerId ? created.name : c.selectedCustomer}</option>}{customerChoices.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
            <div className="fpc-customer-more fpc-wide"><span>{customerChoices.length} / {snapshot.customers.total} {c.customersLoaded}</span>{choicesCursor && <button type="button" className="fp-link" disabled={locked} onClick={() => { void moreCustomerChoices(); }}>{c.moreCustomers}</button>}</div>
            <label>{c.quoteDate}<input required type="date" value={quoteDraft.date} onChange={event => setQuoteDraft({ ...quoteDraft, date: event.target.value })}/></label><label>{c.expiry}<input required type="date" min={quoteDraft.date} value={quoteDraft.expiresAt} onChange={event => setQuoteDraft({ ...quoteDraft, expiresAt: event.target.value })}/></label><label>{c.terms}<input required type="number" min="0" max="365" step="1" value={quoteDraft.terms} onChange={event => setQuoteDraft({ ...quoteDraft, terms: event.target.value })}/></label>
          </div>{quoteDraft.projectId && <p className="fp-context">{c.noProjectChange}</p>}<h3 className="fpc-lines-heading">{c.lines}</h3><p className="fpc-hint">{c.decimalHint}</p><div className="fpc-edit-lines">{quoteDraft.lines.map((line, index) => <fieldset key={line.key} className="fpc-edit-line"><legend>{c.line} {index + 1}</legend><div className="fp-form-grid"><label className="fpc-wide">{c.description}<textarea required rows={2} maxLength={4000} value={line.description} onChange={event => updateLine(line.key, { description: event.target.value })}/></label><label>{c.quantity}<input required inputMode="decimal" maxLength={44} pattern="(0|[1-9][0-9]*)([.][0-9]{1,6})?" value={line.quantity} onChange={event => updateLine(line.key, { quantity: event.target.value })}/></label><label>{c.unitPrice}<input required inputMode="decimal" maxLength={39} pattern="(0|[1-9][0-9]*)([.][0-9]{1,2})?" value={line.price} onChange={event => updateLine(line.key, { price: event.target.value })}/></label><label>{c.discount}<input required inputMode="decimal" maxLength={6} pattern="(0|[1-9][0-9]*)([.][0-9]{1,2})?" value={line.discount} onChange={event => updateLine(line.key, { discount: event.target.value })}/></label><label>{c.taxTreatment}<select value={line.taxTreatment} onChange={event => updateLine(line.key, { taxTreatment: event.target.value as LineDraft['taxTreatment'] })}>{(['taxable', 'non_taxable', 'exempt'] as const).map(treatment => <option key={treatment} value={treatment}>{c[treatment]}</option>)}</select></label></div><button type="button" className="fp-link" disabled={quoteDraft.lines.length === 1} onClick={() => setQuoteDraft({ ...quoteDraft, lines: quoteDraft.lines.filter(item => item.key !== line.key) })}>{c.removeLine}</button></fieldset>)}</div><button type="button" className="account-button secondary" disabled={quoteDraft.lines.length >= US_FINANCIAL_PILOT_COMMERCIAL_MAX_LINES} onClick={() => setQuoteDraft({ ...quoteDraft, lines: [...quoteDraft.lines, newLine()] })}>{c.addLine}</button><label className="fpc-notes">{c.notes} · {c.optional}<textarea rows={4} maxLength={20000} value={quoteDraft.notes} onChange={event => setQuoteDraft({ ...quoteDraft, notes: event.target.value })}/></label></fieldset>
          {tooManyLines && <p className="fp-context">{lineLimit}</p>}{draftNet !== null && <dl className="fp-document-total"><div><dt>{c.beforeTax}</dt><dd>{usd(draftNet)}</dd></div></dl>}<p className="fp-context">{c.noTax}</p>{draftReview('quote', quoteDraft.revision)}{reviewPanel('quote')}<div className="fp-actions"><button type="submit" className="account-button fp-primary" disabled={locked || tooManyLines || draftChanged(quoteDraft.revision)}>{state.writing ? c.saving : c.saveQuote}</button><button type="button" className="account-button secondary" disabled={locked} onClick={() => { setQuoteDraft(null); setReview(null); setErrorCode(''); }}>{c.cancel}</button></div></form>}
          {currentQuotes.items.length ? <ul className="fp-records">{(currentQuotes.items as readonly UsFinancialPilotEstimateRow[]).map(row => <li key={row.id}><button type="button" className="fp-invoice-row" disabled={locked || !!quoteDraft} onClick={() => { setSelected(row.id); setMinimumDetailRevision(0); setDetail(null); setErrorCode(''); setMessage(null); }}><div><strong>{row.number}</strong><span>{row.customerName}</span><small>{date(row.date)} · {row.status === 'accepted' ? c.acceptedStatus : c[row.status]}</small></div><div className="fp-row-amount"><strong>{usd(row.netMinor)}</strong><span>{c.beforeTax}</span></div><ChevronRight size={18} aria-hidden/></button></li>)}</ul> : <p className="fp-empty">{c.emptyQuotes}</p>}{pagination('estimates', currentQuotes)}
        </>}
      </section>
    </div>
  </>;
}
