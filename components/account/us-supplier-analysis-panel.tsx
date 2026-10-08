'use client';

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type SubmitEvent } from 'react';
import type { AccountRole } from '../../lib/account-security';
import type { SiteLanguage } from '../../lib/site-language';
import type { ErpState } from '../../lib/international/runtime-types';
import { BrowserUsAnalysisError, createBrowserUsAnalysisSession, type BrowserUsAnalysisReadiness, type BrowserUsAnalysisSession } from '../../lib/international/browser-us-analysis-session';
import { browserUsAnalysisCopy, browserUsAnalysisError } from '../../lib/international/browser-us-analysis-copy';
import './us-supplier-analysis-panel.css';

export interface UsSupplierAnalysisBinding {
  expectedUserId: string;
  accessEpoch(): number;
  otherBusy(): boolean;
  otherPending(): boolean;
  onBusy(value: boolean): void;
  onPending(value: boolean): void;
  onReadiness(value: BrowserUsAnalysisReadiness | null): void;
  onInvalidated(): void;
}
export interface UsSupplierAnalysisPanelProps {
  state: ErpState;
  organizationId: string;
  role: AccountRole;
  supportedSchemaVersion: number;
  language: SiteLanguage;
  disabled?: boolean;
  refreshToken?: number;
  binding: UsSupplierAnalysisBinding;
}

/** Settings are a fresh, public server projection. Changing availability never
 * disposes document drafts or an ambiguous financial operation elsewhere. */
