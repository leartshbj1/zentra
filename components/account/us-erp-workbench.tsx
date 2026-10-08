'use client';

import { useCallback, useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import type { AccountRole } from '@/lib/account-security';
import type { SiteLanguage } from '@/lib/site-language';
import { AUTH_CHANGED_EVENT } from '@/lib/auth-browser-events';
import { countrySubdivisions } from '@/lib/international/addresses';
import { minorInteger } from '@/lib/international/accounting/ledger';
import { browserSellerCopy, browserWorkbenchCopy } from '@/lib/international/browser-workbench-copy';
import { BrowserErpError, createBrowserErpSession, type BrowserErpRead, type BrowserErpSession } from '@/lib/international/browser-erp-session';
import { browserPurchasingCopy } from '@/lib/international/browser-purchasing-copy';
import { browserSalesCopy, browserExportErrorCopy } from '@/lib/international/browser-sales-copy';
import { buildBrowserInvoiceCommand, buildBrowserCustomerPaymentCommand, canUseBrowserSales, emptyBrowserInvoice, emptyBrowserCustomerPayment, type BrowserInvoiceDraft, type BrowserCustomerPaymentDraft } from '@/lib/international/browser-sales';
import { browserPurchaseTotal, buildBrowserVendorBillCommand, buildBrowserVendorCommand, buildBrowserVendorPaymentCommand, emptyBrowserVendor, emptyBrowserVendorBill, emptyBrowserVendorPayment, type BrowserVendorDraft, type BrowserVendorBillDraft, type BrowserVendorPaymentDraft } from '@/lib/international/browser-purchasing';
import { validateErpRequest } from '@/lib/international/erp-request';
import { estimateTotals, invoiceBalance, lineTotals, type SalesLine } from '@/lib/international/invoicing';
import { formatDateOnly } from '@/lib/international/localization';
import { addMoney, decimalToMoney, formatMoney, money } from '@/lib/international/money';
import type { ErpCommand, ErpState } from '@/lib/international/runtime-types';
import { vendorBillBalance } from '@/lib/international/purchasing';
import { UsSellerProfilePanel } from './us-seller-profile-panel';
import { UsTaxProfilePanel } from './us-tax-profile-panel';
import { UsDocumentExports, UsErpReports } from './us-erp-reports';
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
export function UsErpRecords({ state, language, canWrite, disabled, onAccept, exportAccess }: { state: ErpState; language: SiteLanguage; canWrite: boolean; disabled: boolean; onAccept: (id: string) => void; exportAccess?: Omit<Parameters<typeof UsDocumentExports>[0], 'selector' | 'revision'> }) {
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
        {exportAccess && <UsDocumentExports {...exportAccess} selector={{ kind: 'document', documentType: 'estimate', id: estimate.id }} revision={state.revision} />}
      </article>)}</div>}
    </section>
  </>;
}

/** Display eligibility only. Fresh server authority admits every financial write. */
export function canUseBrowserPurchasing(role: AccountRole, supportedSchemaVersion: 1 | 2): boolean {
  return supportedSchemaVersion === 2 && ['owner', 'admin', 'accountant'].includes(role);
}
export function UsPurchasingRecords({ state, language, exportAccess }: { state: ErpState; language: SiteLanguage; exportAccess?: Omit<Parameters<typeof UsDocumentExports>[0], 'selector' | 'revision'> }) {
  const p = browserPurchasingCopy[language], bills = state.vendorBills ?? [], payments = state.vendorPayments ?? [];
  return <>
    <section className="us-erp-section" aria-label={p.vendors}><h3>{p.vendors}</h3>{!(state.vendors ?? []).length ? <p className="us-erp-muted">{p.emptyVendors}</p> : <ul className="us-erp-records">{state.vendors?.map(vendor => <li key={vendor.id}><strong>{vendor.name}</strong><p>{vendor.billingAddress.line1}{vendor.billingAddress.line2 ? `, ${vendor.billingAddress.line2}` : ''}<br />{vendor.billingAddress.city}, {vendor.billingAddress.subdivision} {vendor.billingAddress.postalCode} · {vendor.billingAddress.country}</p></li>)}</ul>}</section>
    <section className="us-erp-section" aria-label={p.bills}><h3>{p.bills}</h3>{!bills.length ? <p className="us-erp-muted">{p.emptyBills}</p> : bills.map(bill => <article className="us-erp-estimate us-purchase-bill" key={bill.id}>
      <div className="us-erp-record-heading"><h4>{bill.reference}</h4><span>{p.approved}</span></div><p>{bill.vendorSnapshot.name}</p>
      <dl className="us-erp-facts"><div><dt>{p.date}</dt><dd><time dateTime={bill.date}>{formatDateOnly(bill.date, locales[language])}</time></dd></div><div><dt>{p.accountingDate}</dt><dd>{formatDateOnly(bill.accountingDate, locales[language])}</dd></div><div><dt>{p.dueDate}</dt><dd>{formatDateOnly(bill.dueDate, locales[language])}</dd></div><div><dt>{p.source}</dt><dd>{bill.sourceReference}</dd></div>
        <div><dt>{p.net}</dt><dd>{formatMoney(bill.net, locales[language])}</dd></div><div><dt>{p.tax}</dt><dd>{formatMoney(bill.tax, locales[language])}</dd></div><div><dt>{p.total}</dt><dd>{formatMoney(bill.total, locales[language])}</dd></div><div><dt>{p.balance}</dt><dd>{formatMoney(vendorBillBalance(bill, payments.filter(payment => payment.billId === bill.id)), locales[language])}</dd></div></dl>
      {exportAccess && <UsDocumentExports {...exportAccess} selector={{ kind: 'document', documentType: 'vendor_bill', id: bill.id }} revision={state.revision} />}
    </article>)}</section>
    <section className="us-erp-section" aria-label={p.payments}><h3>{p.payments}</h3>{!payments.length ? <p className="us-erp-muted">{p.emptyPayments}</p> : <ul className="us-erp-records">{payments.map(payment => <li key={payment.id}><div className="us-erp-record-heading"><strong>{payment.reference}</strong><span>{formatMoney(payment.amount, locales[language])}</span></div><p>{bills.find(bill => bill.id === payment.billId)?.reference}</p><dl className="us-erp-facts"><div><dt>{p.paymentDate}</dt><dd>{formatDateOnly(payment.paymentDate, locales[language])}</dd></div><div><dt>{p.accountingDate}</dt><dd>{formatDateOnly(payment.accountingDate, locales[language])}</dd></div></dl></li>)}</ul>}</section>
  </>;
}

