'use client';

import { useEffect, useEffectEvent, useLayoutEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import type { AccountRole } from '@/lib/account-security';
import type { SiteLanguage } from '@/lib/site-language';
import type { Ledger } from '@/lib/international/accounting/ledger';
import { LedgerError } from '@/lib/international/accounting/ledger';
import { reconciliationStatus } from '@/lib/international/accounting/reconciliation';
import { parseUsBankStatementCsv } from '@/lib/international/us-bank-csv';
import { applyUsBankCommand } from '@/lib/international/us-bank-reconciliation';
import type { UsBankCommand, UsBankReadResponse, UsBankRecord, UsBankRequest } from '@/lib/international/us-bank-contract';
import { BrowserBankError, createBrowserBankSession, type BrowserBankSession } from '@/lib/international/browser-bank-session';
import { browserBankCopy, browserBankError } from '@/lib/international/browser-bank-copy';
import { formatDateOnly } from '@/lib/international/localization';
import { formatMoney, money } from '@/lib/international/money';
import './us-erp-bank.css';
import { useUsBackgroundChannel, type UsBackgroundRegistration } from './us-background-channel';

export interface UsErpBankBinding {
  expectedUserId: string;
  accessEpoch: () => number;
  otherBusy: () => boolean;
  otherPending: () => boolean;
  onBusy: (busy: boolean) => void;
  onPending: (pending: boolean) => void;
  onUnauthorized: () => void;
  onCommitted: () => void;
  registerBackground?: UsBackgroundRegistration;
}
type Draft = { key: string; id: string; connectionId: string; openedRevision: number; text: string; fileBusy: boolean };
type Review = { command: UsBankCommand; id: string; recordRevision: number | null; erpRevision: number; ledgerRevision: number; readSequence: number };
const integer = (value: string | number) => BigInt(value);
/** One RAM draft and one protected transport. Preview authority is used only by
 * pure validation; neither role nor timestamp is sent as a server grant. */
export function UsErpBank({ organizationId, role, language, ledger, erpRevision, supportedSchemaVersion, binding }: { organizationId: string; role: AccountRole; language: SiteLanguage; ledger: Ledger; erpRevision: number; supportedSchemaVersion: number; binding: UsErpBankBinding }) {
  const c = browserBankCopy[language], prefix = useId(), locale = `${language}-US`, identity = `${organizationId}:${binding.expectedUserId}:${role}:${supportedSchemaVersion}:${binding.accessEpoch()}`;
  const refs = useRef({ binding, identity, ledger, erpRevision, options: { organizationId, expectedUserId: binding.expectedUserId, role, supportedSchemaVersion } });
  const updateRefs = useEffectEvent(() => { refs.current = { binding, identity, ledger, erpRevision, options: { organizationId, expectedUserId: binding.expectedUserId, role, supportedSchemaVersion } }; });
  useLayoutEffect(() => { updateRefs(); });
  const session = useRef<BrowserBankSession | null>(null), generation = useRef(0), sequence = useRef(0), fileSequence = useRef(0), lastHead = useRef(`${erpRevision}:${ledger.revision}`), mutation = useRef(0), quietRead = useRef<Promise<boolean> | null>(null), loadingRef = useRef(false), readRef = useRef<UsBankReadResponse | null>(null);
  const [ownedIdentity, setOwnedIdentity] = useState(identity), [read, setRead] = useState<UsBankReadResponse | null>(null), [readSequence, setReadSequence] = useState(0), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null), [selectedId, setSelectedId] = useState<string | null>(null), [bankIds, setBankIds] = useState<string[]>([]), [entryIds, setEntryIds] = useState<string[]>([]), [review, setReview] = useState<Review | null>(null), [voidReason, setVoidReason] = useState(''), [bankPage, setBankPage] = useState(0), [entryPage, setEntryPage] = useState(0), [previewPage, setPreviewPage] = useState(0);
  const financial = ['owner', 'admin', 'accountant'].includes(role), enabled = supportedSchemaVersion === 4 && ledger.currency === 'USD' && ledger.organizationId === organizationId && financial;
  const owned = identity === ownedIdentity, fresh = owned && read?.erpRevision === erpRevision && read.ledgerRevision === ledger.revision;
  const otherBlocked = binding.otherBusy() || binding.otherPending(), blocked = !owned || !enabled || busy || loading || pending || otherBlocked || !fresh;
  const selected = owned ? read?.records.find(record => record.reconciliation.statement.id === selectedId) : undefined;
  const currentReview = owned && fresh && review?.erpRevision === erpRevision && review.ledgerRevision === ledger.revision && review.readSequence === readSequence ? review : null;
  const usd = (units: string) => formatMoney(money('USD', units), locale), day = (date: string) => formatDateOnly(date, locale);
  function purge() { readRef.current = null; setRead(null); setDraft(null); setReview(null); setSelectedId(null); setBankIds([]); setEntryIds([]); setVoidReason(''); fileSequence.current++; }
  function failure(reason: unknown) {
    const code = reason instanceof BrowserBankError || reason instanceof LedgerError || reason instanceof Error && 'code' in reason && typeof reason.code === 'string' ? String(reason.code) : 'service_unavailable';
    if (reason instanceof BrowserBankError && reason.outcome === 'unauthorized') { session.current?.dispose(); generation.current++; purge(); refs.current.binding.onUnauthorized(); }
    setError(browserBankError(language, code));
  }
  async function load(background = false): Promise<boolean> {
    const transport = session.current, started = generation.current, actor = refs.current.identity, version = mutation.current;
    if (!transport || loadingRef.current || quietRead.current || background && (busy || transport.hasPending() || refs.current.binding.otherBusy() || refs.current.binding.otherPending())) return false;
    loadingRef.current = true; if (!background) setLoading(true);
    const operation = (async () => {
      try { const result = await transport.load(); if (started !== generation.current || actor !== refs.current.identity || version !== mutation.current || background && (transport.hasPending() || refs.current.binding.otherBusy() || refs.current.binding.otherPending())) return false;
        if (JSON.stringify(result) !== JSON.stringify(readRef.current)) { readRef.current = result; sequence.current++; setReadSequence(sequence.current); setRead(result); setReview(null); }
        if (!background) setError(''); return true;
      } catch (reason) { if (started !== generation.current || actor !== refs.current.identity) return false; if (background && !(reason instanceof BrowserBankError && reason.outcome === 'unauthorized')) throw reason; failure(reason); return false; }
      finally { if (started === generation.current && actor === refs.current.identity) { loadingRef.current = false; if (!background) setLoading(false); } }
    })();
    if (background) quietRead.current = operation;
    try { return await operation; } finally { if (quietRead.current === operation) quietRead.current = null; }
  }
  useUsBackgroundChannel(binding.registerBackground, () => load(true));
  const resetForEffect = useEffectEvent(() => { loadingRef.current = false; quietRead.current = null; setOwnedIdentity(identity); purge(); setError(''); setNotice(''); setBusy(false); setPending(false); setLoading(false); });
  const loadForEffect = useEffectEvent(() => { void load(); });
  const releaseForEffect = useEffectEvent((current: BrowserBankSession | null, callbacks: UsErpBankBinding) => { generation.current++; current?.dispose(); if (session.current === current) session.current = null; callbacks.onBusy(false); callbacks.onPending(false); });
  useEffect(() => {
    const started = ++generation.current, callbacks = refs.current.binding; let current: BrowserBankSession | null = null;
    queueMicrotask(() => { if (started !== generation.current) return; resetForEffect(); if (!enabled) return; current = createBrowserBankSession(refs.current.options); session.current = current; lastHead.current = `${refs.current.erpRevision}:${refs.current.ledger.revision}`; loadForEffect(); });
    return () => { releaseForEffect(current, callbacks); };
  }, [identity, enabled]);
  const loadForHeadEffect = useEffectEvent(() => { void load(true).catch(() => { /* A later head tick retries this quiet read. */ }); });
  useEffect(() => { const head = `${erpRevision}:${ledger.revision}`, started = generation.current; if (head !== lastHead.current) { lastHead.current = head; queueMicrotask(() => { if (started === generation.current) loadForHeadEffect(); }); } }, [erpRevision, ledger.revision]);
  function clearChoice() { setReview(null); setBankIds([]); setEntryIds([]); setVoidReason(''); setBankPage(0); setEntryPage(0); }
  function startDraft() { if (blocked) return; clearChoice(); setSelectedId(null); setDraft({ key: crypto.randomUUID(), id: crypto.randomUUID(), connectionId: crypto.randomUUID(), openedRevision: erpRevision, text: '', fileBusy: false }); setNotice(''); setError(''); setPreviewPage(0); }
  function preview(command: UsBankCommand, id: string, record: UsBankRecord | null) {
    if (blocked || !read) return;
    try {
      const request: UsBankRequest = { schemaVersion: 1, idempotencyKey: crypto.randomUUID(), reconciliationId: id, expectedErpRevision: erpRevision, expectedReconciliationRevision: record?.reconciliation.revision ?? null, command };
      applyUsBankCommand(record, request, ledger, { organizationId, userId: binding.expectedUserId, role, managementEntitled: true, timestamp: new Date().toISOString() }, read.records);
      setReview({ command, id, recordRevision: request.expectedReconciliationRevision, erpRevision, ledgerRevision: ledger.revision, readSequence: sequence.current }); setError('');
    } catch (reason) { setReview(null); failure(reason); }
  }
  function prepareImport(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); if (!draft || draft.fileBusy || blocked) return;
    const form = new FormData(event.currentTarget), field = (name: string) => { const value = form.get(name); return typeof value === 'string' ? value : ''; };
    try { const statement = parseUsBankStatementCsv({ text: draft.text, id: draft.id, organizationId, externalConnectionId: draft.connectionId, cashAccountId: field('account'), start: field('start'), end: field('end'), opening: field('opening'), closing: field('closing') }); preview({ type: 'create_statement', statement }, draft.id, null); }
    catch (reason) { setReview(null); failure(reason); }
  }
  async function readFile(file: File | undefined) {
    if (!draft || blocked) return; const number = ++fileSequence.current, actor = identity, key = draft.key; setReview(null); setError(''); setDraft(current => current?.key === key ? { ...current, text: '', fileBusy: true } : current);
    try { if (!file || file.size > 2_621_440) throw new BrowserBankError(file ? 'bank_csv_too_large' : 'invalid_request', 422); const text = await file.text(); if (number !== fileSequence.current || actor !== refs.current.identity) return; setDraft(current => current?.key === key ? { ...current, text, fileBusy: false } : current); }
    catch (reason) { if (number === fileSequence.current && actor === refs.current.identity) { setDraft(current => current?.key === key ? { ...current, fileBusy: false } : current); failure(reason); } }
  }
  async function commit(retry = false) {
    if (quietRead.current) { const reviewed = sequence.current; try { if (!await quietRead.current || reviewed !== sequence.current) return; } catch { return; } }
    const transport = session.current, candidate = currentReview, started = generation.current, actor = identity;
    if (!retry && candidate && (candidate.readSequence !== sequence.current || candidate.erpRevision !== refs.current.erpRevision || candidate.ledgerRevision !== refs.current.ledger.revision)) return;
    if (!transport || busy || loading || otherBlocked || !owned || (!retry && (!candidate || blocked))) return;
    mutation.current++; setBusy(true); binding.onBusy(true); setError(''); setNotice('');
    try {
      if (retry) await transport.retry(); else if (candidate) await transport.submit(candidate.command, candidate.id, candidate.erpRevision, candidate.recordRevision);
      if (started !== generation.current || actor !== refs.current.identity) return;
      setReview(null); setDraft(null); clearChoice(); setNotice(c.saved); await load();
      if (started === generation.current && actor === refs.current.identity) binding.onCommitted();
    } catch (reason) { if (started === generation.current && actor === refs.current.identity) { setReview(null); failure(reason); } }
    finally { if (started === generation.current && actor === refs.current.identity) { const uncertain = transport.hasPending(); setPending(uncertain); binding.onPending(uncertain); setBusy(false); binding.onBusy(false); } }
  }
  const pageControls = (page: number, count: number, update: (page: number) => void) => count > 20 && <div className="us-bank-pages"><button type="button" className="account-button secondary" disabled={page === 0} onClick={() => update(page - 1)}>{c.previous}</button><span>{c.page} {page + 1} / {Math.ceil(count / 20)}</span><button type="button" className="account-button secondary" disabled={(page + 1) * 20 >= count} onClick={() => update(page + 1)}>{c.next}</button></div>;
  const rows = selected?.reconciliation.statement.lines ?? [], alreadyBank = new Set(selected?.reconciliation.matches.flatMap(match => match.statementLineIds)), alreadyEntries = new Set(read?.records.filter(record => !record.voided).flatMap(record => record.reconciliation.matches.flatMap(match => match.ledgerEntryIds)));
  const movements = selected ? ledger.entries.map(entry => ({ entry, date: entry.paymentDate ?? entry.transactionDate, amount: entry.lines.filter(line => line.accountId === selected.reconciliation.statement.cashAccountId).reduce((sum, line) => sum + integer(line.debitMinor) - integer(line.creditMinor), integer(0)) })).filter(row => row.amount !== integer(0) && row.date >= selected.reconciliation.statement.start && row.date <= selected.reconciliation.statement.end) : [];
  const bankTotal = rows.filter(row => bankIds.includes(row.id)).reduce((sum, row) => sum + integer(row.amount.minorUnits), integer(0)), bookTotal = movements.filter(row => entryIds.includes(row.entry.id)).reduce((sum, row) => sum + row.amount, integer(0));
  let status: ReturnType<typeof reconciliationStatus> | null = null; try { if (selected && fresh) status = reconciliationStatus(selected.reconciliation, ledger); } catch { /* No empty or invented ready state. */ }
  const closed = Boolean(selected?.voided || selected?.reconciliation.completedAt), reviewCommand = currentReview?.command;
  if (!owned) return null;
  if (!enabled) return <p className="us-erp-muted">{financial ? c.unavailable : c.financial}</p>;
  return <section className="us-bank" lang={language} aria-labelledby={`${prefix}-title`}>
    <div className="us-erp-record-heading"><h3 id={`${prefix}-title`}>{c.title}</h3><button type="button" className="account-button secondary" disabled={busy || loading || otherBlocked} onClick={() => { void load(); binding.onCommitted(); }}>{c.refresh}</button></div><p className="us-erp-muted">{c.help}</p>
    {loading && <output>{c.loading}</output>}{error && <p role="alert">{error}</p>}{notice && <output>{notice}</output>}
    {pending && <div className="us-erp-notice"><p>{c.pending}</p><button type="button" className="account-button" disabled={busy || loading || otherBlocked} onClick={() => void commit(true)}>{c.retry}</button></div>}
    {read && !fresh && <output>{c.fresh}</output>}
    <button type="button" className="account-button" disabled={blocked || (read?.records.length ?? 100) >= 100} onClick={startDraft}>{c.add}</button>
    {read && !read.records.length && <p>{c.empty}</p>}
    {!!read?.records.length && <ul className="us-bank-statements">{read.records.map(record => { const statement = record.reconciliation.statement; return <li key={statement.id}><button type="button" className="us-bank-statement" aria-pressed={selectedId === statement.id} disabled={busy || pending} onClick={() => { setSelectedId(statement.id); setDraft(null); clearChoice(); setError(''); }}><span><strong>{day(statement.start)} – {day(statement.end)}</strong><span>{ledger.accounts.find(account => account.id === statement.cashAccountId)?.name ?? statement.cashAccountId}</span></span><span>{record.voided ? c.voided : record.reconciliation.completedAt ? c.completed : c.active}</span></button></li>; })}</ul>}
    {draft && <section className="us-erp-editor"><div className="us-erp-record-heading"><h3>{c.add}</h3><button type="button" className="account-button secondary" disabled={busy || pending} onClick={() => { setDraft(null); setReview(null); fileSequence.current++; }}>{c.cancel}</button></div>{draft.openedRevision !== erpRevision && !currentReview && <output>{c.stale}</output>}
      <form key={draft.key} onSubmit={prepareImport} onChange={() => setReview(null)}><fieldset disabled={busy || pending || otherBlocked} className="us-erp-form"><div className="us-erp-grid"><label>{c.account}<select name="account" required defaultValue=""><option value="">{c.chooseAccount}</option>{ledger.accounts.filter(account => account.cash).map(account => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></label><label>{c.start}<input name="start" type="date" required /></label><label>{c.end}<input name="end" type="date" required /></label><label>{c.opening}<input name="opening" inputMode="decimal" maxLength={40} required /></label><label>{c.closing}<input name="closing" inputMode="decimal" maxLength={40} required /></label></div><label>{c.file}<input name="csv" type="file" accept=".csv,text/csv" required onChange={event => void readFile(event.target.files?.[0])} /></label><p className="us-erp-muted">{c.csv} {c.limit}</p><button type="submit" className="account-button" disabled={blocked || draft.fileBusy || !draft.text}>{c.review}</button></fieldset></form>
    </section>}
    {selected && <section className="us-bank-detail"><div className="us-erp-record-heading"><h3>{c.statement} · {day(selected.reconciliation.statement.start)} – {day(selected.reconciliation.statement.end)}</h3><span>{selected.voided ? c.voided : selected.reconciliation.completedAt ? c.completed : c.active}</span></div><dl className="us-erp-facts"><div><dt>{c.opening}</dt><dd>{usd(selected.reconciliation.statement.opening.minorUnits)}</dd></div><div><dt>{c.closing}</dt><dd>{usd(selected.reconciliation.statement.closing.minorUnits)}</dd></div><div><dt>{c.audit}</dt><dd>{selected.createdBy}</dd></div><div><dt>{c.approved}</dt><dd>{selected.reconciliation.matches.length}</dd></div>{status && <><div><dt>{c.remaining}</dt><dd>{status.outstandingStatementLineIds.length} / {rows.length}</dd></div><div><dt>{c.openingDifference}</dt><dd>{usd(status.beginningDifferenceMinor)}</dd></div><div><dt>{c.closingDifference}</dt><dd>{usd(status.endingDifferenceMinor)}</dd></div></>}</dl>
      {fresh && selected.reconciliation.completedAt && selected.reconciliation.completedLedgerRevision !== ledger.revision && <output>{c.historical}</output>}
      <div className="us-bank-columns"><section aria-labelledby={`${prefix}-bank`}><h4 id={`${prefix}-bank`}>{c.lines}</h4><ul className="us-bank-movements">{rows.slice(bankPage * 20, (bankPage + 1) * 20).map(row => <li key={row.id}><label><input type="checkbox" checked={bankIds.includes(row.id)} disabled={blocked || closed || alreadyBank.has(row.id)} onChange={event => { setReview(null); setBankIds(current => event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id)); }} /><span><strong>{row.reference}</strong><span>{day(row.date)}{alreadyBank.has(row.id) ? ` · ${c.approved}` : ''}</span></span><strong className="us-bank-amount">{usd(row.amount.minorUnits)}</strong></label></li>)}</ul>{pageControls(bankPage, rows.length, setBankPage)}</section>
      <section aria-labelledby={`${prefix}-book`}><h4 id={`${prefix}-book`}>{c.entries}</h4><ul className="us-bank-movements">{movements.slice(entryPage * 20, (entryPage + 1) * 20).map(row => <li key={row.entry.id}><label><input type="checkbox" checked={entryIds.includes(row.entry.id)} disabled={blocked || closed || alreadyEntries.has(row.entry.id)} onChange={event => { setReview(null); setEntryIds(current => event.target.checked ? [...current, row.entry.id] : current.filter(id => id !== row.entry.id)); }} /><span><strong>{row.entry.description}</strong><span>{day(row.date)} · {row.entry.source.id}{alreadyEntries.has(row.entry.id) ? ` · ${c.approved}` : ''}</span></span><strong className="us-bank-amount">{usd(row.amount.toString())}</strong></label></li>)}</ul>{pageControls(entryPage, movements.length, setEntryPage)}</section></div>
      {!closed && <><dl className="us-erp-facts"><div><dt>{c.bankTotal}</dt><dd>{usd(bankTotal.toString())}</dd></div><div><dt>{c.bookTotal}</dt><dd>{usd(bookTotal.toString())}</dd></div></dl><div className="us-bank-actions"><button type="button" className="account-button" disabled={blocked || !bankIds.length || !entryIds.length} onClick={() => preview({ type: 'approve_match', id: crypto.randomUUID(), statementLineIds: bankIds, ledgerEntryIds: entryIds }, selected.reconciliation.statement.id, selected)}>{c.match}</button><button type="button" className="account-button secondary" disabled={blocked || !status?.ready} onClick={() => preview({ type: 'complete' }, selected.reconciliation.statement.id, selected)}>{c.complete}</button></div>{selected.reconciliation.matches.length === 0 && <details className="us-bank-void"><summary>{c.void}</summary><p>{c.voidHelp}</p><label>{c.reason}<textarea value={voidReason} maxLength={2000} disabled={blocked} onChange={event => { setReview(null); setVoidReason(event.target.value); }} /></label><button type="button" className="account-button secondary" disabled={blocked || !voidReason.trim()} onClick={() => preview({ type: 'void_statement', reason: voidReason }, selected.reconciliation.statement.id, selected)}>{c.review}</button></details>}</>}
    </section>}
    {review && !currentReview && !pending && <output>{c.stale}</output>}
    {currentReview && reviewCommand && <section className="us-erp-confirm" aria-label={c.review}><h3>{reviewCommand.type === 'create_statement' ? c.importHelp : reviewCommand.type === 'approve_match' ? c.matchHelp : reviewCommand.type === 'complete' ? c.completeHelp : c.voidHelp}</h3>
      {reviewCommand.type === 'create_statement' ? <><dl className="us-erp-facts"><div><dt>{c.account}</dt><dd>{ledger.accounts.find(account => account.id === reviewCommand.statement.cashAccountId)?.name}</dd></div><div><dt>{c.start}</dt><dd>{day(reviewCommand.statement.start)}</dd></div><div><dt>{c.end}</dt><dd>{day(reviewCommand.statement.end)}</dd></div><div><dt>{c.opening}</dt><dd>{usd(reviewCommand.statement.opening.minorUnits)}</dd></div><div><dt>{c.closing}</dt><dd>{usd(reviewCommand.statement.closing.minorUnits)}</dd></div><div><dt>{c.lines}</dt><dd>{reviewCommand.statement.lines.length}</dd></div></dl><ul className="us-bank-preview">{reviewCommand.statement.lines.slice(previewPage * 20, (previewPage + 1) * 20).map(row => <li key={row.id}><span>{day(row.date)} · {row.reference}</span><strong>{usd(row.amount.minorUnits)}</strong></li>)}</ul>{pageControls(previewPage, reviewCommand.statement.lines.length, setPreviewPage)}</> : reviewCommand.type === 'approve_match' ? <><p>{reviewCommand.statementLineIds.length} {c.lines} · {reviewCommand.ledgerEntryIds.length} {c.entries}</p><strong>{usd(bankTotal.toString())}</strong></> : reviewCommand.type === 'void_statement' ? <p>{reviewCommand.reason}</p> : <p>{c.openingDifference}: {status && usd(status.beginningDifferenceMinor)} · {c.closingDifference}: {status && usd(status.endingDifferenceMinor)}</p>}
      <button type="button" className="account-button" disabled={blocked} onClick={() => void commit()}>{reviewCommand.type === 'create_statement' ? c.confirm : reviewCommand.type === 'approve_match' ? c.confirmMatch : reviewCommand.type === 'complete' ? c.confirmComplete : c.confirmVoid}</button>
    </section>}
  </section>;
}
