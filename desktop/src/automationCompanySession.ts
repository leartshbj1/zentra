import type { AutomationState } from './automation';
import { automationProblem, type AutomationProblem } from './automationConnection';

export type AutomationCompanySnapshot = {
  state: AutomationState | null;
  knownActive: boolean;
  status: 'disconnected' | 'loading' | 'ready' | 'unavailable';
  problem?: AutomationProblem;
};

/** A company-scoped, memory-only session. An outage may retain the menu, never permission to act. */
export function createAutomationCompanySession(organizationId: string | null, load: () => Promise<AutomationState | null>, online = () => true) {
  let snapshot: AutomationCompanySnapshot = { state: null, knownActive: false, status: organizationId ? 'loading' : 'disconnected' };
  let live = false;
  let generation = 0;
  let pending: Promise<void> | null = null;
  let requested = false;
  const listeners = new Set<() => void>();
  const publish = (next: AutomationCompanySnapshot) => { snapshot = next; listeners.forEach(fn => fn()); };
  const refresh = (invalidate = true): Promise<void> => {
    if (!live || !organizationId) return Promise.resolve();
    if (pending) { requested ||= invalidate; return pending; }
    const epoch = generation;
    pending = (async () => {
      do {
        requested = false;
        let problem: AutomationProblem = online() ? 'service' : 'offline';
        let next: AutomationState | null;
        try { next = await load(); }
        catch (reason) { problem = automationProblem(reason, online()); next = null; }
        if (!live || generation !== epoch) return;
        if (next && next.organizationId === organizationId) publish({ state: next, knownActive: next.active, status: 'ready' });
        else publish({ state: null, knownActive: next ? false : snapshot.knownActive, status: 'unavailable', problem: next ? 'company_mismatch' : problem });
      } while (requested);
    })().finally(() => { if (epoch === generation) pending = null; });
    return pending;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start: () => { live = true; },
    stop: () => { live = false; generation++; pending = null; requested = false; },
    refresh,
  };
}