export function UsSalesRecords({ state, language, exportAccess }: { state: ErpState; language: SiteLanguage; exportAccess?: Omit<Parameters<typeof UsDocumentExports>[0], 'selector' | 'revision'> }) {
  const s = browserSalesCopy[language], c = browserWorkbenchCopy[language];
  const invoices = state.invoices.slice().sort((a, b) => b.date.localeCompare(a.date) || b.issuedAt.localeCompare(a.issuedAt));
  return <section className="us-erp-section us-erp-sales" aria-label={s.invoices}><h2>{s.invoices}</h2>
    {!invoices.length ? <p className="us-erp-muted">{s.emptyInvoices}</p> : invoices.map(invoice => {
      const balance = invoiceBalance(invoice), status = balance.minorUnits === '0' ? 'paid' : balance.minorUnits === invoice.total.minorUnits ? 'outstanding' : 'partial';
      return <article key={invoice.id} className="us-erp-estimate us-sales-invoice"><div className="us-erp-record-heading"><h3>{invoice.number}</h3><span>{s[status]}</span></div><p>{invoice.customer.name}</p>
        <dl className="us-erp-facts"><div><dt>{s.invoiceDate}</dt><dd>{formatDateOnly(invoice.date, locales[language])}</dd></div><div><dt>{s.accountingDate}</dt><dd>{formatDateOnly(invoice.accountingDate, locales[language])}</dd></div><div><dt>{s.dueDate}</dt><dd>{formatDateOnly(invoice.dueDate, locales[language])}</dd></div><div><dt>{s.source}</dt><dd>{state.estimates.find(item => item.id === invoice.sourceEstimateId)?.number ?? invoice.sourceEstimateId}</dd></div><div><dt>{s.tax}</dt><dd>{formatMoney(invoice.tax, locales[language])}</dd></div><div><dt>{s.total}</dt><dd>{formatMoney(invoice.total, locales[language])}</dd></div></dl>
        <p className="us-erp-subtotal">{s.balance}<strong>{formatMoney(balance, locales[language])}</strong></p>
        {!!invoice.payments.length && <details className="us-sales-payment-history"><summary>{s.payments} ({invoice.payments.length})</summary><ul className="us-erp-records">{invoice.payments.slice().sort((a, b) => b.paymentDate.localeCompare(a.paymentDate)).map(payment => <li key={payment.id}><div className="us-erp-record-heading"><strong>{payment.reference}</strong><span>{formatMoney(payment.amount, locales[language])}</span></div><dl className="us-erp-facts"><div><dt>{s.paymentDate}</dt><dd>{formatDateOnly(payment.paymentDate, locales[language])}</dd></div><div><dt>{s.accountingDate}</dt><dd>{formatDateOnly(payment.accountingDate, locales[language])}</dd></div></dl></li>)}</ul></details>}
        {invoice.notes && <p className="us-erp-notes">{invoice.notes}</p>}
        {exportAccess && <UsDocumentExports {...exportAccess} selector={{ kind: 'document', documentType: 'invoice', id: invoice.id }} revision={state.revision} />}
        <p className="us-erp-muted">{c.revision} {state.revision} · USD</p>
      </article>;
    })}
  </section>;
}

