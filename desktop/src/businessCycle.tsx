import { createContext, lazy, Suspense, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Cloud, LoaderCircle, Pause, RefreshCw } from 'lucide-react';
import { desktopApi } from './bridge';
import { BUSINESS_HISTORY_CHANGED, BUSINESS_HISTORY_STATUS } from './businessHistoryState';
import { sameBusinessSelection, type BusinessCycleState, type BusinessCycleStatus, type BusinessHistorySelection } from './businessCycleScheduler';
import { BUSINESS_CYCLE_PREFERENCE, parseBusinessCyclePreference, startBusinessCycleSession } from './businessCycleSession';
import { acquireBusinessWorkspaceLock, businessLockSnapshot, subscribeBusinessLock } from './businessWorkspaceLock';
import { startBusinessResolutionSession, validateBusinessResolutionResult, type BusinessPendingResolution, type BusinessResolutionAction, type BusinessResolutionTarget } from './businessResolutionSession';
import type { Workspace } from './types';
import { Button } from './ui';
import { errorMessage } from './utils';
import './businessCycle.css';

type State = {
  phase: 'loading' | BusinessCycleState['state'];
  selection?: BusinessHistorySelection;
  enabled: boolean;
  working: boolean;
  online: boolean;
  status?: BusinessCycleStatus;
  error?: string;
  resolution?: BusinessPendingResolution | null;
  notice?: string;
};
type Controls = State & { accountScope: string; enable: () => void; pause: () => void; wake: () => void; resolve: (target: BusinessResolutionTarget, action: BusinessResolutionAction) => void };
const BusinessConflictDialog = lazy(() => import('./BusinessConflictDialog'));
export const BusinessCycleContext = createContext<Controls | null>(null);
let previousDrain: Promise<void> = Promise.resolve();
let drainPending = false;

