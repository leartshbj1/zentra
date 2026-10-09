import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUsBackgroundSync } from './browser-us-background-sync';

afterEach(() => { vi.useRealTimers(); });
function environment() {
  let visible = true, online = true, listener: (() => void) | undefined;
  const unlisten = vi.fn(() => { listener = undefined; });
  return { options: { visible: () => visible, online: () => online, subscribe: (changed: () => void) => { listener = changed; return unlisten; } },
    visible(value: boolean) { visible = value; listener?.(); }, online(value: boolean) { online = value; listener?.(); }, unlisten };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('quiet US background single-flight scheduler', () => {
  it('checks immediately and every three seconds after completion', async () => {
    vi.useFakeTimers(); const env = environment(), tick = vi.fn(async () => {}), sync = createUsBackgroundSync({ ...env.options, tick });
    await vi.advanceTimersByTimeAsync(0); expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_999); expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(tick).toHaveBeenCalledTimes(2); sync.dispose();
  });
  it('coalesces wakes while a request is running, without overlap', async () => {
    vi.useFakeTimers(); const env = environment(), wait = deferred(); let active = 0, peak = 0;
    const tick = vi.fn(async () => { peak = Math.max(peak, ++active); if (tick.mock.calls.length === 1) await wait.promise; active--; });
    const sync = createUsBackgroundSync({ ...env.options, tick }); await vi.advanceTimersByTimeAsync(0);
    sync.wake(); sync.wake(); await vi.advanceTimersByTimeAsync(20_000); expect(tick).toHaveBeenCalledTimes(1);
    wait.resolve(); await vi.advanceTimersByTimeAsync(0); expect(tick).toHaveBeenCalledTimes(2); expect(peak).toBe(1); sync.dispose();
  });
  it('does not poll hidden or offline, and catches up immediately on return', async () => {
    vi.useFakeTimers(); const env = environment(); env.visible(false); const tick = vi.fn(async () => {}), sync = createUsBackgroundSync({ ...env.options, tick });
    await vi.advanceTimersByTimeAsync(30_000); expect(tick).not.toHaveBeenCalled(); env.visible(true); await vi.advanceTimersByTimeAsync(0); expect(tick).toHaveBeenCalledTimes(1);
    env.online(false); sync.wake(); await vi.advanceTimersByTimeAsync(30_000); expect(tick).toHaveBeenCalledTimes(1); env.online(true); await vi.advanceTimersByTimeAsync(0); expect(tick).toHaveBeenCalledTimes(2); sync.dispose();
  });
  it('waits for an admitted owner to be ready without issuing a request', async () => {
    vi.useFakeTimers(); const env = environment(); let ready = false; const tick = vi.fn(async () => {}), sync = createUsBackgroundSync({ ...env.options, ready: () => ready, tick });
    await vi.advanceTimersByTimeAsync(9_000); expect(tick).not.toHaveBeenCalled(); ready = true; sync.wake(); await vi.advanceTimersByTimeAsync(0); expect(tick).toHaveBeenCalledTimes(1); sync.dispose();
  });
  it('backs off failures, honors retry-after and does not bypass it through ordinary wakes', async () => {
    vi.useFakeTimers(); const env = environment(), error = Object.assign(new Error('rate_limited'), { retryAfterMs: 20_000 }), onError = vi.fn();
    const tick = vi.fn(async () => { if (tick.mock.calls.length < 3) throw error; });
    const sync = createUsBackgroundSync({ ...env.options, tick, onError }); await vi.advanceTimersByTimeAsync(0); sync.wake();
    await vi.advanceTimersByTimeAsync(19_999); expect(tick).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(1); expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000); expect(tick).toHaveBeenCalledTimes(3); expect(onError).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000); expect(tick).toHaveBeenCalledTimes(4); sync.dispose();
  });
  it('bounds repeated failure delay without a hot loop', async () => {
    vi.useFakeTimers(); const env = environment(), tick = vi.fn(async () => { throw new Error('unavailable'); });
    const sync = createUsBackgroundSync({ ...env.options, tick, maximumBackoffMs: 12_000 }); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(6_000); expect(tick).toHaveBeenCalledTimes(2); await vi.advanceTimersByTimeAsync(11_999); expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(tick).toHaveBeenCalledTimes(3); await vi.advanceTimersByTimeAsync(12_000); expect(tick).toHaveBeenCalledTimes(4); sync.dispose();
  });
  it('disposes subscriptions and ignores an in-flight completion', async () => {
    vi.useFakeTimers(); const env = environment(), wait = deferred(), tick = vi.fn(() => wait.promise), sync = createUsBackgroundSync({ ...env.options, tick });
    await vi.advanceTimersByTimeAsync(0); sync.wake(); sync.dispose(); sync.dispose(); wait.resolve(); env.visible(true);
    await vi.advanceTimersByTimeAsync(30_000); expect(tick).toHaveBeenCalledTimes(1); expect(env.unlisten).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('stops permanently on a terminal access callback', async () => {
    vi.useFakeTimers(); const env = environment(), tick = vi.fn(async () => { throw new Error('unauthorized'); }), onError = vi.fn(() => false as const), sync = createUsBackgroundSync({ ...env.options, tick, onError });
    await vi.advanceTimersByTimeAsync(0); sync.wake(); env.online(true); await vi.advanceTimersByTimeAsync(30_000); expect(tick).toHaveBeenCalledTimes(1); expect(env.unlisten).toHaveBeenCalledTimes(1); sync.dispose();
  });
  it('contains a throwing error reporter without an unhandled polling rejection', async () => {
    vi.useFakeTimers(); const env = environment(), tick = vi.fn(async () => { throw new Error('closed_code'); }), sync = createUsBackgroundSync({ ...env.options, tick, onError: () => { throw new Error('callback'); } });
    await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(6_000); expect(tick).toHaveBeenCalledTimes(2); sync.dispose();
  });
  it.each([0, 999, 60_001, NaN, 1.5])('rejects unsafe interval %s', intervalMs => { expect(() => createUsBackgroundSync({ tick: async () => {}, intervalMs })).toThrow('invalid_sync_interval'); });
});