function UsSalesPanel({ state, language, role, disabled, invoiceIssuanceAvailable, taxSettingsId, exportAccess, onWrite, onInvalid }: { state: ErpState; language: SiteLanguage; role: AccountRole; disabled: boolean; invoiceIssuanceAvailable: boolean; taxSettingsId: string; exportAccess: Omit<Parameters<typeof UsDocumentExports>[0], 'selector' | 'revision'>; onWrite: (command: ErpCommand) => void; onInvalid: () => void }) {
  const s = browserSalesCopy[language], c = browserWorkbenchCopy[language], prefix = useId(), financial = canUseBrowserSales(role);
  const [invoiceDraft, setInvoice] = useState(emptyBrowserInvoice), [paymentDraft, setPayment] = useState(emptyBrowserCustomerPayment);
  const [review, setReview] = useState<{ command: Extract<ErpCommand, { type: 'issue_invoice' | 'record_payment' }>; revision: number } | null>(null);
  const [submittedInvoiceId, setSubmittedInvoiceId] = useState<string | null>(null), [submittedPaymentId, setSubmittedPaymentId] = useState<string | null>(null);
  const invoiceCommitted = submittedInvoiceId !== null && state.invoices.some(item => item.id === submittedInvoiceId);
  const paymentCommitted = submittedPaymentId !== null && state.invoices.some(item => item.payments.some(entry => entry.id === submittedPaymentId));
  const invoice = invoiceCommitted ? emptyBrowserInvoice() : invoiceDraft, payment = paymentCommitted ? emptyBrowserCustomerPayment() : paymentDraft;
  const activeReview = review?.revision === state.revision ? review : null;
  const periods = state.ledger.periods.filter(period => period.status === 'open'), estimates = state.estimates.filter(estimate => estimate.status === 'accepted' && !state.invoices.some(item => item.sourceEstimateId === estimate.id));
  function updateInvoice(fields: Partial<BrowserInvoiceDraft>) { setReview(null); setInvoice(previous => ({ ...(invoiceCommitted ? emptyBrowserInvoice() : previous), ...fields })); if (invoiceCommitted) setSubmittedInvoiceId(null); }
  function updatePayment(fields: Partial<BrowserCustomerPaymentDraft>) { setReview(null); setPayment(previous => ({ ...(paymentCommitted ? emptyBrowserCustomerPayment() : previous), ...fields })); if (paymentCommitted) setSubmittedPaymentId(null); }
  function prepare(event: SubmitEvent<HTMLFormElement>, type: 'invoice' | 'payment') {
    event.preventDefault(); if (disabled || !financial) return;
    try { setReview({ command: type === 'invoice' ? buildBrowserInvoiceCommand(state.configuration.organizationId, state, invoice, crypto.randomUUID(), invoiceIssuanceAvailable) : buildBrowserCustomerPaymentCommand(state.configuration.organizationId, state, payment, crypto.randomUUID()), revision: state.revision }); }
    catch { setReview(null); onInvalid(); }
  }
  function confirm() {
    if (disabled || !financial || !activeReview) return;
    if (activeReview.command.type === 'issue_invoice' && !invoiceIssuanceAvailable) { setReview(null); onInvalid(); return; }
    if (activeReview.command.type === 'issue_invoice') setSubmittedInvoiceId(activeReview.command.id); else setSubmittedPaymentId(activeReview.command.id);
    onWrite(activeReview.command); setReview(null);
  }
  const field = (label: string, value: string, change: (value: string) => void, type = 'date', id?: string) => <label>{label}<input id={id} type={type} inputMode={type === 'text' ? 'decimal' : undefined} required maxLength={type === 'text' ? 39 : undefined} value={value} onChange={event => change(event.target.value)} /></label>;
  const period = (value: string, change: (value: string) => void, id: string) => <div className="us-erp-select-field"><label htmlFor={id}>{s.period}</label><select id={id} value={value} required onChange={event => change(event.target.value)}><option value="">{c.choose}</option>{periods.map(item => <option key={item.id} value={item.id}>{formatDateOnly(item.start, locales[language])} – {formatDateOnly(item.end, locales[language])}</option>)}</select></div>;
  const selectedInvoice = state.invoices.find(item => item.id === payment.invoiceId);
  const reviewCommand = activeReview?.command;
  return <>
    <UsSalesRecords state={state} language={language} exportAccess={exportAccess} />
    {financial && <div className="us-sales-editors">
      <details className="us-erp-editor"><summary>{s.newInvoice}</summary>{!invoiceIssuanceAvailable ? <div className="us-sales-unavailable"><p>{s.issuanceUnavailable}</p><a className="us-sales-setting-link" href={`#${taxSettingsId}`} onClick={() => document.getElementById(taxSettingsId)?.focus()}>{s.taxSettings}</a></div> : !estimates.length ? <p>{s.noEstimate}</p> : !periods.length ? <p>{s.noPeriod}</p> : <form onSubmit={event => prepare(event, 'invoice')}><fieldset disabled={disabled} className="us-erp-form"><div className="us-erp-select-field"><label htmlFor={`${prefix}-estimate`}>{s.chooseEstimate}</label><select id={`${prefix}-estimate`} required value={invoice.estimateId} onChange={event => updateInvoice({ estimateId: event.target.value })}><option value="">{c.choose}</option>{estimates.map(item => <option key={item.id} value={item.id}>{item.number} · {item.customer.name}</option>)}</select></div><div className="us-erp-grid">{field(s.invoiceDate, invoice.date, value => updateInvoice({ date: value }))}{field(s.accountingDate, invoice.accountingDate, value => updateInvoice({ accountingDate: value }))}{field(s.dueDate, invoice.dueDate, value => updateInvoice({ dueDate: value }))}{period(invoice.periodId, value => updateInvoice({ periodId: value }), `${prefix}-invoice-period`)}</div><button type="submit" className="account-button">{s.reviewInvoice}</button></fieldset></form>}</details>
      <details className="us-erp-editor"><summary>{s.newPayment}</summary>{!state.invoices.length ? <p>{s.noInvoice}</p> : !periods.length ? <p>{s.noPeriod}</p> : <form onSubmit={event => prepare(event, 'payment')}><fieldset disabled={disabled} className="us-erp-form"><p>{s.paymentHelp}</p><div className="us-erp-select-field"><label htmlFor={`${prefix}-invoice`}>{s.invoice}</label><select id={`${prefix}-invoice`} required value={payment.invoiceId} onChange={event => updatePayment({ invoiceId: event.target.value })}><option value="">{c.choose}</option>{state.invoices.map(item => <option key={item.id} value={item.id}>{item.number} · {item.customer.name}</option>)}</select></div>{selectedInvoice ? <p className="us-erp-subtotal">{s.balance}<strong>{formatMoney(invoiceBalance(selectedInvoice), locales[language])}</strong></p> : <p className="us-erp-muted">{s.chooseInvoice}</p>}{field(s.amount, payment.amount, value => updatePayment({ amount: value }), 'text')}<div className="us-erp-grid">{field(s.paymentDate, payment.paymentDate, value => updatePayment({ paymentDate: value }))}{field(s.accountingDate, payment.accountingDate, value => updatePayment({ accountingDate: value }))}{period(payment.periodId, value => updatePayment({ periodId: value }), `${prefix}-receipt-period`)}</div><label>{s.reference}<input required maxLength={500} value={payment.reference} onChange={event => updatePayment({ reference: event.target.value })} /></label><button type="submit" className="account-button">{s.recordPayment}</button></fieldset></form>}</details>
      {reviewCommand && <section className="us-erp-confirm us-sales-confirm" aria-label={reviewCommand.type === 'issue_invoice' ? s.invoiceReview : s.paymentReview}><h3>{reviewCommand.type === 'issue_invoice' ? s.invoiceReview : s.paymentReview}</h3><p>{reviewCommand.type === 'issue_invoice' ? s.invoiceReviewHelp : s.paymentReviewHelp}</p><dl className="us-erp-facts"><div><dt>{reviewCommand.type === 'issue_invoice' ? s.chooseEstimate : s.invoice}</dt><dd>{reviewCommand.type === 'issue_invoice' ? state.estimates.find(item => item.id === reviewCommand.estimateId)?.number : state.invoices.find(item => item.id === reviewCommand.invoiceId)?.number}</dd></div><div><dt>{s.accountingDate}</dt><dd>{formatDateOnly(reviewCommand.accountingDate, locales[language])}</dd></div>{reviewCommand.type === 'issue_invoice' ? <><div><dt>{s.invoiceDate}</dt><dd>{formatDateOnly(reviewCommand.date, locales[language])}</dd></div><div><dt>{s.dueDate}</dt><dd>{formatDateOnly(reviewCommand.dueDate, locales[language])}</dd></div></> : <><div><dt>{s.paymentDate}</dt><dd>{formatDateOnly(reviewCommand.paymentDate, locales[language])}</dd></div><div><dt>{s.amount}</dt><dd>{formatMoney(money('USD', reviewCommand.amountMinor), locales[language])}</dd></div><div><dt>{s.reference}</dt><dd>{reviewCommand.reference}</dd></div></>}</dl><div className="us-erp-actions"><button type="button" className="account-button" disabled={disabled} onClick={confirm}>{reviewCommand.type === 'issue_invoice' ? s.confirmInvoice : s.confirmPayment}</button><button type="button" className="account-button secondary" disabled={disabled} onClick={() => setReview(null)}>{s.cancel}</button></div></section>}
    </div>}
  </>;
}

