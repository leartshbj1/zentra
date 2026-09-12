import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startProjectSyncScheduler } from './projectSyncScheduler';
import type { ProjectSyncStatus } from './projectSync';

const status: ProjectSyncStatus = { mode: 'legacy', connected: true, pending: 0, documents: [], syncing: false };
function setup(overrides: Partial<Parameters<typeof startProjectSyncScheduler>[0]> = {}) {
  const options = { local: vi.fn(async () => status), synchronize: vi.fn(async () => status),
    isOnline: () => true, onStatus: vi.fn(), onError: vi.fn(), onRunning: vi.fn(),
    onWorkspaceChanged: vi.fn(async (_signal: AbortSignal) => {}), ...overrides };
  return { options, scheduler: startProjectSyncScheduler(options) };
}
describe('project document synchronization lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it('keeps slow offline reads single-flight and resumes after connectivity returns', async () => {
    let online = false, finish!: (status: ProjectSyncStatus) => void;
    const local = vi.fn(() => new Promise<ProjectSyncStatus>(r => { finish = r; }));
    const { options, scheduler } = setup({ local, isOnline: () => online });
    await vi.advanceTimersByTimeAsync(300);
    for (let i = 0; i < 10; i++) scheduler.wake();
    await vi.advanceTimersByTimeAsync(5000);
    expect(local).toHaveBeenCalledTimes(1);
    expect(options.synchronize).not.toHaveBeenCalled();
    online = true; scheduler.wake(); finish(status);
    await vi.advanceTimersByTimeAsync(300);
    expect(options.synchronize).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
  it('coalesces wake events during a native pass', async () => {
    let finish!: (status: ProjectSyncStatus) => void;
    const synchronize = vi.fn(() => new Promise<ProjectSyncStatus>(r => { finish = r; }));
    const { scheduler } = setup({ synchronize });
    await vi.advanceTimersByTimeAsync(300);
    for (let i = 0; i < 15; i++) scheduler.wake();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(synchronize).toHaveBeenCalledTimes(1);
    finish(status); await vi.advanceTimersByTimeAsync(300);
    expect(synchronize).toHaveBeenCalledTimes(2);
    scheduler.stop(); finish(status);
  });
  it.each(['reject', 'status'] as const)('holds backoff on %s errors despite focus events', async failure => {
    const synchronize = vi.fn(async (): Promise<ProjectSyncStatus> => {
      if (failure === 'reject') throw new Error('offline');
      return { ...status, error: 'offline' };
    });
    const { scheduler } = setup({ synchronize });
    await vi.advanceTimersByTimeAsync(300);
    for (let i = 0; i < 20; i++) { scheduler.wake(); await vi.advanceTimersByTimeAsync(1000); }
    expect(synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(synchronize).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
  it('retries a failed workspace refresh before starting another native request', async () => {
    const refresh = vi.fn(async (_signal: AbortSignal) => {}).mockRejectedValueOnce(new Error('read'));
    const synchronize = vi.fn(async () => status).mockResolvedValueOnce({ ...status, changed: true });
    const { scheduler } = setup({ synchronize, onWorkspaceChanged: refresh });
    await vi.advanceTimersByTimeAsync(300);
    expect(synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.invocationCallOrder[1]).toBeLessThan(synchronize.mock.invocationCallOrder[1]);
    scheduler.stop();
  });
  it('lets a manual retry resume pending reads immediately, even while offline', async () => {
    let online = true;
    const refresh = vi.fn(async (_signal: AbortSignal) => {}).mockRejectedValueOnce(new Error('read'));
    const synchronize = vi.fn(async () => ({ ...status, changed: true }));
    const { scheduler } = setup({ synchronize, isOnline: () => online, onWorkspaceChanged: refresh });
    await vi.advanceTimersByTimeAsync(300);
    online = false;
    scheduler.wake(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(synchronize).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
  it('suppresses late statuses and refreshes after the account changes', async () => {
    let finish!: (status: ProjectSyncStatus) => void;
    const onStatus = vi.fn();
    const { options, scheduler } = setup({ onStatus, synchronize: vi.fn(() => new Promise<ProjectSyncStatus>(r => { finish = r; })) });
    await vi.advanceTimersByTimeAsync(300);
    const before = onStatus.mock.calls.length;
    scheduler.stop(); finish({ ...status, changed: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(options.onStatus).toHaveBeenCalledTimes(before);
    expect(options.onWorkspaceChanged).not.toHaveBeenCalled();
  });
  it('aborts a workspace refresh already in progress on unmount', async () => {
    let signal!: AbortSignal, finish!: () => void;
    const refresh = vi.fn((value: AbortSignal) => { signal = value; return new Promise<void>(r => { finish = r; }); });
    const { scheduler } = setup({ synchronize: vi.fn(async () => ({ ...status, changed: true })), onWorkspaceChanged: refresh });
    await vi.advanceTimersByTimeAsync(300);
    expect(signal.aborted).toBe(false);
    scheduler.stop();
    expect(signal.aborted).toBe(true);
    finish();
  });
  it('does not rapidly poll the legacy queue once the business history owns files', async () => {
    const synchronize = vi.fn(async (): Promise<ProjectSyncStatus> => ({ ...status, mode: 'business', pending: 10 }));
    const { scheduler } = setup({ synchronize });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(synchronize).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
