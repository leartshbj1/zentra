'use client';

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type SubmitEvent } from 'react';
import { ACCOUNT_ROLES, type AccountRole } from '@/lib/account-security';
import { AUTH_CHANGED_EVENT } from '@/lib/auth-browser-events';
import type { SiteLanguage } from '@/lib/site-language';
import { createUsBackgroundSync, type UsBackgroundSync } from '@/lib/international/browser-us-background-sync';
import { validateUsSupportWorkspaceProjection, validateUsSupportWorkspaceReceipt, validateUsSupportWorkspaceRequest, type UsSupportWorkspaceProjection, type UsSupportWorkspaceRequest } from '@/lib/international/us-support-workspace-contract';
import './us-erp-workbench.css';

export const usSupportWorkspaceCopy = {
  fr: { title: 'Espace Support', introduction: 'Préparez un espace Support propre à cette entreprise.', limitation: 'La connexion d’une boîte mail, la réception et le tri ne sont pas disponibles dans cet espace.', loading: 'Vérification de l’espace Support…', refresh: 'Actualiser', empty: 'L’espace Support n’est pas encore préparé.', name: 'Nom de l’espace', nameHelp: 'Entre 2 et 100 caractères. Ce nom sera conservé avec l’espace.', prepare: 'Préparer l’espace Support', working: 'Préparation…', prepared: 'Espace préparé', saved: 'L’espace Support a été préparé.', member: 'Un propriétaire ou administrateur disposant de Complet peut préparer cet espace.', pending: 'La préparation n’est pas confirmée. Réessayez la même demande ; aucun nouvel espace ne sera demandé.', retry: 'Réessayer la même demande', memory: 'Cette reprise reste dans cet onglet. Recharger ou fermer l’onglet l’efface de la mémoire.', invalid: 'Saisissez un nom de 2 à 100 caractères, sans caractères de contrôle.', unavailable: 'L’opération n’a pas pu être confirmée. Réessayez dans un instant.', denied: 'L’accès a changé. Les informations et la demande en attente ont été effacées de cet onglet. Rechargez la page après avoir vérifié votre connexion.', conflict: 'La demande diffère d’un enregistrement existant. Actualisez l’état de l’espace avant de poursuivre.' },
  de: { title: 'Support-Arbeitsbereich', introduction: 'Bereiten Sie einen eigenen Support-Arbeitsbereich für dieses Unternehmen vor.', limitation: 'Postfachverbindung, Nachrichtenempfang und Sortierung sind in diesem Arbeitsbereich nicht verfügbar.', loading: 'Support-Arbeitsbereich wird geprüft…', refresh: 'Aktualisieren', empty: 'Der Support-Arbeitsbereich ist noch nicht vorbereitet.', name: 'Name des Arbeitsbereichs', nameHelp: '2 bis 100 Zeichen. Dieser Name wird mit dem Arbeitsbereich gespeichert.', prepare: 'Support-Arbeitsbereich vorbereiten', working: 'Wird vorbereitet…', prepared: 'Arbeitsbereich vorbereitet', saved: 'Der Support-Arbeitsbereich wurde vorbereitet.', member: 'Ein Inhaber oder Administrator mit Complet kann diesen Arbeitsbereich vorbereiten.', pending: 'Die Vorbereitung ist nicht bestätigt. Wiederholen Sie dieselbe Anfrage; es wird kein neuer Arbeitsbereich angefordert.', retry: 'Dieselbe Anfrage wiederholen', memory: 'Die Wiederholung bleibt in diesem Tab. Neuladen oder Schließen löscht sie aus dem Speicher.', invalid: 'Geben Sie einen Namen mit 2 bis 100 Zeichen ohne Steuerzeichen ein.', unavailable: 'Der Vorgang konnte nicht bestätigt werden. Versuchen Sie es gleich erneut.', denied: 'Der Zugriff hat sich geändert. Informationen und ausstehende Anfrage wurden aus diesem Tab gelöscht. Prüfen Sie Ihre Anmeldung und laden Sie die Seite neu.', conflict: 'Die Anfrage weicht von einem vorhandenen Eintrag ab. Aktualisieren Sie den Zustand des Arbeitsbereichs, bevor Sie fortfahren.' },
  it: { title: 'Spazio Support', introduction: 'Prepara uno spazio Support dedicato a questa azienda.', limitation: 'Il collegamento di una casella email, la ricezione e lo smistamento non sono disponibili in questo spazio.', loading: 'Verifica dello spazio Support…', refresh: 'Aggiorna', empty: 'Lo spazio Support non è ancora preparato.', name: 'Nome dello spazio', nameHelp: 'Da 2 a 100 caratteri. Il nome sarà conservato con lo spazio.', prepare: 'Prepara lo spazio Support', working: 'Preparazione…', prepared: 'Spazio preparato', saved: 'Lo spazio Support è stato preparato.', member: 'Un titolare o amministratore con Complet può preparare questo spazio.', pending: 'La preparazione non è confermata. Riprova la stessa richiesta; non verrà richiesto un nuovo spazio.', retry: 'Riprova la stessa richiesta', memory: 'Il tentativo resta in questa scheda. Ricaricare o chiudere la scheda lo elimina dalla memoria.', invalid: 'Inserisci un nome da 2 a 100 caratteri, senza caratteri di controllo.', unavailable: 'Impossibile confermare l’operazione. Riprova tra poco.', denied: 'L’accesso è cambiato. Le informazioni e la richiesta in attesa sono state eliminate da questa scheda. Verifica l’accesso e ricarica la pagina.', conflict: 'La richiesta differisce da un record esistente. Aggiorna lo stato dello spazio prima di continuare.' },
  en: { title: 'Support workspace', introduction: 'Prepare a separate Support workspace for this company.', limitation: 'Mailbox connection, mail reception and sorting are not available in this workspace.', loading: 'Checking Support workspace…', refresh: 'Refresh', empty: 'The Support workspace has not been prepared yet.', name: 'Workspace name', nameHelp: '2 to 100 characters. This name will be retained with the workspace.', prepare: 'Prepare Support workspace', working: 'Preparing…', prepared: 'Workspace prepared', saved: 'The Support workspace has been prepared.', member: 'An owner or administrator with Complet can prepare this workspace.', pending: 'Preparation is not confirmed. Retry the same request; no new workspace will be requested.', retry: 'Retry the same request', memory: 'This retry stays in this tab. Reloading or closing the tab clears it from memory.', invalid: 'Enter a name of 2 to 100 characters without control characters.', unavailable: 'The operation could not be confirmed. Try again in a moment.', denied: 'Access changed. Information and the pending request have been cleared from this tab. Check your sign-in and reload the page.', conflict: 'The request differs from an existing record. Refresh the workspace state before continuing.' },
} as const;

