'use client';

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type SubmitEvent } from 'react';
import type { AccountRole } from '@/lib/account-security';
import type { SiteLanguage } from '@/lib/site-language';
import type { ErpState } from '@/lib/international/runtime-types';
import type { UsSupplierProposal, UsSupplierReview } from '@/lib/international/us-supplier-contract';
import { canonicalErpJson } from '@/lib/international/erp-contract';
import { buildBrowserVendorBillCommand } from '@/lib/international/browser-purchasing';
import { validateUsSupplierReview } from '@/lib/international/us-supplier-proposal';
import { BrowserUsSupplierError, createBrowserUsSupplierSession, type BrowserUsSupplierRead, type BrowserUsSupplierResult, type BrowserUsSupplierSession } from '@/lib/international/browser-us-supplier-session';
import { browserUsSupplierCopy, browserUsSupplierError } from '@/lib/international/browser-us-supplier-copy';
import { formatDateOnly } from '@/lib/international/localization';
import { formatMoney, money } from '@/lib/international/money';
import './us-supplier-proposals.css';
import { useUsBackgroundChannel, type UsBackgroundRegistration } from './us-background-channel';

export interface UsSupplierProposalsBinding {
  expectedUserId: string;
  accessEpoch: () => number;
  otherBusy: () => boolean;
  otherPending: () => boolean;
  onBusy: (busy: boolean) => void;
  onPending: (pending: boolean) => void;
  onCommitted: () => void;
  onInvalidated: () => void;
  registerBackground?: UsBackgroundRegistration;
}
export interface UsSupplierProposalsProps {
  state: ErpState;
  organizationId: string;
  role: AccountRole;
  language: SiteLanguage;
  supportedSchemaVersion: number;
  disabled?: boolean;
  /** Explicit service readiness, never inferred from subscription or schema. */
  analysisAvailable?: boolean;
  hideTextImport?: boolean;
  binding: UsSupplierProposalsBinding;
}
interface Draft { proposalId: string; vendorId: string; reference: string; date: string; accountingDate: string; dueDate: string; periodId: string; net: string; tax: string; taxReviewed: boolean; confirmed: boolean; openedRevision: number }
interface ImportDraft { fileName: string; documentText: string; consent: boolean; fileBusy: boolean }
interface Review { proposalId: string; proposalRevision: number; sourceHash: string; erpRevision: number; readSequence: number; values: UsSupplierReview }
const integer = (value: string | number) => BigInt(value);
function decimal(minor: string | null): string { if (minor === null) return ''; const value = BigInt(minor); return `${value / BigInt(100)}.${(value % BigInt(100)).toString().padStart(2, '0')}`; }
function initialDraft(proposal: UsSupplierProposal, revision: number): Draft {
  const printed = (field: keyof UsSupplierProposal['extraction']['fields']) => proposal.extraction.evidence[field] ? proposal.extraction.fields[field] : null;
  const isUsd = proposal.extraction.fields.currency === 'USD';
  return { proposalId: proposal.id, vendorId: '', reference: printed('reference') ?? '', date: printed('invoiceDate') ?? '', dueDate: printed('dueDate') ?? '', accountingDate: '', periodId: '', net: isUsd ? decimal(printed('netMinor')) : '', tax: isUsd ? decimal(printed('printedTaxMinor')) : '', taxReviewed: false, confirmed: false, openedRevision: revision };
}
/** Explicit local review against the current ERP head. The server remains the
 * financial authority; no proposal can choose a vendor, date or tax for it. */
export function buildBrowserUsSupplierReview(organizationId: string, state: ErpState, proposal: UsSupplierProposal, draft: Pick<Draft, 'vendorId' | 'reference' | 'date' | 'accountingDate' | 'dueDate' | 'periodId' | 'net' | 'tax' | 'taxReviewed' | 'confirmed'>): UsSupplierReview {
  if (state.schemaVersion !== 4 || proposal.organizationId !== organizationId || proposal.state !== 'review' || !draft.taxReviewed || !draft.confirmed) throw new BrowserUsSupplierError('supplier_review_required', 422);
  if (proposal.extraction.fields.currency !== null && proposal.extraction.fields.currency !== 'USD') throw new BrowserUsSupplierError('supplier_currency_unsupported', 422);
  const command = buildBrowserVendorBillCommand(organizationId, state, { vendorId: draft.vendorId, reference: draft.reference, sourceReference: `mail:${proposal.id}:${proposal.source.sha256}`, date: draft.date, accountingDate: draft.accountingDate, dueDate: draft.dueDate, periodId: draft.periodId, net: draft.net, purchaseTax: draft.tax }, `us-mail-bill:${proposal.id}`);
  return validateUsSupplierReview({ vendorId: command.vendorId, reference: command.reference, date: command.date, accountingDate: command.accountingDate, dueDate: command.dueDate, periodId: command.periodId, netMinor: command.netMinor, printedTaxMinor: command.purchaseTaxMinor });
}

