'use client';

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type SubmitEvent } from 'react';
import { Check } from 'lucide-react';
import type { SiteLanguage } from '@/lib/site-language';
import type { BrowserUsFinancialPilotSession, BrowserUsFinancialPilotState } from '@/lib/international/browser-us-financial-pilot-session';
import type { UsFinancialPilotSellerRead } from '@/lib/international/us-financial-pilot-seller';
import type { UsSellerProfile } from '@/lib/international/seller-profile';
import { sellerCommandFromDraft, type SellerDraft, type SellerReview } from '@/lib/international/browser-us-financial-pilot-seller-input';
import { browserUsFinancialPilotSellerCopy, browserUsFinancialPilotSellerErrorCopy } from '@/lib/international/browser-us-financial-pilot-seller-copy';
import './us-financial-pilot-commercial.css';

interface Props {
  session: BrowserUsFinancialPilotSession; state: BrowserUsFinancialPilotState; language: SiteLanguage; active: boolean; canEdit: boolean;
}
const draftFrom = (profile: UsSellerProfile): SellerDraft => ({ displayName: profile.displayName, contactEmail: profile.contactEmail ?? '', contactPhone: profile.contactPhone ?? '' });
function errorCode(error: unknown): string {
  const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : error instanceof TypeError ? 'invalid_seller_input' : 'service_unavailable';
}