export interface UsErpWorkbenchProps { organizationId: string; expectedUserId: string; role: AccountRole; language: SiteLanguage; supportedSchemaVersion?: 1 | 2; salesEnabled?: boolean; invoiceIssuanceAvailable?: boolean }
export function UsErpWorkbench(props: UsErpWorkbenchProps) {
  return <UsErpWorkbenchPanel key={`${props.organizationId}:${props.expectedUserId}:${props.role}:${props.supportedSchemaVersion ?? 1}:${props.salesEnabled === true}:${props.invoiceIssuanceAvailable === true}`} {...props} />;
}
function UsErpWorkbenchPanel({ organizationId, expectedUserId, role, language, supportedSchemaVersion = 1, salesEnabled = false, invoiceIssuanceAvailable = false }: UsErpWorkbenchProps) {
  const c = browserWorkbenchCopy[language], p = browserPurchasingCopy[language], prefix = useId(), purchasingEnabled = supportedSchemaVersion === 2;
  const session = useRef<BrowserErpSession | null>(null), generation = useRef(0), privacyEpoch = useRef(0), busyRef = useRef(true), pendingType = useRef<ErpCommand['type'] | null>(null), noticeRef = useRef<HTMLDivElement>(null), nextLine = useRef(2);
  const sellerBusyRef = useRef(true), sellerPendingRef = useRef(false);
  const taxBusyRef = useRef(false), taxPendingRef = useRef(false), taxInvalidation = useRef<(() => void) | null>(null), erpAdmittedRef = useRef(false);
  const [read, setRead] = useState<BrowserErpRead | null>(null), [busy, setBusy] = useState(true), [fresh, setFresh] = useState(false), [pending, setPending] = useState(false);
  const [readEpoch, setReadEpoch] = useState(0);
  const [sellerBusy, setSellerBusy] = useState(true), [sellerPending, setSellerPending] = useState(false), [accessEpoch, setAccessEpoch] = useState(0), [writeLocked, setWriteLocked] = useState(false);
  const [taxBusy, setTaxBusy] = useState(false), [taxPending, setTaxPending] = useState(false), [taxAdmitted, setTaxAdmitted] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; key: 'invalid' | 'unavailable' | 'denied' | 'conflict' | 'uncertain' | 'saved' | 'savedReload' | 'purchasingUnavailable' | 'salesInvalid' | 'taxRequired' | 'salesRateLimited' } | null>(null);
  const [salesResetEpoch, setSalesResetEpoch] = useState(0);
  const [customer, setCustomer] = useState(emptyCustomer), [estimate, setEstimate] = useState(emptyEstimate), [start, setStart] = useState(''), [end, setEnd] = useState(''), [acceptId, setAcceptId] = useState<string | null>(null);
  const [vendor, setVendor] = useState(emptyBrowserVendor), [bill, setBill] = useState(emptyBrowserVendorBill), [payment, setPayment] = useState(emptyBrowserVendorPayment);
  const [billConfirmation, setBillConfirmation] = useState<{ command: Extract<ErpCommand, { type: 'record_vendor_bill' }>; revision: number } | null>(null);
  const canWrite = role !== 'read_only', canPurchase = canUseBrowserPurchasing(role, supportedSchemaVersion), blocked = busy || pending || sellerBusy || sellerPending || taxBusy || taxPending || !fresh || writeLocked;
  const invalidateAccess = useCallback(() => {
    const epoch = ++privacyEpoch.current; setAccessEpoch(epoch); setWriteLocked(true);
    taxInvalidation.current?.();
    erpAdmittedRef.current = false;
    setTaxAdmitted(false);
    setRead(null); setFresh(false); setAcceptId(null); setCustomer(emptyCustomer()); setEstimate(emptyEstimate()); setStart(''); setEnd(''); setNotice({ kind: 'error', key: 'denied' });
    setVendor(emptyBrowserVendor()); setBill(emptyBrowserVendorBill()); setPayment(emptyBrowserVendorPayment()); setBillConfirmation(null);
    setSalesResetEpoch(value => value + 1);
  }, []);
  const currentAccessEpoch = useCallback(() => privacyEpoch.current, []), otherBusy = useCallback(() => busyRef.current || taxBusyRef.current, []), otherPending = useCallback(() => (session.current?.hasPending() ?? false) || taxPendingRef.current, []);
  const taxOtherBusy = useCallback(() => busyRef.current || sellerBusyRef.current, []), taxOtherPending = useCallback(() => (session.current?.hasPending() ?? false) || sellerPendingRef.current, []);
  const onTaxBusy = useCallback((value: boolean) => { taxBusyRef.current = value; setTaxBusy(value); }, []), onTaxPending = useCallback((value: boolean) => { taxPendingRef.current = value; setTaxPending(value); }, []);
  const registerTaxInvalidation = useCallback((invalidate: (() => void) | null) => { taxInvalidation.current = invalidate; }, []);
  const onSellerBusy = useCallback((value: boolean) => { sellerBusyRef.current = value; setSellerBusy(value); if (!value && erpAdmittedRef.current && privacyEpoch.current === 0) setTaxAdmitted(true); }, []), onSellerPending = useCallback((value: boolean) => { sellerPendingRef.current = value; setSellerPending(value); }, []);
  const admitPrivate = useCallback(() => { erpAdmittedRef.current = true; if (!sellerBusyRef.current && privacyEpoch.current === 0) setTaxAdmitted(true); }, []);
  const errorNotice = useCallback((error: unknown) => {
    if (error instanceof BrowserErpError && error.code === 'rate_limited') return 'salesRateLimited' as const;
    if (error instanceof BrowserErpError && (error.outcome === 'unauthorized' || [401, 402, 403].includes(error.status))) {
      invalidateAccess();
      return 'denied' as const;
    }
    if (error instanceof BrowserErpError && ['feature_unavailable', 'edition_unavailable', 'configuration_changed', 'country_configuration_required'].includes(error.code)) setRead(null);
    if (error instanceof BrowserErpError && ['revision_conflict', 'estimate_revision_conflict', 'idempotency_conflict', 'read_required'].includes(error.code)) { setAcceptId(null); setBillConfirmation(null); setSalesResetEpoch(value => value + 1); return 'conflict' as const; }
    if (error instanceof BrowserErpError && ['tax_configuration_required', 'tax_assessment_expired', 'stale_tax_assessment'].includes(error.code)) return 'taxRequired' as const;
    if (error instanceof BrowserErpError && ['payment_exceeds_balance', 'invoice_not_found', 'invoice_already_issued'].includes(error.code)) return 'salesInvalid' as const;
    if (error instanceof BrowserErpError && ['client_upgrade_required', 'purchasing_unavailable'].includes(error.code)) return 'purchasingUnavailable' as const;
    return error instanceof BrowserErpError && error.outcome === 'uncertain' ? 'uncertain' as const : 'unavailable' as const;
  }, [invalidateAccess]);
  useEffect(() => {
    const current = ++generation.current, privacy = privacyEpoch.current;
    const instance = createBrowserErpSession({ organizationId, expectedUserId, supportedSchemaVersion }); session.current = instance;
    void instance.load().then(value => { if (generation.current === current && privacyEpoch.current === privacy) { setRead(value); setReadEpoch(privacy); setFresh(true); admitPrivate(); } }).catch(error => {
      if (generation.current === current && privacyEpoch.current === privacy) setNotice({ kind: 'error', key: errorNotice(error) });
    }).finally(() => { if (generation.current === current) { busyRef.current = false; setBusy(false); } });
    return () => { generation.current = current + 1; instance.dispose(); session.current = null; };
  }, [organizationId, expectedUserId, supportedSchemaVersion, errorNotice, admitPrivate]);
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
    busyRef.current = true; setBusy(true); setFresh(false); setAcceptId(null); setBillConfirmation(null); setNotice(null);
    try { const value = await instance.load(); if (generation.current === current && privacyEpoch.current === privacy) { setRead(value); setReadEpoch(privacy); setFresh(true); admitPrivate(); } }
    catch (error) { if (generation.current === current && privacyEpoch.current === privacy) setNotice({ kind: 'error', key: errorNotice(error) }); }
    finally { if (generation.current === current) { setPending(instance.hasPending()); busyRef.current = false; setBusy(false); } }
  }
  async function write(command?: ErpCommand) {
    const instance = session.current, current = generation.current, privacy = privacyEpoch.current;
    if (!instance || busyRef.current || sellerBusyRef.current || taxBusyRef.current || command && (blocked || !canWrite || !read || privacy !== readEpoch || sellerPendingRef.current || taxPendingRef.current)) return;
    if (command && ['save_vendor', 'record_vendor_bill', 'record_vendor_payment'].includes(command.type) && !canPurchase) return;
    busyRef.current = true; setBusy(true); setFresh(false); setNotice(null); setAcceptId(null); setBillConfirmation(null);
    let confirmed = false;
    if (command) pendingType.current = command.type;
    try {
      if (command) await instance.submit(command, read?.status === 'ready' ? read.state.revision : 0); else await instance.retry();
      confirmed = true;
      if (generation.current !== current || privacyEpoch.current !== privacy) return;
      // A confirmed creation clears its form, while manual reloads and rejected/uncertain writes preserve drafts.
      if (pendingType.current === 'save_customer') setCustomer(emptyCustomer());
      if (pendingType.current === 'save_estimate') { setEstimate(emptyEstimate()); nextLine.current = 2; }
      if (pendingType.current === 'save_vendor') setVendor(emptyBrowserVendor());
      if (pendingType.current === 'record_vendor_bill') setBill(emptyBrowserVendorBill());
      if (pendingType.current === 'record_vendor_payment') setPayment(emptyBrowserVendorPayment());
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
  function submitPurchase(event: SubmitEvent<HTMLFormElement>, build: () => ErpCommand, review = false) {
    event.preventDefault(); if (blocked || !canPurchase || read?.status !== 'ready') return;
    try {
      const command = build();
      if (review && command.type === 'record_vendor_bill') { setBillConfirmation({ command, revision: read.state.revision }); setNotice(null); }
      else void write(command);
    } catch { setBillConfirmation(null); setNotice({ kind: 'error', key: 'invalid' }); }
  }
  function confirmBill() {
    if (blocked || !canPurchase || !billConfirmation || read?.status !== 'ready') return;
    if (billConfirmation.revision !== read.state.revision) { setBillConfirmation(null); setNotice({ kind: 'error', key: 'conflict' }); return; }
    void write(billConfirmation.command);
  }
  function field(label: string, value: string, onChange: (value: string) => void, options: { type?: string; required?: boolean; maxLength?: number; inputMode?: 'decimal' | 'numeric'; autoComplete?: string; id?: string } = {}) {
    return <label>{label}<input {...options} value={value} onChange={event => onChange(event.target.value)} /></label>;
  }
  const customerField = (key: Exclude<keyof BrowserCustomerDraft, 'kind'>, label: string, required = true, options: Parameters<typeof field>[3] = {}) => field(label, customer[key], value => setCustomer(previous => ({ ...previous, [key]: value })), { required, maxLength: 160, ...options });
  const vendorField = (key: Exclude<keyof BrowserVendorDraft, 'kind' | 'country'>, label: string, required = true, options: Parameters<typeof field>[3] = {}) => field(label, vendor[key], value => setVendor(previous => ({ ...previous, [key]: value })), { required, maxLength: 160, ...options });
  const updateBill = (fields: Partial<BrowserVendorBillDraft>) => { setBillConfirmation(null); setBill(previous => ({ ...previous, ...fields })); };
  const billField = (key: keyof BrowserVendorBillDraft, label: string, options: Parameters<typeof field>[3] = {}) => field(label, bill[key], value => updateBill({ [key]: value }), { required: true, maxLength: 500, ...options });
  const paymentField = (key: keyof BrowserVendorPaymentDraft, label: string, options: Parameters<typeof field>[3] = {}) => field(label, payment[key], value => setPayment(previous => ({ ...previous, [key]: value })), { required: true, maxLength: 500, ...options });
  const openPeriods = read?.status === 'ready' ? read.state.ledger.periods.filter(item => item.status === 'open') : [];
  const periodField = (value: string, onChange: (value: string) => void, id: string) => <div className="us-erp-select-field"><label htmlFor={id}>{p.period}</label><select id={id} required value={value} onChange={event => onChange(event.target.value)}><option value="">{c.choose}</option>{openPeriods.map(item => <option key={item.id} value={item.id}>{formatDateOnly(item.start, locales[language])} – {formatDateOnly(item.end, locales[language])}</option>)}</select></div>;
  const selectedBill = read?.status === 'ready' ? read.state.vendorBills?.find(item => item.id === payment.billId) : undefined;
  let purchasePreview: string | null = null;
  try { purchasePreview = formatMoney(browserPurchaseTotal(bill), locales[language]); } catch { /* A partial draft has no recorded total. */ }
  let preview: string | null = null;
  try { preview = formatMoney(estimate.lines.reduce((total, line) => addMoney(total, lineTotals(browserSalesLine(line), 'USD').net), money('USD', '0')), locales[language]); } catch { /* Partial drafts have no authoritative or invented amount. */ }
  const acceptedEstimate = read?.status === 'ready' ? read.state.estimates.find(item => item.id === acceptId && item.status === 'draft') : undefined;
  const exportAccess = { organizationId, expectedUserId, supportedSchemaVersion, language, accessEpoch, currentAccessEpoch, disabled: blocked, onAccessDenied: invalidateAccess, sellerSettingsId: `${prefix}-seller-settings` };
  const s = browserSalesCopy[language];
  return <div className="us-erp-workbench" lang={language}>
    <header className="us-erp-heading"><h1>{c.title}</h1><p>{salesEnabled ? s.introduction : purchasingEnabled ? p.introduction : c.introduction}</p><p className="us-erp-limitation">{salesEnabled ? s.limitation : purchasingEnabled ? p.limitation : c.limitation}</p></header>
    <div className="us-erp-toolbar"><button type="button" className="account-button secondary" disabled={busy || sellerBusy || taxBusy} onClick={() => void reload()}>{busy ? c.reloading : c.reload}</button>{read?.status === 'ready' && <span>{c.revision} {read.state.revision}</span>}</div>
    <p className="us-erp-muted">{c.draftKept}</p>
    {notice && <div className={`us-erp-notice ${notice.kind}`} ref={noticeRef} tabIndex={-1} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.key === 'purchasingUnavailable' ? p.unavailable : notice.key === 'salesInvalid' ? s.invalid : notice.key === 'taxRequired' ? s.taxRequired : notice.key === 'salesRateLimited' ? browserExportErrorCopy[language].rateLimited : c[notice.key]}</div>}
    {pending && <aside className="us-erp-pending" aria-live="polite"><p>{c.pending}</p><p>{c.pendingMemory}</p><button type="button" className="account-button" disabled={busy || sellerBusy || taxBusy} onClick={() => void write()}>{busy ? c.busy : c.retry}</button></aside>}
    {!read && !notice && <output>{c.loading}</output>}
    {writeLocked && <p className="us-erp-muted">{browserSellerCopy[language].writeLocked}</p>}
    <div id={`${prefix}-seller-settings`} tabIndex={-1}><UsSellerProfilePanel organizationId={organizationId} expectedUserId={expectedUserId} role={role} language={language} blocked={busy || pending || taxBusy || taxPending} writeLocked={writeLocked} accessEpoch={accessEpoch}
      currentAccessEpoch={currentAccessEpoch} otherBusy={otherBusy} otherPending={otherPending}
      onBusyChange={onSellerBusy} onPendingChange={onSellerPending} onAccessDenied={invalidateAccess} /></div>
    <div id={`${prefix}-tax-settings`} tabIndex={-1}><UsTaxProfilePanel organizationId={organizationId} expectedUserId={expectedUserId} role={role} language={language} admitted={taxAdmitted} blocked={busy || pending || sellerBusy || sellerPending} writeLocked={writeLocked} accessEpoch={accessEpoch}
      currentAccessEpoch={currentAccessEpoch} otherBusy={taxOtherBusy} otherPending={taxOtherPending}
      onBusyChange={onTaxBusy} onPendingChange={onTaxPending} onAccessDenied={invalidateAccess} registerInvalidation={registerTaxInvalidation} /></div>
    {!canWrite && <p className="us-erp-muted">{c.readOnly}</p>}
    {read?.status === 'uninitialized' && <section className="us-erp-section"><h2>{c.initializeTitle}</h2><p>{c.initializeHelp}</p>{role === 'owner' ? <form onSubmit={event => submit(event, () => buildBrowserInitializeCommand(organizationId, start, end, crypto.randomUUID()))}>
      <fieldset disabled={blocked} className="us-erp-form"><div className="us-erp-grid">{field(c.periodStart, start, setStart, { type: 'date', required: true })}{field(c.periodEnd, end, setEnd, { type: 'date', required: true })}</div><button type="submit" className="account-button">{c.initialize}</button></fieldset>
    </form> : <p>{c.ownerRequired}</p>}</section>}
    {read?.status === 'ready' && <>
      <UsErpRecords state={read.state} language={language} canWrite={canWrite} disabled={blocked} onAccept={setAcceptId} {...(salesEnabled ? { exportAccess } : {})} />
      {salesEnabled && <UsSalesPanel key={`${accessEpoch}:${salesResetEpoch}`} state={read.state} language={language} role={role} disabled={blocked} invoiceIssuanceAvailable={invoiceIssuanceAvailable} taxSettingsId={`${prefix}-tax-settings`} exportAccess={exportAccess} onWrite={command => void write(command)} onInvalid={() => setNotice({ kind: 'error', key: 'salesInvalid' })} />}
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
      {purchasingEnabled && <section className="us-erp-section us-erp-purchasing" aria-label={p.title}><h2>{p.title}</h2><p className="us-erp-muted">{p.help}</p>
        <UsPurchasingRecords state={read.state} language={language} {...(salesEnabled ? { exportAccess } : {})} />
        {!canPurchase ? <p className="us-erp-muted">{p.readOnly}</p> : <>
          <details className="us-erp-editor"><summary>{p.newVendor}</summary><form onSubmit={event => submitPurchase(event, () => buildBrowserVendorCommand(organizationId, vendor, crypto.randomUUID()))}><fieldset disabled={blocked} className="us-erp-form">
            <div className="us-erp-select-field"><label htmlFor={`${prefix}-vendor-kind`}>{p.vendorKind}</label><select id={`${prefix}-vendor-kind`} value={vendor.kind} onChange={event => setVendor(previous => ({ ...previous, kind: event.target.value as BrowserVendorDraft['kind'] }))}><option value="business">{c.business}</option><option value="individual">{c.individual}</option></select></div>
            {vendorField('name', p.vendorName)}<div className="us-erp-select-field"><label htmlFor={`${prefix}-vendor-country`}>{p.country}</label><select id={`${prefix}-vendor-country`} value={vendor.country} onChange={event => setVendor(previous => ({ ...previous, country: event.target.value as BrowserVendorDraft['country'], subdivision: '', postalCode: '' }))}><option value="US">{p.us}</option><option value="CH">{p.ch}</option></select></div>
            {vendorField('line1', p.address, true, { maxLength: 200 })}{vendorField('line2', p.address2, false, { maxLength: 200 })}<div className="us-erp-grid">{vendorField('city', p.city, true, { maxLength: 120 })}<div className="us-erp-select-field"><label htmlFor={`${prefix}-vendor-subdivision`}>{p.subdivision}</label><select id={`${prefix}-vendor-subdivision`} required value={vendor.subdivision} onChange={event => setVendor(previous => ({ ...previous, subdivision: event.target.value }))}><option value="">{c.choose}</option>{countrySubdivisions[vendor.country].map(item => <option key={item} value={item}>{item}</option>)}</select></div>{vendorField('postalCode', p.postalCode, true, { maxLength: 10 })}</div>
            <div className="us-erp-grid">{vendorField('email', p.email, false, { type: 'email', maxLength: 254 })}{vendorField('phone', p.phone, false, { type: 'tel', maxLength: 80 })}</div>{vendorField('contactName', p.contactName, false)}{vendorField('paymentTermsDays', p.terms, true, { inputMode: 'numeric', maxLength: 3 })}<button type="submit" className="account-button">{p.saveVendor}</button>
          </fieldset></form></details>
          <details className="us-erp-editor"><summary>{p.newBill}</summary>{!(read.state.vendors ?? []).length ? <p>{p.noVendor}</p> : !openPeriods.length ? <p>{p.noPeriod}</p> : <form onSubmit={event => submitPurchase(event, () => buildBrowserVendorBillCommand(organizationId, read.state, bill, crypto.randomUUID()), true)}><fieldset disabled={blocked} className="us-erp-form">
            <div className="us-erp-select-field"><label htmlFor={`${prefix}-bill-vendor`}>{p.vendor}</label><select id={`${prefix}-bill-vendor`} required value={bill.vendorId} onChange={event => updateBill({ vendorId: event.target.value })}><option value="">{c.choose}</option>{read.state.vendors?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
            {billField('reference', p.reference)}{billField('sourceReference', p.sourceReference)}<div className="us-erp-grid">{billField('date', p.date, { type: 'date' })}{billField('dueDate', p.dueDate, { type: 'date' })}{billField('accountingDate', p.accountingDate, { type: 'date' })}{periodField(bill.periodId, value => updateBill({ periodId: value }), `${prefix}-bill-period`)}</div>
            <p id={`${prefix}-purchase-decimals`} className="us-erp-muted">{p.decimalHelp}</p><div className="us-erp-grid" aria-describedby={`${prefix}-purchase-decimals`}>{billField('net', p.net, { inputMode: 'decimal', maxLength: 39 })}{billField('purchaseTax', p.tax, { inputMode: 'decimal', maxLength: 39 })}</div>{purchasePreview && <p className="us-erp-subtotal">{p.total}<strong>{purchasePreview}</strong></p>}<button type="submit" className="account-button">{p.reviewBill}</button>
          </fieldset></form>}</details>
          {billConfirmation && <section className="us-erp-confirm us-purchase-confirm" aria-label={p.approvalTitle}><h3>{p.approvalTitle}</h3><p>{p.approvalHelp}</p><p><strong>{read.state.vendors?.find(item => item.id === billConfirmation.command.vendorId)?.name}</strong> · {billConfirmation.command.reference}</p><dl className="us-erp-facts"><div><dt>{p.source}</dt><dd>{billConfirmation.command.sourceReference}</dd></div><div><dt>{p.date}</dt><dd>{formatDateOnly(billConfirmation.command.date, locales[language])}</dd></div><div><dt>{p.accountingDate}</dt><dd>{formatDateOnly(billConfirmation.command.accountingDate, locales[language])}</dd></div><div><dt>{p.dueDate}</dt><dd>{formatDateOnly(billConfirmation.command.dueDate, locales[language])}</dd></div><div><dt>{p.net}</dt><dd>{formatMoney(money('USD', billConfirmation.command.netMinor), locales[language])}</dd></div><div><dt>{p.tax}</dt><dd>{formatMoney(money('USD', billConfirmation.command.purchaseTaxMinor), locales[language])}</dd></div><div><dt>{p.total}</dt><dd>{formatMoney(addMoney(money('USD', billConfirmation.command.netMinor), money('USD', billConfirmation.command.purchaseTaxMinor)), locales[language])}</dd></div></dl><div className="us-erp-actions"><button type="button" className="account-button" disabled={blocked} onClick={confirmBill}>{p.approveBill}</button><button type="button" className="account-button secondary" disabled={busy} onClick={() => setBillConfirmation(null)}>{c.cancel}</button></div></section>}
          <details className="us-erp-editor"><summary>{p.newPayment}</summary>{!(read.state.vendorBills ?? []).length ? <p>{p.noBill}</p> : !openPeriods.length ? <p>{p.noPeriod}</p> : <form onSubmit={event => submitPurchase(event, () => buildBrowserVendorPaymentCommand(organizationId, read.state, payment, crypto.randomUUID()))}><fieldset disabled={blocked} className="us-erp-form">
            <p>{p.paymentHelp}</p><div className="us-erp-select-field"><label htmlFor={`${prefix}-payment-bill`}>{p.bill}</label><select id={`${prefix}-payment-bill`} required value={payment.billId} onChange={event => setPayment(previous => ({ ...previous, billId: event.target.value }))}><option value="">{c.choose}</option>{read.state.vendorBills?.map(item => <option key={item.id} value={item.id}>{item.vendorSnapshot.name} · {item.reference}</option>)}</select></div>
            {selectedBill ? <p className="us-erp-subtotal">{p.balance}<strong>{formatMoney(vendorBillBalance(selectedBill, (read.state.vendorPayments ?? []).filter(item => item.billId === selectedBill.id)), locales[language])}</strong></p> : <p className="us-erp-muted">{p.chooseBill}</p>}
            {paymentField('amount', p.amount, { inputMode: 'decimal', maxLength: 39 })}<div className="us-erp-grid">{paymentField('paymentDate', p.paymentDate, { type: 'date' })}{paymentField('accountingDate', p.accountingDate, { type: 'date' })}{periodField(payment.periodId, value => setPayment(previous => ({ ...previous, periodId: value })), `${prefix}-payment-period`)}</div>{paymentField('reference', p.paymentReference)}<button type="submit" className="account-button">{p.recordPayment}</button>
          </fieldset></form>}</details>
        </>}
      </section>}
      {salesEnabled && <UsErpReports {...exportAccess} state={read.state} />}
    </>}
  </div>;
}
