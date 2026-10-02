import { afterEach, describe, expect, it, vi } from 'vitest';

// Actual components and bridge, with a closed diagnostic transport and fake
// preference cleanup. No database, browser storage or device reset is touched.
const runtime = vi.hoisted(() => ({ host: null as any, invoke: vi.fn(), cleanup: vi.fn(), cancel: vi.fn(), operation: vi.fn() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (...args: any[]) => runtime.host.state(...args),
  useRef: (...args: any[]) => runtime.host.ref(...args),
  useEffect: (action: any, deps: any) => runtime.host.effect(action, deps, 'passive'),
  useLayoutEffect: (action: any, deps: any) => runtime.host.effect(action, deps, 'layout'),
}));
vi.mock('./diagnostics', () => ({ diagnosticInvoke: runtime.invoke, diagnosticOperation: runtime.operation }));
vi.mock('./resetApp', () => ({ clearLocalAppPreferences: runtime.cleanup }));
vi.mock('./payrollLocalAi', () => ({ payrollLocalAi: { cancel: runtime.cancel } }));
vi.mock('./language', () => ({ t: (value: string) => value, getAppLocale: () => 'fr-CH' }));
vi.mock('./ui', () => ({ Button: () => null, ErrorPanel: () => null, Modal: () => null, Field: () => null }));
import { ResetAppPanel } from './ResetAppPanel';
import { ResetRecovery } from './ResetRecovery';
import { Button, ErrorPanel } from './ui';

type Element = { type: unknown; props: Record<string, any> };
class Host {
  slots: any[] = []; index = 0; dirty = false; mounted = true; tree: unknown;
  effects: Array<() => void> = []; writes: unknown[] = []; unmountedWrites = 0;
  constructor(public component: (props: any) => unknown, public props: any) { this.render(); }
  state(initial: any) {
    const slot = this.slots[this.index++] ??= { value: typeof initial === 'function' ? initial() : initial };
    slot.setter ??= (value: any) => {
      if (!this.mounted) this.unmountedWrites++;
      this.writes.push(value); const next = typeof value === 'function' ? value(slot.value) : value;
      if (!Object.is(next, slot.value)) { slot.value = next; this.dirty = true; }
    };
    return [slot.value, slot.setter];
  }
  ref(initial: unknown) { return this.slots[this.index++] ??= { current: initial }; }
  effect(action: () => (() => void) | void, deps: unknown[], kind: 'layout' | 'passive') {
    const index = this.index++, previous = this.slots[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) this.effects.push(() => {
      previous?.cleanup?.(); this.slots[index] = { deps, kind, action, cleanup: action() };
    });
  }
  render(props = this.props) {
    this.props = props; this.index = 0; this.dirty = false; this.effects = []; runtime.host = this;
    this.tree = this.component(props); for (const action of this.effects) action(); this.flush();
  }
  flush() { if (this.mounted && this.dirty) this.render(); }
  unmount(layoutOnly = false) { for (const slot of this.slots) if (!layoutOnly || slot.kind === 'layout') slot.cleanup?.(); this.mounted = false; }
  replayEffects() { for (const slot of this.slots) if (slot.action) { slot.cleanup?.(); slot.cleanup = slot.action(); } }
}
function nodes(tree: unknown): Element[] {
  return Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree as Element, ...nodes((tree as Element).props?.children)];
}
function one(host: Host, predicate: (node: Element) => boolean) {
  const matches = nodes(host.tree).filter(predicate); expect(matches).toHaveLength(1); return matches[0];
}
const open = (host: Host) => one(host, node => node.type === Button && node.props.variant === 'secondary' && !node.props.disabled).props.onClick();
const confirmation = (host: Host, value: string) => one(host, node => node.type === 'input').props.onChange({ target: { value } });
const resetButton = (host: Host) => one(host, node => node.type === Button && node.props.variant === 'danger');
const recoveryButton = (host: Host) => one(host, node => node.type === Button);
const error = (host: Host) => nodes(host.tree).find(node => node.type === ErrorPanel)?.props.message ?? '';
async function settle(host?: Host) { for (let n = 0; n < 40; n++) { await Promise.resolve(); host?.flush(); } }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function panel() {
  const tasks: ReturnType<typeof deferred<{ reset: boolean }>>[] = [], reload = vi.fn();
  vi.stubGlobal('window', { location: { reload } });
  runtime.operation.mockImplementation(async (_area, _operation, call) => call());
  runtime.cleanup.mockResolvedValue(undefined);
  runtime.invoke.mockImplementation((command: string, args: any) => {
    if (command !== 'reset_local_app' || args.confirmation !== 'REINITIALISER') throw Error(`Unexpected transport: ${command}`);
    const task = deferred<{ reset: boolean }>(); tasks.push(task); return task.promise;
  });
  const host = new Host(ResetAppPanel, {}); open(host); host.flush(); confirmation(host, 'REINITIALISER'); host.flush();
  return { host, tasks, reload };
}
async function recovery() {
  const availability = deferred<{ available: boolean }>(), restores: ReturnType<typeof deferred<void>>[] = [];
  const reads: ReturnType<typeof deferred<{ onboarding_completed: number }>>[] = [], publish = vi.fn();
  runtime.invoke.mockImplementation((command: string) => {
    if (command === 'get_reset_recovery') return availability.promise;
    if (command === 'restore_reset_recovery') { const task = deferred<void>(); restores.push(task); return task.promise; }
    if (command === 'get_app_state') { const task = deferred<{ onboarding_completed: number }>(); reads.push(task); return task.promise; }
    throw Error(`Unexpected transport: ${command}`);
  });
  const host = new Host(ResetRecovery, { onRestored: publish });
  expect(host.tree).toBeNull(); availability.resolve({ available: true }); await settle(host);
  return { host, restores, reads, publish };
}
afterEach(() => { for (const fn of [runtime.invoke, runtime.cleanup, runtime.cancel, runtime.operation]) fn.mockReset(); runtime.host = null; vi.unstubAllGlobals(); });