export function useBusinessCycleBackground(options: {
  accountScope: string;
  connected: boolean;
  canInstall: () => boolean;
  onWorkspace: (workspace: Workspace) => void;
}) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const [state, setState] = useState<State>({ phase: 'loading', enabled: false, working: false, online: navigator.onLine !== false });
  const commands = useRef({ enable: () => {}, pause: () => {}, wake: () => {}, resolve: (_target: BusinessResolutionTarget, _action: BusinessResolutionAction) => {} });
  useLayoutEffect(() => {
    let active = true;
    let working = false;
    let pausedByUser = false;
    let choice: BusinessHistorySelection | undefined;
    let session: ReturnType<typeof startBusinessCycleSession> | undefined;
    let resolutionSession: ReturnType<typeof startBusinessResolutionSession> | undefined;
    let work: Promise<void> = Promise.resolve();
    const prior = previousDrain;
    const startupLock = drainPending ? acquireBusinessWorkspaceLock() : undefined;
    const publish = (next: Partial<State>) => { if (active) setState(old => ({ ...old, ...next })); };
    const failed = (reason: unknown) => publish({ error: errorMessage(reason, 'La synchronisation est interrompue. Les modifications locales sont conservées.') });
    const refresh = async () => {
      if (!active) return;
      const workspace = await desktopApi.loadWorkspace();
      if (active) {
        flushSync(() => latest.current.onWorkspace(workspace));
        publish({ error: undefined });
      }
    };
    function start(selection: BusinessHistorySelection) {
      session = startBusinessCycleSession({
        selection,
        synchronize: desktopApi.syncBusinessCycle,
        respond: desktopApi.respondBusinessInstallation,
        pause: desktopApi.pauseBusinessCycle,
        isOnline: () => navigator.onLine !== false,
        isCurrent: () => active,
        canInstall: () => active && latest.current.canInstall(),
        acquire: acquireBusinessWorkspaceLock,
        refreshWorkspace: refresh,
        onStatus: status => {
          const held = ['conflict', 'invalid', 'paused'].includes(status.state);
          if (held) {
            try { localStorage.removeItem(BUSINESS_CYCLE_PREFERENCE); } catch { /* Native session is held regardless of preference storage. */ }
          }
          publish({ status, enabled: !held, error: undefined,
            resolution: status.detail?.state === 'resolution_pending' ? status.detail.resolution as BusinessPendingResolution : undefined });
          if (status.workspace_changed) window.dispatchEvent(new Event('zentra-project-documents-changed'));
        },
        onError: failed,
      });
      publish({ enabled: true, status: undefined, error: undefined });
    }
    async function discover(resume: boolean) {
      const result = await desktopApi.getBusinessCycleState();
      if (!active) return;
      const previousChoice = choice;
      choice = result.state === 'ready' ? result.selection : undefined;
      if (previousChoice && choice && !sameBusinessSelection(previousChoice, choice)) publish({ status: undefined });
      const resolution = result.state === 'ready' ? result.resolution : undefined;
      publish({ phase: result.state, selection: choice, resolution });
      if (resolution) {
        try { localStorage.removeItem(BUSINESS_CYCLE_PREFERENCE); } catch { /* A protected resolution never implicitly resumes. */ }
        publish({ enabled: false });
      }
      if (resume && choice && !pausedByUser && !resolution) {
        let stored: BusinessHistorySelection | null = null;
        try { stored = parseBusinessCyclePreference(localStorage.getItem(BUSINESS_CYCLE_PREFERENCE)); } catch { /* No implicit activation without a readable preference. */ }
        if (stored && sameBusinessSelection(choice, stored)) start(choice);
      }
      return result;
    }
    async function initialize() {
      await prior;
      if (!active) { startupLock?.release(); return; }
      try {
        if (startupLock) { await refresh(); startupLock.release(); }
        if (options.connected) await discover(true);
        else publish({ phase: 'waiting_for_connection' });
      } catch (reason) {
        startupLock?.failed(reason, initialize);
        failed(reason);
      }
    }
    const initial = initialize();
    function run(action: () => Promise<void>) {
      if (!active || working) return;
      working = true;
      publish({ working: true, error: undefined });
      work = initial.then(async () => { if (active) await action(); }).catch(failed).finally(() => { working = false; publish({ working: false }); });
    }
    const wake = () => {
      publish({ online: navigator.onLine !== false });
      if (session) session.wake();
      else if (options.connected) run(async () => { if (session) session.wake(); else await discover(true); });
    };
    commands.current = {
      wake,
      enable: () => run(async () => {
        await initial;
        await session?.stop();
        session = undefined;
        publish({ enabled: false });
        const selected = choice;
        const available = await discover(false);
        if (!active) return;
        if (available?.state === 'ready' && available.resolution) throw new Error('Reprenez ou annulez la résolution protégée avant de relancer la synchronisation.');
        if (!selected || !choice || !sameBusinessSelection(selected, choice))
          throw new Error('Le dossier disponible a changé. Vérifiez votre entreprise puis activez ce dossier.');
        localStorage.setItem(BUSINESS_CYCLE_PREFERENCE, JSON.stringify(choice));
        pausedByUser = false;
        start(choice);
      }),
      pause: () => {
        // Stop accepting installation permission immediately, before any await.
        pausedByUser = true;
        try { localStorage.removeItem(BUSINESS_CYCLE_PREFERENCE); } catch (reason) { failed(reason); }
        const stopping = session?.stop();
        working = true;
        publish({ enabled: false, working: true });
        work = Promise.all([initial, work, stopping]).then(() => {
          session = undefined; publish({ status: undefined });
        }).catch(failed).finally(() => { working = false; publish({ working: false }); });
      },
      resolve: (target, action) => run(async () => {
        await session?.stop(); session = undefined;
        publish({ enabled: false, notice: undefined });
        localStorage.removeItem(BUSINESS_CYCLE_PREFERENCE);
        await discover(false);
        if (!active || !choice) throw new Error('Reconnectez le compte de cette entreprise.');
        const selected = choice;
        resolutionSession = startBusinessResolutionSession({
          selection: selected,
          invoke: permission => desktopApi.resolveBusinessConflict(selected, target, action, permission),
          respond: desktopApi.respondBusinessInstallation, pause: desktopApi.pauseBusinessCycle,
          isCurrent: () => active, canInstall: () => latest.current.canInstall(),
          acquire: acquireBusinessWorkspaceLock, refresh,
        });
        try {
          const result = await resolutionSession.done;
          validateBusinessResolutionResult(result, target);
          if (active) {
            publish({ status: undefined, notice: result.cancelled ? 'Demande annulée. Vous pouvez comparer à nouveau les modifications.'
              : result.cancellation_superseded ? 'La demande avait déjà été acceptée. Les choix enregistrés ont été appliqués et le dossier est actualisé.'
                : 'Choix appliqués. Le dossier est actualisé ; vous pouvez réactiver la synchronisation.' });
            window.dispatchEvent(new Event('zentra-project-documents-changed'));
          }
        } finally {
          // Discover the durable result even after a lost invoke response. The
          // session retains a failed read barrier and retries reads only.
          if (active) await discover(false);
        }
      }),
    };
    publish({ phase: 'loading', enabled: false, working: false, selection: undefined, status: undefined, resolution: undefined, notice: undefined, error: undefined });
    const events = ['online', 'offline', 'focus', 'zentra-business-cycle-wake', 'zentra-project-documents-changed', BUSINESS_HISTORY_CHANGED, BUSINESS_HISTORY_STATUS];
    const visible = () => { if (document.visibilityState === 'visible') wake(); };
    const finishedInput = () => session?.wake();
    events.forEach(event => window.addEventListener(event, wake));
    document.addEventListener('visibilitychange', visible);
    document.addEventListener('focusout', finishedInput);
    return () => {
      active = false;
      commands.current = { enable: () => {}, pause: () => {}, wake: () => {}, resolve: () => {} };
      events.forEach(event => window.removeEventListener(event, wake));
      document.removeEventListener('visibilitychange', visible);
      document.removeEventListener('focusout', finishedInput);
      const stopping = session?.stop();
      const resolutionStopping = resolutionSession?.stop();
      drainPending = true;
      const draining = Promise.allSettled([initial, work, stopping, resolutionStopping]).then(() => { startupLock?.release(); });
      previousDrain = draining;
      void draining.finally(() => { if (previousDrain === draining) drainPending = false; });
    };
  }, [options.accountScope, options.connected]);
  return { ...state, accountScope: options.accountScope, enable: () => commands.current.enable(), pause: () => commands.current.pause(), wake: () => commands.current.wake(), resolve: (target: BusinessResolutionTarget, action: BusinessResolutionAction) => commands.current.resolve(target, action) };
}

