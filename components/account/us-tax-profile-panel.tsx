'use client';

import { useCallback, useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import type { AccountRole } from '@/lib/account-security';
import type { SiteLanguage } from '@/lib/site-language';
import { countrySubdivisions } from '@/lib/international/addresses';
import { countryConfiguration } from '@/lib/international/country-config';
import { browserTaxProfileCopy } from '@/lib/international/browser-tax-profile-copy';
import { BrowserTaxProfileError, createBrowserTaxProfileSession, type BrowserTaxProfileSession } from '@/lib/international/browser-tax-profile-session';
import { validateUsTaxFacts, type UsTaxFacts, type UsTaxProfileState } from '@/lib/international/us-tax-profile';

export interface BrowserTaxProfileDraft { legalName: string; line1: string; line2: string; city: string; subdivision: string; postalCode: string; timeZone: string }
const emptyDraft = (): BrowserTaxProfileDraft => ({ legalName: '', line1: '', line2: '', city: '', subdivision: '', postalCode: '', timeZone: '' });
const draftFrom = (state: UsTaxProfileState): BrowserTaxProfileDraft => state.status === 'declared' ? { legalName: state.facts.legalName, ...state.facts.taxOrigin, line2: state.facts.taxOrigin.line2 ?? '', timeZone: state.facts.timeZone } : emptyDraft();
export function buildBrowserTaxFacts(draft: BrowserTaxProfileDraft): UsTaxFacts {
  return validateUsTaxFacts({ schemaVersion: 1, legalName: draft.legalName.trim(), taxOrigin: { country: 'US', line1: draft.line1.trim(), ...(draft.line2.trim() ? { line2: draft.line2.trim() } : {}), city: draft.city.trim(), subdivision: draft.subdivision, postalCode: draft.postalCode.trim() }, timeZone: draft.timeZone });
}
export interface UsTaxProfilePanelProps {
  organizationId: string; expectedUserId: string; role: AccountRole; language: SiteLanguage;
  admitted: boolean; blocked: boolean; writeLocked: boolean; accessEpoch: number;
  currentAccessEpoch(this: void): number; otherBusy(this: void): boolean; otherPending(this: void): boolean;
  onBusyChange(this: void, busy: boolean): void; onPendingChange(this: void, pending: boolean): void; onAccessDenied(this: void, status: number): void;
  registerInvalidation(this: void, invalidate: (() => void) | null): void;
}
type Notice = 'invalid' | 'unavailable' | 'denied' | 'conflict' | 'uncertain' | 'saved' | 'savedReload';

/** A private session is never created for a non-owner or after a shared denial.
 * Changes of tenant/user/role remount the whole workbench; epoch fences hide the
 * current private DOM and invalidate RAM before any delayed response can return. */
export function UsTaxProfilePanel(props: UsTaxProfilePanelProps) {
  const { organizationId, expectedUserId, role, language, admitted, writeLocked, accessEpoch, currentAccessEpoch, onBusyChange, onPendingChange, onAccessDenied, registerInvalidation } = props;
  const c = browserTaxProfileCopy[language], prefix = useId();
  const session = useRef<BrowserTaxProfileSession | null>(null), generation = useRef(0), busyRef = useRef(false), dirtyRef = useRef(false), noticeRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<UsTaxProfileState | null>(null), [draft, setDraft] = useState(emptyDraft), [dataEpoch, setDataEpoch] = useState(accessEpoch);
  const [fresh, setFresh] = useState(false), [busy, setBusy] = useState(false), [pending, setPending] = useState(false), [notice, setNotice] = useState<Notice | null>(null);
  const owner = role === 'owner', permitted = owner && !writeLocked && accessEpoch === 0;
  const shownState = permitted && dataEpoch === accessEpoch ? state : null;
  const shownNotice = owner && (writeLocked || dataEpoch !== accessEpoch) ? 'denied' : notice;
  const disabled = props.blocked || busy || pending || !fresh || !permitted;
  const occupy = useCallback((value: boolean) => { busyRef.current = value; setBusy(value); onBusyChange(value); }, [onBusyChange]);
  const purge = useCallback(() => {
    generation.current++; session.current?.invalidate(); setState(null); setDraft(emptyDraft()); dirtyRef.current = false;
    setFresh(false); setPending(false); onPendingChange(false); setNotice('denied'); occupy(false);
  }, [occupy, onPendingChange]);
  const failure = useCallback((error: unknown): Notice => {
    if (error instanceof BrowserTaxProfileError && (error.outcome === 'unauthorized' || [401, 402, 403].includes(error.status))) { onAccessDenied(error.status); return 'denied'; }
    if (error instanceof BrowserTaxProfileError && error.code === 'invalid_request' && error.outcome === 'rejected') return 'invalid';
    if (error instanceof BrowserTaxProfileError && ['revision_conflict', 'request_id_conflict', 'read_required'].includes(error.code)) return 'conflict';
    return error instanceof BrowserTaxProfileError && error.outcome === 'uncertain' ? 'uncertain' : 'unavailable';
  }, [onAccessDenied]);
  useEffect(() => { registerInvalidation(purge); return () => registerInvalidation(null); }, [purge, registerInvalidation]);
  useEffect(() => {
    if (!permitted || !admitted) return;
    const current = ++generation.current, privacy = currentAccessEpoch();
    const instance = createBrowserTaxProfileSession({ organizationId, expectedUserId, onAccessDenied: () => onAccessDenied(403) }); session.current = instance;
    void Promise.resolve().then(() => { if (generation.current !== current || currentAccessEpoch() !== privacy) return null; occupy(true); return instance.load(); }).then(value => {
      if (!value) return;
      if (generation.current === current && currentAccessEpoch() === privacy) { setState(value); setDataEpoch(privacy); setDraft(draftFrom(value)); setFresh(true); }
    }).catch(error => { if (generation.current === current && currentAccessEpoch() === privacy) setNotice(failure(error)); })
      .finally(() => { if (generation.current === current) occupy(false); });
    return () => { generation.current = current + 1; instance.dispose(); session.current = null; onBusyChange(false); onPendingChange(false); };
  }, [organizationId, expectedUserId, permitted, admitted, currentAccessEpoch, onAccessDenied, onBusyChange, onPendingChange, occupy, failure]);
  useEffect(() => { if (shownNotice && shownNotice !== 'saved') noticeRef.current?.focus(); }, [shownNotice]);
  function confirmPending(instance: BrowserTaxProfileSession) { const value = instance.hasPending(); setPending(value); onPendingChange(value); }
  async function reload() {
    const instance = session.current, current = generation.current, privacy = currentAccessEpoch();
    if (!instance || !permitted || busyRef.current || props.otherBusy()) return;
    occupy(true); setFresh(false); setNotice(null);
    try { const value = await instance.load(); if (generation.current === current && currentAccessEpoch() === privacy) { setState(value); setDataEpoch(privacy); if (!dirtyRef.current) setDraft(draftFrom(value)); setFresh(true); } }
    catch (error) { if (generation.current === current && currentAccessEpoch() === privacy) setNotice(failure(error)); }
    finally { if (generation.current === current) { confirmPending(instance); occupy(false); } }
  }
  async function write(facts?: UsTaxFacts) {
    const instance = session.current, current = generation.current, privacy = currentAccessEpoch();
    if (!instance || !permitted || busyRef.current || props.otherBusy() || facts && (disabled || !state || privacy !== dataEpoch || props.otherPending())) return;
    occupy(true); setFresh(false); setNotice(null); let confirmed = false;
    try {
      if (facts) await instance.submit(facts, state?.revision ?? 0); else await instance.retry();
      confirmed = true;
      if (generation.current !== current || currentAccessEpoch() !== privacy) return;
      const value = await instance.load();
      if (generation.current === current && currentAccessEpoch() === privacy) { setState(value); setDataEpoch(privacy); setDraft(draftFrom(value)); dirtyRef.current = false; setFresh(true); setNotice('saved'); }
    } catch (error) { if (generation.current === current && currentAccessEpoch() === privacy) { const key = failure(error); setNotice(key === 'denied' ? key : confirmed ? 'savedReload' : key); } }
    finally { if (generation.current === current) { confirmPending(instance); occupy(false); } }
  }
  function submit(event: SubmitEvent<HTMLFormElement>) { event.preventDefault(); if (disabled) return; try { void write(buildBrowserTaxFacts(draft)); } catch { setNotice('invalid'); } }
  function change(key: keyof BrowserTaxProfileDraft, value: string) { dirtyRef.current = true; setDraft(previous => ({ ...previous, [key]: value })); }
  const field = (key: keyof BrowserTaxProfileDraft, label: string, maximum: number, required = true, pattern?: string) => <label htmlFor={`${prefix}-${key}`}>{label}<input id={`${prefix}-${key}`} name={key} required={required} maxLength={maximum} pattern={pattern} autoComplete="off" value={draft[key]} onChange={event => change(key, event.target.value)} /></label>;
  return <section className="us-erp-section us-tax-profile" aria-labelledby={`${prefix}-title`}>
    <div className="us-erp-record-heading"><h2 id={`${prefix}-title`}>{c.title}</h2>{owner && <output className="us-tax-status">{shownState?.status === 'declared' ? c.declared : c.unconfigured}</output>}</div>
    <p className="us-erp-muted">{c.limitation}</p>
    {!owner ? <p className="us-erp-muted">{c.ownerOnly}</p> : <>
      {shownNotice && <div className={`us-erp-notice ${shownNotice === 'saved' ? 'success' : 'error'}`} ref={noticeRef} tabIndex={-1} role={shownNotice === 'saved' ? 'status' : 'alert'}>{c[shownNotice]}</div>}
      {permitted && pending && <aside className="us-erp-pending" aria-live="polite"><p>{c.pending}</p><p>{c.pendingMemory}</p><button type="button" className="account-button" disabled={busy || props.otherBusy()} onClick={() => void write()}>{busy ? c.busy : c.retry}</button></aside>}
      {permitted && !shownState && !shownNotice && <output>{c.loading}</output>}
      {shownState && <details className="us-erp-editor us-tax-editor"><summary>{c.edit}</summary><div className="us-tax-editor-content"><p>{c.help}</p>
        <button type="button" className="account-button secondary" disabled={busy || props.otherBusy() || !permitted} onClick={() => void reload()}>{c.reload}</button>
        <form autoComplete="off" onSubmit={submit}><fieldset className="us-erp-form" disabled={disabled}>
          {field('legalName', c.legalName, 256)}{field('line1', c.line1, 200)}{field('line2', c.line2, 200, false)}
          <div className="us-erp-grid">{field('city', c.city, 120)}<div className="us-tax-select-field"><label htmlFor={`${prefix}-subdivision`}>{c.state}</label><select id={`${prefix}-subdivision`} name="subdivision" required autoComplete="off" value={draft.subdivision} onChange={event => change('subdivision', event.target.value)}><option value="">{c.choose}</option>{countrySubdivisions.US.map(state => <option key={state} value={state}>{state}</option>)}</select></div>{field('postalCode', c.postalCode, 10, true, '[0-9]{5}(-[0-9]{4})?')}
          <div className="us-tax-select-field"><label htmlFor={`${prefix}-timeZone`}>{c.timeZone}</label><select id={`${prefix}-timeZone`} name="timeZone" required autoComplete="off" value={draft.timeZone} onChange={event => change('timeZone', event.target.value)}><option value="">{c.choose}</option>{countryConfiguration('US').timeZones.map(zone => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}</select></div></div>
          <p className="us-erp-muted">{c.draftKept}</p><button type="submit" className="account-button">{c.save}</button>
        </fieldset></form>
      </div></details>}
      {permitted && !shownState && shownNotice && <button type="button" className="account-button secondary" disabled={busy || props.otherBusy()} onClick={() => void reload()}>{c.reload}</button>}
    </>}
  </section>;
}
