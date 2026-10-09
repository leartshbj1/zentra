'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type SubmitEvent } from 'react';
import type { AccountRole } from '@/lib/account-security';
import type { SiteLanguage } from '@/lib/site-language';
import { validateAddress } from '@/lib/international/addresses';
import { BrowserErpError } from '@/lib/international/browser-erp-session';
import { buildBrowserInvoiceCommand, emptyBrowserInvoice, type BrowserInvoiceDraft } from '@/lib/international/browser-sales';
import { browserUsTaxInvoiceCopy, browserUsTaxInvoicePendingConflict } from '@/lib/international/browser-us-tax-invoice-copy';
import { browserUsTaxEstimateSupported, buildBrowserUsTaxInvoiceChoices, type BrowserUsTaxLineChoice } from '@/lib/international/browser-us-tax-invoice';
import { createBrowserUsTaxInvoiceSession, type BrowserUsTaxCode, type BrowserUsTaxInvoiceChoices, type BrowserUsTaxInvoiceSession } from '@/lib/international/browser-us-tax-invoice-session';
import type { ErpSchemaVersion } from '@/lib/international/erp-schema-capability';
import { estimateTotals } from '@/lib/international/invoicing';
import { formatDateOnly } from '@/lib/international/localization';
import { formatMoney } from '@/lib/international/money';
import type { ErpCommand, ErpState } from '@/lib/international/runtime-types';
import { usTaxInvoiceLocalCandidates } from '@/lib/international/us-tax-invoice-time';
import type { UsTaxReadiness } from '@/lib/international/us-tax-readiness';
import './us-tax-invoice-panel.css';

export interface UsTaxInvoicePanelProps {
  organizationId: string; expectedUserId: string; role: AccountRole; language: SiteLanguage; supportedSchemaVersion: ErpSchemaVersion;
  state: ErpState; blocked: boolean; writeLocked: boolean; accessEpoch: number;
  currentAccessEpoch(this: void): number;
  /** Wait for a quiet ERP read, then synchronously claim the workbench write slot. */
  acquire(this: void, retry: boolean): Promise<ErpState | null>;
  onBusyChange(this: void, value: boolean): void; onPendingChange(this: void, value: boolean): void;
  onAccessDenied(this: void, status: number): void; onCommitted(this: void): void;
  registerInvalidation(this: void, invalidate: (() => void) | null): void;
}
type Notice = 'invalid' | 'stale' | 'pendingBlocked' | 'unavailable' | 'denied' | 'saved' | 'savedReload';
type Review = Readonly<{ command: Extract<ErpCommand, { type: 'issue_invoice' }>; revision: number; choices: BrowserUsTaxInvoiceChoices; localTime: string; zone: string; codes: readonly BrowserUsTaxCode[] }>;
const blankLine = (): BrowserUsTaxLineChoice => ({ code: '', checked: null, confirmed: false });