export class BrowserUsSupportWorkspaceError extends Error {
  constructor(readonly code: string, readonly status = 503, readonly denied = false) { super(code); this.name = 'BrowserUsSupportWorkspaceError'; }
}
export interface BrowserUsSupportWorkspaceSession {
  load(): Promise<UsSupportWorkspaceProjection>;
  create(name: string): Promise<UsSupportWorkspaceProjection>;
  retry(): Promise<UsSupportWorkspaceProjection>;
  hasPending(): boolean;
  dispose(): void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safeErrors = new Set(['invalid_support_request', 'support_workspace_conflict', 'support_idempotency_conflict', 'configuration_changed', 'feature_unavailable', 'edition_unavailable', 'support_unavailable', 'rate_limited', 'service_unavailable']);
function fail(code = 'invalid_response', status = 503, denied = false): never { throw new BrowserUsSupportWorkspaceError(code, status, denied); }

/** One tab owns an immutable creation envelope. A background read never
 * acknowledges an uncertain POST, nor permits a second creation in its place. */
export function createBrowserUsSupportWorkspaceSession(options: { organizationId: string; expectedUserId: string; role: AccountRole; fetch?: typeof globalThis.fetch; newId?: () => string; timeoutMs?: number }): BrowserUsSupportWorkspaceSession {
  const { organizationId, expectedUserId, role } = options, timeout = options.timeoutMs ?? 15_000;
  if (!uuid.test(organizationId) || !uuid.test(expectedUserId) || !ACCOUNT_ROLES.includes(role) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) return fail('invalid_support_request', 422);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), path = `/api/international/workspaces/${organizationId}/support-workspace`;
  let disposed = false, epoch = 0, mutation = 0, sequence = 0, writing = false;
  let head: UsSupportWorkspaceProjection | null = null, pending: Readonly<{ request: UsSupportWorkspaceRequest; body: string }> | null = null;
  const controllers = new Set<AbortController>(), cancellations = new Set<() => void>();
  const alive = (stamp = epoch) => { if (disposed || stamp !== epoch) return fail('session_changed', 401, true); };
  function dispose() { if (disposed) return; disposed = true; epoch++; head = null; pending = null; for (const cancel of cancellations) cancel(); cancellations.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); }
  function projection(raw: unknown) {
    let value: UsSupportWorkspaceProjection; try { value = validateUsSupportWorkspaceProjection(raw, organizationId); } catch { return fail(); }
    if (value.userId !== expectedUserId || value.role !== role) { dispose(); return fail('session_changed', 401, true); }
    return value;
  }
  async function request(method: 'GET' | 'POST', body?: string): Promise<unknown> {
    const stamp = epoch; alive(stamp); const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel = () => {};
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserUsSupportWorkspaceError('service_unavailable')); }, timeout); });
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new BrowserUsSupportWorkspaceError('session_changed', 401, true)); cancellations.add(cancel); });
    const wait = <T,>(promise: Promise<T>) => Promise.race([promise, deadline, cancelled]);
    try {
      const response = await wait(fetcher(path, { method, headers: { Accept: 'application/json', 'X-Zentra-Expected-User': expectedUserId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }), credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive(stamp);
      if ([401, 402, 403].includes(response.status)) { void response.body?.cancel().catch(() => {}); dispose(); return fail('access_lost', response.status, true); }
      const max = response.ok ? 16_384 : 4096, length = response.headers.get('Content-Length');
      if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || length !== null && (!/^\d+$/.test(length) || Number(length) > max)) { void response.body?.cancel().catch(() => {}); return fail(); }
      const reader = response.body?.getReader(); let bytes: Uint8Array;
      if (reader) {
        const parts: Uint8Array[] = []; let size = 0;
        try { for (;;) { const part = await wait(reader.read()); alive(stamp); if (part.done) break; size += part.value.byteLength; if (size > max) { void reader.cancel().catch(() => {}); return fail(); } parts.push(part.value); } bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } }
        catch (reason) { void reader.cancel().catch(() => {}); throw reason; }
        finally { reader.releaseLock(); }
      } else { bytes = new Uint8Array(await wait(response.arrayBuffer())); alive(stamp); if (bytes.length > max) return fail(); }
      let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail(); } alive(stamp);
      if (!response.ok) {
        const candidate = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 1 && 'error' in raw ? raw.error : null;
        const code = typeof candidate === 'string' && safeErrors.has(candidate) ? candidate : 'service_unavailable';
        if (response.status === 404 && code === 'feature_unavailable' || response.status === 409 && code === 'edition_unavailable') { dispose(); return fail(code, response.status, true); }
        return fail(code, response.status);
      }
      return raw;
    } catch (reason) { if (reason instanceof BrowserUsSupportWorkspaceError) throw reason; alive(stamp); return fail('service_unavailable'); }
    finally { if (timer) clearTimeout(timer); controllers.delete(controller); cancellations.delete(cancel); }
  }
  async function send(): Promise<UsSupportWorkspaceProjection> {
    alive(); if (writing || !pending) return fail('pending_operation', 409);
    writing = true; mutation++; const original = pending;
    try {
      const raw = await request('POST', original.body); alive();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'projection,receipt,replayed' || !('projection' in raw) || !('receipt' in raw) || !('replayed' in raw) || typeof raw.replayed !== 'boolean') return fail();
      const value = projection(raw.projection); let receipt;
      try { receipt = validateUsSupportWorkspaceReceipt(raw.receipt, organizationId); } catch { return fail(); }
      if (!value.workspace || receipt.requestId !== original.request.requestId || receipt.actorUserId !== expectedUserId || receipt.workspaceId !== value.workspace.workspaceId || receipt.createdAt < value.workspace.createdAt || value.workspace.name !== original.request.name) return fail();
      head = value; pending = null; return value;
    } catch (reason) { if (reason instanceof BrowserUsSupportWorkspaceError && reason.status === 422 && reason.code === 'invalid_support_request') pending = null; throw reason; }
    finally { writing = false; mutation++; }
  }
  return {
    async load() { alive(); const version = mutation, read = ++sequence, value = projection(await request('GET')); alive(); if (version !== mutation || read !== sequence) return fail('stale_read', 0); head = value; return value; },
    async create(name) {
      alive(); if (pending || writing) return fail('pending_operation', 409); if (!head?.canCreate || !['owner', 'admin'].includes(role)) return fail('read_required', 409);
      let input: UsSupportWorkspaceRequest; try { input = validateUsSupportWorkspaceRequest({ schemaVersion: 1, requestId: (options.newId ?? (() => crypto.randomUUID()))(), name }); } catch { return fail('invalid_support_request', 422); }
      pending = Object.freeze({ request: input, body: JSON.stringify(input) }); return send();
    },
    retry: send, hasPending: () => pending !== null, dispose,
  };
}

