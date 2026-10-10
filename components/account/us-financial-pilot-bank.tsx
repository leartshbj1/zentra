'use client';

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ChangeEvent, type SubmitEvent } from 'react';
import { ArrowLeft, Check, ChevronRight, Download, RefreshCw, X } from 'lucide-react';
import type { SiteLanguage } from '@/lib/site-language';
import type { BrowserUsFinancialPilotSession, BrowserUsFinancialPilotState } from '@/lib/international/browser-us-financial-pilot-session';
import type { UsFinancialPilotOverview } from '@/lib/international/us-financial-pilot-contract';
import { US_FINANCIAL_PILOT_BANK_MAX_OPERATIONS, type UsFinancialPilotBankCommand, type UsFinancialPilotBankOrigin } from '@/lib/international/us-financial-pilot-bank';
import { MAX_US_BANK_RECORDS } from '@/lib/international/us-bank-reconciliation';
import type {
  UsFinancialPilotBankContext, UsFinancialPilotBankStatementSummary, UsFinancialPilotBankStatementDetail,
  UsFinancialPilotBankStatementsPage, UsFinancialPilotBankLine, UsFinancialPilotBankMatch,
  UsFinancialPilotBankMovement, UsFinancialPilotBankMovementsPage,
} from '@/lib/international/us-financial-pilot-bank-projection';
import {
  US_FINANCIAL_PILOT_BANK_IMPORT_MAX_BYTES, US_FINANCIAL_PILOT_BANK_EVIDENCE_MAX_PAGES,
  type BankImportDraft, type BankReview,
} from '@/lib/international/browser-us-financial-pilot-bank-input';
import { browserUsFinancialPilotBankCopy, browserUsFinancialPilotBankErrorCopy } from '@/lib/international/browser-us-financial-pilot-bank-copy';
import { formatMoney, money } from '@/lib/international/money';
import { formatDateOnly } from '@/lib/international/localization';
import './us-financial-pilot-bank.css';

interface Props {
  session: BrowserUsFinancialPilotSession;
  state: BrowserUsFinancialPilotState;
  snapshot: UsFinancialPilotOverview;
  language: SiteLanguage;
  active: boolean;
}
type Target = Readonly<{ statementId: string; origin: UsFinancialPilotBankOrigin }>;
type Pair = Readonly<{ revision: number; bankRevision: number }>;
type ReviewLine = Readonly<{ key: string; ordinal: number; date: string; amountMinor: string; reference: string }>;
interface ViewReview {
  readonly value: BankReview;
  readonly token: number;
  readonly statement: UsFinancialPilotBankStatementDetail | null;
  readonly lines: readonly ReviewLine[];
  readonly movements: readonly UsFinancialPilotBankMovement[];
}
const PAGE_SIZE = 25;
const exactInteger = BigInt;
const locales: Readonly<Record<SiteLanguage, string>> = { en: 'en-US', fr: 'fr-CH', de: 'de-CH', it: 'it-CH' };
const pairEqual = (a: Pair | null | undefined, b: Pair | null | undefined) => a?.revision === b?.revision && a?.bankRevision === b?.bankRevision;
const targetEqual = (a: Target | null, b: Target | null) => a?.statementId === b?.statementId && a?.origin === b?.origin;
function errorCode(value: unknown): string {
  if (!value || typeof value !== 'object') return 'service_unavailable';
  const descriptor = Object.getOwnPropertyDescriptor(value, 'code');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : 'service_unavailable';
}
const total = (rows: readonly Readonly<{ amountMinor: string }>[]) => rows.reduce((sum, row) => sum + exactInteger(row.amountMinor), exactInteger(0)).toString();

