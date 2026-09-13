import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Channel, invoke } from '@tauri-apps/api/core';
import { createNativeNavigationSession, type NativeDestination } from './nativeNavigationSession';

const callbacks = new Map<number, (value: unknown) => void>();
let counter = 0, subscription: { id: number; index: number } | undefined;
const configure = vi.fn(async (_command: string, args: { onNavigate?: Channel<unknown> }) => {
  if (args.onNavigate) {
    // Tauri 2.11 replaces/drops the previous Rust Channel registered with this
    // callback ID. The real JS Channel processes its end/sequence messages.
    if (subscription) callbacks.get(subscription.id)?.({ end: true, index: subscription.index });
    subscription = { id: args.onNavigate.id, index: 0 };
  }
  return { available: true };
});
function tap(id: string) {
  if (!subscription) throw Error('No native subscription');
  callbacks.get(subscription.id)?.({ index: subscription.index++, message: { id } });
}
beforeEach(() => {
  callbacks.clear(); subscription = undefined; counter = 0; configure.mockClear();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {
    transformCallback: (callback: (data: unknown) => void) => { const id = ++counter; callbacks.set(id, callback); return id; },
    unregisterCallback: (id: number) => callbacks.delete(id), invoke: configure,
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe('native Apple navigation subscription', () => {
  it('reproduces the old failure with the actual Tauri Channel', async () => {
    const receive = vi.fn(); const channel = new Channel(receive);
    await invoke('configure', { onNavigate: channel });
    await invoke('configure', { onNavigate: channel });
    tap('projects');
    expect(receive).not.toHaveBeenCalled();
  });
  it.each(['plugin:zentra-mobile|configure_navigation', 'configure_macos_navigation'])('keeps all clicks and modal returns working: %s', async command => {
    const navigate = vi.fn(); const available = vi.fn();
    const state = { selected: 'dashboard' as NativeDestination, visible: true, onNavigate: navigate };
    const session = createNativeNavigationSession(command, () => state, available);
    await Promise.all([session.update(), session.update()]);
    for (const id of ['projects', 'quotes', 'menu', 'dashboard', 'projects'] as const) {
      tap(id); expect(navigate).toHaveBeenLastCalledWith(id);
      state.selected = id; await session.update();
    }
    state.visible = false; await session.update();
    const count = navigate.mock.calls.length; tap('quotes'); expect(navigate).toHaveBeenCalledTimes(count);
    state.visible = true; await session.update(); tap('quotes');
    expect(navigate).toHaveBeenCalledTimes(count + 1);
    tap('untrusted-destination'); expect(navigate).toHaveBeenCalledTimes(count + 1);
    expect(configure.mock.calls.filter(([, args]) => args.onNavigate)).toHaveLength(1);
    expect(available).toHaveBeenLastCalledWith(true);
    await session.dispose(); tap('projects'); expect(navigate).toHaveBeenCalledTimes(count + 1);
  });
  it('does not let Strict Mode cleanup hide a new session', async () => {
    const read = () => ({ selected: 'dashboard' as const, visible: true, onNavigate: vi.fn() });
    const old = createNativeNavigationSession('configure', read, vi.fn());
    const start = old.update(); const stop = old.dispose();
    const next = createNativeNavigationSession('configure', read, vi.fn());
    await Promise.all([start, stop, next.update()]);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure.mock.calls[0][1]).toHaveProperty('visible', true);
    await next.dispose();
  });
  it('restores HTML navigation after an unsupported or failed native call', async () => {
    const navigate = vi.fn(), available = vi.fn();
    const session = createNativeNavigationSession('configure', () => ({ selected: 'dashboard', visible: true, onNavigate: navigate }), available);
    await session.update();
    configure.mockRejectedValueOnce(Error('native unavailable'));
    await session.update(); tap('projects');
    expect(navigate).not.toHaveBeenCalled(); expect(available).toHaveBeenLastCalledWith(false);
    expect(configure.mock.calls.at(-1)?.[1]).toHaveProperty('visible', false);
    const calls = configure.mock.calls.length; await session.update(); expect(configure).toHaveBeenCalledTimes(calls);
    await session.dispose();
  });
});
