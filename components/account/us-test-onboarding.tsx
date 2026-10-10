'use client';

import { useCallback, useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import type { SiteLanguage } from '@/lib/site-language';
import { AUTH_CHANGED_EVENT } from '@/lib/auth-browser-events';
import { countrySubdivisions } from '@/lib/international/addresses';
import { countryConfiguration } from '@/lib/international/country-config';
import { creationUuid } from '@/lib/international/workspace-creation';
import { formatMoney } from '@/lib/international/money';
import { createBrowserUsTestOnboardingSession, emptyUsTestOnboardingDraft, US_TEST_ONBOARDING_STORAGE_KEY, UsTestOnboardingError, usTestOnboardingFieldErrors, type BrowserUsTestOnboardingSession, type UsTestOnboardingDraft, type UsTestOnboardingField } from '@/lib/international/browser-us-test-onboarding';
import type { UsTestPublicState } from '@/lib/international/us-saas-test-public';
import { usTestOnboardingCopy } from '@/lib/international/us-test-onboarding-copy';
import './us-test-onboarding.css';

export interface UsTestOnboardingProps { expectedUserId: string; language: SiteLanguage; initialRequestId?: string | null; checkoutReturn?: 'returned' | 'canceled' | null }
const languages = { fr: 'Français', de: 'Deutsch', it: 'Italiano', en: 'English' } as const;
const locator = (value: string | null | undefined) => { try { return value ? creationUuid(value) : null; } catch { return null; } };

export function UsTestOnboarding({ expectedUserId, language, initialRequestId = null, checkoutReturn = null }: UsTestOnboardingProps) {
  const c = usTestOnboardingCopy[language], prefix = useId(), session = useRef<BrowserUsTestOnboardingSession | null>(null), epoch = useRef(0), busyRef = useRef(false);
  const [draft, setDraft] = useState(() => emptyUsTestOnboardingDraft(language)), [state, setState] = useState<UsTestPublicState | null>(null), [busy, setBusy] = useState(false), [initialized, setInitialized] = useState(false), [denied, setDenied] = useState(false), [notice, setNotice] = useState(''), [invalid, setInvalid] = useState<readonly UsTestOnboardingField[]>([]), [companyConfirmed, setCompanyConfirmed] = useState(false), [testConfirmed, setTestConfirmed] = useState(false), [selection, setSelection] = useState(''), [pendingCreation, setPendingCreation] = useState(false), [pendingCheckout, setPendingCheckout] = useState(false), [checkoutUrl, setCheckoutUrl] = useState<string | null>(null), [clock, setClock] = useState(() => Date.now());
  const noticeRef = useRef<HTMLParagraphElement>(null), stageRef = useRef<HTMLElement>(null), stageFocus = useRef(false);
  const expired = !!state?.purchase.expiresAt && clock >= state.purchase.expiresAt * 1000;
  const ready = state?.workspace.state === 'ready' && state.workspace.setupStatus === 'ready' && state.purchase.state === 'ready';
  const stage = ready ? 3 : state ? 2 : 1;
  useEffect(() => { if (notice) noticeRef.current?.focus(); }, [notice]);
  useEffect(() => { if (stageFocus.current) { stageRef.current?.focus(); stageFocus.current = false; } }, [stage, state]);
  useEffect(() => { if (!state?.purchase.expiresAt || ready || expired) return; const timer = setTimeout(() => setClock(Date.now()), Math.min(Math.max(state.purchase.expiresAt * 1000 - Date.now(), 1), 2_147_483_647)); return () => clearTimeout(timer); }, [state?.purchase.expiresAt, ready, expired, clock]);
  const message = useCallback((error: unknown, active: BrowserUsTestOnboardingSession) => {
    if (!(error instanceof UsTestOnboardingError)) return c.unavailable;
    if (error.outcome === 'unauthorized') return c.denied;
    if (error.code === 'payment_unconfirmed') return c.paymentUnconfirmed;
    if (error.code === 'checkout_recovery_required') return c.recoveryRequired;
    if (error.code === 'checkout_expired') return c.expired;
    if (error.code === 'workspace_confirmation_required') return c.reserved;
    if (['request_id_conflict', 'creation_changed', 'purchase_conflict', 'session_conflict', 'configuration_changed'].includes(error.code)) return c.conflict;
    if (['provider_mismatch', 'unsupported_payment', 'price_mismatch', 'offer_unavailable'].includes(error.code)) return c.offerChanged;
    if (error.code === 'not_found' && !active.hasPendingCreation()) return c.notFound;
    if (active.hasPendingCreation() || active.hasPendingCheckout()) return c.uncertain;
    return c.unavailable;
  }, [c]);
  useEffect(() => {
    const generation = ++epoch.current;
    let saved: string | null = null; try { saved = locator(window.sessionStorage.getItem(US_TEST_ONBOARDING_STORAGE_KEY)); } catch { /* The flow also works without browser storage. */ }
    const requestId = locator(initialRequestId) ?? saved;
    if (requestId) try { window.sessionStorage.setItem(US_TEST_ONBOARDING_STORAGE_KEY, requestId); } catch { /* The return URL is also a scoped recovery locator. */ }
    const purge = () => {
      if (epoch.current !== generation) return; ++epoch.current; session.current?.dispose(); session.current = null; busyRef.current = false;
      try { window.sessionStorage.removeItem(US_TEST_ONBOARDING_STORAGE_KEY); } catch { /* No business facts were persisted. */ }
      setDenied(true); setInitialized(true); setBusy(false); setPendingCreation(false); setPendingCheckout(false); setState(null); setDraft(emptyUsTestOnboardingDraft(language)); setCheckoutUrl(null); setSelection(''); setCompanyConfirmed(false); setTestConfirmed(false); setInvalid([]); setNotice(c.denied);
    };
    const active = createBrowserUsTestOnboardingSession({ expectedUserId, requestId, saveRequestId: id => { window.sessionStorage.setItem(US_TEST_ONBOARDING_STORAGE_KEY, id); }, onAccessLost: purge }); session.current = active;
    const storageChanged = (event: StorageEvent) => { if (event.key === AUTH_CHANGED_EVENT || event.key === null) purge(); };
    window.addEventListener(AUTH_CHANGED_EVENT, purge); window.addEventListener('storage', storageChanged);
    queueMicrotask(() => {
      if (epoch.current !== generation) return;
      setDenied(false); setNotice(''); setState(null); setCheckoutUrl(null); setSelection(''); setPendingCreation(false); setPendingCheckout(false); setDraft(emptyUsTestOnboardingDraft(language)); setCompanyConfirmed(false); setTestConfirmed(false);
      if (requestId) {
        busyRef.current = true; setBusy(true);
        void active.load().then(result => { if (epoch.current === generation) { setState(result); setClock(Date.now()); } }).catch(error => { if (epoch.current === generation) setNotice(message(error, active)); }).finally(() => { if (epoch.current === generation) { busyRef.current = false; setBusy(false); setInitialized(true); } });
      } else { setInitialized(true); setBusy(false); busyRef.current = false; }
    });
    const finish = () => { active.dispose(); if (epoch.current === generation) { ++epoch.current; session.current = null; busyRef.current = false; } };
    return () => { window.removeEventListener(AUTH_CHANGED_EVENT, purge); window.removeEventListener('storage', storageChanged); finish(); };
  }, [expectedUserId, language, initialRequestId, c, message]);

  async function run(work: (active: BrowserUsTestOnboardingSession) => Promise<UsTestPublicState>) {
    const active = session.current, generation = epoch.current; if (!active || busyRef.current || denied) return;
    busyRef.current = true; setBusy(true); setNotice('');
    try { const result = await work(active); if (epoch.current !== generation) return; stageFocus.current = true; setState(result); setClock(Date.now()); setCheckoutUrl(result.purchase.state === 'checkout_pending' ? result.checkoutUrl ?? null : null); setTestConfirmed(false); setSelection(''); setInvalid([]); }
    catch (error) { if (epoch.current !== generation) return; setNotice(message(error, active)); }
    finally { if (epoch.current === generation) { setPendingCreation(active.hasPendingCreation()); setPendingCheckout(active.hasPendingCheckout()); busyRef.current = false; setBusy(false); } }
  }
  function create(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); if (busyRef.current || denied) return; const errors = usTestOnboardingFieldErrors(draft); setInvalid(errors);
    if (errors.length || !companyConfirmed) { setNotice(c.invalid); requestAnimationFrame(() => { const field = errors[0] ?? 'companyConfirmed'; document.getElementById(`${prefix}-${field}`)?.focus(); }); return; }
    void run(active => active.create(draft));
  }
  function update<Key extends keyof UsTestOnboardingDraft>(key: Key, value: UsTestOnboardingDraft[Key]) { setDraft(current => ({ ...current, [key]: value })); setInvalid(current => current.filter(field => field !== key)); setCompanyConfirmed(false); }
  const fieldProps = (field: UsTestOnboardingField) => ({ id: `${prefix}-${field}`, name: field, 'aria-invalid': invalid.includes(field) || undefined, 'aria-describedby': invalid.includes(field) ? `${prefix}-${field}-error` : undefined });
  const errorFor = (field: UsTestOnboardingField) => invalid.includes(field) ? <span className="us-test-field-error" id={`${prefix}-${field}-error`}>{c.fieldError}</span> : null;
  const offer = state?.offers.find(item => `${item.module}:${item.plan}` === selection);
  const summary = state?.workspace;

  return <section className="us-test-onboarding" aria-labelledby={`${prefix}-title`}>
    <header className="us-test-header"><span className="us-test-badge">US · TEST</span><h1 id={`${prefix}-title`}>{c.title}</h1><p className="account-lead">{c.lead}</p></header>
    <ol className="us-test-progress" aria-label={c.steps}>{[c.company, c.subscription, c.readyStep].map((label, index) => <li key={label} aria-current={stage === index + 1 ? 'step' : undefined}><span aria-hidden="true">{index + 1}</span><span>{label}</span></li>)}</ol>
    {notice && <p className="us-test-notice" role="alert" tabIndex={-1} ref={noticeRef}>{notice}</p>}
    {denied ? <a className="account-button" href="/compte/espaces/us/nouveau">{c.reload}</a> : <>
      {checkoutReturn && !ready && <output className="us-test-return">{c[checkoutReturn]}</output>}
      {!initialized && <output>{c.checking}</output>}
      {!state && <form className="account-form us-test-form" onSubmit={create} noValidate>
        <fieldset disabled={!initialized || busy || pendingCreation}><legend>{c.company}</legend>
          <p className="us-test-country">{c.country}</p>
          <label htmlFor={`${prefix}-companyName`}>{c.companyName}<input {...fieldProps('companyName')} autoComplete="organization" required maxLength={160} value={draft.companyName} onChange={event => update('companyName', event.target.value)}/>{errorFor('companyName')}</label>
          <label htmlFor={`${prefix}-line1`}>{c.line1}<input {...fieldProps('line1')} autoComplete="address-line1" required maxLength={200} value={draft.line1} onChange={event => update('line1', event.target.value)}/>{errorFor('line1')}</label>
          <div className="us-test-address-grid"><label htmlFor={`${prefix}-city`}>{c.city}<input {...fieldProps('city')} autoComplete="address-level2" required maxLength={120} value={draft.city} onChange={event => update('city', event.target.value)}/>{errorFor('city')}</label>
          <label htmlFor={`${prefix}-subdivision`}>{c.subdivision}<select {...fieldProps('subdivision')} autoComplete="address-level1" required value={draft.subdivision} onChange={event => update('subdivision', event.target.value)}><option value="">{c.choose}</option>{countrySubdivisions.US.map(code => <option key={code} value={code}>{code}</option>)}</select>{errorFor('subdivision')}</label>
          <label htmlFor={`${prefix}-postalCode`}>{c.postalCode}<input {...fieldProps('postalCode')} autoComplete="postal-code" inputMode="numeric" required maxLength={10} value={draft.postalCode} onChange={event => update('postalCode', event.target.value)}/>{errorFor('postalCode')}</label></div>
          <label htmlFor={`${prefix}-timeZone`}>{c.timeZone}<select {...fieldProps('timeZone')} required value={draft.timeZone} onChange={event => update('timeZone', event.target.value)}><option value="">{c.choose}</option>{countryConfiguration('US').timeZones.map(zone => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}</select>{errorFor('timeZone')}</label>
          <div className="us-test-settings-grid"><label htmlFor={`${prefix}-language`}>{c.language}<select id={`${prefix}-language`} name="language" value={draft.language} onChange={event => update('language', event.target.value as SiteLanguage)}>{Object.entries(languages).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
          <label htmlFor={`${prefix}-accountingBasis`}>{c.accountingBasis}<select {...fieldProps('accountingBasis')} required value={draft.accountingBasis} onChange={event => update('accountingBasis', event.target.value)}><option value="">{c.choose}</option><option value="cash">{c.cash}</option><option value="accrual">{c.accrual}</option></select>{errorFor('accountingBasis')}</label></div>
          <p className="account-caption">{c.basisHelp}</p>
          <label className="us-test-check" htmlFor={`${prefix}-companyConfirmed`}><input id={`${prefix}-companyConfirmed`} type="checkbox" checked={companyConfirmed} onChange={event => setCompanyConfirmed(event.target.checked)}/><span>{c.confirmCompany}</span></label>
          <button className="account-button" type="submit">{busy ? c.creating : c.create}</button>
        </fieldset>
      </form>}
      {summary && <section className="us-test-company" aria-label={c.company}><div><strong>{summary.companyName}</strong><span>{c.country}</span></div><p>{summary.configuration.address.line1}<br/>{summary.configuration.address.postalCode} {summary.configuration.address.city}, {summary.configuration.address.subdivision}</p><p className="account-caption">{summary.configuration.timeZone} · {summary.configuration.accountingBasis === 'cash' ? c.cash : c.accrual}</p></section>}
      {pendingCreation && <div className="us-test-actions"><button className="account-button" disabled={busy} onClick={() => void run(active => active.retryCreation())}>{busy ? c.checking : c.retryCreation}</button><button className="account-button secondary" disabled={busy} onClick={() => void run(active => active.recover())}>{c.recover}</button></div>}
      {summary?.state === 'reserved' && <section className="us-test-stage" tabIndex={-1} ref={stageRef}><h2>{c.subscription}</h2><p>{c.reserved}</p><button className="account-button" disabled={busy} onClick={() => void run(active => active.recover())}>{busy ? c.checking : c.recover}</button></section>}
      {summary?.state === 'postgres_confirmed' && state?.purchase.state === 'not_started' && !pendingCheckout && <section className="us-test-stage" tabIndex={-1} ref={stageRef}><h2>{c.offers}</h2>
        {state.offers.length ? <form onSubmit={event => { event.preventDefault(); if (offer && testConfirmed) void run(active => active.checkout(offer)); }}><fieldset disabled={busy}><legend className="us-test-sr-only">{c.offers}</legend><div className="us-test-offers">{state.offers.map(item => { const key = `${item.module}:${item.plan}`, interval = item.interval === 'month' ? item.intervalCount === 1 ? c.month : c.months : item.intervalCount === 1 ? c.year : c.years; return <label className="us-test-offer" key={key} aria-label={`${c[item.module]} ${item.plan}`}><input type="radio" name={`${prefix}-offer`} value={key} checked={selection === key} onChange={() => { setSelection(key); setTestConfirmed(false); }}/><span><strong>{c[item.module]} <span className="us-test-plan">{item.plan}</span></strong><span className="us-test-offer-price">{formatMoney({ currency: 'USD', minorUnits: item.amountMinor }, language === 'en' ? 'en-US' : `${language}-US`)} <small>{c.every} {item.intervalCount} {interval}</small></span><span>{item.seatLimit} {item.seatLimit === 1 ? c.peopleOne : c.peopleMany}</span></span></label>; })}</div><label className="us-test-check"><input type="checkbox" checked={testConfirmed} onChange={event => setTestConfirmed(event.target.checked)}/><span>{c.confirmTest}</span></label><button className="account-button" type="submit" disabled={!offer || !testConfirmed}>{busy ? c.checking : c.continue}</button></fieldset></form> : <p>{c.noOffers}</p>}
        <button className="account-button secondary" disabled={busy} onClick={() => void run(active => active.load())}>{c.refresh}</button>
      </section>}
      {(state?.purchase.state === 'checkout_pending' || pendingCheckout) && !ready && <section className="us-test-stage" tabIndex={-1} ref={stageRef}><h2>{c.pendingTitle}</h2><p>{expired ? c.expired : c.pending}</p>{checkoutUrl && !expired && <><a className="account-button" href={checkoutUrl} target="_blank" rel="noopener noreferrer">{c.checkout}</a><p className="account-caption">{c.checkoutHelp}</p></>}<div className="us-test-actions">{!checkoutUrl && !expired && !pendingCheckout && state?.purchase.module && state.purchase.plan && <button className="account-button secondary" disabled={busy} onClick={() => void run(active => active.reopenCheckout())}>{c.reopenCheckout}</button>}<button className="account-button" disabled={busy} onClick={() => void run(active => active.recover())}>{busy ? c.checking : c.recover}</button>{pendingCheckout && <button className="account-button secondary" disabled={busy} onClick={() => void run(active => active.retryCheckout())}>{c.retryCheckout}</button>}</div></section>}
      {ready && <section className="us-test-stage us-test-ready" tabIndex={-1} ref={stageRef}><h2>{c.ready}</h2><p>{c.readyDetail}</p><a className="account-button" href={`/compte/espaces/us/${summary!.organizationId}`}>{c.open}</a></section>}
    </>}
    <footer className="us-test-footer"><p className="account-caption">{c.storage}</p><a href="/compte/espaces">{c.back}</a></footer>
  </section>;
}
