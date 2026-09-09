import { desktopApi } from '../src/bridge';
import type { BusinessCycleStatus, BusinessHistorySelection } from '../src/businessCycleScheduler';
import type { Workspace } from '../src/types';

// UI-only protocol fixture. Does not claim HTTPS, native SQLite or device coverage.
export function installBusinessCycleFixture(data: () => Workspace) {
  const selection: BusinessHistorySelection = {
    organization_id: 'org-cycle-ui', installation_id: 'device-cycle-ui', capture_generation: 'capture-cycle-ui',
    generation: 'history-cycle-ui', bootstrap_transfer_id: 'initial-cycle-ui',
  };
  let pending = true, failReads = 0;
  let attempt: { id: string; allow: boolean; cancelled: boolean; ask: () => void; finish: (status: BusinessCycleStatus) => void } | undefined;
  const calls: unknown[] = [];
  const result = (state: BusinessCycleStatus['state']): BusinessCycleStatus => ({ state, selection: { ...selection }, workspace_changed: state === 'installed', detail: null, replication_active: false });
  desktopApi.getBusinessCycleState = async () => ({ state: 'ready', selection: { ...selection }, pending_transactions: 0 });
  desktopApi.getBusinessHistoryState = async () => ({ connected: true, organization_id: selection.organization_id, state: 'installed' });
  desktopApi.runCloudBackup = async () => ({ enabled: false, connected: true, backups: [] });
  desktopApi.syncBusinessBootstrap = async () => ({ state: 'history_installed' }) as never;
  desktopApi.getProjectSyncStatus = async () => ({ mode: 'business', pending: 0, syncing: false, connected: true, documents: [] });
  desktopApi.syncProjectDocuments = desktopApi.getProjectSyncStatus;
  desktopApi.loadWorkspace = async () => {
    calls.push({ action: 'refresh', locked: document.querySelector<HTMLElement>('.desktop-app')?.inert });
    if (failReads > 0) { failReads--; throw new Error('Lecture locale interrompue pour la recette'); }
    return structuredClone(data());
  };
  desktopApi.syncBusinessCycle = async (_selection, install, permission) => {
    calls.push({ action: 'cycle', id: permission!.requestId, install });
    if (!pending) return result('idle');
    return new Promise(resolve => {
      attempt = { id: permission!.requestId, allow: false, cancelled: false,
        ask: () => permission!.onRequest({ request_id: 'permission-ui', selection: { ...selection } }), finish: resolve };
    });
  };
  desktopApi.respondBusinessInstallation = async (id, allow) => {
    calls.push({ action: 'permission', id, allow, locked: document.querySelector<HTMLElement>('.desktop-app')?.inert });
    if (attempt) attempt.allow = allow;
    return true;
  };
  desktopApi.pauseBusinessCycle = async id => { calls.push({ action: 'pause', id }); if (attempt?.id === id) attempt.cancelled = true; return { state: 'stopping', in_flight: Boolean(attempt) }; };
  const qa = {
    selection, calls,
    get waiting() { return Boolean(attempt); },
    ask: () => { if (!attempt) throw new Error('No native request in flight'); attempt.ask(); },
    finish: () => {
      if (!attempt) throw new Error('No native request in flight');
      const value = attempt; attempt = undefined;
      if (value.allow && !value.cancelled) { data().clients[0].name = 'Client reçu et vérifié'; data().clients[0].company = 'Dossier reçu'; pending = false; }
      value.finish(result(value.cancelled ? 'paused' : value.allow ? 'installed' : 'awaiting_installation'));
    },
    failNextRead: () => { failReads = 1; },
    queue: () => { pending = true; window.dispatchEvent(new Event('zentra-business-cycle-wake')); },
  };
  Object.assign(window, { __businessCycleQa: qa });
  return { status: 'connected' as const, organizationId: selection.organization_id, organizationName: 'Entreprise de recette', role: 'owner' as const };
}