export function UsTaxInvoicePanel(props: UsTaxInvoicePanelProps) {
  const { organizationId, expectedUserId, role, language, supportedSchemaVersion, state, writeLocked, accessEpoch, currentAccessEpoch, onBusyChange, onPendingChange, onAccessDenied, registerInvalidation } = props;
  const c = browserUsTaxInvoiceCopy[language], prefix = useId(), locale = { en: 'en-US', fr: 'fr-US', de: 'de-US', it: 'it-US' }[language];
  const session = useRef<BrowserUsTaxInvoiceSession | null>(null), generation = useRef(0), busyRef = useRef(false), noticeRef = useRef<HTMLDivElement>(null), reviewRef = useRef<HTMLElement>(null), estimateRef = useRef<HTMLSelectElement>(null);
  const [draft, setDraft] = useState(emptyBrowserInvoice), [time, setTime] = useState(''), [zoneConfirmed, setZoneConfirmed] = useState(false), [selectedInstant, setInstant] = useState(''), [source, setSource] = useState('');
  const [lines, setLines] = useState<Record<string, BrowserUsTaxLineChoice>>({}), [review, setReview] = useState<Review | null>(null), [notice, setNotice] = useState<Notice | null>(null), [editorOpen, setEditorOpen] = useState(true);
  const [busy, setBusy] = useState(false), [pending, setPending] = useState(false), [codes, setCodes] = useState<readonly BrowserUsTaxCode[]>([]), [cursor, setCursor] = useState<string | null>(null), [pages, setPages] = useState(0);
  const [readiness, setReadiness] = useState<UsTaxReadiness | null>(null), [expired, setExpired] = useState(false);
  const permitted = ['owner', 'admin', 'accountant'].includes(role) && !writeLocked && accessEpoch === 0;
  const occupy = useCallback((value: boolean) => { busyRef.current = value; setBusy(value); onBusyChange(value); }, [onBusyChange]);
  const purge = useCallback(() => { generation.current++; session.current?.dispose(); session.current = null; setDraft(emptyBrowserInvoice()); setTime(''); setZoneConfirmed(false); setInstant(''); setSource(''); setLines({}); setReview(null); setCodes([]); setCursor(null); setPages(0); setReadiness(null); setPending(false); onPendingChange(false); occupy(false); setNotice('denied'); }, [occupy, onPendingChange]);
  useEffect(() => { registerInvalidation(purge); return () => registerInvalidation(null); }, [registerInvalidation, purge]);
  useEffect(() => {
    if (!permitted) return;
    const owned = session, instance = createBrowserUsTaxInvoiceSession({ organizationId, expectedUserId, role, supportedSchemaVersion }), current = ++generation.current; owned.current = instance;
    return () => { generation.current = current + 1; instance.dispose(); if (owned.current === instance) owned.current = null; onBusyChange(false); onPendingChange(false); };
  }, [organizationId, expectedUserId, role, supportedSchemaVersion, permitted, onBusyChange, onPendingChange]);
  useEffect(() => { if (notice) noticeRef.current?.focus(); }, [notice]);
  useEffect(() => { if (!readiness) return; const timer = setTimeout(() => setExpired(true), Math.max(0, readiness.expiresAt * 1000 - Date.now())); return () => clearTimeout(timer); }, [readiness]);
  const estimate = state.estimates.find(item => item.id === draft.estimateId), eligible = state.estimates.filter(item => item.status === 'accepted' && !state.invoices.some(invoice => invoice.sourceEstimateId === item.id)), periods = state.ledger.periods.filter(item => item.status === 'open');
  const wallTime = draft.date && time ? `${draft.date}T${time.length === 5 ? `${time}:00` : time}` : '';
  const candidates = useMemo(() => { if (!wallTime) return []; try { return usTaxInvoiceLocalCandidates(wallTime, state.configuration.timeZone); } catch { return []; } }, [wallTime, state.configuration.timeZone]);
  const instant = candidates.length === 1 ? candidates[0].instant : candidates.find(item => item.instant === selectedInstant)?.instant ?? '';
  const activeReview = review?.revision === state.revision ? review : null, staleReview = review !== null && activeReview === null;
  useEffect(() => { if (activeReview) reviewRef.current?.focus(); }, [activeReview]);
  const disabled = props.blocked || busy || pending || !permitted;
  function change(fields: Partial<BrowserInvoiceDraft>) { setReview(null); setDraft(previous => ({ ...previous, ...fields })); if (fields.estimateId !== undefined) { setLines({}); setSource(''); } if (fields.date !== undefined) { setInstant(''); setZoneConfirmed(false); } }
  function changeLine(id: string, fields: Partial<BrowserUsTaxLineChoice>) { setReview(null); setLines(previous => ({ ...previous, [id]: { ...(previous[id] ?? blankLine()), ...fields } })); }
  async function run(work: (instance: BrowserUsTaxInvoiceSession, latest: ErpState) => Promise<void>, retry = false) {
    const instance = session.current, current = generation.current, privacy = currentAccessEpoch();
    if (!instance || !permitted || busyRef.current || !retry && pending) return;
    const latest = await props.acquire(retry);
    if (!latest) return;
    if (generation.current !== current || currentAccessEpoch() !== privacy) { onBusyChange(false); return; }
    occupy(true); setNotice(null);
    try { await work(instance, latest); }
    catch (error) {
      if (generation.current !== current || currentAccessEpoch() !== privacy) return;
      if (error instanceof BrowserErpError && error.outcome === 'unauthorized') { onAccessDenied(error.status); return; }
      setNotice(error instanceof BrowserErpError && error.status === 409 ? instance.hasPending() ? 'pendingBlocked' : 'stale' : error instanceof BrowserErpError && error.outcome === 'rejected' && error.status === 422 ? 'invalid' : 'unavailable');
    } finally { if (generation.current === current && currentAccessEpoch() === privacy) { const value = instance.hasPending(); setPending(value); onPendingChange(value); occupy(false); } }
  }
  function prepare(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled || !estimate) return;
    try {
      if (!zoneConfirmed || !instant) throw new TypeError('Choose invoice time');
      const command = buildBrowserInvoiceCommand(organizationId, state, draft, crypto.randomUUID(), true), choices = buildBrowserUsTaxInvoiceChoices(estimate, lines, instant, source);
      setReview({ command, revision: state.revision, choices, localTime: wallTime, zone: state.configuration.timeZone, codes: estimate.lines.map(line => lines[line.id].checked!) }); setEditorOpen(false); setNotice(null);
    } catch { setReview(null); setNotice('invalid'); }
  }
  function backToChoices() { setReview(null); setEditorOpen(true); requestAnimationFrame(() => estimateRef.current?.focus()); }
  async function issue(retry = false) {
    if (!retry && (!activeReview || disabled)) return;
    const captured = activeReview;
    await run(async (instance, latest) => {
      if (retry) await instance.retry();
      else { if (!captured || latest.revision !== captured.revision) { setReview(null); throw new BrowserErpError('revision_conflict', 409, 'rejected'); } await instance.submit(captured.command, captured.revision, captured.choices); }
      setReview(null); setEditorOpen(true); setDraft(emptyBrowserInvoice()); setLines({}); setSource(''); setTime(''); setZoneConfirmed(false); setInstant(''); setNotice('saved'); props.onCommitted();
    }, retry);
  }
  const field = (label: string, key: keyof BrowserInvoiceDraft) => <label>{label}<input type="date" required value={draft[key]} onChange={event => change({ [key]: event.target.value })} /></label>;
  const destination = estimate ? source === 'billing' ? estimate.customer.billingAddress : source === 'shipping' ? estimate.customer.shippingAddress : null : null;
  const address = (value: typeof destination) => value ? <address>{value.line1}{value.line2 ? <><br />{value.line2}</> : null}<br />{value.city}, {value.subdivision} {value.postalCode}<br />{value.country}</address> : null;
  function usableAddress(value: unknown) { try { validateAddress(value, 'US'); return true; } catch { return false; } }
  if (!['owner', 'admin', 'accountant'].includes(role)) return null;
  return <section className="us-erp-section us-tax-invoice" aria-labelledby={`${prefix}-title`}>
    <h2 id={`${prefix}-title`}>{c.title}</h2><p className="us-erp-muted">{c.limitation}</p>
    {notice && <div ref={noticeRef} tabIndex={-1} className={`us-erp-notice ${notice === 'saved' ? 'success' : 'error'}`} role={notice === 'saved' ? 'status' : 'alert'}>{notice === 'pendingBlocked' ? browserUsTaxInvoicePendingConflict[language] : c[notice]}</div>}
    {permitted && <>
      <div className="us-tax-invoice-readiness"><button type="button" className="account-button secondary" disabled={disabled} onClick={() => void run(async instance => { const value = await instance.readiness(); setReadiness(value); setExpired(value.expiresAt * 1000 <= Date.now()); })}>{busy ? c.loading : c.readiness}</button>{readiness && <output>{expired ? c.expired : readiness.status === 'ready_test' ? c.ready : c.blocked}</output>}<p className="us-erp-muted">{c.readinessHelp}</p></div>
      {pending && <aside className="us-erp-pending" aria-live="polite"><p>{c.pending}</p><button type="button" className="account-button" disabled={busy || writeLocked} onClick={() => void issue(true)}>{busy ? c.loading : c.retry}</button></aside>}
      {!eligible.length ? <p>{c.noEstimate}</p> : !periods.length ? <p>{c.noPeriod}</p> : <details className="us-erp-editor" open={editorOpen || staleReview} onToggle={event => setEditorOpen(event.currentTarget.open)}><summary>{c.title}</summary><form onSubmit={prepare}><fieldset className="us-erp-form" disabled={disabled}>
        <label>{c.estimate}<select ref={estimateRef} aria-label={c.estimate} required value={draft.estimateId} onChange={event => change({ estimateId: event.target.value })}><option value="">{c.choose}</option>{eligible.map(item => <option key={item.id} value={item.id}>{item.number} · {item.customer.name}</option>)}</select></label>
        <div className="us-erp-grid">{field(c.date, 'date')}<label>{c.time}<input type="time" step="1" required value={time} onChange={event => { setTime(event.target.value); setInstant(''); setZoneConfirmed(false); setReview(null); }} /></label>{field(c.accountingDate, 'accountingDate')}{field(c.dueDate, 'dueDate')}<label>{c.period}<select aria-label={c.period} required value={draft.periodId} onChange={event => change({ periodId: event.target.value })}><option value="">{c.choose}</option>{periods.map(item => <option key={item.id} value={item.id}>{formatDateOnly(item.start, locale)} – {formatDateOnly(item.end, locale)}</option>)}</select></label></div>
        <div><p>{c.zone}: <strong>{state.configuration.timeZone.replaceAll('_', ' ')}</strong></p><label className="us-tax-invoice-check"><input type="checkbox" required checked={zoneConfirmed} onChange={event => { setZoneConfirmed(event.target.checked); setReview(null); }} /><span>{c.confirmZone}</span></label></div>
        {wallTime && !candidates.length && <p role="alert">{c.gap}</p>}{candidates.length > 1 && <label>{c.offset}<select aria-label={c.offset} required value={selectedInstant} onChange={event => { setInstant(event.target.value); setReview(null); }}><option value="">{c.choose}</option>{candidates.map(item => <option key={item.instant} value={item.instant}>UTC{item.offset} · {item.instant}</option>)}</select></label>}
        {estimate && !browserUsTaxEstimateSupported(estimate) ? <p role="alert">{c.unsupported}</p> : estimate && <>
          <div><p className="us-erp-muted">{c.catalogueHelp}</p><button type="button" className="account-button secondary" disabled={disabled || pages >= 10 || pages > 0 && !cursor} onClick={() => void run(async instance => { const page = await instance.catalogue(cursor ?? undefined); setCodes(previous => [...new Map([...previous, ...page.taxCodes].map(code => [code.id, code])).values()].slice(0, 500)); setCursor(page.nextCursor); setPages(value => value + 1); })}>{pages ? c.more : c.browse}</button><datalist id={`${prefix}-catalogue`}>{codes.map(code => <option key={code.id} value={code.id}>{code.name}</option>)}</datalist></div>
          <ul className="us-tax-invoice-lines">{estimate.lines.map(line => { const selection = lines[line.id] ?? blankLine(); return <li key={line.id}><h3>{line.description}</h3><label>{c.service}<input list={`${prefix}-catalogue`} autoComplete="off" required maxLength={13} pattern="txcd_[0-9]{8}" value={selection.code} onChange={event => changeLine(line.id, { code: event.target.value, checked: null, confirmed: false })} /></label><button type="button" className="account-button secondary" disabled={disabled || !/^txcd_[0-9]{8}$/.test(selection.code)} onClick={() => void run(async instance => { const checked = await instance.lookup(selection.code); changeLine(line.id, { checked, confirmed: false }); })}>{c.lookup}</button>{selection.checked && <div className="us-tax-invoice-code"><strong>{selection.checked.name}</strong><p>{selection.checked.description}</p><label className="us-tax-invoice-check"><input type="checkbox" required checked={selection.confirmed} onChange={event => changeLine(line.id, { confirmed: event.target.checked })} /><span>{c.confirmService}</span></label></div>}</li>; })}</ul>
          <fieldset className="us-tax-invoice-address"><legend>{c.source}</legend>{(['billing', 'shipping'] as const).map(value => { const saved = value === 'billing' ? estimate.customer.billingAddress : estimate.customer.shippingAddress; return usableAddress(saved) && <label key={value} className="us-tax-invoice-check"><input type="radio" name={`${prefix}-source`} required value={value} checked={source === value} onChange={() => { setSource(value); setReview(null); }} /><span>{c[value]}{address(saved ?? null)}</span></label>; })}</fieldset>
          <button type="submit" className="account-button">{c.review}</button>
        </>}
      </fieldset></form></details>}
      {staleReview && <output>{c.stale}</output>}
      {activeReview && <section ref={reviewRef} tabIndex={-1} className="us-erp-confirm us-tax-invoice-review" aria-labelledby={`${prefix}-review`}><h3 id={`${prefix}-review`}>{c.reviewTitle}</h3><dl className="us-erp-facts"><div><dt>{c.estimate}</dt><dd>{estimate?.number}</dd></div><div><dt>{c.time}</dt><dd>{activeReview.localTime.replace('T', ' ')} · {activeReview.zone}<br />{activeReview.choices.taxDateInstant}</dd></div><div><dt>{c.accountingDate}</dt><dd>{formatDateOnly(activeReview.command.accountingDate, locale)}</dd></div><div><dt>{c.dueDate}</dt><dd>{formatDateOnly(activeReview.command.dueDate, locale)}</dd></div>{estimate && <div><dt>{c.net}</dt><dd>{formatMoney(estimateTotals(estimate).net, locale)}</dd></div>}</dl><ul>{activeReview.codes.map((code, index) => <li key={`${code.id}:${index}`}>{estimate?.lines[index]?.description}: <strong>{code.name}</strong> · {code.id}</li>)}</ul><p>{c.source}: {c[activeReview.choices.addressSource]}</p>{address(destination)}<div className="us-erp-actions"><button type="button" className="account-button" disabled={disabled} onClick={() => void issue()}>{c.confirm}</button><button type="button" className="account-button secondary" disabled={busy || pending} onClick={backToChoices}>{c.cancel}</button></div></section>}
    </>}
  </section>;
}