export function UsFinancialPilotBank({ session, state, snapshot, language, active }: Props) {
  const c = browserUsFinancialPilotBankCopy[language], locale = locales[language], organizationId = snapshot.organizationId;
  const usd = (minor: string) => formatMoney(money('USD', minor), locale);
  const date = (value: string) => formatDateOnly(value, locale);
  const instant = (value: string) => new Intl.DateTimeFormat(locale, { timeZone: snapshot.company.timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  const lifetime = useRef(0), factsEpoch = useRef(0), readSequence = useRef(0), editToken = useRef(0), userEdit = useRef(0), actionSequence = useRef(0);
  const actionFlight = useRef(false), fileFlight = useRef(false), readFlight = useRef(false), fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef({ session, organizationId, active, target: null as Target | null, hasDraft: false });
  const [context, setContext] = useState<UsFinancialPilotBankContext | null>(null);
  const [statements, setStatements] = useState<UsFinancialPilotBankStatementsPage | null>(null);
  const [statementCursor, setStatementCursor] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [linePages, setLinePages] = useState<readonly UsFinancialPilotBankStatementDetail[]>([]);
  const [matchPages, setMatchPages] = useState<readonly UsFinancialPilotBankStatementDetail[]>([]);
  const [movementPages, setMovementPages] = useState<readonly UsFinancialPilotBankMovementsPage[]>([]);
  const [linePage, setLinePage] = useState(0), [matchPage, setMatchPage] = useState(0), [movementPage, setMovementPage] = useState(0);
  const [selectedLines, setSelectedLines] = useState<ReadonlyMap<string, UsFinancialPilotBankLine>>(new Map());
  const [selectedMovements, setSelectedMovements] = useState<ReadonlyMap<number, UsFinancialPilotBankMovement>>(new Map());
  const [selectionPage, setSelectionPage] = useState(0);
  const [draft, setDraft] = useState<BankImportDraft | null>(null), [fileName, setFileName] = useState('');
  const [voidReason, setVoidReason] = useState(''), [showVoid, setShowVoid] = useState(false);
  const [review, setReview] = useState<ViewReview | null>(null), [approvedToken, setApprovedToken] = useState<number | null>(null);
  const [reviewToken, setReviewToken] = useState(0);
  const [reviewPage, setReviewPage] = useState(0), [visitedReviewPages, setVisitedReviewPages] = useState<ReadonlySet<number>>(new Set([0]));
  const [reading, setReading] = useState(false), [fileReading, setFileReading] = useState(false), [busy, setBusy] = useState(false), [exporting, setExporting] = useState(false);
  const [error, setError] = useState(''), [saved, setSaved] = useState(false), [changed, setChanged] = useState(false), [reloadApproved, setReloadApproved] = useState(false), [tick, setTick] = useState(0);
  const hasDraft = !!draft || !!review || selectedLines.size > 0 || selectedMovements.size > 0 || !!voidReason;
  useLayoutEffect(() => {
    latest.current = { session, organizationId, active, target, hasDraft };
  }, [session, organizationId, active, target, hasDraft]);

  const head = state.bank.head;
  const fresh = state.status === 'ready' && !!head && head.revision === snapshot.revision && !state.requiresRefresh && !state.bank.requiresRefresh;
  const currentContext = fresh && pairEqual(context, head) ? context : null;
  const currentStatements = fresh && pairEqual(statements, head) ? statements : null;
  const firstDetail = fresh && linePages[0] && pairEqual(linePages[0], head) && targetEqual(linePages[0].statement, target) ? linePages[0] : null;
  const detail = firstDetail;
  const locked = busy || fileReading || reading || state.pending || state.writing || !fresh;
  const capacity = (head?.bankRevision ?? 0) >= US_FINANCIAL_PILOT_BANK_MAX_OPERATIONS;
  const legacyBlocked = !!currentContext?.legacyPending.some(item => item.cashAccountId === (draft?.cashAccountId ?? detail?.statement.cashAccountId));
  const mutable = !!detail && detail.statement.origin === 'financial-v5' && detail.statement.state === 'open' && !legacyBlocked && !capacity;
  const bankPending = state.pendingKind === 'bank';
  const selectedLineRows = [...selectedLines.values()].sort((a, b) => a.ordinal - b.ordinal);
  const selectedMovementRows = [...selectedMovements.values()].sort((a, b) => a.journalRevision - b.journalRevision);
  const freshLines = new Map((detail ? linePages : []).flatMap(page => page.lines.items.map(row => [row.lineId, row] as const)));
  const freshMovements = new Map((detail ? movementPages : []).flatMap(page => page.items.map(row => [row.journalRevision, row] as const)));
  const selectedFactsReady = selectedLineRows.length > 0 && selectedMovementRows.length > 0 && selectedLineRows.every(row => freshLines.get(row.lineId)?.matchId === null) && selectedMovementRows.every(row => {
    const current = freshMovements.get(row.journalRevision);
    return current?.status === 'available' && !!detail && current.bankDate >= detail.statement.start && current.bankDate <= detail.statement.end;
  });
  const statementTotal = total(selectedLineRows), movementTotal = total(selectedMovementRows), difference = (exactInteger(statementTotal) - exactInteger(movementTotal)).toString();
  const reviewPages = review ? Math.max(1, Math.ceil(Math.max(review.lines.length, review.movements.length) / PAGE_SIZE)) : 1;
  const allReviewPagesVisited = !!review && Array.from({ length: reviewPages }, (_, index) => index).every(index => visitedReviewPages.has(index));
  const reviewCurrent = !!review && review.token === reviewToken && fresh && review.value === state.bank.pendingReview && review.value.request.expectedRevision === head?.revision && review.value.request.expectedBankRevision === head?.bankRevision && (review.value.request.command.type === 'create_statement' || !!detail && review.value.request.expectedStatementRevision === detail.statement.statementRevision && review.value.request.command.statementId === detail.statement.statementId);
  const approved = reviewCurrent && approvedToken === review?.token && allReviewPagesVisited;

  function live(epoch: number): boolean {
    const now = session.getState();
    return epoch === lifetime.current && latest.current.session === session && latest.current.organizationId === organizationId && now.status !== 'denied' && now.status !== 'stopped';
  }
  function validRead(epoch: number, facts: number, sequence: number, pair: Pair, subject: Target | null): boolean {
    const now = session.getState();
    return live(epoch) && latest.current.active && facts === factsEpoch.current && sequence === readSequence.current && !now.pending && !now.writing && !now.requiresRefresh && !now.bank.requiresRefresh && pairEqual(pair, now.bank.head) && targetEqual(subject, latest.current.target);
  }
  function clearReview(): void {
    editToken.current++; setReviewToken(editToken.current); setReview(null); setApprovedToken(null); setReviewPage(0); setVisitedReviewPages(new Set([0])); setReloadApproved(false);
  }
  function editFacts(): void { userEdit.current++; latest.current.hasDraft = true; clearReview(); }
  function interactive(): boolean {
    const now = session.getState();
    return latest.current.active && !actionFlight.current && !fileFlight.current && !now.pending && !now.writing && now.status === 'ready';
  }
  function clearFacts(): void {
    readSequence.current++; readFlight.current = false; setReading(false); setContext(null); setStatements(null); setStatementCursor(null);
    setLinePages([]); setMatchPages([]); setMovementPages([]); setLinePage(0); setMatchPage(0); setMovementPage(0); clearReview();
  }
  function purge(): void {
    clearFacts(); userEdit.current++; actionSequence.current++; actionFlight.current = false; fileFlight.current = false; setBusy(false); setExporting(false); setFileReading(false);
    setDraft(null); setFileName(''); setTarget(null); setSelectedLines(new Map()); setSelectedMovements(new Map()); setSelectionPage(0); setVoidReason(''); setShowVoid(false); setError(''); setSaved(false); setChanged(false);
    latest.current.target = null; latest.current.hasDraft = false;
    if (fileInput.current) fileInput.current.value = '';
  }
  function showError(caught: unknown): void {
    const code = errorCode(caught);
    if (['session_disposed', 'session_changed', 'stale_read'].includes(code)) { if (code === 'stale_read') setChanged(true); return; }
    setError(code);
  }

  function refreshSelectedFacts(lines: readonly UsFinancialPilotBankLine[], movements: readonly UsFinancialPilotBankMovement[]): void {
    setSelectedLines(previous => { const next = new Map(previous); for (const row of lines) if (next.has(row.lineId)) next.set(row.lineId, row); return next; });
    setSelectedMovements(previous => { const next = new Map(previous); for (const row of movements) if (next.has(row.journalRevision)) next.set(row.journalRevision, row); return next; });
  }
  const loadCurrent = useEffectEvent(async (): Promise<void> => {
    const now = session.getState(), pair = now.bank.head;
    if (!pair || now.pending || now.writing || now.requiresRefresh || now.bank.requiresRefresh || !latest.current.active || actionFlight.current || fileFlight.current) return;
    const epoch = lifetime.current, facts = factsEpoch.current, sequence = ++readSequence.current, subject = latest.current.target;
    readFlight.current = true; setReading(true); setError('');
    try {
      const [nextContext, page, nextDetail, moves] = await Promise.all([
        session.readBankContext({ revision: pair.revision, bankRevision: pair.bankRevision }),
        session.readBankStatements({ revision: pair.revision, bankRevision: pair.bankRevision }),
        subject ? session.readBankStatement({ revision: pair.revision, bankRevision: pair.bankRevision, statementId: subject.statementId, origin: subject.origin }) : Promise.resolve(null),
        subject?.origin === 'financial-v5' ? session.readBankMovements({ revision: pair.revision, bankRevision: pair.bankRevision, statementId: subject.statementId, origin: subject.origin }) : Promise.resolve(null),
      ]);
      if (!validRead(epoch, facts, sequence, pair, subject)) return;
      setContext(nextContext); setStatements(page); setStatementCursor(null); setLinePages(nextDetail ? [nextDetail] : []); setMatchPages(nextDetail ? [nextDetail] : []); setMovementPages(moves ? [moves] : []); setLinePage(0); setMatchPage(0); setMovementPage(0);
      if (nextDetail) refreshSelectedFacts(nextDetail.lines.items, moves?.items ?? []);
    } catch (caught) { if (live(epoch) && facts === factsEpoch.current && sequence === readSequence.current) showError(caught); }
    finally { if (live(epoch) && sequence === readSequence.current) { readFlight.current = false; setReading(false); } }
  });
  async function refresh(): Promise<void> {
    if (actionFlight.current || fileFlight.current || session.getState().writing || session.getState().pending) return;
    const epoch = lifetime.current; setError(''); setSaved(false);
    try { await session.refreshBank(); if (live(epoch)) setTick(value => value + 1); }
    catch (caught) { if (live(epoch)) showError(caught); }
  }
  async function nextPage(kind: 'statements' | 'lines' | 'matches' | 'movements', cursor: string): Promise<void> {
    const now = session.getState(), pair = now.bank.head, subject = latest.current.target;
    if (!pair || now.pending || now.writing || now.requiresRefresh || now.bank.requiresRefresh || actionFlight.current || fileFlight.current || readFlight.current) return;
    const pages = kind === 'lines' ? linePages : kind === 'matches' ? matchPages : movementPages;
    if (kind !== 'statements' && pages.length >= US_FINANCIAL_PILOT_BANK_EVIDENCE_MAX_PAGES) { setError('bank_input_too_large'); return; }
    const epoch = lifetime.current, facts = factsEpoch.current, sequence = ++readSequence.current;
    readFlight.current = true; setReading(true); setError('');
    try {
      if (kind === 'statements') {
        const page = await session.readBankStatements({ revision: pair.revision, bankRevision: pair.bankRevision, cursor });
        if (validRead(epoch, facts, sequence, pair, subject)) { setStatements(page); setStatementCursor(cursor); }
      } else if (subject && kind === 'movements') {
        const page = await session.readBankMovements({ revision: pair.revision, bankRevision: pair.bankRevision, statementId: subject.statementId, origin: subject.origin, cursor });
        if (validRead(epoch, facts, sequence, pair, subject)) { clearReview(); setMovementPages(previous => [...previous, page]); setMovementPage(movementPages.length); refreshSelectedFacts([], page.items); }
      } else if (subject) {
        const page = await session.readBankStatement({ revision: pair.revision, bankRevision: pair.bankRevision, statementId: subject.statementId, origin: subject.origin, ...(kind === 'lines' ? { lineCursor: cursor } : { matchCursor: cursor }) });
        if (!validRead(epoch, facts, sequence, pair, subject)) return;
        clearReview();
        if (kind === 'lines') { setLinePages(previous => [...previous, page]); setLinePage(linePages.length); refreshSelectedFacts(page.lines.items, []); }
        else { setMatchPages(previous => [...previous, page]); setMatchPage(matchPages.length); }
      }
    } catch (caught) { if (live(epoch) && facts === factsEpoch.current && sequence === readSequence.current) showError(caught); }
    finally { if (live(epoch) && sequence === readSequence.current) { readFlight.current = false; setReading(false); } }
  }
  function chooseStatement(value: Target | null): void {
    if (!interactive()) return;
    const selected: Target | null = value ? { statementId: value.statementId, origin: value.origin } : null;
    editFacts(); readSequence.current++; setTarget(selected); latest.current.target = selected; setLinePages([]); setMatchPages([]); setMovementPages([]); setSelectedLines(new Map()); setSelectedMovements(new Map()); setSelectionPage(0); setVoidReason(''); setShowVoid(false); setError(''); setSaved(false); setChanged(false);
  }
  function startImport(): void {
    if (locked || !interactive() || !currentContext || capacity || currentContext.statementCount >= MAX_US_BANK_RECORDS) return;
    chooseStatement(null); editFacts(); const account = currentContext.accounts.find(value => !currentContext.legacyPending.some(item => item.cashAccountId === value.accountId)) ?? currentContext.accounts[0];
    setDraft({ cashAccountId: account?.accountId ?? '', start: '', end: '', opening: '', closing: '', text: '' }); setFileName('');
    if (fileInput.current) fileInput.current.value = '';
  }
  function editDraft(field: keyof Omit<BankImportDraft, 'text'>, value: string): void {
    if (locked || !interactive() || !draft) return;
    editFacts(); setDraft({ ...draft, [field]: value }); setError(''); setSaved(false);
  }
  function cancelImport(): void {
    if (!interactive()) return;
    editFacts(); setDraft(null); setFileName(''); if (fileInput.current) fileInput.current.value = '';
  }
  async function readFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    if (locked || !draft || fileFlight.current || actionFlight.current) return;
    editFacts(); const token = editToken.current, epoch = lifetime.current, facts = factsEpoch.current, pair = session.getState().bank.head;
    setDraft({ ...draft, text: '' }); setFileName(''); setError('');
    if (!file) return;
    if (file.size > US_FINANCIAL_PILOT_BANK_IMPORT_MAX_BYTES) { setError('bank_csv_too_large'); event.currentTarget.value = ''; return; }
    fileFlight.current = true; setFileReading(true);
    try {
      const buffer = await file.arrayBuffer();
      if (!live(epoch) || facts !== factsEpoch.current || token !== editToken.current || !pairEqual(pair, session.getState().bank.head)) return;
      if (buffer.byteLength > US_FINANCIAL_PILOT_BANK_IMPORT_MAX_BYTES) { setError('bank_csv_too_large'); return; }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { setError('invalid_bank_statement'); return; }
      setDraft(previous => previous ? { ...previous, text } : null); setFileName(file.name);
    } catch (caught) { if (live(epoch) && token === editToken.current) showError(caught); }
    finally { if (live(epoch)) { fileFlight.current = false; setFileReading(false); if (facts !== factsEpoch.current) setTick(value => value + 1); } }
  }
  function openReview(value: BankReview, subject: UsFinancialPilotBankStatementDetail | null, stamp: Readonly<{ lifetime: number; facts: number; token: number }>): void {
    const now = session.getState();
    if (!live(stamp.lifetime) || factsEpoch.current !== stamp.facts || editToken.current !== stamp.token || now.bank.pendingReview !== value || now.pending || now.writing || now.requiresRefresh || now.bank.requiresRefresh) return;
    const command = value.request.command;
    const lines: readonly ReviewLine[] = command.type === 'create_statement'
      ? command.lines.map((row, index) => ({ ...row, ordinal: index + 1, key: String(index + 1) }))
      : command.type === 'approve_match' ? command.statementLineIds.map(id => freshLines.get(id)!).map(row => ({ ...row, key: row.lineId })) : [];
    const movements = command.type === 'approve_match' ? command.journalRevisions.map(revision => freshMovements.get(revision)!) : [];
    setReview({ value, token: editToken.current, statement: subject, lines, movements }); setReviewPage(0); setVisitedReviewPages(new Set([0])); setApprovedToken(null); setChanged(false); setError('');
  }
  function previewImport(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault(); if (locked || !interactive() || !draft || !currentContext || legacyBlocked || capacity) return;
    clearReview(); const stamp = { lifetime: lifetime.current, facts: factsEpoch.current, token: editToken.current };
    try { openReview(session.reviewBankImport(draft), null, stamp); } catch (caught) { if (live(stamp.lifetime)) showError(caught); }
  }
  function makeReview(type: 'approve_match' | 'complete' | 'void_statement'): void {
    if (locked || !interactive() || !detail || !mutable || !currentContext) return;
    clearReview(); const stamp = { lifetime: lifetime.current, facts: factsEpoch.current, token: editToken.current };
    try {
      const command: Exclude<UsFinancialPilotBankCommand, { type: 'create_statement' }> = type === 'approve_match'
        ? { type, statementId: detail.statement.statementId, statementLineIds: [...selectedLines.keys()], journalRevisions: [...selectedMovements.keys()] }
        : type === 'void_statement' ? { type, statementId: detail.statement.statementId, reason: voidReason } : { type, statementId: detail.statement.statementId };
      openReview(session.reviewBank(command, { statement: detail, linePages: type === 'approve_match' ? linePages.slice(1) : [], movementPages: type === 'approve_match' ? movementPages : [] }), detail, stamp);
    } catch (caught) { if (live(stamp.lifetime)) showError(caught); }
  }
  function toggleLine(row: UsFinancialPilotBankLine): void {
    if (locked || !interactive() || !mutable || row.matchId !== null) return;
    editFacts(); setSelectedLines(previous => { const next = new Map(previous); if (next.has(row.lineId)) next.delete(row.lineId); else next.set(row.lineId, row); return next; }); setSelectionPage(0); setError(''); setSaved(false);
  }
  function toggleMovement(row: UsFinancialPilotBankMovement): void {
    if (locked || !interactive() || !mutable || row.status !== 'available' || !detail || row.bankDate < detail.statement.start || row.bankDate > detail.statement.end) return;
    editFacts(); setSelectedMovements(previous => { const next = new Map(previous); if (next.has(row.journalRevision)) next.delete(row.journalRevision); else next.set(row.journalRevision, row); return next; }); setSelectionPage(0); setError(''); setSaved(false);
  }
  function removeSelection(kind: 'line' | 'movement', key: string | number): void {
    if (busy || readFlight.current || !interactive()) return;
    editFacts();
    if (kind === 'line') setSelectedLines(previous => { const next = new Map(previous); next.delete(String(key)); return next; });
    else setSelectedMovements(previous => { const next = new Map(previous); next.delete(Number(key)); return next; });
    setSelectionPage(0);
  }
  async function submit(): Promise<void> {
    const now = session.getState();
    if (!review || !approved || !reviewCurrent || locked || actionFlight.current || now.pending || now.writing || now.bank.pendingReview !== review.value || review.token !== editToken.current) return;
    const epoch = lifetime.current, sequence = ++actionSequence.current, edited = userEdit.current, submitted = review.value;
    actionFlight.current = true; setBusy(true); setError(''); setSaved(false);
    try {
      const receipt = await session.submitBank(submitted, true);
      if (!live(epoch) || sequence !== actionSequence.current || edited !== userEdit.current) return;
      finishWrite(receipt.statementId);
    } catch (caught) { if (live(epoch) && sequence === actionSequence.current) showError(caught); }
    finally { if (live(epoch) && sequence === actionSequence.current) { actionFlight.current = false; setBusy(false); setTick(value => value + 1); } }
  }
  function finishWrite(statementId: string): void {
    clearReview(); setDraft(null); setFileName(''); if (fileInput.current) fileInput.current.value = '';
    setSelectedLines(new Map()); setSelectedMovements(new Map()); setVoidReason(''); setShowVoid(false); setChanged(false); setSaved(true);
    latest.current.hasDraft = false;
    const next: Target = { statementId, origin: 'financial-v5' }; latest.current.target = next; setTarget(next); setTick(value => value + 1);
  }
  async function retry(): Promise<void> {
    const now = session.getState();
    if (actionFlight.current || now.writing || now.pendingKind !== 'bank') return;
    const epoch = lifetime.current, sequence = ++actionSequence.current, edited = userEdit.current;
    actionFlight.current = true; setBusy(true); setError('');
    try { const receipt = await session.retryBank(); if (live(epoch) && sequence === actionSequence.current && edited === userEdit.current) finishWrite(receipt.statementId); }
    catch (caught) { if (live(epoch) && sequence === actionSequence.current) showError(caught); }
    finally { if (live(epoch) && sequence === actionSequence.current) { actionFlight.current = false; setBusy(false); setTick(value => value + 1); } }
  }
  async function exportCsv(): Promise<void> {
    if (locked || !detail || actionFlight.current) return;
    const epoch = lifetime.current, facts = factsEpoch.current, token = editToken.current, sequence = ++actionSequence.current;
    actionFlight.current = true; setBusy(true); setExporting(true); setError('');
    try {
      const result = await session.exportBank(detail, language);
      if (live(epoch) && facts === factsEpoch.current && token === editToken.current && sequence === actionSequence.current && latest.current.active && targetEqual(target, latest.current.target)) session.downloadBank(result);
    } catch (caught) { if (live(epoch) && sequence === actionSequence.current) showError(caught); }
    finally { if (live(epoch) && sequence === actionSequence.current) { actionFlight.current = false; setBusy(false); setExporting(false); } }
  }
  function reloadWorkspace(): void {
    const now = session.getState();
    if (!reloadApproved || actionFlight.current || now.writing || now.pendingKind !== 'bank') return;
    window.location.reload();
  }

  const observeSession = useEffectEvent((source: BrowserUsFinancialPilotSession, before: BrowserUsFinancialPilotState, next: BrowserUsFinancialPilotState) => {
    if (latest.current.session !== source) return;
    if (next.status === 'denied' || next.status === 'stopped') { lifetime.current++; factsEpoch.current++; purge(); }
    else if (!pairEqual(before.bank.head, next.bank.head) || !before.writing && next.writing || !before.requiresRefresh && next.requiresRefresh || !before.bank.requiresRefresh && next.bank.requiresRefresh) {
      factsEpoch.current++; if (latest.current.hasDraft) setChanged(true); clearFacts();
    }
  });
  useEffect(() => {
    const guards = { lifetime, factsEpoch, readSequence, actionSequence };
    const invalidate = () => { guards.lifetime.current++; guards.factsEpoch.current++; guards.readSequence.current++; guards.actionSequence.current++; };
    invalidate(); const epoch = guards.lifetime.current;
    // Block callbacks immediately; the queued RAM reset belongs only to this subscription.
    actionFlight.current = fileFlight.current = readFlight.current = true;
    queueMicrotask(() => { if (guards.lifetime.current === epoch) { purge(); setTick(value => value + 1); } });
    let before = session.getState();
    const unsubscribe = session.subscribe(() => {
      const next = session.getState(); observeSession(session, before, next); before = next;
    });
    return () => { invalidate(); unsubscribe(); };
  }, [session, organizationId]);

  useEffect(() => {
    try { session.setBankActive(active); } catch { /* The common lifecycle may already have stopped the session. */ }
    return () => { try { session.setBankActive(false); } catch { /* Terminal purge owns the session. */ } };
  }, [session, active]);

  useEffect(() => {
    if (!active || !fresh || state.pending || state.writing) return;
    void loadCurrent();
  }, [session, active, organizationId, head?.revision, head?.bankRevision, fresh, state.pending, state.writing, target?.statementId, target?.origin, tick]);

  function numberedPages(count: number, current: number, select: (page: number) => void, label: string) {
    if (count <= 1) return null;
    return <nav className="fpb-page-numbers" aria-label={label}>{Array.from({ length: count }, (_, index) => <button className="fp-link" key={index} type="button" disabled={busy || state.writing} aria-current={index === current ? 'page' : undefined} aria-label={`${label} ${index + 1}`} onClick={() => select(index)}>{index + 1}</button>)}</nav>;
  }
  function statementFacts(value: UsFinancialPilotBankStatementSummary) {
    return <dl className="fp-report-facts">
      <div><dt>{c.labels.account}</dt><dd>{currentContext?.accounts.find(account => account.accountId === value.cashAccountId)?.name ?? value.cashAccountId}</dd></div>
      <div><dt>{c.labels.start}</dt><dd>{date(value.start)}</dd></div><div><dt>{c.labels.end}</dt><dd>{date(value.end)}</dd></div>
      <div><dt>{c.labels.opening}</dt><dd>{usd(value.openingMinor)}</dd></div><div><dt>{c.labels.closing}</dt><dd>{usd(value.closingMinor)}</dd></div>
      <div><dt>{c.csv.origin}</dt><dd>{c.origin[value.origin]}</dd></div><div><dt>{c.csv.status}</dt><dd>{c.state[value.state]}</dd></div>
    </dl>;
  }
  function evaluation(value: UsFinancialPilotBankStatementDetail) {
    return <div className="fpb-comparisons">
      {value.statement.completion && <section><h3>{c.labels.recordedCompletion}</h3><p className="fpb-note">{c.notices.completionRecorded}</p><dl className="fp-report-facts">
        <div><dt>{c.csv.completedBy}</dt><dd>{value.statement.completion.completedBy}</dd></div><div><dt>{c.csv.completedAt}</dt><dd>{instant(value.statement.completion.completedAt)}</dd></div>
        <div><dt>{c.csv.completedLedgerRevision}</dt><dd>{value.statement.completion.ledgerRevision}</dd></div>
        {value.statement.completion.source && <div><dt>{c.csv.completedSourceRevision}</dt><dd>{value.statement.completion.source.revision}</dd></div>}
      </dl></section>}
      <section><h3>{c.labels.currentEvaluation}</h3>{value.current ? <><p className="fpb-note">{value.current.ready ? c.labels.ready : c.labels.notReady}</p><dl className="fp-report-facts">
        <div><dt>{c.labels.outstandingLines}</dt><dd>{value.current.outstandingLineCount}</dd></div><div><dt>{c.labels.unmatchedMovements}</dt><dd>{value.current.unmatchedMovementCount}</dd></div>
        <div><dt>{c.labels.beginningDifference}</dt><dd>{usd(value.current.beginningDifferenceMinor)}</dd></div><div><dt>{c.labels.endingDifference}</dt><dd>{usd(value.current.endingDifferenceMinor)}</dd></div>
      </dl>{value.cashChangedSinceCompletion !== null && <p className="fpb-note">{value.cashChangedSinceCompletion ? c.notices.cashChanged : c.notices.cashUnchanged}</p>}</> : <p className="fpb-note">{c.notices.legacyCurrentUnavailable}</p>}</section>
    </div>;
  }
  function source(row: UsFinancialPilotBankMovement) {
    return <div className="fpb-source"><span>{c.sourceKind[row.source.kind]}</span>{row.source.reference && <span className="fpb-verbatim">{row.source.reference}</span>}<span>{c.csv.journalRevision}: {row.journalRevision}</span>
      {row.source.kind === 'manual_reversal' && row.source.journalRevision !== null && <span>{c.csv.originalJournalRevision}: {row.source.journalRevision}</span>}
      <span>{c.csv.transactionDate}: {date(row.transactionDate)} · {c.csv.accountingDate}: {date(row.accountingDate)}</span>{row.paymentDate && <span>{c.csv.paymentDate}: {date(row.paymentDate)}</span>}</div>;
  }
  function reviewLines(rows: readonly ReviewLine[]) {
    return <div className="fp-table-scroll"><table><caption>{c.labels.lines} · {rows.length}</caption><thead><tr><th scope="col">{c.csv.ordinal}</th><th scope="col">{c.labels.date}</th><th scope="col">{c.labels.reference}</th><th scope="col">{c.labels.amount}</th></tr></thead><tbody>{rows.slice(reviewPage * PAGE_SIZE, (reviewPage + 1) * PAGE_SIZE).map(row => <tr key={row.key}><th scope="row">{row.ordinal}</th><td>{date(row.date)}</td><td className="fpb-verbatim">{row.reference}</td><td>{usd(row.amountMinor)}</td></tr>)}</tbody></table></div>;
  }
  function matchHistory(row: UsFinancialPilotBankMatch) {
    return <li key={row.matchId}><div><strong>{usd(row.amountMinor)}</strong><span>{c.csv.approvedBy}: {row.approvedBy} · {instant(row.approvedAt)}</span>
      <details><summary>{c.csv.matchId}: {row.matchId}</summary><p>{c.csv.matchLines}</p><ul className="fpb-relations">{row.statementLineIds.map(id => <li key={id}>{id}</li>)}</ul><p>{c.csv.matchJournals}</p><ul className="fpb-relations">{row.journalRevisions.map(revision => <li key={revision}>{c.csv.journalRevision}: {revision}</li>)}</ul>{row.sourceRevision !== null && <p>{c.csv.sourceRevision}: {row.sourceRevision}</p>}</details>
    </div></li>;
  }

  if (state.status === 'denied' || state.status === 'stopped') return <section className="fpb-workspace" hidden={!active}><p className="fpb-note" aria-live="polite">{c.notices.denied}</p></section>;
  return <div className="fpb-workspace" hidden={!active}>
    <p className="fpb-note">{c.notices.test}</p>
    {bankPending ? <section className="fp-notice fpb-pending" aria-live="polite"><h2>{c.labels.review}</h2><p>{c.notices.pending}</p>
      {state.bank.pendingReview?.request.command.type === 'create_statement' && <dl className="fp-report-facts"><div><dt>{c.labels.start}</dt><dd>{date(state.bank.pendingReview.request.command.start)}</dd></div><div><dt>{c.labels.end}</dt><dd>{date(state.bank.pendingReview.request.command.end)}</dd></div><div><dt>{c.labels.closing}</dt><dd>{usd(state.bank.pendingReview.request.command.closingMinor)}</dd></div></dl>}
      <div className="fp-actions"><button className="account-button fp-primary" type="button" disabled={busy || state.writing} onClick={() => void retry()}><RefreshCw size={17} aria-hidden/>{state.writing ? c.labels.saving : c.labels.retry}</button></div>
      <div className="fpb-reload"><p>{c.notices.reloadRamLoss}</p><label className="fpb-check"><input type="checkbox" checked={reloadApproved} disabled={busy || state.writing} onChange={event => setReloadApproved(event.target.checked)}/><span>{c.labels.approval}</span></label><button className="account-button secondary" type="button" disabled={!reloadApproved || busy || state.writing} onClick={reloadWorkspace}>{c.labels.reloadSpace}</button></div>
    </section> : null}
    {error || state.bank.error ? <div className="fp-notice" role="alert"><p>{browserUsFinancialPilotBankErrorCopy(language, error || state.bank.error?.code || '')}</p>{!state.pending && <button className="account-button secondary" type="button" disabled={busy || fileReading || state.writing || state.bank.refreshing} onClick={() => void refresh()}>{c.labels.refresh}</button>}</div> : null}
    {saved && <p className="fp-success" aria-live="polite"><Check size={18} aria-hidden/>{c.notices.saved}</p>}
    {changed && !bankPending && <p className="fpb-note" aria-live="polite">{c.notices.changed}</p>}
    {state.bank.requiresRefresh && !bankPending && !state.bank.error && <div className="fp-notice"><p>{c.notices.unavailable}</p><button className="account-button secondary" type="button" disabled={busy || state.pending || state.writing || state.bank.refreshing} onClick={() => void refresh()}>{state.bank.refreshing ? c.labels.loading : c.labels.refresh}</button></div>}
    {!bankPending && review ? <section className="fpb-review">
      <button className="fp-back" type="button" disabled={busy || fileReading || reading || state.pending || state.writing} onClick={clearReview}><ArrowLeft size={18} aria-hidden/>{c.labels.edit}</button><h2>{c.labels.review}</h2><p className="fpb-note">{c.notices.reviewCheck}</p>
      {review.value.request.command.type === 'create_statement' ? <><p className="fpb-note">{c.notices.csvNotArchived}</p><dl className="fp-report-facts"><div><dt>{c.labels.account}</dt><dd>{currentContext?.accounts.find(account => account.accountId === (review.value.request.command as Extract<UsFinancialPilotBankCommand, { type: 'create_statement' }>).cashAccountId)?.name ?? review.value.request.command.cashAccountId}</dd></div><div><dt>{c.labels.start}</dt><dd>{date(review.value.request.command.start)}</dd></div><div><dt>{c.labels.end}</dt><dd>{date(review.value.request.command.end)}</dd></div><div><dt>{c.labels.opening}</dt><dd>{usd(review.value.request.command.openingMinor)}</dd></div><div><dt>{c.labels.closing}</dt><dd>{usd(review.value.request.command.closingMinor)}</dd></div></dl></> : review.statement && statementFacts(review.statement.statement)}
      {!!review.lines.length && reviewLines(review.lines)}
      {!!review.movements.length && <section className="fpb-review-movements"><h3>{c.labels.movements} · {review.movements.length}</h3><ul className="fpb-movement-list">{review.movements.slice(reviewPage * PAGE_SIZE, (reviewPage + 1) * PAGE_SIZE).map(row => <li key={row.journalRevision}><div><strong>{row.description}</strong><span>{date(row.bankDate)}</span>{source(row)}</div><strong className="fpb-amount">{usd(row.amountMinor)}</strong></li>)}</ul></section>}
      {numberedPages(reviewPages, reviewPage, index => { setReviewPage(index); setVisitedReviewPages(previous => new Set([...previous, index])); setApprovedToken(null); }, c.labels.review)}
      {review.value.importTotals && <dl className="fpb-totals"><div><dt>{c.labels.lines}</dt><dd>{review.value.importTotals.lineCount}</dd></div><div><dt>{c.labels.amount}</dt><dd>{usd(review.value.importTotals.statementNetMinor)}</dd></div><div><dt>{c.labels.closing}</dt><dd>{usd(review.value.importTotals.closingMinor)}</dd></div></dl>}
      {review.value.matchTotals && <dl className="fpb-totals"><div><dt>{c.labels.statementTotal}</dt><dd>{usd(review.value.matchTotals.statementMinor)}</dd></div><div><dt>{c.labels.movementTotal}</dt><dd>{usd(review.value.matchTotals.movementMinor)}</dd></div><div><dt>{c.labels.difference}</dt><dd>{usd(review.value.matchTotals.differenceMinor)}</dd></div></dl>}
      {review.value.request.command.type === 'complete' && review.statement && evaluation(review.statement)}
      {review.value.request.command.type === 'void_statement' && <dl className="fp-report-facts"><div><dt>{c.labels.voidReason}</dt><dd className="fpb-verbatim">{review.value.request.command.reason}</dd></div></dl>}
      {!allReviewPagesVisited && <p className="fpb-note">{c.labels.lines} · {visitedReviewPages.size}/{reviewPages} · {c.labels.review}</p>}
      {!reviewCurrent && <p className="fpb-note" aria-live="polite">{c.notices.changed}</p>}
      <label className="fpb-check"><input type="checkbox" checked={approved} disabled={locked || !reviewCurrent || !allReviewPagesVisited} onChange={event => setApprovedToken(event.target.checked ? review.token : null)}/><span>{c.labels.approval}</span></label>
      <div className="fp-actions"><button className="account-button fp-primary" type="button" disabled={locked || !approved} onClick={() => void submit()}>{state.writing ? c.labels.saving : c.labels.confirm}</button><button className="account-button secondary" type="button" disabled={busy || fileReading || reading || state.pending || state.writing} onClick={clearReview}>{c.labels.edit}</button></div>
    </section> : !bankPending && draft ? <section className="fpb-import"><button className="fp-back" type="button" disabled={busy || fileReading || reading || state.pending || state.writing} onClick={cancelImport}><ArrowLeft size={18} aria-hidden/>{c.labels.back}</button><h2>{c.labels.newStatement}</h2><p className="fpb-note">{c.notices.manualOnly}</p><p className="fpb-note">{c.notices.csvFormat}</p>
      <form className="fp-payment" onSubmit={previewImport}><fieldset className="fpb-fields" disabled={locked}><div className="fp-form-grid"><label className="fpb-wide">{c.labels.account}<select required value={draft.cashAccountId} onChange={event => editDraft('cashAccountId', event.target.value)}><option value="">{c.labels.account}</option>{currentContext?.accounts.map(account => <option key={account.accountId} value={account.accountId}>{account.code} · {account.name}</option>)}</select></label><label>{c.labels.start}<input type="date" required value={draft.start} onChange={event => editDraft('start', event.target.value)}/></label><label>{c.labels.end}<input type="date" required value={draft.end} onChange={event => editDraft('end', event.target.value)}/></label><label>{c.labels.opening}<input type="text" inputMode="decimal" required maxLength={40} value={draft.opening} onChange={event => editDraft('opening', event.target.value)}/></label><label>{c.labels.closing}<input type="text" inputMode="decimal" required maxLength={40} value={draft.closing} onChange={event => editDraft('closing', event.target.value)}/></label><label className="fpb-wide">{c.labels.file}<input ref={fileInput} type="file" accept=".csv,text/csv" onChange={event => void readFile(event)}/><span className="fpb-file-note">{fileReading ? c.labels.loading : fileName} · {US_FINANCIAL_PILOT_BANK_IMPORT_MAX_BYTES / 1024} KiB · UTF-8</span></label></div>
      <p className="fpb-note">{c.notices.csvNotArchived}</p>{legacyBlocked && <p className="fpb-note" aria-live="polite">{c.notices.legacyPending}</p>}<div className="fp-actions"><button className="account-button fp-primary" type="submit" disabled={locked || !draft.text || !currentContext || legacyBlocked || capacity}>{c.labels.preview}</button><button className="account-button secondary" type="button" onClick={cancelImport}>{c.labels.cancel}</button></div></fieldset></form>
    </section> : !bankPending && target ? <section className="fp-detail"><button className="fp-back" type="button" disabled={busy || fileReading || reading || state.pending || state.writing} onClick={() => chooseStatement(null)}><ArrowLeft size={18} aria-hidden/>{c.labels.back}</button>{detail ? <>
      <div className="fp-detail-heading"><h2>{date(detail.statement.start)} – {date(detail.statement.end)}</h2><span className="fpb-state">{c.state[detail.statement.state]}</span></div>{statementFacts(detail.statement)}
      {detail.statement.origin === 'legacy-frozen' && <p className="fpb-note">{c.notices.legacyFrozen}</p>}{legacyBlocked && detail.statement.origin === 'financial-v5' && <p className="fpb-note">{c.notices.legacyPending}</p>}
      {evaluation(detail)}
      <div className="fpb-export"><button className="account-button secondary" type="button" disabled={locked} onClick={() => void exportCsv()}><Download size={17} aria-hidden/>{exporting ? c.labels.exporting : c.labels.exportCsv}</button><p className="fpb-note">{c.notices.exportComplete}</p></div>
      <section className="fpb-lines"><h3>{c.labels.lines} · {detail.statement.lineCount}</h3><ul className="fpb-line-list">{linePages[linePage]?.lines.items.map(row => <li key={row.lineId}><div className="fpb-row-main">{mutable ? <label className="fpb-row-check" aria-label={`${c.labels.lines} · ${row.ordinal} · ${row.reference}`}><input type="checkbox" checked={selectedLines.has(row.lineId)} disabled={locked || row.matchId !== null} onChange={() => toggleLine(row)}/><span><strong>{row.ordinal} · {row.reference}</strong><small>{date(row.date)}{row.matchId !== null && <> · {c.csv.matchId}: {row.matchId}</>}</small></span></label> : <div><strong>{row.ordinal} · {row.reference}</strong><small>{date(row.date)}{row.matchId !== null && <> · {c.csv.matchId}: {row.matchId}</>}</small></div>}</div><strong className="fpb-amount">{usd(row.amountMinor)}</strong></li>)}</ul>
        {numberedPages(linePages.length, linePage, setLinePage, c.labels.lines)}{linePages.at(-1)?.lines.nextCursor && <button className="account-button secondary" type="button" disabled={locked || linePages.length >= US_FINANCIAL_PILOT_BANK_EVIDENCE_MAX_PAGES} onClick={() => void nextPage('lines', linePages.at(-1)!.lines.nextCursor!)}>{c.labels.more} · {c.labels.lines}</button>}
      </section>
      {detail.statement.origin === 'financial-v5' && <section className="fpb-movements"><h3>{c.labels.movements} · {movementPages[0]?.total ?? 0}</h3><ul className="fpb-movement-list">{movementPages[movementPage]?.items.map(row => <li key={row.journalRevision}><div className="fpb-row-main">{mutable ? <label className="fpb-row-check" aria-label={`${c.labels.movements} · ${row.description}`}><input type="checkbox" checked={selectedMovements.has(row.journalRevision)} disabled={locked || row.status !== 'available' || row.bankDate < detail.statement.start || row.bankDate > detail.statement.end} onChange={() => toggleMovement(row)}/><span><strong>{row.description}</strong><small>{date(row.bankDate)} · {c.movementStatus[row.status]}</small></span></label> : <div><strong>{row.description}</strong><small>{date(row.bankDate)} · {c.movementStatus[row.status]}</small></div>}{source(row)}</div><strong className="fpb-amount">{usd(row.amountMinor)}</strong></li>)}</ul>
        {numberedPages(movementPages.length, movementPage, setMovementPage, c.labels.movements)}{movementPages.at(-1)?.nextCursor && <button className="account-button secondary" type="button" disabled={locked || movementPages.length >= US_FINANCIAL_PILOT_BANK_EVIDENCE_MAX_PAGES} onClick={() => void nextPage('movements', movementPages.at(-1)!.nextCursor!)}>{c.labels.more} · {c.labels.movements}</button>}
      </section>}
      {(selectedLines.size > 0 || selectedMovements.size > 0) && <section className="fpb-selection"><h3>{c.labels.selected} · {selectedLines.size} / {selectedMovements.size}</h3><p className="fpb-note">{c.notices.selectionOffPage}</p><dl className="fpb-totals"><div><dt>{c.labels.statementTotal}</dt><dd>{usd(statementTotal)}</dd></div><div><dt>{c.labels.movementTotal}</dt><dd>{usd(movementTotal)}</dd></div><div><dt>{c.labels.difference}</dt><dd>{usd(difference)}</dd></div></dl>
        <ul className="fpb-selected-list">{selectedLineRows.slice(selectionPage * PAGE_SIZE, (selectionPage + 1) * PAGE_SIZE).map(row => <li key={row.lineId}><div><span>{c.labels.lines} · {row.ordinal}</span><strong>{row.reference}</strong><small>{usd(row.amountMinor)}</small></div><button className="fpb-remove" type="button" aria-label={`${c.labels.cancel} · ${row.reference}`} disabled={busy || fileReading || reading || state.pending || state.writing} onClick={() => removeSelection('line', row.lineId)}><X size={18} aria-hidden/></button></li>)}{selectedMovementRows.slice(selectionPage * PAGE_SIZE, (selectionPage + 1) * PAGE_SIZE).map(row => <li key={row.journalRevision}><div><span>{c.labels.movements} · {row.journalRevision}</span><strong>{row.description}</strong><small>{usd(row.amountMinor)}</small></div><button className="fpb-remove" type="button" aria-label={`${c.labels.cancel} · ${row.description}`} disabled={busy || fileReading || reading || state.pending || state.writing} onClick={() => removeSelection('movement', row.journalRevision)}><X size={18} aria-hidden/></button></li>)}</ul>
        {numberedPages(Math.max(1, Math.ceil(Math.max(selectedLines.size, selectedMovements.size) / PAGE_SIZE)), selectionPage, setSelectionPage, c.labels.selected)}{!selectedFactsReady && <p className="fpb-note">{c.errors.evidence}</p>}<div className="fp-actions"><button className="account-button fp-primary" type="button" disabled={locked || !mutable || !selectedFactsReady || difference !== '0'} onClick={() => makeReview('approve_match')}>{c.labels.approveMatch}</button></div>
      </section>}
      <section className="fp-history fpb-matches"><h3>{c.csv.matches} · {detail.statement.matchCount}</h3><ul>{matchPages[matchPage]?.matches.items.map(matchHistory)}</ul>{numberedPages(matchPages.length, matchPage, setMatchPage, c.csv.matches)}{matchPages.at(-1)?.matches.nextCursor && <button className="account-button secondary" type="button" disabled={locked || matchPages.length >= US_FINANCIAL_PILOT_BANK_EVIDENCE_MAX_PAGES} onClick={() => void nextPage('matches', matchPages.at(-1)!.matches.nextCursor!)}>{c.labels.more} · {c.csv.matches}</button>}</section>
      {mutable && <div className="fp-actions"><button className="account-button fp-primary" type="button" disabled={locked || !detail.current?.ready} onClick={() => makeReview('complete')}>{c.labels.complete}</button>{detail.statement.matchCount === 0 && <button className="account-button secondary" type="button" disabled={locked} onClick={() => { if (interactive()) { editFacts(); setShowVoid(value => !value); } }}>{c.labels.voidStatement}</button>}</div>}
      {showVoid && mutable && detail.statement.matchCount === 0 && <form className="fp-payment fpb-void" onSubmit={event => { event.preventDefault(); makeReview('void_statement'); }}><fieldset className="fpb-fields" disabled={locked}><label>{c.labels.voidReason}<input type="text" value={voidReason} required maxLength={2000} onChange={event => { if (interactive()) { editFacts(); setVoidReason(event.target.value); } }}/></label><div className="fp-actions"><button className="account-button secondary" type="submit" disabled={locked || !voidReason.trim()}>{c.labels.review}</button></div></fieldset></form>}
      {detail.statement.voided && <dl className="fp-report-facts fpb-audit"><div><dt>{c.csv.voidedBy}</dt><dd>{detail.statement.voided.by}</dd></div><div><dt>{c.csv.voidedAt}</dt><dd>{instant(detail.statement.voided.at)}</dd></div><div><dt>{c.labels.voidReason}</dt><dd className="fpb-verbatim">{detail.statement.voided.reason}</dd></div></dl>}
      <details className="fpb-audit"><summary>{c.labels.history}</summary><dl className="fp-report-facts"><div><dt>{c.csv.statementId}</dt><dd>{detail.statement.statementId}</dd></div><div><dt>{c.csv.createdBy}</dt><dd>{detail.statement.createdBy}</dd></div><div><dt>{c.csv.createdAt}</dt><dd>{instant(detail.statement.createdAt)}</dd></div><div><dt>{c.csv.financialRevision}</dt><dd>{detail.revision}</dd></div><div><dt>{c.csv.bankRevision}</dt><dd>{detail.bankRevision}</dd></div><div><dt>{c.csv.statementRevision}</dt><dd>{detail.statement.statementRevision}</dd></div><div><dt>{c.csv.ledgerRevision}</dt><dd>{detail.ledgerRevision}</dd></div></dl></details>
    </> : <p className="fp-empty" aria-live="polite">{c.labels.loading}</p>}</section> : !bankPending && <section className="fp-register"><div className="fp-register-title"><h2>{c.labels.history}</h2><span>{currentStatements?.total ?? currentContext?.statementCount ?? '—'}</span></div><div className="fp-actions"><button className="account-button fp-primary" type="button" disabled={locked || !currentContext || currentContext.statementCount >= MAX_US_BANK_RECORDS || capacity} onClick={startImport}>{c.labels.newStatement}</button><button className="account-button secondary" type="button" disabled={busy || fileReading || reading || state.pending || state.writing || state.bank.refreshing} onClick={() => void refresh()}>{state.bank.refreshing ? c.labels.loading : c.labels.refresh}</button></div>
      {capacity || (currentContext?.statementCount ?? 0) >= MAX_US_BANK_RECORDS ? <p className="fpb-note">{c.errors.capacity}</p> : null}{currentContext?.legacyPending.length ? <div>{[...new Set(currentContext.legacyPending.map(item => item.cashAccountId))].map(accountId => <p className="fpb-note" key={accountId}>{currentContext.accounts.find(account => account.accountId === accountId)?.name ?? accountId}: {c.notices.legacyPending}</p>)}</div> : null}
      {!currentStatements ? <p className="fp-empty" aria-live="polite">{c.labels.loading}</p> : currentStatements.items.length ? <ul className="fp-records">{currentStatements.items.map(row => <li key={`${row.origin}:${row.statementId}`}><button className="fp-invoice-row" type="button" disabled={busy || fileReading || reading || state.pending || state.writing} onClick={() => chooseStatement(row)}><div><strong>{date(row.start)} – {date(row.end)}</strong><span>{currentContext?.accounts.find(account => account.accountId === row.cashAccountId)?.name ?? row.cashAccountId}</span><small>{c.state[row.state]} · {c.origin[row.origin]}</small></div><div className="fp-row-amount"><strong>{usd(row.closingMinor)}</strong><span>{c.labels.closing}</span></div><ChevronRight size={18} aria-hidden/></button></li>)}</ul> : <p className="fp-empty">{c.labels.empty}</p>}
      <div className="fp-pagination">{statementCursor && <button className="fp-link" type="button" disabled={locked} onClick={() => setTick(value => value + 1)}>{c.labels.first}</button>}{currentStatements?.nextCursor && <button className="account-button secondary" type="button" disabled={locked} onClick={() => void nextPage('statements', currentStatements.nextCursor!)}>{c.labels.more}</button>}</div>
    </section>}
  </div>;
}
