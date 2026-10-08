'use client';

import { useCallback, useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import type { AccountRole } from '@/lib/account-security';
import type { SiteLanguage } from '@/lib/site-language';
import { AUTH_CHANGED_EVENT } from '@/lib/auth-browser-events';
import { countrySubdivisions } from '@/lib/international/addresses';
import { minorInteger } from '@/lib/international/accounting/ledger';
import { browserSellerCopy, browserWorkbenchCopy } from '@/lib/international/browser-workbench-copy';
import { BrowserErpError, createBrowserErpSession, type BrowserErpRead, type BrowserErpSession } from '@/lib/international/browser-erp-session';
import { validateErpRequest } from '@/lib/international/erp-request';
import { estimateTotals, lineTotals, type SalesLine } from '@/lib/international/invoicing';
import { formatDateOnly } from '@/lib/international/localization';
import { addMoney, decimalToMoney, formatMoney, money } from '@/lib/international/money';
import type { ErpCommand, ErpState } from '@/lib/international/runtime-types';
import { UsSellerProfilePanel } from './us-seller-profile-panel';
import { UsTaxProfilePanel } from './us-tax-profile-panel';
import './us-erp-workbench.css';

export interface BrowserCustomerDraft {
  kind: 'business' | 'individual'; name: string; line1: string; line2: string; city: string; subdivision: string; postalCode: string;
  email: string; phone: string; contactName: string; paymentTermsDays: string;
}
export interface BrowserEstimateLineDraft { id: string; description: string; quantity: string; unitPrice: string }
export interface BrowserEstimateDraft {
  customerId: string; date: string; expiresAt: string; paymentTermsDays: string; notes: string; lines: readonly BrowserEstimateLineDraft[];
}
const emptyCustomer = (): BrowserCustomerDraft => ({ kind: 'business', name: '', line1: '', line2: '', city: '', subdivision: '', postalCode: '', email: '', phone: '', contactName: '', paymentTermsDays: '' });
const emptyEstimate = (): BrowserEstimateDraft => ({ customerId: '', date: '', expiresAt: '', paymentTermsDays: '', notes: '', lines: [{ id: 'line-1', description: '', quantity: '', unitPrice: '' }] });
function days(value: string): number {
  if (!/^[0-9]{1,3}$/.test(value) || Number(value) > 365) throw new TypeError('Invalid payment terms');
  return Number(value);
}
function checked(command: ErpCommand, organizationId: string): ErpCommand {
  return validateErpRequest({ idempotencyKey: 'workbench-validation', expectedRevision: 0, command }, organizationId).command;
}
export function buildBrowserCustomerCommand(organizationId: string, draft: BrowserCustomerDraft, id: string): ErpCommand {
  return checked({ type: 'save_customer', customer: {
    id, organizationId, kind: draft.kind, name: draft.name.trim(),
    billingAddress: { country: 'US', line1: draft.line1.trim(), ...(draft.line2.trim() ? { line2: draft.line2.trim() } : {}), city: draft.city.trim(), subdivision: draft.subdivision, postalCode: draft.postalCode.trim() },
    ...(draft.email.trim() ? { email: draft.email.trim() } : {}), ...(draft.phone.trim() ? { phone: draft.phone.trim() } : {}),
    ...(draft.contactName.trim() ? { contactName: draft.contactName.trim() } : {}), paymentTermsDays: days(draft.paymentTermsDays),
  } }, organizationId);
}
export function browserSalesLine(draft: BrowserEstimateLineDraft): SalesLine {
  if (!/^[0-9]{1,30}(?:\.[0-9]{1,6})?$/.test(draft.quantity) || !/^[0-9]{1,30}(?:\.[0-9]{1,2})?$/.test(draft.unitPrice)) throw new TypeError('Invalid decimal input');
  const [whole, fraction = ''] = draft.quantity.split('.');
  const units = BigInt(whole + fraction);
  if (units <= BigInt(0)) throw new TypeError('Invalid quantity');
  const line: SalesLine = { id: draft.id, description: draft.description.trim(), quantityUnits: units.toString(), quantityScale: fraction.length, unitPrice: decimalToMoney('USD', draft.unitPrice), discountBasisPoints: 0, taxTreatment: 'taxable' };
  Object.values(lineTotals(line, 'USD')).forEach(total => minorInteger(total.minorUnits));
  return line;
}
export function buildBrowserEstimateCommand(organizationId: string, draft: BrowserEstimateDraft, id: string): ErpCommand {
  if (draft.expiresAt < draft.date || !draft.lines.length || new Set(draft.lines.map(line => line.id)).size !== draft.lines.length) throw new TypeError('Invalid estimate');
  const lines = draft.lines.map(browserSalesLine);
  minorInteger(lines.reduce((total, line) => addMoney(total, lineTotals(line, 'USD').gross), money('USD', '0')).minorUnits);
  return checked({ type: 'save_estimate', id, expectedEstimateRevision: 0, customerId: draft.customerId, date: draft.date, expiresAt: draft.expiresAt, paymentTermsDays: days(draft.paymentTermsDays), notes: draft.notes, lines }, organizationId);
}
export function buildBrowserInitializeCommand(organizationId: string, start: string, end: string, periodId: string): ErpCommand {
  if (start > end) throw new TypeError('Invalid period');
  return checked({ type: 'initialize', periods: [{ id: periodId, start, end, status: 'open' }] }, organizationId);
}
const locales: Record<SiteLanguage, string> = { fr: 'fr-US', de: 'de-US', it: 'it-US', en: 'en-US' };

/** Only persisted records are displayed here; form drafts never become optimistic ERP records. */
export function UsErpRecords({ state, language, canWrite, disabled, onAccept }: { state: ErpState; language: SiteLanguage; canWrite: boolean; disabled: boolean; onAccept: (id: string) => void }) {
  const c = browserWorkbenchCopy[language];
  return <>
    <section className="us-erp-section" aria-label={c.customers}><h2>{c.customers}</h2>
      {!state.customers.length ? <p className="us-erp-muted">{c.emptyCustomers}</p> : <ul className="us-erp-records">{state.customers.map(customer => <li key={customer.id}><strong>{customer.name}</strong><p>{customer.billingAddress.line1}{customer.billingAddress.line2 ? `, ${customer.billingAddress.line2}` : ''}<br />{customer.billingAddress.city}, {customer.billingAddress.subdivision} {customer.billingAddress.postalCode}</p></li>)}</ul>}
    </section>
    <section className="us-erp-section" aria-label={c.estimates}><h2>{c.estimates}</h2>
      {!state.estimates.length ? <p className="us-erp-muted">{c.emptyEstimates}</p> : <div className="us-erp-records">{state.estimates.map(estimate => <article key={estimate.id} className="us-erp-estimate">
        <div className="us-erp-record-heading"><h3>{estimate.number}</h3><span>{c[estimate.status]}</span></div>
        <p>{estimate.customer.name}</p><dl className="us-erp-facts"><div><dt>{c.date}</dt><dd><time dateTime={estimate.date}>{formatDateOnly(estimate.date, locales[language])}</time></dd></div><div><dt>{c.expiresAt}</dt><dd><time dateTime={estimate.expiresAt}>{formatDateOnly(estimate.expiresAt, locales[language])}</time></dd></div><div><dt>{c.terms}</dt><dd>{estimate.paymentTermsDays}</dd></div></dl>
        <ul className="us-erp-saved-lines">{estimate.lines.map(line => <li key={line.id}><span>{line.description}</span><strong>{formatMoney(lineTotals(line, 'USD').net, locales[language])}</strong></li>)}</ul>
        <p className="us-erp-subtotal">{c.subtotal} <strong>{formatMoney(estimateTotals(estimate).net, locales[language])}</strong></p><p className="us-erp-muted">{c.taxPending}</p>
        {estimate.notes && <p className="us-erp-notes">{estimate.notes}</p>}
        {canWrite && estimate.status === 'draft' && <button type="button" className="account-button secondary" disabled={disabled} onClick={() => onAccept(estimate.id)}>{c.accept}</button>}
      </article>)}</div>}
    </section>
  </>;
}

export interface UsErpWorkbenchProps { organizationId: string; expectedUserId: string; role: AccountRole; language: SiteLanguage }
export function UsErpWorkbench(props: UsErpWorkbenchProps) {
  return <UsErpWorkbenchPanel key={`${props.organizationId}:${props.expectedUserId}:${props.role}`} {...props} />;
}
function UsErpWorkbenchPanel({ organizationId, expectedUserId, role, language }: UsErpWorkbenchProps) {
  const c = browserWorkbenchCopy[language], prefix = useId();
  const session = useRef<BrowserErpSession | null>(null), generation = useRef(0), privacyEpoch = useRef(0), busyRef = useRef(true), pendingType = useRef<ErpCommand['type'] | null>(null), noticeRef = useRef<HTMLDivElement>(null), nextLine = useRef(2);
  const sellerBusyRef = useRef(true), sellerPendingRef = useRef(false);
  const taxBusyRef = useRef(false), taxPendingRef = useRef(false), taxInvalidation = useRef<(() => void) | null>(null), erpAdmittedRef = useRef(false);
  const [read, setRead] = useState<BrowserErpRead | null>(null), [busy, setBusy] = useState(true), [fresh, setFresh] = useState(false), [pending, setPending] = useState(false);
  const [readEpoch, setReadEpoch] = useState(0);
  const [sellerBusy, setSellerBusy] = useState(true), [sellerPending, setSellerPending] = useState(false), [accessEpoch, setAccessEpoch] = useState(0), [writeLocked, setWriteLocked] = useState(false);
  const [taxBusy, setTaxBusy] = useState(false), [taxPending, setTaxPending] = useState(false), [taxAdmitted, setTaxAdmitted] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; key: 'invalid' | 'unavailable' | 'denied' | 'conflict' | 'uncertain' | 'saved' | 'savedReload' } | null>(null);
  const [customer, setCustomer] = useState(emptyCustomer), [estimate, setEstimate] = useState(emptyEstimate), [start, setStart] = useState(''), [end, setEnd] = useState(''), [acceptId, setAcceptId] = useState<string | null>(null);
  const canWrite = role !== 'read_only', blocked = busy || pending || sellerBusy || sellerPending || taxBusy || taxPending || !fresh || writeLocked;
  const invalidateAccess = useCallback(() => {
    const epoch = ++privacyEpoch.current; setAccessEpoch(epoch); setWriteLocked(true);
    taxInvalidation.current?.();
    erpAdmittedRef.current = false;
    setTaxAdmitted(false);
    setRead(null); setFresh(false); setAcceptId(null); setCustomer(emptyCustomer()); setEstimate(emptyEstimate()); setStart(''); setEnd(''); setNotice({ kind: 'error', key: 'denied' });
  }, []);
  const currentAccessEpoch = useCallback(() => privacyEpoch.current, []), otherBusy = useCallback(() => busyRef.current || taxBusyRef.current, []), otherPending = useCallback(() => (session.current?.hasPending() ?? false) || taxPendingRef.current, []);
  const taxOtherBusy = useCallback(() => busyRef.current || sellerBusyRef.current, []), taxOtherPending = useCallback(() => (session.current?.hasPending() ?? false) || sellerPendingRef.current, []);
  const onTaxBusy = useCallback((value: boolean) => { taxBusyRef.current = value; setTaxBusy(value); }, []), onTaxPending = useCallback((value: boolean) => { taxPendingRef.current = value; setTaxPending(value); }, []);
  const registerTaxInvalidation = useCallback((invalidate: (() => void) | null) => { taxInvalidation.current = invalidate; }, []);
  const onSellerBusy = useCallback((value: boolean) => { sellerBusyRef.current = value; setSellerBusy(value); if (!value && erpAdmittedRef.current && privacyEpoch.current === 0) setTaxAdmitted(true); }, []), onSellerPending = useCallback((value: boolean) => { sellerPendingRef.current = value; setSellerPending(value); }, []);
  const admitPrivate = useCallback(() => { erpAdmittedRef.current = true; if (!sellerBusyRef.current && privacyEpoch.current === 0) setTaxAdmitted(true); }, []);
  const errorNotice = useCallback((error: unknown) => {
    if (error instanceof BrowserErpError && (error.outcome === 'unauthorized' || [401, 402, 403].includes(error.status))) {
      invalidateAccess();
      return 'denied' as const;
    }
    if (error instanceof BrowserErpError && ['feature_unavailable', 'edition_unavailable', 'configuration_changed', 'country_configuration_required'].includes(error.code)) setRead(null);
    if (error instanceof BrowserErpError && ['revision_conflict', 'estimate_revision_conflict', 'idempotency_conflict', 'read_required'].includes(error.code)) { setAcceptId(null); return 'conflict' as const; }
    return error instanceof BrowserErpError && error.outcome === 'uncertain' ? 'uncertain' as const : 'unavailable' as const;
  }, [invalidateAccess]);
  useEffect(() => {
    const current = ++generation.current, privacy = privacyEpoch.current;
    const instance = createBrowserErpSession({ organizationId, expectedUserId }); session.current = instance;
    void instance.load().then(value => { if (generation.current === current && privacyEpoch.current === privacy) { setRead(value); setReadEpoch(privacy); setFresh(true); admitPrivate(); } }).catch(error => {
      if (generation.current === current && privacyEpoch.current === privacy) setNotice({ kind: 'error', key: errorNotice(error) });
    }).finally(() => { if (generation.current === current) { busyRef.current = false; setBusy(false); } });
    return () => { generation.current = current + 1; instance.dispose(); session.current = null; };
  }, [organizationId, expectedUserId, errorNotice, admitPrivate]);
  useEffect(() => {
    const changed = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== AUTH_CHANGED_EVENT) return;
      // UX purge only: the server's expected-user check is the actual actor fence.
      invalidateAccess();
    };
    window.addEventListener('storage', changed); window.addEventListener(AUTH_CHANGED_EVENT, changed);
    return () => { window.removeEventListener('storage', changed); window.removeEventListener(AUTH_CHANGED_EVENT, changed); };
  }, [invalidateAccess]);
  useEffect(() => { if (notice?.kind === 'error') noticeRef.current?.focus(); }, [notice]);
  async function reload() {
    const instance = session.current, current = generation.current, privacy = privacyEpoch.current;
    if (!instance || busyRef.current || sellerBusyRef.current || taxBusyRef.current) return;
    busyRef.current = true; setBusy(true); setFresh(false); setAcceptId(null); setNotice(null);
    try { const value = await instance.load(); if (generation.current === current && privacyEpoch.current === privacy) { setRead(value); setReadEpoch(privacy); setFresh(true); admitPrivate(); } }
    catch (error) { if (generation.current === current && privacyEpoch.current === privacy) setNotice({ kind: 'error', key: errorNotice(error) }); }
    finally { if (generation.current === current) { setPending(instance.hasPending()); busyRef.current = false; setBusy(false); } }
  }
  async function write(command?: ErpCommand) {
    const instance = session.current, current = generation.current, privacy = privacyEpoch.current;
    if (!instance || busyRef.current || sellerBusyRef.current || taxBusyRef.current || command && (blocked || !canWrite || !read || privacy !== readEpoch || sellerPendingRef.current || taxPendingRef.current)) return;
    busyRef.current = true; setBusy(true); setFresh(false); setNotice(null); setAcceptId(null);
    let confirmed = false;
    if (command) pendingType.current = command.type;
    try {
      if (command) await instance.submit(command, read?.status === 'ready' ? read.state.revision : 0); else await instance.retry();
      confirmed = true;
      if (generation.current !== current || privacyEpoch.current !== privacy) return;
      // A confirmed creation clears its form, while manual reloads and rejected/uncertain writes preserve drafts.
      if (pendingType.current === 'save_customer') setCustomer(emptyCustomer());
      if (pendingType.current === 'save_estimate') { setEstimate(emptyEstimate()); nextLine.current = 2; }
      pendingType.current = null;
      const value = await instance.load();
      if (generation.current === current && privacyEpoch.current === privacy) { setRead(value); setReadEpoch(privacy); setFresh(true); setNotice({ kind: 'success', key: 'saved' }); }
    } catch (error) {
      if (generation.current === current && privacyEpoch.current === privacy) {
        const key = errorNotice(error);
        setNotice({ kind: 'error', key: key === 'denied' ? key : confirmed ? 'savedReload' : key });
      }
    } finally { if (generation.current === current) { setPending(instance.hasPending()); busyRef.current = false; setBusy(false); } }
  }
  function submit(event: SubmitEvent<HTMLFormElement>, build: () => ErpCommand) {
    event.preventDefault(); if (blocked || !canWrite) return;
    try { const command = build(); void write(command); } catch { setNotice({ kind: 'error', key: 'invalid' }); }
  }
  function field(label: string, value: string, onChange: (value: string) => void, options: { type?: string; required?: boolean; maxLength?: number; inputMode?: 'decimal' | 'numeric'; autoComplete?: string; id?: string } = {}) {
    return <label>{label}<input {...options} value={value} onChange={event => onChange(event.target.value)} /></label>;
  }
  const customerField = (key: Exclude<keyof BrowserCustomerDraft, 'kind'>, label: string, required = true, options: Parameters<typeof field>[3] = {}) => field(label, customer[key], value => setCustomer(previous => ({ ...previous, [key]: value })), { required, maxLength: 160, ...options });
  let preview: string | null = null;
  try { preview = formatMoney(estimate.lines.reduce((total, line) => addMoney(total, lineTotals(browserSalesLine(line), 'USD').net), money('USD', '0')), locales[language]); } catch { /* Partial drafts have no authoritative or invented amount. */ }
  const acceptedEstimate = read?.status === 'ready' ? read.state.estimates.find(item => item.id === acceptId && item.status === 'draft') : undefined;
  return <div className="us-erp-workbench" lang={language}>
    <header className="us-erp-heading"><h1>{c.title}</h1><p>{c.introduction}</p><p className="us-erp-limitation">{c.limitation}</p></header>
    <div className="us-erp-toolbar"><button type="button" className="account-button secondary" disabled={busy || sellerBusy || taxBusy} onClick={() => void reload()}>{busy ? c.reloading : c.reload}</button>{read?.status === 'ready' && <span>{c.revision} {read.state.revision}</span>}</div>
    <p className="us-erp-muted">{c.draftKept}</p>
    {notice && <div className={`us-erp-notice ${notice.kind}`} ref={noticeRef} tabIndex={-1} role={notice.kind === 'error' ? 'alert' : 'status'}>{c[notice.key]}</div>}
    {pending && <aside className="us-erp-pending" aria-live="polite"><p>{c.pending}</p><p>{c.pendingMemory}</p><button type="button" className="account-button" disabled={busy || sellerBusy || taxBusy} onClick={() => void write()}>{busy ? c.busy : c.retry}</button></aside>}
    {!read && !notice && <output>{c.loading}</output>}
    {writeLocked && <p className="us-erp-muted">{browserSellerCopy[language].writeLocked}</p>}
    <UsSellerProfilePanel organizationId={organizationId} expectedUserId={expectedUserId} role={role} language={language} blocked={busy || pending || taxBusy || taxPending} writeLocked={writeLocked} accessEpoch={accessEpoch}
      currentAccessEpoch={currentAccessEpoch} otherBusy={otherBusy} otherPending={otherPending}
      onBusyChange={onSellerBusy} onPendingChange={onSellerPending} onAccessDenied={invalidateAccess} />
    <UsTaxProfilePanel organizationId={organizationId} expectedUserId={expectedUserId} role={role} language={language} admitted={taxAdmitted} blocked={busy || pending || sellerBusy || sellerPending} writeLocked={writeLocked} accessEpoch={accessEpoch}
      currentAccessEpoch={currentAccessEpoch} otherBusy={taxOtherBusy} otherPending={taxOtherPending}
      onBusyChange={onTaxBusy} onPendingChange={onTaxPending} onAccessDenied={invalidateAccess} registerInvalidation={registerTaxInvalidation} />
    {!canWrite && <p className="us-erp-muted">{c.readOnly}</p>}
    {read?.status === 'uninitialized' && <section className="us-erp-section"><h2>{c.initializeTitle}</h2><p>{c.initializeHelp}</p>{role === 'owner' ? <form onSubmit={event => submit(event, () => buildBrowserInitializeCommand(organizationId, start, end, crypto.randomUUID()))}>
      <fieldset disabled={blocked} className="us-erp-form"><div className="us-erp-grid">{field(c.periodStart, start, setStart, { type: 'date', required: true })}{field(c.periodEnd, end, setEnd, { type: 'date', required: true })}</div><button type="submit" className="account-button">{c.initialize}</button></fieldset>
    </form> : <p>{c.ownerRequired}</p>}</section>}
    {read?.status === 'ready' && <>
      <UsErpRecords state={read.state} language={language} canWrite={canWrite} disabled={blocked} onAccept={setAcceptId} />
      {acceptedEstimate && canWrite && <section className="us-erp-confirm" aria-label={c.confirmAcceptance}><h2>{acceptedEstimate.number}</h2><p>{c.acceptanceHelp}</p><div className="us-erp-actions"><button type="button" className="account-button" disabled={blocked} onClick={() => void write({ type: 'accept_estimate', estimateId: acceptedEstimate.id, expectedEstimateRevision: acceptedEstimate.revision })}>{c.confirmAcceptance}</button><button type="button" className="account-button secondary" disabled={busy} onClick={() => setAcceptId(null)}>{c.cancel}</button></div></section>}
      {canWrite && <>
        <details className="us-erp-editor"><summary>{c.newCustomer}</summary><form onSubmit={event => submit(event, () => buildBrowserCustomerCommand(organizationId, customer, crypto.randomUUID()))}><fieldset disabled={blocked} className="us-erp-form">
          <label>{c.customerKind}<select aria-label={c.customerKind} value={customer.kind} onChange={event => setCustomer(previous => ({ ...previous, kind: event.target.value as BrowserCustomerDraft['kind'] }))}><option value="business">{c.business}</option><option value="individual">{c.individual}</option></select></label>
          {customerField('name', c.customerName)}{customerField('line1', c.address, true, { maxLength: 200, autoComplete: 'street-address' })}{customerField('line2', c.address2, false, { maxLength: 200 })}
          <div className="us-erp-grid">{customerField('city', c.city, true, { maxLength: 120 })}<label>{c.state}<select aria-label={c.state} required value={customer.subdivision} onChange={event => setCustomer(previous => ({ ...previous, subdivision: event.target.value }))}><option value="">{c.choose}</option>{countrySubdivisions.US.map(state => <option key={state} value={state}>{state}</option>)}</select></label>{customerField('postalCode', c.postalCode, true, { maxLength: 10, autoComplete: 'postal-code' })}</div>
          <div className="us-erp-grid">{customerField('email', c.email, false, { type: 'email', maxLength: 254 })}{customerField('phone', c.phone, false, { type: 'tel', maxLength: 80 })}</div>{customerField('contactName', c.contactName, false)}{customerField('paymentTermsDays', c.terms, true, { inputMode: 'numeric', maxLength: 3 })}
          <button type="submit" className="account-button">{c.saveCustomer}</button>
        </fieldset></form></details>
        <details className="us-erp-editor"><summary>{c.newEstimate}</summary>{!read.state.customers.length ? <p>{c.noCustomer}</p> : <form onSubmit={event => submit(event, () => buildBrowserEstimateCommand(organizationId, estimate, crypto.randomUUID()))}><fieldset disabled={blocked} className="us-erp-form">
          <label>{c.customer}<select aria-label={c.customer} required value={estimate.customerId} onChange={event => setEstimate(previous => ({ ...previous, customerId: event.target.value }))}><option value="">{c.choose}</option>{read.state.customers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <div className="us-erp-grid">{field(c.date, estimate.date, value => setEstimate(previous => ({ ...previous, date: value })), { type: 'date', required: true })}{field(c.expiresAt, estimate.expiresAt, value => setEstimate(previous => ({ ...previous, expiresAt: value })), { type: 'date', required: true })}{field(c.terms, estimate.paymentTermsDays, value => setEstimate(previous => ({ ...previous, paymentTermsDays: value })), { required: true, inputMode: 'numeric', maxLength: 3 })}</div>
          <p id={`${prefix}-decimals`} className="us-erp-muted">{c.decimalHelp}</p>
          {estimate.lines.map((line, index) => <div className="us-erp-line" key={line.id}><h3>{c.line} {index + 1}</h3>{field(c.description, line.description, value => setEstimate(previous => ({ ...previous, lines: previous.lines.map(item => item.id === line.id ? { ...item, description: value } : item) })), { required: true, maxLength: 4000 })}<div className="us-erp-grid" aria-describedby={`${prefix}-decimals`}>{field(c.quantity, line.quantity, value => setEstimate(previous => ({ ...previous, lines: previous.lines.map(item => item.id === line.id ? { ...item, quantity: value } : item) })), { required: true, inputMode: 'decimal', maxLength: 37 })}{field(c.unitPrice, line.unitPrice, value => setEstimate(previous => ({ ...previous, lines: previous.lines.map(item => item.id === line.id ? { ...item, unitPrice: value } : item) })), { required: true, inputMode: 'decimal', maxLength: 33 })}</div>{estimate.lines.length > 1 && <button type="button" className="account-button secondary" onClick={() => setEstimate(previous => ({ ...previous, lines: previous.lines.filter(item => item.id !== line.id) }))}>{c.removeLine} {index + 1}</button>}</div>)}
          <button type="button" className="account-button secondary" disabled={estimate.lines.length >= 100} onClick={() => { const id = `line-${nextLine.current++}`; setEstimate(previous => ({ ...previous, lines: [...previous.lines, { id, description: '', quantity: '', unitPrice: '' }] })); }}>{c.addLine}</button>
          <label>{c.notes}<textarea maxLength={20000} rows={4} value={estimate.notes} onChange={event => setEstimate(previous => ({ ...previous, notes: event.target.value }))} /></label>
          {preview && <p className="us-erp-subtotal">{c.subtotal} <strong>{preview}</strong></p>}<p className="us-erp-muted">{c.taxPending}</p><button type="submit" className="account-button">{c.saveEstimate}</button>
        </fieldset></form>}</details>
      </>}
    </>}
  </div>;
}