export function UsFinancialPilotSeller({ session, state, language, active, canEdit }: Props) {
  const c = browserUsFinancialPilotSellerCopy[language], seller = state.seller, organizationId = state.snapshot?.organizationId;
  const lifetime = useRef(0), flight = useRef(false), initialized = useRef(false), editToken = useRef(0), automaticKey = useRef('');
  const latest = useRef({ session, organizationId });
  const [source, setSource] = useState<UsFinancialPilotSellerRead | null>(null), [draft, setDraft] = useState<SellerDraft | null>(null);
  const [review, setReview] = useState<{ token: number; value: SellerReview } | null>(null), [approved, setApproved] = useState<number | null>(null), [reviewToken, setReviewToken] = useState(0);
  const [busy, setBusy] = useState(false), [localError, setLocalError] = useState(''), [loadTick, setLoadTick] = useState(0);
  const ownPending = state.pendingKind === 'seller', locked = state.pending || state.writing || busy;
  const sourceCurrent = !!source && !!seller?.head && source.head.organizationId === organizationId && source.head.revision === state.snapshot?.revision && source.head.revision === seller.head.revision && source.head.sellerRevision === seller.head.sellerRevision && !state.requiresRefresh && !seller.requiresRefresh;
  const reviewCurrent = !!review && review.token === reviewToken && sourceCurrent && review.value.source.head.revision === source?.head.revision && review.value.source.head.sellerRevision === source?.head.sellerRevision;
  const shownReview = ownPending ? seller?.pendingReview : reviewCurrent ? review?.value : null;
  const shownError = localError || seller?.error?.code || '';
  useLayoutEffect(() => { latest.current = { session, organizationId }; }, [session, organizationId]);
  function clearReview() { editToken.current++; setReviewToken(editToken.current); setReview(null); setApproved(null); }
  function live(at: number) {
    const now = session.getState();
    return at === lifetime.current && latest.current.session === session && latest.current.organizationId === organizationId && now.status !== 'denied' && now.status !== 'stopped';
  }
  const purge = useEffectEvent(() => {
    clearReview(); setSource(null); setDraft(null); setBusy(false); setLocalError(''); automaticKey.current = ''; flight.current = false;
  });
  const observe = useEffectEvent((before: BrowserUsFinancialPilotState, next: BrowserUsFinancialPilotState) => {
    if (next.status === 'denied' || next.status === 'stopped') { lifetime.current++; initialized.current = false; purge(); }
    else if ((!before.writing && next.writing) || before.snapshot?.revision !== next.snapshot?.revision || before.seller?.head?.sellerRevision !== next.seller?.head?.sellerRevision || (!before.requiresRefresh && next.requiresRefresh) || (!before.seller?.requiresRefresh && next.seller?.requiresRefresh)) {
      clearReview(); automaticKey.current = '';
    }
  });
  const retire = useEffectEvent(() => { lifetime.current++; initialized.current = false; });
  useEffect(() => {
    lifetime.current++; initialized.current = false; flight.current = true; const at = lifetime.current;
    queueMicrotask(() => { if (lifetime.current === at) { purge(); initialized.current = true; setLoadTick(value => value + 1); } });
    let before = session.getState();
    const unsubscribe = session.subscribe(() => { const next = session.getState(); observe(before, next); before = next; });
    return () => { retire(); unsubscribe(); };
  }, [session, organizationId]);
  async function task<T>(work: () => Promise<T>, done: (value: T) => void) {
    if (flight.current) return;
    const at = lifetime.current; flight.current = true; setBusy(true); setLocalError('');
    try { const value = await work(); if (live(at)) done(value); }
    catch (error) { const code = errorCode(error); if (live(at) && !['stale_read', 'session_disposed'].includes(code)) setLocalError(code); }
    finally { if (live(at)) { flight.current = false; setBusy(false); } }
  }
  function load() {
    const now = session.getState();
    if (!initialized.current || flight.current || now.status !== 'ready' || now.pending || now.writing || now.seller?.refreshing) return;
    clearReview(); void task(() => session.readSeller(), value => { setSource(value); });
  }
  const loadWhenActive = useEffectEvent(() => {
    if (!active || !initialized.current || !seller || state.status !== 'ready' || locked || seller.refreshing || draft || sourceCurrent) return;
    const key = `${state.snapshot?.revision ?? 0}:${seller.head?.sellerRevision ?? 0}:${seller.requiresRefresh}`;
    if (automaticKey.current === key) return;
    automaticKey.current = key; load();
  });
  useEffect(() => { loadWhenActive(); }, [active, session, organizationId, state.status, state.snapshot?.revision, state.pending, state.writing, seller?.head?.sellerRevision, seller?.requiresRefresh, seller?.refreshing, busy, draft, sourceCurrent, loadTick]);
  function edit() {
    if (!canEdit || locked || !sourceCurrent || !source) return;
    clearReview(); setLocalError(''); setDraft(draftFrom(source.presentation.profile));
  }
  function change(patch: Partial<SellerDraft>) { clearReview(); setLocalError(''); setDraft(value => value ? { ...value, ...patch } : value); }
  function prepare(event: SubmitEvent) {
    event.preventDefault(); const now = session.getState();
    if (!canEdit || locked || flight.current || !draft || !source || !sourceCurrent || now.pending || now.writing) return;
    clearReview(); setLocalError('');
    try { const value = session.reviewSeller(source, sellerCommandFromDraft(draft)); setReview({ token: editToken.current, value }); }
    catch (error) { setLocalError(errorCode(error)); }
  }
  function submit() {
    const now = session.getState(), checked = review;
    if (!canEdit || locked || flight.current || !reviewCurrent || !checked?.value.changed || approved !== checked.token || checked.token !== editToken.current || now.pending || now.writing) return;
    void task(() => session.submitSeller(checked.value, true), () => { clearReview(); setDraft(null); setSource(null); automaticKey.current = ''; });
  }
  function retry() {
    const now = session.getState(); if (flight.current || now.writing || now.pendingKind !== 'seller') return;
    void task(() => session.retrySeller(), () => { clearReview(); setDraft(null); setSource(null); automaticKey.current = ''; });
  }
  function comparison(value: SellerReview) {
    const before = value.source.presentation.profile, after = value.profile;
    return <div className="fpc-review"><h3>{c.review}</h3><p className="fp-context">{c.revision}: {value.source.head.sellerRevision}</p>
      <div className="fpc-current fp-parties">{([{ title: c.before, profile: before }, { title: c.after, profile: after }] as const).map(({ title, profile }) => <section key={title}><h3>{title}</h3><dl className="fp-report-facts">{(['displayName', 'contactEmail', 'contactPhone'] as const).map(key => <div key={key}><dt>{key === 'displayName' ? c.name : key === 'contactEmail' ? c.email : c.phone}</dt><dd className="fpc-preserve">{profile[key] ?? c.notProvided}</dd></div>)}</dl></section>)}</div>
    </div>;
  }
  if (!seller || state.status === 'denied' || state.status === 'stopped') return null;
  return <section className="fpc-workspace" hidden={!active} aria-label={c.title}>
    <div className="fp-detail-heading"><div><h2>{c.title}</h2><p>{c.notice}</p></div></div>
    <p className="fp-context">{c.history}</p>
    {!canEdit && <p className="fp-context">{c.readOnly}</p>}
    {seller.lastReceipt && !ownPending && <output className="fp-success"><Check size={18} aria-hidden/>{c.saved}</output>}
    {ownPending ? <div aria-live="polite"><div className="fp-notice"><p>{c.pending}</p>{shownError && <p>{browserUsFinancialPilotSellerErrorCopy(language, shownError)}</p>}<button type="button" className="account-button secondary" disabled={state.writing || busy} onClick={retry}>{state.writing || busy ? c.saving : c.retry}</button></div>{shownReview && comparison(shownReview)}</div> : <>
      {shownError && <p role="alert">{browserUsFinancialPilotSellerErrorCopy(language, shownError)}</p>}
      {state.pending && <p className="fp-notice">{c.otherPending}</p>}
      {draft && !sourceCurrent && <div className="fp-notice"><p>{c.changed}</p><button type="button" className="account-button secondary" disabled={locked || seller.refreshing} onClick={load}>{c.load}</button></div>}
      {!draft && sourceCurrent && source ? <article className="fp-document"><h3>{c.current}</h3><dl><div><dt>{c.name}</dt><dd className="fpc-preserve">{source.presentation.profile.displayName}</dd></div><div><dt>{c.email}</dt><dd className="fpc-preserve">{source.presentation.profile.contactEmail ?? c.notProvided}</dd></div><div><dt>{c.phone}</dt><dd className="fpc-preserve">{source.presentation.profile.contactPhone ?? c.notProvided}</dd></div></dl><p className="fp-context">{c.revision}: {source.head.sellerRevision}</p>{canEdit && <div className="fp-actions"><button type="button" className="account-button secondary" disabled={locked} onClick={edit}>{c.edit}</button></div>}</article> : !draft && <div className="fp-empty"><p><output>{busy || seller.refreshing ? c.loading : c.unavailable}</output></p><button type="button" className="account-button secondary" disabled={locked || seller.refreshing} onClick={load}>{c.load}</button></div>}
      {draft && <form className="fp-payment fpc-form" onSubmit={prepare}><fieldset className="fpc-fields" disabled={locked || !canEdit}><div className="fp-form-grid">
        <label className="fpc-wide">{c.name}<input required autoComplete="organization" maxLength={256} value={draft.displayName} onChange={event => change({ displayName: event.target.value })}/></label>
        <label>{c.email} · {c.optional}<input type="email" autoComplete="email" maxLength={254} value={draft.contactEmail} onChange={event => change({ contactEmail: event.target.value })}/></label>
        <label>{c.phone} · {c.optional}<input type="tel" autoComplete="tel" maxLength={80} value={draft.contactPhone} onChange={event => change({ contactPhone: event.target.value })}/></label>
      </div></fieldset>
        <div className="fp-actions"><button type="submit" className="account-button secondary" disabled={locked || !canEdit || !sourceCurrent}>{c.review}</button><button type="button" className="account-button secondary" disabled={locked} onClick={() => { clearReview(); setDraft(null); setLocalError(''); }}>{c.cancel}</button></div>
        {shownReview && <div aria-live="polite">{comparison(shownReview)}{shownReview.changed ? <><label className="fpc-checkbox"><input type="checkbox" disabled={locked || !canEdit} checked={approved === review?.token} onChange={event => setApproved(event.target.checked ? review?.token ?? null : null)}/><span>{c.approve}</span></label><div className="fp-actions"><button type="button" className="account-button fp-primary" disabled={locked || !canEdit || !reviewCurrent || approved !== review?.token} onClick={submit}>{state.writing ? c.saving : c.save}</button></div></> : <p className="fp-context">{c.unchanged}</p>}</div>}
      </form>}
    </>}
  </section>;
}