export function businessCycleLabel(state: Pick<State, 'enabled' | 'online' | 'status' | 'resolution'>): string {
  if (state.resolution) return state.resolution.cancellation_requested ? 'Annulation à reprendre' : 'Résolution à terminer';
  if (!state.online) return 'Hors ligne · données conservées';
  if (state.status?.state === 'conflict') return 'Modifications à rapprocher';
  if (state.status?.state === 'invalid') return 'Synchronisation à vérifier';
  if (!state.enabled) return 'Synchronisation en pause';
  switch (state.status?.state) {
    case 'awaiting_installation': return 'Données reçues · saisie à terminer';
    case 'receiving': return 'Réception des modifications…';
    case 'sending': case 'awaiting_receipt': return 'Envoi des modifications…';
    case 'idle': return 'Dossier à jour au dernier passage';
    case 'waiting_for_connection': return 'Connexion au compte nécessaire';
    case 'retry': return 'Nouvelle tentative prévue';
    case 'busy': return 'Une opération du dossier est en cours';
    default: return 'Synchronisation activée';
  }
}
export function BusinessCycleControls({ compact = false }: { compact?: boolean }) {
  const cycle = useContext(BusinessCycleContext);
  const [reviewOpen, setReviewOpen] = useState<string>();
  if (!cycle) return null;
  if (cycle.phase !== 'ready') return compact ? null : <div className="business-cycle-controls"><output>{cycle.error || (cycle.phase === 'loading' ? 'Recherche du dossier à synchroniser…' : 'Connectez le compte de cette entreprise pour synchroniser ce dossier.')}</output><Button size="small" variant="ghost" disabled={cycle.working} onClick={cycle.wake}>Vérifier la connexion</Button></div>;
  if (compact) return <details className="business-cycle-disclosure"><summary><Cloud size={15} />{businessCycleLabel(cycle)}{cycle.error ? ' · À vérifier' : ''}</summary><BusinessCycleControls /></details>;
  const held = cycle.status?.state === 'conflict' || cycle.status?.state === 'invalid';
  const detail = cycle.status?.detail;
  const transaction = !cycle.resolution && cycle.status?.state === 'conflict' && detail?.state === 'reconciliation_conflict' && typeof detail.transaction_id === 'string' ? detail.transaction_id : undefined;
  const reviewKey = transaction ? `${cycle.accountScope}:${cycle.selection?.generation}:${cycle.selection?.capture_generation}:${transaction}` : undefined;
  return <div className="business-cycle-controls">
    <output className="business-cycle-heading"><Cloud size={16} /><strong>{businessCycleLabel(cycle)}</strong></output>
    {!compact && <p>{cycle.resolution ? 'Vos choix sont enregistrés. Reprenez cette demande pour terminer le rapprochement. Si un chronomètre bloque l’application, conservez-le depuis l’écran Temps, puis reprenez ici. Une demande déjà acceptée sera appliquée même si vous demandez son annulation.' : held
      ? 'Les modifications locales sont conservées. Le partage est suspendu pour éviter d’écraser des données. Vérifiez le dossier avant de réessayer.'
      : cycle.status?.state === 'awaiting_installation'
        ? 'Enregistrez et fermez la saisie en cours. L’application reprendra depuis les listes ou l’accueil.'
        : 'Les données et documents de cette entreprise seront échangés sur cet appareil. Après une coupure, les envois reprendront au retour du réseau.'}</p>}
    <div className="business-cycle-actions">
      {transaction && <Button size="small" disabled={cycle.working || !cycle.online} onClick={() => setReviewOpen(reviewKey)}>Comparer les modifications</Button>}
      {cycle.resolution && <><Button size="small" disabled={cycle.working || !cycle.online || !cycle.resolution.can_apply} onClick={() => cycle.resolve(cycle.resolution!, 'apply')}>Reprendre la résolution</Button>{!cycle.resolution.accepted && <Button size="small" variant="secondary" disabled={cycle.working || !cycle.online || !cycle.resolution.can_apply} onClick={() => cycle.resolve(cycle.resolution!, 'cancel')}>Annuler la demande</Button>}</>}
      {!cycle.resolution && <Button size="small" variant="secondary" disabled={cycle.working} onClick={cycle.enabled && !cycle.error ? cycle.wake : cycle.enable}>
        <RefreshCw size={15} />{cycle.error || held ? 'Réessayer' : cycle.enabled ? 'Synchroniser' : 'Activer sur cet appareil'}
      </Button>}
      {cycle.enabled && <Button size="small" variant="ghost" disabled={cycle.working} onClick={cycle.pause}><Pause size={15} /> Pause</Button>}
    </div>
    {cycle.error && <p role="alert" className="business-history-error">{cycle.error}</p>}
    {cycle.notice && <output>{cycle.notice}</output>}
    {transaction && reviewKey === reviewOpen && <Suspense fallback={<output>Ouverture de la comparaison…</output>}><BusinessConflictDialog key={reviewKey} transactionId={transaction} onClose={() => setReviewOpen(undefined)} onApply={id => { flushSync(() => setReviewOpen(undefined)); cycle.resolve({ transaction_id: transaction, resolution_id: id }, 'apply'); }} /></Suspense>}
  </div>;
}

