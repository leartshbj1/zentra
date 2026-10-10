'use client';
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AccountRole } from '@/lib/account-security';
import type { SiteLanguage } from '@/lib/site-language';
import { US_SUPPLIER_DOCUMENT_MAX_BYTES, type UsSupplierDocument, type UsSupplierDocumentMedia } from '@/lib/international/us-supplier-document-contract';
import { BrowserUsSupplierDocumentError, createBrowserUsSupplierDocumentsSession, type BrowserUsSupplierDocumentResult, type BrowserUsSupplierDocumentsSession } from '@/lib/international/browser-us-supplier-documents-session';
import { browserUsSupplierDocumentsCopy, browserUsSupplierDocumentError } from '@/lib/international/browser-us-supplier-documents-copy';
import './us-supplier-documents.css';

export interface UsSupplierDocumentsBinding {
  expectedUserId: string; accessEpoch: () => number; otherBusy: () => boolean; otherPending: () => boolean;
  onBusy: (value: boolean) => void; onPending: (value: boolean) => void; onCommitted: () => void; onInvalidated: () => void;
  registerInvalidation?: (invalidate: (() => void) | null) => void;
}
export interface UsSupplierDocumentsProps {
  organizationId: string; role: AccountRole; language: SiteLanguage; supportedSchemaVersion: number; disabled?: boolean; analysisAvailable?: boolean; proposalReviewId?: string; refreshToken?: number; binding: UsSupplierDocumentsBinding;
}
export function UsSupplierDocuments({ organizationId, role, language, supportedSchemaVersion, disabled = false, analysisAvailable = false, proposalReviewId, refreshToken = 0, binding }: UsSupplierDocumentsProps) {
  const c = browserUsSupplierDocumentsCopy[language], prefix = useId(), identity = `${organizationId}:${binding.expectedUserId}:${role}:${supportedSchemaVersion}:${binding.accessEpoch()}`;
  const refs = useRef({ binding, identity, disabled }), generation = useRef(0), transport = useRef<BrowserUsSupplierDocumentsSession | null>(null), busyRef = useRef(false), loadingRef = useRef(false), fileInput = useRef<HTMLInputElement>(null), urls = useRef(new Set<string>());
  const [ownedIdentity, setOwnedIdentity] = useState(identity), [documents, setDocuments] = useState<readonly UsSupplierDocument[]>([]), [file, setFile] = useState<File | null>(null), [selected, setSelected] = useState<UsSupplierDocument | null>(null), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [page, setPage] = useState(0);
  const enabled = supportedSchemaVersion === 4 && ['owner', 'admin', 'accountant'].includes(role) && binding.accessEpoch() === 0, owned = ownedIdentity === identity && enabled;
  const blocked = disabled || !owned || busy || pending || loading || binding.otherBusy() || binding.otherPending();
  const updateRefs = useEffectEvent(() => { refs.current = { binding, identity, disabled }; }); useLayoutEffect(() => { updateRefs(); });
  const currentIdentity = () => `${organizationId}:${refs.current.binding.expectedUserId}:${role}:${supportedSchemaVersion}:${refs.current.binding.accessEpoch()}`;
  const current = (started: number, actor: string) => generation.current === started && currentIdentity() === actor;
  function clear() { setDocuments([]); setFile(null); setSelected(null); setConsent(false); setNotice(''); if (fileInput.current) fileInput.current.value = ''; for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); }
  function invalidate() { generation.current++; transport.current?.dispose(); transport.current = null; busyRef.current = false; loadingRef.current = false; clear(); setBusy(false); setLoading(false); setPending(false); refs.current.binding.onBusy(false); refs.current.binding.onPending(false); }
  function failure(reason: unknown) { if (reason instanceof BrowserUsSupplierDocumentError && reason.outcome === 'unauthorized') { invalidate(); refs.current.binding.onInvalidated(); } setError(browserUsSupplierDocumentError(language, reason instanceof BrowserUsSupplierDocumentError ? reason.code : 'service_unavailable')); }
  async function load() {
    const session = transport.current, started = generation.current, actor = currentIdentity(); if (!session || loadingRef.current) return;
    loadingRef.current = true; setLoading(true);
    try { const result = await session.load(); if (current(started, actor)) { setDocuments(result); setError(''); } }
    catch (reason) { if (current(started, actor)) failure(reason); }
    finally { if (current(started, actor)) { loadingRef.current = false; setLoading(false); } }
  }
  const mount = useEffectEvent(() => { setOwnedIdentity(identity); clear(); setError(''); setPending(false); setBusy(false); setPage(0); if (enabled) { transport.current = createBrowserUsSupplierDocumentsSession({ organizationId, expectedUserId: binding.expectedUserId, role, supportedSchemaVersion }); void load(); } });
  const release = useEffectEvent(() => { generation.current++; transport.current?.dispose(); transport.current = null; busyRef.current = false; loadingRef.current = false; for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); binding.onBusy(false); binding.onPending(false); });
  useEffect(() => { const started = ++generation.current; queueMicrotask(() => { if (generation.current === started) mount(); }); return () => release(); }, [identity, enabled]);
  const invalidateForEffect = useEffectEvent(() => { invalidate(); });
  const registerInvalidation = binding.registerInvalidation;
  useEffect(() => { registerInvalidation?.(() => invalidateForEffect()); return () => registerInvalidation?.(null); }, [registerInvalidation]);
  const seenRefresh = useRef(refreshToken);
  const refreshOriginals = useEffectEvent(() => { if (!busyRef.current && !loadingRef.current && !transport.current?.hasPending() && !refs.current.disabled && !refs.current.binding.otherBusy() && !refs.current.binding.otherPending()) { seenRefresh.current = refreshToken; void load(); } });
  useEffect(() => { if (refreshToken !== seenRefresh.current && enabled && owned && !disabled && !busy && !loading && !pending) refreshOriginals(); }, [refreshToken, enabled, owned, disabled, busy, loading, pending]);
  async function operate(task: (session: BrowserUsSupplierDocumentsSession) => Promise<BrowserUsSupplierDocumentResult>) {
    const session = transport.current, started = generation.current, actor = currentIdentity(), callbacks = refs.current.binding;
    if (!session || refs.current.disabled || busyRef.current || loadingRef.current || callbacks.otherBusy() || callbacks.otherPending()) return;
    busyRef.current = true; setBusy(true); callbacks.onBusy(true); setError(''); setNotice(''); let committed = false;
    try { const result = await task(session); if (!current(started, actor)) return; setDocuments(previous => [result.document, ...previous.filter(value => value.id !== result.document.id)]); setPage(0); setSelected(null); setConsent(false); if (result.action === 'import') { setFile(null); if (fileInput.current) fileInput.current.value = ''; setNotice(c.saved); } else { setNotice(c.prepared); committed = true; } await load(); }
    catch (reason) { if (current(started, actor)) failure(reason); }
    finally { if (current(started, actor)) { const unresolved = session.hasPending(); setPending(unresolved); callbacks.onPending(unresolved); busyRef.current = false; setBusy(false); callbacks.onBusy(false); if (committed) callbacks.onCommitted(); } }
  }
  async function download(document: UsSupplierDocument) {
    const session = transport.current, started = generation.current, actor = currentIdentity(), callbacks = refs.current.binding;
    if (!session || blocked || busyRef.current || callbacks.otherBusy() || callbacks.otherPending()) return;
    busyRef.current = true; setBusy(true); callbacks.onBusy(true); setError('');
    try { const blob = await session.download(document); if (!current(started, actor)) return; const url = URL.createObjectURL(blob); urls.current.add(url); const link = window.document.createElement('a'); link.href = url; link.download = document.fileName; link.rel = 'noreferrer'; link.click(); setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 0); }
    catch (reason) { if (current(started, actor)) failure(reason); }
    finally { if (current(started, actor)) { busyRef.current = false; setBusy(false); callbacks.onBusy(false); } }
  }
  if (!owned) return null;
  const totalPages = Math.max(1, Math.ceil(documents.length / 10)), visiblePage = Math.min(page, totalPages - 1), visible = documents.slice(visiblePage * 10, visiblePage * 10 + 10);
  return <section className="us-supplier-documents" aria-label={c.title}>
    <header className="us-supplier-documents-header"><div><h3>{c.title}</h3><p>{c.help}</p></div><button type="button" className="account-button secondary" disabled={blocked} onClick={() => void load()}>{c.reload}</button></header>
    <p className="us-supplier-documents-muted">{c.private}</p>
    <form className="us-supplier-documents-import" onSubmit={event => { event.preventDefault(); if (!file || blocked) return; const selectedFile = file; void operate(async session => session.import({ fileName: selectedFile.name, mediaType: selectedFile.type as UsSupplierDocumentMedia, bytes: await selectedFile.arrayBuffer() })); }}>
      <label htmlFor={`${prefix}-file`}>{c.file}<input ref={fileInput} id={`${prefix}-file`} type="file" accept="application/pdf,image/png,image/jpeg,text/plain" disabled={blocked} aria-describedby={`${prefix}-formats`} onChange={event => { const value = event.target.files?.[0] ?? null; setError(''); if (value && (!['application/pdf', 'image/png', 'image/jpeg', 'text/plain'].includes(value.type) || !value.size || value.size > US_SUPPLIER_DOCUMENT_MAX_BYTES)) { setFile(null); event.target.value = ''; setError(c.invalid); } else setFile(value); }} /></label>
      <small id={`${prefix}-formats`} className="us-supplier-documents-muted">{c.formats}</small><button type="submit" className="account-button" disabled={blocked || !file}>{busy ? c.busy : c.import}</button>
    </form>
    {loading && <output className="us-supplier-documents-feedback">{c.loading}</output>}{error && <p role="alert" className="us-supplier-documents-feedback">{error}</p>}{notice && <output className="us-supplier-documents-feedback">{notice}</output>}
    {pending && <aside className="us-supplier-documents-pending"><p>{c.pending}</p><p className="us-supplier-documents-muted">{c.memory}</p><button type="button" className="account-button" disabled={disabled || busy || binding.otherBusy() || binding.otherPending()} onClick={() => void operate(session => session.retry())}>{busy ? c.busy : c.retry}</button></aside>}
    {!analysisAvailable && <p className="us-supplier-documents-muted">{c.analysisUnavailable}</p>}
    {selected && <form className="us-supplier-documents-consent" onSubmit={event => { event.preventDefault(); if (!blocked && consent && analysisAvailable) void operate(session => session.analyze(selected, true)); }}><h4>{c.consentTitle}</h4><p>{selected.fileName}</p><label><input type="checkbox" checked={consent} disabled={blocked || !analysisAvailable} onChange={event => setConsent(event.target.checked)} />{c.consent}</label><div className="us-supplier-documents-actions"><button type="submit" className="account-button" disabled={blocked || !consent || !analysisAvailable}>{c.prepare}</button><button type="button" className="account-button secondary" disabled={blocked} onClick={() => { setSelected(null); setConsent(false); }}>{c.cancel}</button></div></form>}
    {!loading && !documents.length && <p>{c.empty}</p>}
    <ul className="us-supplier-documents-list">{visible.map(document => <li className="us-supplier-document-row" key={document.id}><div><strong>{document.fileName}</strong><p><small className="us-supplier-documents-muted">{new Intl.DateTimeFormat(`${language}-US`, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(document.createdAt))} · {new Intl.NumberFormat(`${language}-US`, { maximumFractionDigits: 1 }).format(document.sizeBytes / 1024)} KB</small></p><p>{!document.stored ? c.reserved : document.proposalId ? c.proposal : document.readable ? c.readable : c.unreadable}</p></div><div className="us-supplier-documents-actions"><button type="button" className="account-button secondary" disabled={blocked || !document.stored} onClick={() => void download(document)}>{c.download}</button>{document.proposalId && proposalReviewId ? <a className="account-button secondary" href={`#${proposalReviewId}`}>{c.review}</a> : <button type="button" className="account-button secondary" disabled={blocked || !document.stored || !document.readable || !analysisAvailable} onClick={() => { setSelected(document); setConsent(false); setError(''); }}>{c.analyze}</button>}</div></li>)}</ul>
    {totalPages > 1 && <nav className="us-supplier-documents-pagination" aria-label={c.page}><button type="button" className="account-button secondary" disabled={visiblePage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>{c.previous}</button><span>{visiblePage + 1} / {totalPages}</span><button type="button" className="account-button secondary" disabled={visiblePage + 1 >= totalPages} onClick={() => setPage(value => Math.min(totalPages - 1, value + 1))}>{c.next}</button></nav>}
  </section>;
}
