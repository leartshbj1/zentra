import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';
import type { BusinessPendingResolution, BusinessResolutionResult } from '../src/businessResolutionSession';

// Protocol simulation for mounted UI tests. Native SQLite/HTTP proofs are separate.
export function installBusinessResolutionFixture(data: () => Workspace) {
  const key = 'qa-resolution-pending';
  let pending: BusinessPendingResolution | null = JSON.parse(sessionStorage.getItem(key) ?? 'null');
  let mode = 'lose';
  let capture = sessionStorage.getItem('qa-resolution-capture');
  let finish: (() => void) | undefined;
  const calls: Array<{ action: string; allow?: boolean; locked?: boolean }> = [];
  const originalState = desktopApi.getBusinessCycleState;
  const originalCycle = desktopApi.syncBusinessCycle;
  const save = () => sessionStorage.setItem(key, JSON.stringify(pending));
  desktopApi.getBusinessCycleState = async () => {
    const state = await originalState();
    return state.state === 'ready' ? { ...state, selection: { ...state.selection, capture_generation: capture ?? state.selection.capture_generation },
      resolution: pending ? { ...pending, can_apply: !new URLSearchParams(location.search).has('conflictReadOnly') } : null } : state;
  };
  desktopApi.syncBusinessCycle = async (...args) => {
    if (pending) throw new Error('A pending resolution must not restart the ordinary cycle');
    return originalCycle(...args);
  };
  const granted = new Map<string, boolean>();
  desktopApi.respondBusinessInstallation = async (id, allow) => {
    calls.push({ action: 'permission', allow, locked: document.querySelector<HTMLElement>('.desktop-app')?.inert });
    granted.set(id, allow); return true;
  };
  desktopApi.resolveBusinessConflict = async (selection, target, action, permission) => {
    calls.push({ action });
    const ask = async (suffix: string) => {
      const id = `${permission.requestId}-${suffix}`;
      permission.onRequest({ request_id: id, selection });
      await Promise.resolve();
      if (!granted.get(id)) throw new Error('Autorisation refusée');
    };
    await ask('freeze');
    pending = { ...target, accepted: mode === 'accepted', cancellation_requested: action === 'cancel', can_apply: true }; save();
    await new Promise<void>(resolve => { finish = resolve; }); finish = undefined;
    if (mode === 'lose') throw new Error('Réponse réseau perdue. La demande reste conservée.');
    const installed = action === 'apply' || mode === 'accepted';
    if (installed) {
      await ask('install');
      data().clients[0].name = 'Client après résolution';
      capture = 'capture-after-resolution'; sessionStorage.setItem('qa-resolution-capture', capture);
    }
    pending = null; save();
    const result: BusinessResolutionResult = { ...target, state: installed ? 'resolution_installed' : 'resolution_cancelled',
      selection: { ...selection, capture_generation: capture ?? selection.capture_generation }, workspace_changed: installed,
      installed, cancelled: !installed, cancellation_superseded: installed && action === 'cancel' };
    return result;
  };
  Object.assign(window, { __businessResolutionQa: { calls, get waiting() { return Boolean(finish); },
    finish: () => { if (!finish) throw new Error('No resolution running'); finish(); },
    mode: (value: string) => { mode = value; },
    seed: () => { pending = { transaction_id: 'received-conflict', resolution_id: 'saved-resolution', accepted: false, cancellation_requested: false, can_apply: true }; save(); window.dispatchEvent(new Event('zentra-business-cycle-wake')); },
  } });
}