export function UsSupplierProposals({ state, organizationId, role, language, supportedSchemaVersion, disabled = false, analysisAvailable = false, hideTextImport = false, binding }: UsSupplierProposalsProps) {
  const c = browserUsSupplierCopy[language], prefix = useId(), locale = `${language}-US`;
  const identity = `${organizationId}:${binding.expectedUserId}:${role}:${supportedSchemaVersion}:${binding.accessEpoch()}`;
  const refs = useRef({ binding, identity, state, organizationId, role, supportedSchemaVersion });
  const updateRefs = useEffectEvent(() => { refs.current = { binding, identity, state, organizationId, role, supportedSchemaVersion }; });
  useLayoutEffect(() => { updateRefs(); });
  const transport = useRef<BrowserUsSupplierSession | null>(null), generation = useRef(0), readSequence = useRef(0), fileSequence = useRef(0), lastHead = useRef(state.revision), mutation = useRef(0), quietRead = useRef<Promise<boolean> | null>(null), loadingRef = useRef(false), readRef = useRef<BrowserUsSupplierRead | null>(null);
  const [ownedIdentity, setOwnedIdentity] = useState(identity), [read, setRead] = useState<BrowserUsSupplierRead | null>(null), [sequence, setSequence] = useState(0), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null), [draft, setDraft] = useState<Draft | null>(null), [review, setReview] = useState<Review | null>(null), [importDraft, setImportDraft] = useState<ImportDraft | null>(null), [page, setPage] = useState(0);
  const enabled = supportedSchemaVersion === 4 && state.schemaVersion === 4 && state.configuration.organizationId === organizationId && state.configuration.country === 'US' && state.configuration.currency === 'USD' && state.ledger.organizationId === organizationId && ['owner', 'admin', 'accountant'].includes(role);
  const owned = ownedIdentity === identity && enabled, fresh = owned && read?.erpRevision === state.revision;
  const otherBlocked = binding.otherBusy() || binding.otherPending(), editingBlocked = disabled || !owned || busy || pending || otherBlocked, blocked = editingBlocked || loading || !fresh;
  const selected = owned ? read?.proposals.find(proposal => proposal.id === selectedId) : undefined;
  const unsupportedCurrency = !!selected && selected.extraction.fields.currency !== null && selected.extraction.fields.currency !== 'USD';
  const currentReview = fresh && review?.erpRevision === state.revision && review.readSequence === sequence && selected?.id === review.proposalId && selected.revision === review.proposalRevision && selected.source.sha256 === review.sourceHash ? review : null;
  const usd = (value: string) => formatMoney(money('USD', value), locale), day = (value: string) => formatDateOnly(value, locale);
  const printedAmount = (proposal: UsSupplierProposal, value: string) => proposal.extraction.fields.currency === 'USD' ? usd(value) : `${decimal(value)}${proposal.extraction.fields.currency === null ? '' : ` ${proposal.extraction.fields.currency}`}`;
  const currentIdentity = () => { const r = refs.current; return `${r.organizationId}:${r.binding.expectedUserId}:${r.role}:${r.supportedSchemaVersion}:${r.binding.accessEpoch()}`; };
  const current = (started: number, actor: string) => generation.current === started && actor === currentIdentity();
  function purge() { readRef.current = null; setRead(null); setSelectedId(null); setDraft(null); setReview(null); setImportDraft(null); fileSequence.current++; }
  function failure(reason: unknown) {
    const code = reason instanceof BrowserUsSupplierError || reason instanceof Error && 'code' in reason && typeof reason.code === 'string' ? String(reason.code) : reason instanceof TypeError ? 'invalid_request' : 'service_unavailable';
    if (reason instanceof BrowserUsSupplierError && reason.outcome === 'unauthorized') { transport.current?.dispose(); generation.current++; purge(); setBusy(false); setPending(false); refs.current.binding.onBusy(false); refs.current.binding.onPending(false); refs.current.binding.onInvalidated(); }
    setError(browserUsSupplierError(language, code));
  }
  async function load(background = false): Promise<boolean> {
    const session = transport.current, started = generation.current, actor = currentIdentity(), version = mutation.current;
    if (!session || loadingRef.current || quietRead.current || background && (busy || session.hasPending() || refs.current.binding.otherBusy() || refs.current.binding.otherPending())) return false;
    loadingRef.current = true; if (!background) setLoading(true);
    const operation = (async () => {
      try { const result = await session.load(); if (!current(started, actor) || version !== mutation.current || background && (session.hasPending() || refs.current.binding.otherBusy() || refs.current.binding.otherPending())) return false;
        if (JSON.stringify(result) !== JSON.stringify(readRef.current)) { readRef.current = result; readSequence.current++; setSequence(readSequence.current); setRead(result); setReview(null); }
        if (!background) setError(''); return true;
      } catch (reason) { if (!current(started, actor)) return false; if (background && !(reason instanceof BrowserUsSupplierError && reason.outcome === 'unauthorized')) throw reason; failure(reason); return false; }
      finally { if (current(started, actor)) { loadingRef.current = false; if (!background) setLoading(false); } }
    })();
    if (background) quietRead.current = operation;
    try { return await operation; } finally { if (quietRead.current === operation) quietRead.current = null; }
  }
  useUsBackgroundChannel(binding.registerBackground, () => load(true));
  const resetForEffect = useEffectEvent(() => { loadingRef.current = false; quietRead.current = null; setOwnedIdentity(identity); purge(); setError(''); setNotice(''); setBusy(false); setPending(false); setLoading(false); setPage(0); });
  const loadForEffect = useEffectEvent(() => { void load(); });
  const releaseForEffect = useEffectEvent((session: BrowserUsSupplierSession | null, callbacks: UsSupplierProposalsBinding) => { generation.current++; session?.dispose(); if (transport.current === session) transport.current = null; callbacks.onBusy(false); callbacks.onPending(false); });
  useEffect(() => {
    const started = ++generation.current, callbacks = refs.current.binding; let session: BrowserUsSupplierSession | null = null;
    queueMicrotask(() => { if (started !== generation.current) return; resetForEffect(); if (!enabled) return; session = createBrowserUsSupplierSession({ organizationId: refs.current.organizationId, expectedUserId: callbacks.expectedUserId, role: refs.current.role, supportedSchemaVersion: refs.current.supportedSchemaVersion }); transport.current = session; lastHead.current = refs.current.state.revision; loadForEffect(); });
    return () => { releaseForEffect(session, callbacks); };
  }, [identity, enabled]);
  const loadForHeadEffect = useEffectEvent(() => { void load(true).catch(() => { /* A later head tick retries this quiet read. */ }); });
  useEffect(() => { const started = generation.current; if (state.revision !== lastHead.current) { lastHead.current = state.revision; queueMicrotask(() => { if (started === generation.current) loadForHeadEffect(); }); } }, [state.revision]);
  async function operate(operation: (session: BrowserUsSupplierSession) => Promise<BrowserUsSupplierResult>) {
    if (quietRead.current) { const reviewed = readSequence.current; try { if (!await quietRead.current || reviewed !== readSequence.current) return; } catch { return; } }
    const session = transport.current, started = generation.current, actor = currentIdentity(), callbacks = refs.current.binding;
    if (!session || disabled || busy || callbacks.otherBusy() || callbacks.otherPending()) return;
    mutation.current++; setBusy(true); callbacks.onBusy(true); setError(''); setNotice('');
    try {
      const result = await operation(session); if (!current(started, actor)) return;
      if (result.action === 'prepare') { setImportDraft(null); setSelectedId(result.proposal.id); setDraft(result.proposal.state === 'review' ? initialDraft(result.proposal, refs.current.state.revision) : null); setNotice(c.prepared); }
      else { setDraft(null); setReview(null); setNotice(result.replayed ? c.replayed : c.success); callbacks.onCommitted(); }
      await load();
    } catch (reason) { if (current(started, actor)) failure(reason); }
    finally { if (current(started, actor)) { const unresolved = session.hasPending(); setPending(unresolved); callbacks.onPending(unresolved); setBusy(false); callbacks.onBusy(false); } }
  }
  function select(proposal: UsSupplierProposal) { if (editingBlocked) return; setSelectedId(proposal.id); setImportDraft(null); setDraft(proposal.state === 'review' ? initialDraft(proposal, state.revision) : null); setReview(null); setError(''); setNotice(''); }
  function change<K extends keyof Draft>(field: K, value: Draft[K]) { setReview(null); setDraft(previous => previous ? { ...previous, [field]: value } : previous); }
  function verify(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); if (blocked || unsupportedCurrency || !selected || !draft) return;
    try { const values = buildBrowserUsSupplierReview(organizationId, refs.current.state, selected, draft); setReview({ proposalId: selected.id, proposalRevision: selected.revision, sourceHash: selected.source.sha256, erpRevision: state.revision, readSequence: sequence, values }); setDraft(previous => previous ? { ...previous, openedRevision: state.revision } : previous); setError(''); }
    catch (reason) { setReview(null); failure(reason); }
  }
  function confirm() {
    if (blocked || unsupportedCurrency || !currentReview || !selected || !draft) return;
    try { const values = buildBrowserUsSupplierReview(organizationId, refs.current.state, selected, draft); if (canonicalErpJson(values) !== canonicalErpJson(currentReview.values)) throw new BrowserUsSupplierError('supplier_review_required', 422); void operate(session => session.approve(selected, values, currentReview.erpRevision)); }
    catch (reason) { setReview(null); failure(reason); }
  }
  async function readFile(file: File | undefined) {
    if (!importDraft || editingBlocked) return; const number = ++fileSequence.current, actor = currentIdentity(); setImportDraft(previous => previous ? { ...previous, documentText: '', consent: false, fileBusy: true } : previous); setError('');
    try { if (!file || file.size > 16_384 || !/\.txt$/i.test(file.name)) throw new BrowserUsSupplierError('document_too_large', 422); const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); if (number !== fileSequence.current || actor !== currentIdentity()) return; setImportDraft(previous => previous ? { ...previous, fileName: file.name, documentText: text, fileBusy: false } : previous); }
    catch (reason) { if (number === fileSequence.current && actor === currentIdentity()) { setImportDraft(previous => previous ? { ...previous, fileBusy: false } : previous); failure(reason); } }
  }
  function prepare(event: SubmitEvent<HTMLFormElement>) { event.preventDefault(); if (blocked || !analysisAvailable || !importDraft || !importDraft.consent || importDraft.fileBusy) return; const input = { fileName: importDraft.fileName, documentText: importDraft.documentText, consent: true as const }; void operate(session => session.prepare(input)); }
  function back() { if (editingBlocked) return; setSelectedId(null); setDraft(null); setReview(null); setImportDraft(null); fileSequence.current++; }
  let enteredTotal: string | null = null;
  if (draft && /^[0-9]{1,36}(?:\.[0-9]{1,2})?$/.test(draft.net) && /^[0-9]{1,36}(?:\.[0-9]{1,2})?$/.test(draft.tax)) {
    const minor = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0')); }; enteredTotal = (minor(draft.net) + minor(draft.tax)).toString();
  }
  const proposals = owned ? read?.proposals ?? [] : [], pageCount = Math.max(1, Math.ceil(proposals.length / 10)), visiblePage = Math.min(page, pageCount - 1);
  return <section className="us-supplier" aria-labelledby={`${prefix}-title`}>
    <div className="us-supplier-heading"><div><h2 id={`${prefix}-title`}>{c.title}</h2><p>{c.intro}</p></div><div className="us-supplier-actions">{!hideTextImport && <button type="button" className="account-button secondary" disabled={blocked || !analysisAvailable || importDraft?.fileBusy} onClick={() => { fileSequence.current++; setSelectedId(null); setDraft(null); setReview(null); setImportDraft({ fileName: '', documentText: '', consent: false, fileBusy: false }); setError(''); setNotice(''); }}>{c.import}</button>}<button type="button" className="account-button secondary" disabled={!enabled || busy || loading} onClick={() => void load()}>{c.refresh}</button></div></div>
    {!enabled ? <p>{state.schemaVersion !== 4 || supportedSchemaVersion !== 4 ? c.upgrade : c.access}</p> : <>
      {!analysisAvailable && <p className="us-supplier-muted">{c.unavailable}</p>}
      {error && <p role="alert" className="us-supplier-feedback">{error}</p>}{notice && <output className="us-supplier-feedback">{notice}</output>}
      {loading && !read && <output>{c.loading}</output>}
      {pending && <section className="us-supplier-recovery" aria-label={c.waiting}><p>{c.waiting}</p><button type="button" className="account-button" disabled={disabled || busy || otherBlocked} onClick={() => void operate(session => session.retry())}>{c.retry}</button></section>}
      {owned && !hideTextImport && importDraft && <section className="us-supplier-editor"><div className="us-supplier-heading"><h3>{c.import}</h3><button type="button" className="account-button secondary" disabled={editingBlocked || importDraft.fileBusy} onClick={back}>{c.close}</button></div><form onSubmit={prepare}><fieldset disabled={editingBlocked || importDraft.fileBusy || !analysisAvailable}>
        <label>{c.fileName}<input name="fileName" required maxLength={160} value={importDraft.fileName} onChange={event => setImportDraft(previous => previous ? { ...previous, fileName: event.target.value, consent: false } : previous)} /></label>
        <label>{c.file}<input name="file" type="file" accept=".txt,text/plain" onChange={event => void readFile(event.target.files?.[0])} /></label>
        <label>{c.text}<textarea name="documentText" required value={importDraft.documentText} maxLength={16_384} onChange={event => setImportDraft(previous => previous ? { ...previous, documentText: event.target.value, consent: false } : previous)} /></label><p className="us-supplier-muted">{c.plainText}</p>
        <label className="us-supplier-check"><input name="consent" type="checkbox" required checked={importDraft.consent} onChange={event => setImportDraft(previous => previous ? { ...previous, consent: event.target.checked } : previous)} /><span>{c.consent}</span></label>
        <button type="submit" className="account-button" disabled={blocked || !importDraft.consent || !importDraft.documentText.trim()}>{c.analyze}</button>
      </fieldset></form></section>}
      {owned && selected && <section className="us-supplier-editor"><div className="us-supplier-heading"><div><h3>{selected.extraction.fields.reference ?? selected.source.fileName}</h3><p>{selected.extraction.fields.supplierName ?? c.unknown}</p></div><button type="button" className="account-button secondary" disabled={editingBlocked} onClick={back}>{c.back}</button></div>
        <details className="us-supplier-source"><summary>{c.source}</summary><pre>{selected.source.documentText}</pre></details>
        {selected.state === 'recorded' && selected.recording ? <><output>{c.recorded}</output><dl className="us-supplier-facts"><div><dt>{c.savedVendor}</dt><dd>{state.vendors?.find(vendor => vendor.id === selected.recording?.review.vendorId)?.name ?? selected.recording.review.vendorId}</dd></div><div><dt>{c.reference}</dt><dd>{selected.recording.review.reference}</dd></div><div><dt>{c.total}</dt><dd>{usd((integer(selected.recording.review.netMinor) + integer(selected.recording.review.printedTaxMinor)).toString())}</dd></div><div><dt>{c.audit}</dt><dd>{selected.recording.by}</dd></div></dl></> : draft && <>
          {(draft.openedRevision !== state.revision || review && !currentReview) && !pending && <output className="us-supplier-feedback">{c.stale}</output>}
          {unsupportedCurrency && <p role="alert" className="us-supplier-feedback">{c.unsupportedCurrency}</p>}{selected.extraction.fields.currency === null && <p className="us-supplier-muted">{c.unknownCurrency}</p>}{selected.extraction.issues.some(issue => issue !== 'human_approval_required') && <p className="us-supplier-muted">{c.missing}</p>}
          <form onSubmit={verify}><fieldset disabled={editingBlocked}>
            <label>{c.vendor}<select name="vendor" required value={draft.vendorId} onChange={event => change('vendorId', event.target.value)}><option value="">{c.chooseVendor}</option>{state.vendors?.map(vendor => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select></label>{!state.vendors?.length && <p className="us-supplier-muted">{c.noVendor}</p>}
            <label>{c.reference}<input name="reference" required maxLength={500} value={draft.reference} onChange={event => change('reference', event.target.value)} /></label>
            <div className="us-supplier-grid"><label>{c.date}<input name="date" type="date" required value={draft.date} onChange={event => change('date', event.target.value)} /></label><label>{c.dueDate}<input name="dueDate" type="date" required value={draft.dueDate} onChange={event => change('dueDate', event.target.value)} /></label><label>{c.accountingDate}<input name="accountingDate" type="date" required value={draft.accountingDate} onChange={event => change('accountingDate', event.target.value)} /></label><label>{c.period}<select name="period" required value={draft.periodId} onChange={event => change('periodId', event.target.value)}><option value="">{c.choosePeriod}</option>{state.ledger.periods.filter(period => period.status === 'open').map(period => <option key={period.id} value={period.id}>{day(period.start)} – {day(period.end)}</option>)}</select></label><label>{c.net}<input name="net" inputMode="decimal" required maxLength={40} value={draft.net} onChange={event => change('net', event.target.value)} /></label><label>{c.tax}<input name="tax" inputMode="decimal" required maxLength={40} value={draft.tax} onChange={event => change('tax', event.target.value)} /></label></div>
            <p className="us-supplier-muted">{c.taxHelp}</p><dl className="us-supplier-facts"><div><dt>{c.total}</dt><dd>{enteredTotal === null ? '—' : usd(enteredTotal)}</dd></div>{selected.extraction.fields.totalMinor !== null && <div><dt>{c.printedTotal}</dt><dd>{printedAmount(selected, selected.extraction.fields.totalMinor)}</dd></div>}</dl>
            {selected.extraction.fields.currency === 'USD' && enteredTotal !== null && selected.extraction.fields.totalMinor !== null && enteredTotal !== selected.extraction.fields.totalMinor && <output className="us-supplier-feedback">{c.mismatch}</output>}
            <label className="us-supplier-check"><input name="taxReviewed" type="checkbox" required checked={draft.taxReviewed} onChange={event => change('taxReviewed', event.target.checked)} /><span>{c.taxReviewed}</span></label><label className="us-supplier-check"><input name="confirmed" type="checkbox" required checked={draft.confirmed} onChange={event => change('confirmed', event.target.checked)} /><span>{c.confirmed}</span></label>
            <button type="submit" className="account-button" disabled={blocked || unsupportedCurrency || !draft.taxReviewed || !draft.confirmed}>{c.verify}</button>
          </fieldset></form>
          {currentReview && <section className="us-supplier-confirm" aria-labelledby={`${prefix}-confirmation`}><h4 id={`${prefix}-confirmation`}>{c.confirmation}</h4><p>{c.confirmationHelp}</p><dl className="us-supplier-facts"><div><dt>{c.vendor}</dt><dd>{state.vendors?.find(vendor => vendor.id === currentReview.values.vendorId)?.name}</dd></div><div><dt>{c.reference}</dt><dd>{currentReview.values.reference}</dd></div><div><dt>{c.accountingDate}</dt><dd>{day(currentReview.values.accountingDate)}</dd></div><div><dt>{c.total}</dt><dd>{usd((integer(currentReview.values.netMinor) + integer(currentReview.values.printedTaxMinor)).toString())}</dd></div></dl><button type="button" className="account-button" disabled={blocked} onClick={confirm}>{c.confirm}</button></section>}
        </>}
      </section>}
      {owned && !selected && !importDraft && <>{read && !proposals.length && <div className="us-supplier-empty"><h3>{c.empty}</h3><p>{c.emptyHelp}</p></div>}<ul className="us-supplier-list">{proposals.slice(visiblePage * 10, (visiblePage + 1) * 10).map(proposal => <li key={proposal.id}><button type="button" disabled={editingBlocked} onClick={() => select(proposal)}><span><strong>{proposal.extraction.fields.reference ?? proposal.source.fileName}</strong><span>{proposal.extraction.fields.supplierName ?? c.unknown}</span></span><span className="us-supplier-row-end">{proposal.extraction.fields.totalMinor === null ? null : <strong>{printedAmount(proposal, proposal.extraction.fields.totalMinor)}</strong>}<span>{proposal.state === 'recorded' ? c.recorded : c.toReview}</span></span></button></li>)}</ul>{pageCount > 1 && <nav className="us-supplier-pagination" aria-label={c.page}><button type="button" className="account-button secondary" disabled={visiblePage === 0} onClick={() => setPage(previous => Math.max(0, previous - 1))}>{c.previous}</button><span>{visiblePage + 1} / {pageCount}</span><button type="button" className="account-button secondary" disabled={visiblePage + 1 >= pageCount} onClick={() => setPage(previous => Math.min(pageCount - 1, previous + 1))}>{c.next}</button></nav>}</>}
    </>}
  </section>;
}