describe('local reset admission and recovery lifecycle', () => {
  it('suppresses late recovery discovery in the layout cleanup window before passive cleanup', async () => {
    const availability = deferred<{ available: boolean }>(); runtime.invoke.mockImplementation((command: string) => {
      if (command === 'get_reset_recovery') return availability.promise;
      throw Error(`Unexpected transport: ${command}`);
    });
    const host = new Host(ResetRecovery, { onRestored: vi.fn() }); host.unmount(true); const writes = host.writes.length;
    availability.resolve({ available: true }); await settle(host); expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0);
  });
  it('completes one explicitly confirmed reset and reloads only after preference cleanup', async () => {
    const { host, tasks, reload } = panel(), cleanup = deferred<void>(); runtime.cleanup.mockReturnValueOnce(cleanup.promise);
    resetButton(host).props.onClick(); await settle(host); expect(tasks).toHaveLength(1); expect(runtime.cancel).toHaveBeenCalledOnce();
    tasks[0].resolve({ reset: true }); await settle(host); expect(runtime.cleanup).toHaveBeenCalledOnce(); expect(reload).not.toHaveBeenCalled();
    cleanup.resolve(); await settle(host); expect(reload).toHaveBeenCalledOnce();
  });
  it('locks an admitted reset synchronously, even for two calls before a render', async () => {
    const { host, tasks } = panel(), click = resetButton(host).props.onClick; click(); click(); await settle(host);
    expect(tasks).toHaveLength(1); tasks[0].resolve({ reset: true }); await settle(host); expect(runtime.cleanup).toHaveBeenCalledOnce();
  });
  it('admits a current confirmed reset after StrictMode effect cleanup and setup replay', async () => {
    const { host, tasks, reload } = panel(); host.replayEffects(); resetButton(host).props.onClick(); await settle(host);
    expect(tasks).toHaveLength(1); tasks[0].resolve({ reset: true }); await settle(host); expect(reload).toHaveBeenCalledOnce();
  });
  it('disables confirmation and refuses an already open dialog when another operation becomes busy', async () => {
    const { host, tasks } = panel(); host.render({ disabled: true });
    expect(resetButton(host).props.disabled).toBe(true); expect(one(host, node => node.type === 'input').props.disabled).toBe(true);
    resetButton(host).props.onClick(); await settle(host); expect(tasks).toHaveLength(0); expect(runtime.cancel).not.toHaveBeenCalled();
  });
  it('refuses a previously captured reset handler after the disabled prop changes', async () => {
    const { host, tasks } = panel(), click = resetButton(host).props.onClick; host.render({ disabled: true }); click(); await settle(host);
    expect(tasks).toHaveLength(0); expect(runtime.cleanup).not.toHaveBeenCalled();
  });
  it('uses the current confirmation when an older reset handler is retained', async () => {
    const { host, tasks } = panel(), click = resetButton(host).props.onClick; confirmation(host, ''); host.flush(); click(); await settle(host);
    expect(tasks).toHaveLength(0); expect(runtime.cancel).not.toHaveBeenCalled();
  });
  it.each([false, true])('refuses a retained reset handler after unmount, layoutOnly=%s', async layoutOnly => {
    const { host, tasks } = panel(), click = resetButton(host).props.onClick; host.unmount(layoutOnly); const writes = host.writes.length;
    click(); await settle(host); expect(tasks).toHaveLength(0); expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0);
  });
  it('keeps the original recovery backup on explicit retry after preference cleanup fails', async () => {
    const { host, tasks, reload } = panel(); runtime.cleanup.mockRejectedValueOnce(new Error('Synthetic cache refusal'));
    resetButton(host).props.onClick(); await settle(host); tasks[0].resolve({ reset: true }); await settle(host);
    expect(error(host)).toBe('Synthetic cache refusal'); expect(reload).not.toHaveBeenCalled();
    resetButton(host).props.onClick(); await settle(host); expect(tasks).toHaveLength(1); expect(runtime.cleanup).toHaveBeenCalledTimes(2); expect(reload).toHaveBeenCalledOnce();
  });
  it('records the preference cleanup as a fixed diagnostic operation without the confirmation or contents', async () => {
    const { host, tasks } = panel(); resetButton(host).props.onClick(); await settle(host); tasks[0].resolve({ reset: true }); await settle(host);
    expect(runtime.operation).toHaveBeenCalledExactlyOnceWith('app', 'reset.preferences_clear', expect.any(Function));
  });
  it('finishes admitted device cleanup after unmount but suppresses a late failure in the departed screen', async () => {
    const { host, tasks, reload } = panel(); resetButton(host).props.onClick(); await settle(host); host.unmount(); const writes = host.writes.length;
    runtime.cleanup.mockRejectedValueOnce(new Error('Synthetic cleanup refusal')); tasks[0].resolve({ reset: true }); await settle(host);
    expect(runtime.cleanup).toHaveBeenCalledOnce(); expect(reload).not.toHaveBeenCalled(); expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0);
  });
  it('allows a later explicit retry after an actual reset refusal', async () => {
    const { host, tasks } = panel(); resetButton(host).props.onClick(); await settle(host); tasks[0].reject(new Error('Synthetic reset refusal')); await settle(host);
    expect(error(host)).toBe('Synthetic reset refusal'); expect(runtime.cleanup).not.toHaveBeenCalled();
    resetButton(host).props.onClick(); await settle(host); expect(tasks).toHaveLength(2); tasks[1].resolve({ reset: true }); await settle(host);
  });
  it('publishes a current recovered workspace exactly once, using the current callback', async () => {
    const { host, restores, reads, publish } = await recovery(); recoveryButton(host).props.onClick(); await settle(host);
    const latest = vi.fn(); host.render({ onRestored: latest }); restores[0].resolve(); await settle(host); reads[0].resolve({ onboarding_completed: 0 }); await settle(host);
    expect(publish).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledOnce(); expect(latest.mock.calls[0][0]).toMatchObject({ onboardingCompleted: false });
  });
  it('locks a recovery synchronously before the first await', async () => {
    const { host, restores, reads, publish } = await recovery(), click = recoveryButton(host).props.onClick; click(); click(); await settle(host);
    expect(restores).toHaveLength(1); restores[0].resolve(); await settle(host); reads[0].resolve({ onboarding_completed: 0 }); await settle(host); expect(publish).toHaveBeenCalledOnce();
  });
  it('reports a confirmed restoration separately and retries only the failed read', async () => {
    const { host, restores, reads, publish } = await recovery(); recoveryButton(host).props.onClick(); await settle(host);
    restores[0].resolve(); await settle(host); reads[0].reject(new Error('Synthetic saved workspace read refusal')); await settle(host);
    expect(error(host)).toContain('L’opération a été enregistrée'); expect(publish).not.toHaveBeenCalled();
    recoveryButton(host).props.onClick(); await settle(host); expect(restores).toHaveLength(1); expect(reads).toHaveLength(2);
    reads[1].reject(new Error('Synthetic explicit read refusal')); await settle(host); expect(error(host)).toContain('L’opération a été enregistrée');
    recoveryButton(host).props.onClick(); await settle(host); expect(restores).toHaveLength(1); expect(reads).toHaveLength(3);
    reads[2].resolve({ onboarding_completed: 0 }); await settle(host); expect(publish).toHaveBeenCalledOnce();
  });
  it('admits a current recovery after StrictMode effect replay and retains its refusal for an explicit retry', async () => {
    const { host, restores, reads, publish } = await recovery(); host.replayEffects(); await settle(host);
    recoveryButton(host).props.onClick(); await settle(host); restores[0].reject(new Error('Synthetic current restore refusal')); await settle(host);
    expect(error(host)).toBe('Synthetic current restore refusal'); expect(reads).toHaveLength(0); expect(publish).not.toHaveBeenCalled();
    recoveryButton(host).props.onClick(); await settle(host); expect(restores).toHaveLength(2); restores[1].resolve(); await settle(host);
    reads[0].resolve({ onboarding_completed: 0 }); await settle(host); expect(publish).toHaveBeenCalledOnce();
  });
  it.each([false, true])('refuses a retained recovery handler after unmount, layoutOnly=%s', async layoutOnly => {
    const { host, restores } = await recovery(), click = recoveryButton(host).props.onClick; host.unmount(layoutOnly); const writes = host.writes.length;
    click(); await settle(host); expect(restores).toHaveLength(0); expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0);
  });
  it.each(['restore', 'refresh'] as const)('does not publish a late receipt after leaving the screen during %s', async stage => {
    const { host, restores, reads, publish } = await recovery(); recoveryButton(host).props.onClick(); await settle(host);
    if (stage === 'refresh') { restores[0].resolve(); await settle(host); }
    host.unmount(true); const writes = host.writes.length;
    if (stage === 'restore') { restores[0].resolve(); await settle(host); }
    reads[0].resolve({ onboarding_completed: 0 }); await settle(host);
    expect(publish).not.toHaveBeenCalled(); expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0);
  });
  it('suppresses a late restoration refusal and never replays it automatically', async () => {
    const { host, restores, reads, publish } = await recovery(); recoveryButton(host).props.onClick(); await settle(host); host.unmount(); const writes = host.writes.length;
    restores[0].reject(new Error('Synthetic restore refusal')); await settle(host);
    expect(restores).toHaveLength(1); expect(reads).toHaveLength(0); expect(publish).not.toHaveBeenCalled(); expect(host.writes).toHaveLength(writes);
  });
});
