import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from './types';
import type { AppointmentInboxItem, AppointmentInboxState } from './AppointmentInbox';

// The actual hook and its request adapter run with deterministic effects and
// deferred local transport. No React DOM, native IPC or backend is loaded.
const runtime = vi.hoisted(() => ({ host: null as any, invoke: vi.fn(), load: vi.fn() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (...args: any[]) => runtime.host.state(...args),
  useRef: (...args: any[]) => runtime.host.ref(...args),
  useCallback: (...args: any[]) => runtime.host.callback(...args),
  useEffect: (...args: any[]) => runtime.host.effect(...args),
  useLayoutEffect: (...args: any[]) => runtime.host.effect(...args),
}));
vi.mock('./diagnostics', () => ({ diagnosticInvoke: runtime.invoke }));
vi.mock('./bridge', () => ({ desktopApi: { loadWorkspace: runtime.load } }));
vi.mock('./language', () => ({ t: (value: string) => value, useAppLanguage: () => 'fr' }));
vi.mock('./ui', () => ({ Button: () => null, Field: () => null, Modal: () => null }));
import { useAppointmentInbox } from './AppointmentInbox';

type Args = Parameters<typeof useAppointmentInbox>;
type Result = ReturnType<typeof useAppointmentInbox>;
class Host {
  slots: any[] = []; index = 0; effects: Array<() => void> = [];
  mounted = true; dirty = false; unmountedWrites = 0; writes: unknown[] = [];
  result!: Result;
  constructor(public args: Args) { this.render(); }
  state(initial: unknown) {
    const slot = this.slots[this.index++] ??= { value: initial };
    return [slot.value, (value: any) => {
      if (!this.mounted) this.unmountedWrites++;
      const next = typeof value === 'function' ? value(slot.value) : value;
      this.writes.push(next);
      if (!Object.is(slot.value, next)) { slot.value = next; this.dirty = true; }
    }];
  }
  ref(initial: unknown) { return this.slots[this.index++] ??= { current: initial }; }
  callback(action: unknown, deps: unknown[]) {
    const index = this.index++, previous = this.slots[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) this.slots[index] = { value: action, deps };
    return this.slots[index].value;
  }
  effect(action: () => (() => void) | void, deps: unknown[]) {
    const index = this.index++, previous = this.slots[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) this.effects.push(() => {
      previous?.cleanup?.(); this.slots[index] = { deps, cleanup: action() };
    });
  }
  render(args = this.args) {
    this.args = args; this.index = 0; this.effects = []; this.dirty = false;
    runtime.host = this; this.result = useAppointmentInbox(...args);
    for (const effect of this.effects) effect(); this.flush();
  }
  flush() { if (this.mounted && this.dirty) this.render(); }
  unmount() { for (const slot of this.slots) slot.cleanup?.(); this.mounted = false; }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async (host: Host) => { for (let n = 0; n < 12; n++) { await Promise.resolve(); host.flush(); } };
function item(id = 'synthetic-item', state = 'ready'): AppointmentInboxItem {
  return { id, organizationId: 'synthetic-org', sender: 'synthetic@example.invalid', subject: 'Synthetic', state,
    otherDevice: false, importedAt: null, extraction: { title: 'Synthetic appointment', startDate: '2026-10-02', endDate: '2026-10-02',
      startTime: '10:00', endTime: '11:00', allDay: false, location: '', notes: '', status: 'scheduled', issues: [] } };
}
const state = (items: AppointmentInboxItem[] = [], organizationId = 'synthetic-org'): AppointmentInboxState => ({ organizationId, active: true, automatic: true, items });
const workspace = (scope?: string) => ({ workNotesScope: scope }) as Workspace;
function setup(scope: string | undefined, refreshWorkspace?: () => Promise<void>) {
  const reads: ReturnType<typeof deferred<AppointmentInboxState>>[] = [];
  const imports: Array<ReturnType<typeof deferred<{ saved?: boolean }>> & { data: any }> = [];
  const loads: ReturnType<typeof deferred<Workspace>>[] = [];
  runtime.invoke.mockImplementation((command: string, args: { data: any }) => {
    expect(command).toBe('appointment_inbox_request');
    if (args.data === null) { const task = deferred<AppointmentInboxState>(); reads.push(task); return task.promise; }
    expect(args.data.action).toBe('import');
    const task = deferred<{ saved?: boolean }>(); imports.push({ ...task, data: args.data }); return task.promise;
  });
  runtime.load.mockImplementation(() => { const task = deferred<Workspace>(); loads.push(task); return task.promise; });
  const publish = vi.fn(), blocked = vi.fn(() => false);
  const host = new Host(['synthetic-org', false, blocked, publish, refreshWorkspace, scope]);
  return { host, reads, imports, loads, publish, blocked };
}
beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
  vi.stubGlobal('setInterval', vi.fn(() => 1)); vi.stubGlobal('clearInterval', vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); runtime.invoke.mockReset(); runtime.load.mockReset(); runtime.host = null; });

