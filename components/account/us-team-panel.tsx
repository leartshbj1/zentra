'use client';

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type SubmitEvent } from 'react';
import type { AccountRole } from '../../lib/account-security';
import type { SiteLanguage } from '../../lib/site-language';
import { AUTH_CHANGED_EVENT } from '../../lib/auth-browser-events';
import type { UsTeamInviteRole, UsTeamProjection } from '../../lib/international/us-team-contract';
import { usTeamCanManageRole } from '../../lib/international/us-team-validation';
import { BrowserUsTeamError, createBrowserUsTeamSession, type BrowserUsTeamDraft, type BrowserUsTeamSession } from '../../lib/international/browser-us-team-session';
import { browserUsTeamCopy, browserUsTeamError } from '../../lib/international/browser-us-team-copy';
import './us-team-panel.css';
import { useUsBackgroundChannel, type UsBackgroundRegistration } from './us-background-channel';

type TeamRemoval = { action: 'revoke_invitation'; invitationId: string } | { action: 'revoke_member'; membershipId: string };
export interface UsTeamPanelProps { organizationId: string; expectedUserId: string; role: AccountRole; language: SiteLanguage; disabled?: boolean; admitted?: boolean; accessEpoch?: () => number; onInvalidated?: () => void; registerBackground?: UsBackgroundRegistration }
export function UsTeamPanel({ organizationId, expectedUserId, role, language, disabled = false, admitted = true, accessEpoch, onInvalidated, registerBackground }: UsTeamPanelProps) {
  const c = browserUsTeamCopy[language], id = useId(), identity = `${organizationId}:${expectedUserId}:${role}:${accessEpoch?.() ?? 0}`;
  const refs = useRef({ identity, disabled, onInvalidated });
  const update = useEffectEvent(() => { refs.current = { identity, disabled, onInvalidated }; }); useLayoutEffect(() => { update(); });
  const session = useRef<BrowserUsTeamSession | null>(null), generation = useRef(0), readSequence = useRef(0), linkRef = useRef<HTMLInputElement>(null), mutation = useRef(0), quietRead = useRef<Promise<boolean> | null>(null), loadingRef = useRef(false), readRef = useRef<UsTeamProjection | null>(null);
  const [ownedIdentity, setOwnedIdentity] = useState(identity), [head, setHead] = useState<UsTeamProjection | null>(null), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [pending, setPending] = useState(false), [open, setOpen] = useState(false), [email, setEmail] = useState(''), [inviteRole, setInviteRole] = useState<UsTeamInviteRole | ''>(''), [confirmation, setConfirmation] = useState<TeamRemoval | null>(null), [link, setLink] = useState<string | null>(null), [lostLink, setLostLink] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const owned = admitted && ownedIdentity === identity, read = owned ? head : null, managers = role === 'owner' || role === 'admin', blocked = disabled || busy || loading || pending || !read;
  const current = (started: number, actor: string) => generation.current === started && refs.current.identity === actor;
  function fail(reason: unknown) { if (reason instanceof BrowserUsTeamError && reason.outcome === 'unauthorized') { session.current?.dispose(); generation.current++; setHead(null); setEmail(''); setInviteRole(''); setOpen(false); setConfirmation(null); setLink(null); setLostLink(false); setPending(false); setBusy(false); setLoading(false); refs.current.onInvalidated?.(); } else if (reason instanceof BrowserUsTeamError && ['team_revision_conflict', 'team_idempotency_conflict', 'read_required'].includes(reason.code)) { setHead(null); setConfirmation(null); } setError(browserUsTeamError(language, reason instanceof BrowserUsTeamError ? reason.code : 'service_unavailable')); }
  async function load(background = false): Promise<boolean> {
    const transport = session.current, started = generation.current, actor = refs.current.identity, version = mutation.current;
    if (!transport || loadingRef.current || quietRead.current || background && (refs.current.disabled || busy || transport.hasPending())) return false;
    loadingRef.current = true; if (!background) setLoading(true);
    const operation = (async () => {
      try { const value = await transport.load(); if (!current(started, actor) || version !== mutation.current || background && transport.hasPending()) return false;
        const previous = readRef.current;
        if (!previous || JSON.stringify({ ...value, checkedAt: 0 }) !== JSON.stringify({ ...previous, checkedAt: 0 })) { readSequence.current++; setConfirmation(null); }
        readRef.current = value; setHead(value);
        if (!background) setError(''); return true;
      } catch (reason) { if (!current(started, actor)) return false; if (background && !(reason instanceof BrowserUsTeamError && reason.outcome === 'unauthorized')) throw reason; if (!background) setHead(null); fail(reason); return false; }
      finally { if (current(started, actor)) { loadingRef.current = false; if (!background) setLoading(false); } }
    })();
    if (background) quietRead.current = operation;
    try { return await operation; } finally { if (quietRead.current === operation) quietRead.current = null; }
  }
  useUsBackgroundChannel(registerBackground, () => load(true));
  const reset = useEffectEvent(() => { loadingRef.current = false; quietRead.current = null; readRef.current = null; readRef.current = null; setOwnedIdentity(identity); setHead(null); setLoading(false); setBusy(false); setPending(false); setEmail(''); setInviteRole(''); setOpen(false); setConfirmation(null); setLink(null); setLostLink(false); setNotice(''); setError(''); });
  const loadEffect = useEffectEvent(() => { void load(); }); const failEffect = useEffectEvent((reason: unknown) => { fail(reason); });
  const release = useEffectEvent((transport: BrowserUsTeamSession | null) => { generation.current++; transport?.dispose(); if (session.current === transport) session.current = null; });
  useEffect(() => { const started = ++generation.current; let transport: BrowserUsTeamSession | null = null; queueMicrotask(() => { if (generation.current !== started) return; reset(); if (!admitted) return; try { transport = createBrowserUsTeamSession({ organizationId, expectedUserId, role }); session.current = transport; loadEffect(); } catch (reason) { failEffect(reason); } }); return () => release(transport); }, [identity, organizationId, expectedUserId, role, admitted]);
  const revoke = useEffectEvent(() => { fail(new BrowserUsTeamError('session_changed', 0, 'unauthorized')); });
  useEffect(() => { const changed = (event: Event) => { if (event instanceof StorageEvent && event.key !== AUTH_CHANGED_EVENT && !event.key?.startsWith('sb-') && event.key !== null) return; revoke(); }; window.addEventListener(AUTH_CHANGED_EVENT, changed); window.addEventListener('storage', changed); return () => { window.removeEventListener(AUTH_CHANGED_EVENT, changed); window.removeEventListener('storage', changed); }; }, []);
  async function operate(draft: BrowserUsTeamDraft | 'retry') {
    if (quietRead.current) { const reviewed = readSequence.current; try { if (!await quietRead.current || reviewed !== readSequence.current) return; } catch { return; } }
    const transport = session.current, actor = refs.current.identity, started = generation.current; if (!transport || refs.current.disabled || busy || draft !== 'retry' && (loading || pending || !read)) return; mutation.current++; setBusy(true); setError(''); setNotice(''); setLink(null); setLostLink(false);
    try { const value = draft === 'retry' ? await transport.retry() : await transport.change(draft); if (!current(started, actor)) return;
      // This receipt can be historical. Only a subsequent GET becomes head.
      setNotice(value.replayed ? c.replayed : c.saved); setConfirmation(null); setOpen(false); setEmail(''); setInviteRole(''); setLink(value.invitationLink ? new URL(value.invitationLink, window.location.origin).href : null); setLostLink(['create_invitation', 'regenerate_invitation'].includes(value.receipt.action) && !value.invitationLink); await load(); }
    catch (reason) { if (current(started, actor)) fail(reason); }
    finally { if (current(started, actor)) { setPending(transport.hasPending()); setBusy(false); } }
  }
  function submit(event: SubmitEvent<HTMLFormElement>) { event.preventDefault(); if (!inviteRole) return; void operate({ action: 'create_invitation', email, role: inviteRole }); }
  async function copy() { if (!link || !owned) return; const actor = refs.current.identity; const absolute = new URL(link, window.location.origin).href; try { await navigator.clipboard.writeText(absolute); if (actor === refs.current.identity) setNotice(c.copied); } catch { if (actor === refs.current.identity) { linkRef.current?.focus(); linkRef.current?.select(); setError(c.copyFailed); } } }
  if (!owned) return null;
  const locale = { fr: 'fr-CH', de: 'de-CH', it: 'it-CH', en: 'en-US' }[language], date = (value: number) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(value * 1000);
  return <section className="us-team" lang={language} aria-labelledby={`${id}-title`} aria-busy={busy || loading}>
    <div className="us-team-heading"><div><h2 id={`${id}-title`}>{c.title}</h2><p className="us-team-muted">{c.description}</p></div><div className="us-team-actions"><button className="account-button secondary" type="button" disabled={busy || loading || disabled} onClick={() => { void load(); }}>{loading ? c.loading : c.refresh}</button>{managers && <button className="account-button" type="button" disabled={blocked || !read || read.remainingSeats === 0} onClick={() => { setOpen(true); setConfirmation(null); }}>{c.invite}</button>}</div></div>
    {read && <><div className="us-team-capacity"><strong>{read.remainingSeats} {c.seats} {c.of} {read.seatLimit}</strong><p className="us-team-muted">{read.reservedInvitations} {c.reserved}</p></div>{read.remainingSeats === 0 && managers && <p className="us-team-muted">{c.noSeats}</p>}
      <div className="us-team-group"><h3>{c.members}</h3><ul className="us-team-list">{read.members.map(member => <li key={member.membershipId}><div><strong>{member.displayName ?? c.unnamed}</strong><p className="us-team-muted">{c[member.role]}</p></div>{managers && member.userId !== expectedUserId && usTeamCanManageRole(role, member.role) && <button className="account-button secondary" type="button" disabled={blocked} onClick={() => { setConfirmation({ action: 'revoke_member', membershipId: member.membershipId }); setOpen(false); }}>{c.revoke}</button>}</li>)}</ul></div>
      {managers && <div className="us-team-group"><h3>{c.invitations}</h3>{read.invitations.length ? <ul className="us-team-list">{read.invitations.map(invitation => <li key={invitation.invitationId}><div><strong>{invitation.email}</strong><p className="us-team-muted">{c[invitation.role]} · {c.expires} {date(invitation.expiresAt)}</p></div>{usTeamCanManageRole(role, invitation.role) && <div className="us-team-actions"><button className="account-button secondary" type="button" disabled={blocked} onClick={() => { void operate({ action: 'regenerate_invitation', invitationId: invitation.invitationId }); }}>{c.regenerate}</button><button className="account-button secondary" type="button" disabled={blocked} onClick={() => { setConfirmation({ action: 'revoke_invitation', invitationId: invitation.invitationId }); setOpen(false); }}>{c.revokeInvite}</button></div>}</li>)}</ul> : <p className="us-team-muted">{c.emptyInvitations}</p>}</div>}
    </>}
    {!managers && <p className="us-team-muted">{c.readOnly}</p>}
    {open && managers && <div className="us-team-editor"><h3>{c.invite}</h3><form onSubmit={submit}><fieldset disabled={blocked}><label>{c.email}<input name="email" autoComplete="email" type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label><label>{c.role}<select aria-label={c.role} name="role" required value={inviteRole} onChange={event => setInviteRole(event.target.value as UsTeamInviteRole | '')}><option value="">{c.choose}</option>{(['admin', 'accountant', 'member', 'read_only'] as const).filter(value => usTeamCanManageRole(role, value)).map(value => <option key={value} value={value}>{c[value]}</option>)}</select></label></fieldset><div className="us-team-actions"><button className="account-button" type="submit" disabled={blocked || !email.trim() || !inviteRole}>{busy ? c.working : c.create}</button><button className="account-button secondary" type="button" disabled={busy} onClick={() => setOpen(false)}>{c.cancel}</button></div></form></div>}
    {confirmation && <section className="us-team-confirm" aria-labelledby={`${id}-confirm`}><h3 id={`${id}-confirm`}>{c.revokeTitle}</h3><p><strong>{confirmation.action === 'revoke_member' ? read?.members.find(row => row.membershipId === confirmation.membershipId)?.displayName ?? c.unnamed : read?.invitations.find(row => row.invitationId === confirmation.invitationId)?.email}</strong></p><p>{confirmation.action === 'revoke_member' ? c.revokeHelp : c.revokeInvitationHelp}</p><div className="us-team-actions"><button className="account-button" type="button" disabled={blocked} onClick={() => { void operate(confirmation); }}>{c.confirmRevoke}</button><button className="account-button secondary" type="button" disabled={busy} onClick={() => setConfirmation(null)}>{c.cancel}</button></div></section>}
    {link && <div className="us-team-link"><p>{c.linkOnly}</p><input ref={linkRef} aria-label={c.copy} readOnly value={link} /><button className="account-button secondary" type="button" onClick={() => { void copy(); }}>{c.copy}</button></div>}
    {lostLink && <p className="us-team-muted">{c.lostLink}</p>}
    {pending && <div className="us-team-recovery"><p>{c.pending}</p><button className="account-button secondary" type="button" disabled={busy || disabled} onClick={() => { void operate('retry'); }}>{c.retry}</button></div>}
    <div className="us-team-feedback" aria-live="polite" aria-atomic="true">{error && <p role="alert">{error}</p>}{notice && <p>{notice}</p>}</div>
  </section>;
}