interface SupportContentProps {
  language: SiteLanguage; projection: UsSupportWorkspaceProjection | null; name: string; busy: boolean; loading: boolean; pending: boolean; terminal: boolean; error: string; saved: boolean;
  onName: (value: string) => void; onSubmit: (event: SubmitEvent<HTMLFormElement>) => void; onRetry: () => void; onRefresh: () => void;
}
export function UsSupportWorkspaceContent({ language, projection, name, busy, loading, pending, terminal, error, saved, onName, onSubmit, onRetry, onRefresh }: SupportContentProps) {
  const c = usSupportWorkspaceCopy[language], id = useId(), blocked = busy || loading || pending || terminal;
  const message = error === 'invalid_support_request' ? c.invalid : error === 'access_lost' ? c.denied : ['support_workspace_conflict', 'support_idempotency_conflict'].includes(error) ? c.conflict : c.unavailable;
  return <section className="us-erp-workbench us-erp-section us-support-workspace" lang={language} aria-labelledby={`${id}-title`} aria-busy={busy || loading}>
    <div className="us-erp-record-heading"><h2 id={`${id}-title`}>{c.title}</h2><button className="account-button secondary" type="button" disabled={busy || loading || terminal} onClick={onRefresh}>{c.refresh}</button></div>
    <p>{c.introduction}</p><p className="us-erp-muted">{c.limitation}</p>
    {loading && !projection && <output>{c.loading}</output>}
    {projection?.workspace ? <dl className="us-erp-facts"><div><dt>{c.prepared}</dt><dd><strong>{projection.workspace.name}</strong></dd></div></dl> : projection && <p>{c.empty}</p>}
    {projection?.canCreate && <form className="us-erp-form" onSubmit={onSubmit}>
      <label htmlFor={`${id}-name`}>{c.name}<input id={`${id}-name`} name="supportWorkspaceName" autoComplete="off" value={name} required minLength={2} maxLength={100} disabled={blocked} aria-invalid={error === 'invalid_support_request' || undefined} aria-describedby={`${id}-help${error === 'invalid_support_request' ? ` ${id}-error` : ''}`} onChange={event => onName(event.target.value)} /></label>
      <small id={`${id}-help`} className="us-erp-muted">{c.nameHelp}</small><button type="submit" className="account-button" disabled={blocked || name.trim().length < 2}>{busy ? c.working : c.prepare}</button>
    </form>}
    {projection && !projection.workspace && !projection.canCreate && <p className="us-erp-muted">{c.member}</p>}
    {error && <p id={`${id}-error`} role="alert">{message}</p>}{saved && <output>{c.saved}</output>}
    {pending && <aside className="us-erp-pending"><p>{c.pending}</p><p>{c.memory}</p><button type="button" className="account-button" disabled={busy || terminal} onClick={onRetry}>{busy ? c.working : c.retry}</button></aside>}
  </section>;
}

