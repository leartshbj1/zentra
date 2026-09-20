import type { AutomationState } from './automation';

export type AutomationCompanySnapshot = {
  state: AutomationState | null;
  knownActive: boolean;
  status: 'disconnected' | 'loading' | 'ready' | 'unavailable';
};

/** A company-scoped, memory-only session. An outage may retain the menu, never permission to act. */
export function createAutomationCompanySession(organizationId: string | null, load: () => Promise<AutomationState | null>) {
  let snapshot: AutomationCompanySnapshot = { state: null, knownActive: false, status: organizationId ? 'loading' : 'disconnected' };
  let live = false;
  let generation = 0;
  let pending: Promise<void> | null = null;
  let requested = false;
  const listeners = new Set<() => void>();
  const publish = (next: AutomationCompanySnapshot) => { snapshot = next; listeners.forEach(fn => fn()); };
  const refresh = (): Promise<void> => {
    if (!live || !organizationId) return Promise.resolve();
    if (pending) { requested = true; return pending; }
    const epoch = generation;
    pending = (async () => {
      do {
        requested = false;
        const next = await load().catch(() => null);
        if (!live || generation !== epoch) return;
        if (next && next.organizationId === organizationId) publish({ state: next, knownActive: next.active, status: 'ready' });
        else publish({ state: null, knownActive: next ? false : snapshot.knownActive, status: 'unavailable' });
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