export function BusinessInstallOverlay() {
  const state = useSyncExternalStore(subscribeBusinessLock, businessLockSnapshot, businessLockSnapshot);
  const panel = useRef<HTMLDialogElement>(null);
  const [retrying, setRetrying] = useState(false);
  useLayoutEffect(() => {
    const dialog = panel.current;
    if (!state.locked || !dialog) return;
    dialog.focus({ preventScroll: true });
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
      if (event.key === 'Tab') { event.preventDefault(); (dialog.querySelector('button') ?? dialog).focus(); }
    };
    dialog.addEventListener('keydown', trap);
    return () => dialog.removeEventListener('keydown', trap);
  }, [state.locked]);
  if (!state.locked) return null;
  return createPortal(<div className="business-install-backdrop" data-business-install-overlay>
    <dialog open ref={panel} className="business-install-dialog" aria-modal="true" aria-labelledby="business-install-title" tabIndex={-1}>
      <LoaderCircle className={state.error ? undefined : 'spin'} size={25} />
      <h2 id="business-install-title">{state.error ? 'Actualisation à reprendre' : 'Actualisation du dossier'}</h2>
      <p>{state.error ? errorMessage(state.error, 'La lecture des données locales a été interrompue.') : 'Application des modifications reçues. La saisie reprend dès que le dossier est actualisé.'}</p>
      {state.retry && <Button disabled={retrying} onClick={() => { setRetrying(true); void state.retry!().catch(() => {}).finally(() => setRetrying(false)); }}>Réessayer l’actualisation</Button>}
    </dialog>
  </div>, document.body);
}