export interface UsSupportWorkspacePanelProps {
  organizationId: string; expectedUserId: string; role: AccountRole; language: SiteLanguage; admitted?: boolean; active?: boolean; accessEpoch?: number;
  currentAccessEpoch?: () => number; registerInvalidation?: (invalidate: (() => void) | null) => void; onIdentityLost?: () => void;
}
export function UsSupportWorkspacePanel({ organizationId, expectedUserId, role, language, admitted = true, active = true, accessEpoch = 0, currentAccessEpoch, registerInvalidation, onIdentityLost }: UsSupportWorkspacePanelProps) {
  const identity = `${organizationId}:${expectedUserId}:${role}:${accessEpoch}`, usable = admitted && accessEpoch === 0;
  const refs = useRef({ identity, active, currentAccessEpoch, accessEpoch, onIdentityLost }), generation = useRef(0), mutation = useRef(0), busyRef = useRef(false), loadingRef = useRef(false), transport = useRef<BrowserUsSupportWorkspaceSession | null>(null), scheduler = useRef<UsBackgroundSync | null>(null), head = useRef<UsSupportWorkspaceProjection | null>(null);
  const [ownedIdentity, setOwnedIdentity] = useState(identity), [read, setRead] = useState<UsSupportWorkspaceProjection | null>(null), [name, setName] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [terminal, setTerminal] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  useLayoutEffect(() => { refs.current = { identity, active, currentAccessEpoch, accessEpoch, onIdentityLost }; });
  const current = (stamp: number, actor: string) => generation.current === stamp && refs.current.identity === actor && (refs.current.currentAccessEpoch?.() ?? refs.current.accessEpoch) === refs.current.accessEpoch;
  function invalidate() { generation.current++; transport.current?.dispose(); transport.current = null; scheduler.current?.dispose(); scheduler.current = null; head.current = null; busyRef.current = false; loadingRef.current = false; setRead(null); setName(''); setPending(false); setBusy(false); setLoading(false); setSaved(false); setTerminal(true); setError('access_lost'); }
  function failure(reason: unknown) {
    if (reason instanceof BrowserUsSupportWorkspaceError && reason.denied) { invalidate(); if (reason.status === 401) refs.current.onIdentityLost?.(); }
    else setError(reason instanceof BrowserUsSupportWorkspaceError ? reason.code : 'service_unavailable');
  }
  async function load(quiet = false) {
    const session = transport.current, stamp = generation.current, actor = refs.current.identity, version = mutation.current;
    if (!session || loadingRef.current || busyRef.current || !current(stamp, actor)) return;
    loadingRef.current = true; if (!quiet) setLoading(true);
    try { const value = await session.load(); if (!current(stamp, actor) || version !== mutation.current) return; if (JSON.stringify(head.current) !== JSON.stringify(value)) { head.current = value; setRead(value); } if (!quiet) setError(''); }
    catch (reason) { if (current(stamp, actor)) { if (reason instanceof BrowserUsSupportWorkspaceError && reason.code === 'stale_read') return; if (quiet && !(reason instanceof BrowserUsSupportWorkspaceError && reason.denied)) throw reason; failure(reason); } }
    finally { if (current(stamp, actor)) { loadingRef.current = false; if (!quiet) setLoading(false); } }
  }
  const mount = useEffectEvent(() => { setOwnedIdentity(identity); setRead(null); head.current = null; setName(''); setPending(false); setBusy(false); setLoading(false); setTerminal(false); setError(''); setSaved(false); busyRef.current = false; loadingRef.current = false; if (!usable) { invalidate(); return; } try { transport.current = createBrowserUsSupportWorkspaceSession({ organizationId, expectedUserId, role }); void load(); scheduler.current = createUsBackgroundSync({ intervalMs: 30_000, ready: () => refs.current.active && !busyRef.current && !loadingRef.current, tick: () => load(true), onError: () => {} }); } catch (reason) { failure(reason); } });
  const release = useEffectEvent(() => { generation.current++; transport.current?.dispose(); transport.current = null; scheduler.current?.dispose(); scheduler.current = null; head.current = null; });
  useEffect(() => { const stamp = ++generation.current; queueMicrotask(() => { if (generation.current === stamp) mount(); }); return () => release(); }, [identity, usable]);
  const invalidateEvent = useEffectEvent(() => invalidate());
  useEffect(() => { registerInvalidation?.(() => invalidateEvent()); return () => registerInvalidation?.(null); }, [registerInvalidation]);
  const identityLost = useEffectEvent(() => { invalidate(); refs.current.onIdentityLost?.(); });
  useEffect(() => { const changed = (event: Event) => { if (event instanceof StorageEvent && event.key !== AUTH_CHANGED_EVENT && !event.key?.startsWith('sb-') && event.key !== null) return; identityLost(); }; window.addEventListener(AUTH_CHANGED_EVENT, changed); window.addEventListener('storage', changed); return () => { window.removeEventListener(AUTH_CHANGED_EVENT, changed); window.removeEventListener('storage', changed); }; }, []);
  useEffect(() => { if (active) scheduler.current?.wake(); }, [active]);
  async function operate(retry: boolean) {
    const session = transport.current, stamp = generation.current, actor = refs.current.identity;
    if (!session || busyRef.current || !current(stamp, actor) || !retry && (loadingRef.current || session.hasPending() || !head.current?.canCreate)) return;
    busyRef.current = true; mutation.current++; setBusy(true); setError(''); setSaved(false);
    try { const value = await (retry ? session.retry() : session.create(name)); if (!current(stamp, actor)) return; head.current = value; setRead(value); setName(''); setSaved(true); }
    catch (reason) { if (current(stamp, actor)) failure(reason); }
    finally { if (current(stamp, actor)) { setPending(session.hasPending()); busyRef.current = false; setBusy(false); } }
  }
  const owned = usable && ownedIdentity === identity;
  return <UsSupportWorkspaceContent language={language} projection={owned ? read : null} name={owned ? name : ''} busy={owned && busy} loading={owned && loading} pending={owned && pending} terminal={!owned || terminal} error={!owned ? 'access_lost' : error} saved={owned && saved} onName={setName} onSubmit={event => { event.preventDefault(); void operate(false); }} onRetry={() => { void operate(true); }} onRefresh={() => { void load(); }} />;
}