type Stage = 'read' | 'import' | 'workspace' | 'callback' | 'latest-read';
async function reach(stage: Stage) {
  const callback = deferred<void>(), refresh = stage === 'callback' ? vi.fn(() => callback.promise) : undefined;
  const fixture = setup('synthetic-scope-a', refresh), { host, reads, imports, loads } = fixture;
  if (stage !== 'read') {
    reads[0].resolve(state([item(), ...(stage === 'import' ? [item('second-old-item', 'processing')] : [])])); await settle(host);
    expect(imports).toHaveLength(1);
    if (stage !== 'import') {
      imports[0].resolve({ saved: true }); await settle(host);
      if (stage === 'latest-read') { loads[0].resolve(workspace('synthetic-scope-a')); await settle(host); expect(reads).toHaveLength(2); }
    }
  }
  const pending = stage === 'read' ? reads[0] : stage === 'import' ? imports[0]
    : stage === 'workspace' ? loads[0] : stage === 'callback' ? callback : reads[1];
  const value = stage === 'read' || stage === 'latest-read' ? state([item('old-late-item')])
    : stage === 'import' ? { saved: true } : stage === 'workspace' ? workspace('synthetic-scope-a') : undefined;
  return { ...fixture, callback, refresh, pending, value };
}

describe('appointment refresh lifetime and physical workspace', () => {
  it.each(['synthetic-scope-a', undefined])('preserves the current refresh and legacy scope=%s', async scope => {
    const { host, reads, imports, loads, publish } = setup(scope);
    const batch = Array.from({ length: 12 }, (_, n) => item(`synthetic-${n}`, n === 0 ? 'processing' : 'ready'));
    reads[0].resolve(state([{ ...item('other-device'), otherDevice: true }, ...batch])); await settle(host);
    for (let n = 0; n < 10; n++) {
      expect(imports).toHaveLength(n + 1);
      expect(imports[n].data).toEqual({ action: 'import', id: batch[n].id, automatic: n !== 0 });
      imports[n].resolve({ saved: true }); await settle(host);
    }
    expect(imports).toHaveLength(10); expect(loads).toHaveLength(1);
    loads[0].resolve(workspace(scope || 'legacy-received-scope')); await settle(host);
    expect(publish).toHaveBeenCalledTimes(1); expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(reads).toHaveLength(2); reads[1].resolve(state()); await settle(host);
    expect(host.result.state).toEqual(state()); expect(imports).toHaveLength(10);
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 15000);
  });

  const cases = (['read', 'import', 'workspace', 'callback', 'latest-read'] as const)
    .flatMap(stage => (['unmount', 'scope', 'org'] as const).flatMap(transition => [false, true].map(rejected => ({ stage, transition, rejected }))));
  it.each(cases)('discards $stage completion after $transition, rejection=$rejected', async ({ stage, transition, rejected }) => {
    const fixture = await reach(stage), { host, reads, imports, loads, publish, pending, value, refresh } = fixture;
    const imported = imports.length, loaded = loads.length, published = publish.mock.calls.length;
    const events = vi.mocked(window.dispatchEvent).mock.calls.length, startedReads = reads.length;
    if (transition === 'unmount') host.unmount();
    else {
      const args = [...host.args] as Args;
      if (transition === 'scope') args[5] = 'synthetic-scope-b'; else args[0] = 'synthetic-org-b';
      host.render(args);
    }
    const written = host.writes.length;
    if (rejected) pending.reject(new Error('Synthetic old rejection'));
    else (pending.resolve as (value: any) => void)(value);
    await settle(host);
    expect(imports).toHaveLength(imported); expect(loads).toHaveLength(loaded);
    expect(publish).toHaveBeenCalledTimes(published); expect(window.dispatchEvent).toHaveBeenCalledTimes(events);
    expect(host.unmountedWrites).toBe(0);
    expect(host.writes.slice(written).some(value => typeof value === 'string' && value.includes('Synthetic old rejection'))).toBe(false);
    expect(host.writes.slice(written).some(value => (value as AppointmentInboxState)?.items?.some(row => row.id === 'old-late-item'))).toBe(false);
    if (transition === 'unmount') expect(reads).toHaveLength(startedReads);
    else {
      expect(reads).toHaveLength(startedReads + 1);
      const org = host.args[0]!; reads.at(-1)!.resolve(state([], org)); await settle(host);
      expect(host.result.state).toEqual(state([], org)); expect(reads).toHaveLength(startedReads + 1);
    }
    if (refresh) expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not publish a fallback workspace with another physical scope', async () => {
    const { host, reads, imports, loads, publish } = setup('synthetic-scope-a');
    reads[0].resolve(state([item()])); await settle(host); imports[0].resolve({ saved: true }); await settle(host);
    loads[0].resolve(workspace('synthetic-scope-other')); await settle(host);
    expect(publish).not.toHaveBeenCalled(); expect(window.dispatchEvent).not.toHaveBeenCalled();
    expect(reads).toHaveLength(1); expect(imports).toHaveLength(1);
  });
  it('preserves the supplied workspace refresher on the current scope', async () => {
    const callback = deferred<void>(), refresh = vi.fn(() => callback.promise);
    const { host, reads, imports, loads, publish } = setup('synthetic-scope-a', refresh);
    reads[0].resolve(state([item()])); await settle(host); imports[0].resolve({ saved: true }); await settle(host);
    expect(refresh).toHaveBeenCalledTimes(1); expect(loads).toHaveLength(0);
    callback.resolve(); await settle(host); expect(reads).toHaveLength(2);
    reads[1].resolve(state()); await settle(host); expect(publish).not.toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1); expect(imports).toHaveLength(1);
  });
  it.each(['read-only', 'blocked', 'not-automatic', 'other-device', 'different-org'] as const)('preserves %s admission', async condition => {
    const { host, reads, imports, blocked } = setup('synthetic-scope-a');
    if (condition === 'read-only') { const args = [...host.args] as Args; args[1] = true; host.render(args); }
    if (condition === 'blocked') blocked.mockReturnValue(true);
    const incoming = state([{ ...item(), otherDevice: condition === 'other-device' }], condition === 'different-org' ? 'synthetic-other-org' : 'synthetic-org');
    if (condition === 'not-automatic') incoming.automatic = false;
    reads[0].resolve(incoming); await settle(host); expect(imports).toHaveLength(0); expect(reads).toHaveLength(1);
  });
  it.each(['offline', 'hidden'] as const)('does not start a refresh while %s', async condition => {
    if (condition === 'offline') Object.assign(navigator, { onLine: false });
    else Object.assign(document, { visibilityState: 'hidden' });
    const { reads, imports } = setup('synthetic-scope-a'); expect(reads).toHaveLength(0); expect(imports).toHaveLength(0);
  });
});
