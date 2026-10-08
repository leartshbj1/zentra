'use client';

import { useCallback, useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import type { AccountRole } from '@/lib/account-security';
import type { SiteLanguage } from '@/lib/site-language';
import { browserSellerCopy } from '@/lib/international/browser-workbench-copy';
import { BrowserSellerError, createBrowserSellerSession, type BrowserSellerSession } from '@/lib/international/browser-seller-session';
import type { UsSellerProfile, UsSellerProfileState } from '@/lib/international/seller-profile';
export { browserSellerCopy } from '@/lib/international/browser-workbench-copy';

export interface BrowserSellerDraft { displayName: string; contactEmail: string; contactPhone: string }
const emptyDraft = (): BrowserSellerDraft => ({ displayName: '', contactEmail: '', contactPhone: '' });
const draftFrom = (state: UsSellerProfileState): BrowserSellerDraft => state.status === 'configured' ? { displayName: state.profile.displayName, contactEmail: state.profile.contactEmail ?? '', contactPhone: state.profile.contactPhone ?? '' } : emptyDraft();
export function buildBrowserSellerProfile(draft: BrowserSellerDraft): UsSellerProfile {
  const text = (value: string, maximum: number, required = false) => {
    if (typeof value !== 'string' || value.length > maximum || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || required && !value.trim()) throw new TypeError('Invalid seller detail');
    return value.trim();
  };
  const displayName = text(draft.displayName, 256, true), contactEmail = text(draft.contactEmail, 254), contactPhone = text(draft.contactPhone, 80);
  if (contactEmail && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contactEmail)) throw new TypeError('Invalid seller email');
  return Object.freeze({ displayName, ...(contactEmail ? { contactEmail } : {}), ...(contactPhone ? { contactPhone } : {}) });
}
/** Render only public contact details, never receipt actors or private authority. */
export function UsSellerProfileDetails({ state, language }: { state: UsSellerProfileState; language: SiteLanguage }) {
  const c = browserSellerCopy[language];
  if (state.status === 'unconfigured') return <p className="us-erp-muted">{c.sellerEmpty}</p>;
  return <><dl className="us-seller-details"><div><dt>{c.displayName}</dt><dd>{state.profile.displayName}</dd></div>{state.profile.contactEmail && <div><dt>{c.contactEmail}</dt><dd>{state.profile.contactEmail}</dd></div>}{state.profile.contactPhone && <div><dt>{c.contactPhone}</dt><dd>{state.profile.contactPhone}</dd></div>}</dl><p className="us-erp-muted us-seller-revision">{c.revision} {state.revision}</p></>;
}
export interface UsSellerProfilePanelProps {
  organizationId: string; expectedUserId: string; role: AccountRole; language: SiteLanguage;
  blocked: boolean; writeLocked: boolean; accessEpoch: number;
  currentAccessEpoch(this: void): number; otherBusy(this: void): boolean; otherPending(this: void): boolean;
  onBusyChange(this: void, busy: boolean): void; onPendingChange(this: void, pending: boolean): void; onAccessDenied(this: void, status: number): void;
}
type Notice = 'invalid' | 'unavailable' | 'denied' | 'conflict' | 'uncertain' | 'saved' | 'savedReload';
/** This instance survives revocation so its private exact retry remains in RAM. */
export function UsSellerProfilePanel(props: UsSellerProfilePanelProps) {
  const { organizationId, expectedUserId, role, language, blocked, writeLocked, accessEpoch, currentAccessEpoch, onBusyChange, onPendingChange, onAccessDenied } = props;
  const c = browserSellerCopy[language], prefix = useId(), session = useRef<BrowserSellerSession | null>(null), generation = useRef(0), lastAccessEpoch = useRef(accessEpoch), busyRef = useRef(true), dirtyRef = useRef(false), noticeRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<UsSellerProfileState | null>(null), [draft, setDraft] = useState(emptyDraft), [fresh, setFresh] = useState(false), [busy, setBusy] = useState(true), [pending, setPending] = useState(false), [notice, setNotice] = useState<Notice | null>(null);
  const [dataEpoch, setDataEpoch] = useState(accessEpoch);
  const shownState = dataEpoch === accessEpoch ? state : null, shownNotice = dataEpoch === accessEpoch ? notice : 'denied';
  const editable = role === 'owner', disabled = blocked || busy || pending || !fresh || writeLocked;
  const occupy = useCallback((value: boolean) => { busyRef.current = value; setBusy(value); onBusyChange(value); }, [onBusyChange]);
  function confirmPending(instance: BrowserSellerSession) { const value = instance.hasPending(); setPending(value); props.onPendingChange(value); }
  const failure = useCallback((error: unknown): Notice => {
    if (error instanceof BrowserSellerError && (error.outcome === 'unauthorized' || [401, 402, 403].includes(error.status))) { onAccessDenied(error.status); return 'denied'; }
    if (error instanceof BrowserSellerError && ['revision_conflict', 'request_id_conflict', 'read_required'].includes(error.code)) return 'conflict';
    return error instanceof BrowserSellerError && error.outcome === 'uncertain' ? 'uncertain' : 'unavailable';
  }, [onAccessDenied]);
  useEffect(() => {
    const current = ++generation.current, privacy = currentAccessEpoch(), instance = createBrowserSellerSession({ organizationId, expectedUserId }); session.current = instance; onBusyChange(true);
    void instance.load().then(value => { if (generation.current === current && currentAccessEpoch() === privacy) { setState(value); setDataEpoch(privacy); setDraft(draftFrom(value)); setFresh(true); } }).catch(error => { if (generation.current === current && currentAccessEpoch() === privacy) setNotice(failure(error)); }).finally(() => { if (generation.current === current) occupy(false); });
    return () => { generation.current = current + 1; instance.dispose(); session.current = null; onBusyChange(false); onPendingChange(false); };
  }, [organizationId, expectedUserId, currentAccessEpoch, onBusyChange, onPendingChange, occupy, failure]);
  useEffect(() => {
    if (lastAccessEpoch.current === accessEpoch) return;
    lastAccessEpoch.current = accessEpoch; setState(null); setDataEpoch(accessEpoch); setDraft(emptyDraft()); dirtyRef.current = false; setFresh(false); setNotice('denied');
  }, [accessEpoch]);
  useEffect(() => { if (notice && notice !== 'saved') noticeRef.current?.focus(); }, [notice]);
  async function reload() {
    const instance = session.current, current = generation.current, privacy = props.currentAccessEpoch();
    if (!instance || busyRef.current) return;
    occupy(true); setFresh(false); setNotice(null);
    try { const value = await instance.load(); if (generation.current === current && props.currentAccessEpoch() === privacy) { setState(value); setDataEpoch(privacy); if (!dirtyRef.current) setDraft(draftFrom(value)); setFresh(true); } }
    catch (error) { if (generation.current === current && props.currentAccessEpoch() === privacy) setNotice(failure(error)); }
    finally { if (generation.current === current) { confirmPending(instance); occupy(false); } }
  }
  async function write(profile?: UsSellerProfile) {
    const instance = session.current, current = generation.current, privacy = props.currentAccessEpoch();
    if (!instance || busyRef.current || props.otherBusy() || profile && (disabled || !editable || !state || privacy !== dataEpoch || props.otherPending())) return;
    occupy(true); setFresh(false); setNotice(null); let confirmed = false;
    try {
      if (profile) await instance.submit(profile, state?.revision ?? 0); else await instance.retry();
      confirmed = true;
      if (generation.current !== current || props.currentAccessEpoch() !== privacy) return;
      // A replay can describe an older revision. Always read the current head.
      const value = await instance.load();
      if (generation.current === current && props.currentAccessEpoch() === privacy) { setState(value); setDataEpoch(privacy); setDraft(draftFrom(value)); dirtyRef.current = false; setFresh(true); setNotice('saved'); }
    } catch (error) { if (generation.current === current && props.currentAccessEpoch() === privacy) { const key = failure(error); setNotice(key === 'denied' ? key : confirmed ? 'savedReload' : key); } }
    finally { if (generation.current === current) { confirmPending(instance); occupy(false); } }
  }
  function submit(event: SubmitEvent<HTMLFormElement>) { event.preventDefault(); if (disabled || !editable) return; try { void write(buildBrowserSellerProfile(draft)); } catch { setNotice('invalid'); } }
  const field = (key: keyof BrowserSellerDraft, label: string, maximum: number, type = 'text', required = false) => <label htmlFor={`${prefix}-${key}`}>{label}<input id={`${prefix}-${key}`} name={key} type={type} required={required} maxLength={maximum} value={draft[key]} onChange={event => { dirtyRef.current = true; setDraft(previous => ({ ...previous, [key]: event.target.value })); }} /></label>;
  const form = <form onSubmit={submit}><fieldset className="us-erp-form" disabled={disabled}>{field('displayName', c.displayName, 256, 'text', true)}<div className="us-erp-grid">{field('contactEmail', c.contactEmail, 254, 'email')}{field('contactPhone', c.contactPhone, 80, 'tel')}</div><p className="us-erp-muted">{c.draftKept}</p><button type="submit" className="account-button">{c.save}</button></fieldset></form>;
  return <section className="us-erp-section us-seller-profile" aria-labelledby={`${prefix}-title`}>
    <div className="us-erp-record-heading"><h2 id={`${prefix}-title`}>{c.sellerTitle}</h2><button type="button" className="account-button secondary" disabled={busy} onClick={() => void reload()}>{c.reload}</button></div><p>{c.sellerHelp}</p><p className="us-erp-muted">{c.nonVerified}</p>
    {shownNotice && <div className={`us-erp-notice ${shownNotice === 'saved' ? 'success' : 'error'}`} ref={noticeRef} tabIndex={-1} role={shownNotice === 'saved' ? 'status' : 'alert'}>{c[shownNotice]}</div>}
    {pending && <aside className="us-erp-pending" aria-live="polite"><p>{c.pending}</p><p>{c.pendingMemory}</p><button type="button" className="account-button" disabled={busy || blocked && props.otherBusy()} onClick={() => void write()}>{busy ? c.busy : c.retry}</button></aside>}
    {shownState ? <UsSellerProfileDetails state={shownState} language={language} /> : !shownNotice && <output>{c.loading}</output>}
    {!editable && <p className="us-erp-muted">{c.ownerOnly}</p>}{writeLocked && <p className="us-erp-muted">{c.writeLocked}</p>}
    {editable && shownState && (shownState.status === 'unconfigured' ? form : <details className="us-erp-editor"><summary>{c.edit}</summary>{form}</details>)}
  </section>;
}