export function UsSupplierAnalysisPanel({ state, organizationId, role, supportedSchemaVersion, language, disabled = false, refreshToken = 0, binding }: UsSupplierAnalysisPanelProps) {
  const c = browserUsAnalysisCopy[language], id = useId();
  const identity = `${organizationId}:${binding.expectedUserId}:${role}:${supportedSchemaVersion}:${binding.accessEpoch()}`;
  const enabled = supportedSchemaVersion === 4 && state.schemaVersion === 4 && state.configuration.organizationId === organizationId && state.configuration.country === 'US' && state.configuration.currency === 'USD' && state.ledger.organizationId === organizationId && ['owner', 'admin', 'accountant'].includes(role);
  const refs = useRef({ identity, binding, disabled, enabled, organizationId, role, supportedSchemaVersion });
  const updateRefs = useEffectEvent(() => { refs.current = { identity, binding, disabled, enabled, organizationId, role, supportedSchemaVersion }; });
  useLayoutEffect(() => { updateRefs(); });
  const session = useRef<BrowserUsAnalysisSession | null>(null), generation = useRef(0), readSequence = useRef(0), lastPolicy = useRef<string | null>(null), previousRefresh = useRef(refreshToken);
  const [ownedIdentity, setOwnedIdentity] = useState(identity), [read, setRead] = useState<BrowserUsAnalysisReadiness | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [pending, setPending] = useState(false), [expired, setExpired] = useState(false), [open, setOpen] = useState(false), [consent, setConsent] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const owned = enabled && ownedIdentity === identity;
  const projection = owned ? read : null, fresh = !!projection && !expired;
  const blocked = disabled || !owned || busy || pending || loading || binding.otherBusy() || binding.otherPending();
  const canActivate = fresh && projection.mayConfigure && role === 'owner' && projection.policyVersion !== null;
  const canPause = fresh && projection.mayConfigure && ['owner', 'admin'].includes(role) && projection.mode === 'active';
  const current = (started: number, actor: string) => started === generation.current && actor === refs.current.identity;
  function fail(reason: unknown) {
    const code = reason instanceof BrowserUsAnalysisError ? reason.code : 'service_unavailable';
    if (reason instanceof BrowserUsAnalysisError && reason.outcome === 'unauthorized') {
      session.current?.dispose(); generation.current++; setRead(null); setOpen(false); setConsent(false); setPending(false); setBusy(false); setLoading(false); refs.current.binding.onReadiness(null); refs.current.binding.onPending(false); refs.current.binding.onBusy(false); refs.current.binding.onInvalidated();
    }
    setError(browserUsAnalysisError(language, code));
  }
  async function load() {
    const transport = session.current, started = generation.current, actor = refs.current.identity, number = ++readSequence.current;
    if (!transport) return;
    setLoading(true); refs.current.binding.onReadiness(null);
    try {
      const result = await transport.load(); if (!current(started, actor) || number !== readSequence.current) return;
      if (lastPolicy.current !== result.policyVersion) setConsent(false); lastPolicy.current = result.policyVersion; setRead(result); setExpired(false); setError(''); refs.current.binding.onReadiness(result);
    } catch (reason) { if (current(started, actor) && number === readSequence.current) { setRead(null); refs.current.binding.onReadiness(null); fail(reason); } }
    finally { if (current(started, actor) && number === readSequence.current) setLoading(false); }
  }
  const reset = useEffectEvent(() => { lastPolicy.current = null; setOwnedIdentity(identity); setRead(null); setBusy(false); setLoading(false); setPending(false); setExpired(false); setOpen(false); setConsent(false); setError(''); setNotice(''); });
  const loadForEffect = useEffectEvent(() => { void load(); });
  const failForEffect = useEffectEvent((reason: unknown) => { fail(reason); });
  const release = useEffectEvent((transport: BrowserUsAnalysisSession | null, callbacks: UsSupplierAnalysisBinding) => { generation.current++; transport?.dispose(); if (session.current === transport) session.current = null; callbacks.onReadiness(null); callbacks.onBusy(false); callbacks.onPending(false); });
  useEffect(() => {
    const started = ++generation.current, callbacks = refs.current.binding; let transport: BrowserUsAnalysisSession | null = null;
    queueMicrotask(() => {
      if (started !== generation.current) return; reset(); if (!enabled) return;
      try { transport = createBrowserUsAnalysisSession({ organizationId: refs.current.organizationId, expectedUserId: callbacks.expectedUserId, role: refs.current.role, supportedSchemaVersion: refs.current.supportedSchemaVersion }); session.current = transport; loadForEffect(); }
      catch (reason) { failForEffect(reason); }
    });
    return () => release(transport, callbacks);
  }, [identity, enabled]);
  const refreshForEffect = useEffectEvent(() => { if (previousRefresh.current === refreshToken) return; previousRefresh.current = refreshToken; loadForEffect(); });
  useEffect(() => { const started = generation.current; queueMicrotask(() => { if (started === generation.current) refreshForEffect(); }); }, [refreshToken]);
  const expire = useEffectEvent(() => { setExpired(true); refs.current.binding.onReadiness(null); });
  useEffect(() => {
    if (!projection) return;
    const started = generation.current, timer = setTimeout(() => { if (started === generation.current) expire(); }, Math.max(0, projection.expiresAt * 1000 - Date.now()));
    return () => clearTimeout(timer);
  }, [projection]);
  async function operate(action: 'active' | 'paused' | 'retry') {
    const transport = session.current, callbacks = refs.current.binding, started = generation.current, actor = refs.current.identity;
    if (!transport || refs.current.disabled || busy || callbacks.otherBusy() || callbacks.otherPending() || action !== 'retry' && (pending || loading || !fresh) || action === 'active' && (!canActivate || !consent) || action === 'paused' && !canPause) return;
    setBusy(true); callbacks.onBusy(true); callbacks.onReadiness(null); setError(''); setNotice('');
    try { const result = action === 'retry' ? await transport.retry() : await transport.change(action, action === 'active'); if (!current(started, actor)) return; setNotice(result.replayed ? c.replayed : c.saved); setOpen(false); setConsent(false); await load(); }
    catch (reason) { if (current(started, actor)) fail(reason); }
    finally { if (current(started, actor)) { const unresolved = transport.hasPending(); setPending(unresolved); callbacks.onPending(unresolved); setBusy(false); callbacks.onBusy(false); } }
  }
  function confirm(event: SubmitEvent<HTMLFormElement>) { event.preventDefault(); void operate('active'); }
  if (!owned) return null;
  const status = projection?.mode === 'paused' ? c.paused : projection?.availability === 'ready' && fresh ? c.active : c.blocked;
  const reason = !fresh ? loading ? c.loading : c.stale : projection.reason === 'provider_unconfigured' ? c.providerMissing : projection.reason === 'consent_required' ? c.consentRequired : projection.reason === 'quota_exhausted' ? c.quotaEmpty : projection.reason === 'quota_unconfigured' ? c.noQuota : projection.reason === 'configuration_required' || projection.reason === 'policy_unconfigured' ? c.configuration : '';
  const locale = { fr: 'fr-CH', de: 'de-CH', it: 'it-CH', en: 'en-US' }[language], count = new Intl.NumberFormat(locale), date = (value: number) => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(value * 1000);
  return <section className="us-analysis" aria-labelledby={`${id}-title`} aria-busy={busy || loading}>
    <div className="us-analysis-heading"><div><h2 id={`${id}-title`}>{c.title}</h2><p className="us-analysis-muted">{c.description}</p><span className="us-analysis-status" data-state={projection?.mode === 'paused' ? 'paused' : projection?.availability === 'ready' && fresh ? 'ready' : 'blocked'}>{status}</span></div>
      <div className="us-analysis-actions"><button className="account-button secondary" type="button" disabled={busy || loading} onClick={() => { void load(); }}>{c.refresh}</button>{projection?.mode === 'active' && ['owner', 'admin'].includes(role) && <button className="account-button secondary" type="button" disabled={blocked || !canPause} onClick={() => { void operate('paused'); }}>{c.pause}</button>}{role === 'owner' && (projection?.mode !== 'active' || projection.acceptedPolicyVersion !== projection.policyVersion) && <button className="account-button" type="button" disabled={blocked || !canActivate} onClick={() => { setOpen(true); setConsent(false); }}>{c.activate}</button>}</div>
    </div>
    {projection?.quota ? <div className="us-analysis-quota"><strong>{count.format(projection.quota.remaining)} {c.remaining} {c.limit} {count.format(projection.quota.limit)}</strong><span className="us-analysis-muted">{c.renews} {date(projection.quota.periodEnd)}</span>{projection.quota.reserved > 0 && <small>{count.format(projection.quota.reserved)} {c.reserved}</small>}</div> : <p className="us-analysis-muted">{c.noQuota}</p>}
    {reason && !(reason === c.noQuota && !projection?.quota) && <p className="us-analysis-muted">{reason}</p>}
    {role !== 'owner' && <p className="us-analysis-muted">{role === 'accountant' ? c.readonly : c.ownerOnly}</p>}
    {open && role === 'owner' && <div className="us-analysis-editor"><h3>{c.confirmTitle}</h3><dl className="us-analysis-policy"><dt>{c.policy}</dt><dd>{projection?.policyVersion ?? c.configuration}</dd></dl><form onSubmit={confirm}><fieldset disabled={blocked || !canActivate}><label className="us-analysis-check"><input name="consent" type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{c.consent}</label></fieldset><div className="us-analysis-actions"><button className="account-button" type="submit" disabled={blocked || !canActivate || !consent}>{busy ? c.saving : c.confirm}</button><button className="account-button secondary" type="button" onClick={() => { setOpen(false); setConsent(false); }}>{c.cancel}</button></div></form></div>}
    {pending && <div className="us-analysis-recovery"><p>{c.pending}</p><button className="account-button secondary" type="button" disabled={disabled || busy || binding.otherBusy() || binding.otherPending()} onClick={() => { void operate('retry'); }}>{c.retry}</button></div>}
    <div className="us-analysis-feedback" aria-live="polite" aria-atomic="true">{error && <p role="alert">{error}</p>}{notice && <p>{notice}</p>}</div>
  </section>;
}
