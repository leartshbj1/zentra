'use client';

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type SubmitEvent } from 'react';
import type { SiteLanguage } from '../../lib/site-language';
import { AUTH_CHANGED_EVENT } from '../../lib/auth-browser-events';
import type { UsTeamResolution } from '../../lib/international/us-team-contract';
import { BrowserUsTeamError, captureUsTeamInvitationFragment, createBrowserUsTeamInvitationSession, type BrowserUsTeamInvitationSession } from '../../lib/international/browser-us-team-session';
import { browserUsTeamCopy, browserUsTeamError } from '../../lib/international/browser-us-team-copy';
import './us-team-panel.css';
import './us-team-invitation.css';

export interface UsTeamInvitationProps { language: SiteLanguage; expectedUserId: string | null; authenticatedEmail?: string }
export function UsTeamInvitation({ language, expectedUserId, authenticatedEmail }: UsTeamInvitationProps) {
  const c = browserUsTeamCopy[language], id = useId(), identity = expectedUserId ?? 'signed-out';
  const refs = useRef(identity), session = useRef<BrowserUsTeamInvitationSession | null>(null), generation = useRef(0), bootstrap = useRef<{ identity: string; token: string | null } | null>(null);
  const update = useEffectEvent(() => { refs.current = identity; }); useLayoutEffect(() => { update(); });
  const [ownedIdentity, setOwnedIdentity] = useState(identity), [tokenAvailable, setTokenAvailable] = useState(false), [resolution, setResolution] = useState<UsTeamResolution | null>(null), [busy, setBusy] = useState(false), [pending, setPending] = useState(false), [expired, setExpired] = useState(false), [firstName, setFirstName] = useState(''), [lastName, setLastName] = useState(''), [joinedOrganization, setJoinedOrganization] = useState<string | null>(null), [error, setError] = useState('');
  const owned = ownedIdentity === identity, read = owned ? resolution : null, current = (started: number, actor: string) => started === generation.current && actor === refs.current;
  function fail(reason: unknown) { if (reason instanceof BrowserUsTeamError && reason.outcome === 'unauthorized') { bootstrap.current = { identity: refs.current, token: null }; session.current?.dispose(); generation.current++; setTokenAvailable(false); setResolution(null); setFirstName(''); setLastName(''); setPending(false); setBusy(false); } setError(browserUsTeamError(language, reason instanceof BrowserUsTeamError ? reason.code : 'service_unavailable')); }
  const reset = useEffectEvent(() => { setOwnedIdentity(identity); setResolution(null); setTokenAvailable(false); setBusy(false); setPending(false); setExpired(false); setFirstName(''); setLastName(''); setJoinedOrganization(null); setError(''); });
  const failEffect = useEffectEvent((reason: unknown) => { fail(reason); });
  const release = useEffectEvent((transport: BrowserUsTeamInvitationSession | null) => { const released = ++generation.current; transport?.dispose(); if (session.current === transport) session.current = null; queueMicrotask(() => { if (generation.current === released) bootstrap.current = { identity: refs.current, token: null }; }); });
  useLayoutEffect(() => {
    const started = ++generation.current; let transport: BrowserUsTeamInvitationSession | null = null;
    // Synchronous client bootstrap: remove even an invalid fragment before
    // any request. The page/layout intentionally installs no URL analytics.
    if (!bootstrap.current) bootstrap.current = { identity, token: captureUsTeamInvitationFragment(window.location, window.history) };
    else if (bootstrap.current.identity !== identity) bootstrap.current = { identity, token: null };
    const token = bootstrap.current.token;
    queueMicrotask(() => { if (started !== generation.current) return; reset(); if (!expectedUserId || !token) { bootstrap.current = { identity, token: null }; return; } try { transport = createBrowserUsTeamInvitationSession({ expectedUserId, token }); session.current = transport; setTokenAvailable(true); } catch (reason) { bootstrap.current = { identity, token: null }; failEffect(reason); } });
    return () => release(transport);
  }, [identity, expectedUserId]);
  const revoke = useEffectEvent(() => { bootstrap.current = { identity, token: null }; fail(new BrowserUsTeamError('session_changed', 0, 'unauthorized')); });
  useEffect(() => { const changed = (event: Event) => { if (event instanceof StorageEvent && event.key !== AUTH_CHANGED_EVENT && !event.key?.startsWith('sb-') && event.key !== null) return; revoke(); }; window.addEventListener(AUTH_CHANGED_EVENT, changed); window.addEventListener('storage', changed); return () => { window.removeEventListener(AUTH_CHANGED_EVENT, changed); window.removeEventListener('storage', changed); }; }, []);
  const markExpired = useEffectEvent(() => { setExpired(true); });
  useEffect(() => { if (!read) return; const started = generation.current, timer = setTimeout(() => { if (generation.current === started) markExpired(); }, Math.max(0, read.expiresAt * 1000 - Date.now())); return () => clearTimeout(timer); }, [read]);
  async function operate(action: 'resolve' | 'accept' | 'retry') { const transport = session.current, started = generation.current, actor = refs.current; if (!transport || busy || action !== 'retry' && pending || action === 'accept' && (!read || expired || !firstName.trim() || !lastName.trim())) return; setBusy(true); setError('');
    try { if (action === 'resolve') { const value = await transport.resolve(); if (current(started, actor)) { bootstrap.current = { identity: actor, token: null }; setResolution(value); setExpired(false); } }
      else { const value = action === 'retry' ? await transport.retry() : await transport.accept(firstName, lastName); if (current(started, actor)) { setJoinedOrganization(value.receipt.organizationId); setResolution(null); setTokenAvailable(false); setFirstName(''); setLastName(''); } } }
    catch (reason) { if (current(started, actor)) fail(reason); }
    finally { if (current(started, actor)) { setPending(transport.hasPending()); setBusy(false); } }
  }
  function accept(event: SubmitEvent<HTMLFormElement>) { event.preventDefault(); void operate('accept'); }
  const locale = { fr: 'fr-CH', de: 'de-CH', it: 'it-CH', en: 'en-US' }[language];
  return <section className="us-team-invitation" lang={language} aria-labelledby={`${id}-title`} aria-busy={busy}>
    <h2 id={`${id}-title`}>{owned && joinedOrganization ? c.joined : c.joinTitle}</h2>
    {owned && joinedOrganization ? <div className="us-team-actions"><a className="account-button" href={`/compte/espaces/us/${encodeURIComponent(joinedOrganization)}?reglage=gestion`}>{c.openWorkspace}</a></div> : <>
      <p className="us-team-muted">{c.joinIntro}</p>
      {!expectedUserId ? <><p>{c.signInHelp}</p><a className="account-button" href="/connexion?retour=%2Finvitation%2Fus">{c.signIn}</a></> : owned && <>
        {authenticatedEmail && <p className="us-team-muted">{c.recipient} : <strong>{authenticatedEmail}</strong> <a className="us-team-change-account" href="/connexion?autre=1&retour=%2Finvitation%2Fus">{c.changeAccount}</a></p>}
        {!tokenAvailable && <><p>{c.noToken}</p>{error && <p className="us-team-muted">{c.signInHelp}</p>}</>}
        {tokenAvailable && !read && <button className="account-button" type="button" disabled={busy || pending} onClick={() => { void operate('resolve'); }}>{busy ? c.loading : c.resolve}</button>}
        {read && <><dl className="us-team-invitation-facts"><div><dt>{c.company}</dt><dd>{read.organizationName}</dd></div><div><dt>{c.role}</dt><dd>{c[read.role]}</dd></div><div><dt>{c.expires}</dt><dd>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(read.expiresAt * 1000)}</dd></div></dl><p className="us-team-muted">{c.acceptanceHelp}</p><form onSubmit={accept}><fieldset disabled={busy || pending || expired}>
          {/* Standard Text-group tokens: https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill — this lint version still rejects them with type="text"; scoped diagnostic retained in QA. */}
          <label>{c.firstName}<input type="text" name="firstName"
            // oxlint-disable-next-line jsx-a11y/autocomplete-valid
            autoComplete="given-name" required maxLength={70} value={firstName} onChange={event => setFirstName(event.target.value)} /></label>
          <label>{c.lastName}<input type="text" name="lastName"
            // oxlint-disable-next-line jsx-a11y/autocomplete-valid
            autoComplete="family-name" required maxLength={70} value={lastName} onChange={event => setLastName(event.target.value)} /></label>
        </fieldset><div className="us-team-actions"><button className="account-button" type="submit" disabled={busy || pending || expired || !firstName.trim() || !lastName.trim()}>{busy ? c.working : c.accept}</button></div></form>{expired && !pending && <p>{c.invalidInvitation}</p>}</>}
        {pending && <div className="us-team-recovery"><p>{c.pending}</p><button className="account-button secondary" type="button" disabled={busy} onClick={() => { void operate('retry'); }}>{c.retry}</button></div>}
      </>}
    </>}
    <div className="us-team-feedback" aria-live="polite" aria-atomic="true">{owned && error && <p role="alert">{error}</p>}</div>
  </section>;
}
