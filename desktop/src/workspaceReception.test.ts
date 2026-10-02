import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceReception } from './workspaceReception';

type Snapshot = { scope: string; revision: number };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  let value: Snapshot = { scope: 'a', revision: 1 }, scope = 'a';
  let online = true, visible = true, allowed = true;
  const read = vi.fn(async () => ({ scope, revision: 2 }));
  const publish = vi.fn((next: Snapshot) => { value = next; });
  const onError = vi.fn();
  const reader = createWorkspaceReception({ read, publish, onError,
    current: () => value, scope: () => scope,
    available: () => online && visible, canPublish: () => allowed,
    matchesScope: next => next.scope === scope,
  });
  reader.start();
  return { reader, read, publish, onError, value: () => value,
    mutate(revision: number) { value = { scope, revision }; },
    switchTo(next: string) { reader.stop(); scope = next; value = { scope, revision: 1 }; reader.start(); },
    offline() { online = false; reader.suspend(); },
    hidden() { visible = false; reader.suspend(); },
    resume() { online = visible = true; reader.wake(); },
    allow(next: boolean) { allowed = next; },
  };
}
afterEach(() => { vi.useRealTimers(); });

describe('confirmed inbox writes and bounded workspace reconciliation', () => {
  it('coalesces supplier and appointment requests with one read in flight', async () => {
    vi.useFakeTimers();
    const f = fixture(), first = deferred<Snapshot>();
    f.read.mockImplementationOnce(() => first.promise);
    const supplier = f.reader.request(), appointment = f.reader.request();
    expect(supplier).toBe(appointment);
    expect(f.read).toHaveBeenCalledTimes(1);
    first.resolve({ scope: 'a', revision: 1 });
    await supplier;
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith({ scope: 'a', revision: 2 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.read).toHaveBeenCalledTimes(2);
    f.reader.stop();
  });
  it('keeps a local mutation visible until a fresh read includes it', async () => {
    const f = fixture(), first = deferred<Snapshot>();
    f.read.mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ scope: 'a', revision: 3 });
    const job = f.reader.request();
    f.mutate(3);
    first.resolve({ scope: 'a', revision: 2 });
    await job;
    expect(f.publish).toHaveBeenCalledExactlyOnceWith({ scope: 'a', revision: 3 });
    f.reader.stop();
  });
  it('ends a pass after two competing reads and resumes after a mutation burst', async () => {
    vi.useFakeTimers();
    const f = fixture(), first = deferred<Snapshot>(), second = deferred<Snapshot>();
    f.read.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
      .mockResolvedValueOnce({ scope: 'a', revision: 8 });
    const job = f.reader.request();
    for (let i = 2; i <= 4; i++) { f.mutate(i); void f.reader.request(); }
    first.resolve({ scope: 'a', revision: 1 });
    await Promise.resolve(); await Promise.resolve();
    expect(f.read).toHaveBeenCalledTimes(2);
    for (let i = 5; i <= 8; i++) { f.mutate(i); void f.reader.request(); }
    second.resolve({ scope: 'a', revision: 4 });
    await job;
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.value().revision).toBe(8);
    expect(f.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(299);
    expect(f.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith({ scope: 'a', revision: 8 });
    expect(f.read).toHaveBeenCalledTimes(3);
    f.reader.stop();
  });
  it('preserves a confirmed import after read failure and pauses retries offline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error('Read interrupted'))
      .mockRejectedValueOnce(new Error('Still disconnected'))
      .mockResolvedValueOnce({ scope: 'a', revision: 3 });
    await expect(f.reader.request()).rejects.toThrow('Read interrupted');
    await vi.advanceTimersByTimeAsync(300);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.onError).toHaveBeenCalledTimes(1);
    f.offline();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.read).toHaveBeenCalledTimes(2);
    f.resume(); await vi.advanceTimersByTimeAsync(300);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith({ scope: 'a', revision: 3 });
    f.reader.stop();
  });
  it('backs off unsuccessful reads to at most one pass every three seconds', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.read.mockRejectedValue(new Error('Unavailable'));
    await expect(f.reader.request()).rejects.toThrow();
    for (const delay of [300, 600, 1_200, 2_400, 3_000]) {
      const count = f.read.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.read).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.read).toHaveBeenCalledTimes(count + 1);
    }
    f.reader.stop();
  });
  it('keeps a hidden response pending and resumes only when visible', async () => {
    vi.useFakeTimers();
    const f = fixture(), hold = deferred<Snapshot>();
    f.read.mockImplementationOnce(() => hold.promise);
    const job = f.reader.request(); f.hidden();
    hold.resolve({ scope: 'a', revision: 2 }); await job;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledTimes(1);
    f.resume(); await vi.advanceTimersByTimeAsync(300);
    expect(f.publish).toHaveBeenCalledTimes(1);
    f.reader.stop();
  });
  it('does not publish over an editor or company reception that became blocked', async () => {
    vi.useFakeTimers();
    const f = fixture(), hold = deferred<Snapshot>();
    f.read.mockImplementationOnce(() => hold.promise);
    const job = f.reader.request(); f.allow(false);
    hold.resolve({ scope: 'a', revision: 2 }); await job;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
    f.allow(true); f.reader.wake(); await vi.advanceTimersByTimeAsync(300);
    expect(f.publish).toHaveBeenCalledTimes(1);
    f.reader.stop();
  });
  it('ignores an old lifetime even when the user returns to the same company', async () => {
    vi.useFakeTimers();
    const f = fixture(), hold = deferred<Snapshot>();
    let inflight = 0, maximum = 0;
    f.read.mockImplementationOnce(async () => {
      maximum = Math.max(maximum, ++inflight);
      try { return await hold.promise; } finally { inflight--; }
    }).mockImplementationOnce(async () => {
      maximum = Math.max(maximum, ++inflight);
      try { return { scope: 'a', revision: 4 }; } finally { inflight--; }
    });
    const old = f.reader.request();
    f.switchTo('b'); void f.reader.request();
    f.switchTo('a'); void f.reader.request();
    hold.resolve({ scope: 'a', revision: 2 }); await old;
    expect(f.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith({ scope: 'a', revision: 4 });
    expect(maximum).toBe(1);
    f.reader.stop();
  });
  it('discards an unmounted read and never retries or publishes it', async () => {
    vi.useFakeTimers();
    const f = fixture(), hold = deferred<Snapshot>();
    f.read.mockImplementationOnce(() => hold.promise);
    const old = f.reader.request(); f.reader.stop();
    hold.reject(new Error('Old lifetime')); await old;
    await f.reader.request(); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });
  it('never applies a snapshot from another native workspace', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.read.mockResolvedValueOnce({ scope: 'b', revision: 2 }).mockResolvedValueOnce({ scope: 'b', revision: 3 });
    await f.reader.request();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith({ scope: 'a', revision: 2 });
    f.reader.stop();
  });
});
