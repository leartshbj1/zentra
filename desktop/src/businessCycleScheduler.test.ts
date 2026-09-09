import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBusinessCycleScheduler, type BusinessCycleStatus, type BusinessHistorySelection } from './businessCycleScheduler';

const selection: BusinessHistorySelection = {
  organization_id: 'company-a', installation_id: 'device-a',
  capture_generation: 'capture-a', generation: 'history-a', bootstrap_transfer_id: 'initial-a',
};
const status = (state: BusinessCycleStatus['state']): BusinessCycleStatus => ({
  state, selection, workspace_changed: state === 'installed', detail: null, replication_active: false,
});
function setup(overrides: Partial<Parameters<typeof startBusinessCycleScheduler>[0]> = {}) {
  const options = {
    selection, synchronize: vi.fn(async () => status('idle')),
    pauseNative: vi.fn(async () => {}), isOnline: () => true, canInstall: () => true,
    onWorkspaceChanged: vi.fn(async (_signal: AbortSignal) => {}), onStatus: vi.fn(), onError: vi.fn(),
    ...overrides,
  };
  return { options, scheduler: startBusinessCycleScheduler(options) };
}
describe('selected business history scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('keeps changes offline and receives on network return using the exact selection', async () => {
    let online = false;
    const { options, scheduler } = setup({ isOnline: () => online });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(options.synchronize).not.toHaveBeenCalled();
    online = true;
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(300);
    expect(options.synchronize).toHaveBeenCalledExactlyOnceWith(selection, true);
    await scheduler.stop();
  });

  it('coalesces focus events without overlapping an active native pass', async () => {
    let finish!: (value: BusinessCycleStatus) => void;
    const { options, scheduler } = setup({ synchronize: vi.fn(() => new Promise<BusinessCycleStatus>(resolve => { finish = resolve; })) });
    await vi.advanceTimersByTimeAsync(300);
    for (let i = 0; i < 20; i++) scheduler.wake();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(options.synchronize).toHaveBeenCalledTimes(1);
    finish(status('sending'));
    await vi.advanceTimersByTimeAsync(500);
    expect(options.synchronize).toHaveBeenCalledTimes(2);
    const drained = scheduler.stop();
    finish(status('installed'));
    await drained;
    expect(options.onWorkspaceChanged).not.toHaveBeenCalled();
  });

  it('allows receipt download while an editor defers installation', async () => {
    let install = false;
    const { options, scheduler } = setup({ canInstall: () => install, synchronize: vi.fn(async () => status('awaiting_installation')) });
    await vi.advanceTimersByTimeAsync(300);
    expect(options.synchronize).toHaveBeenLastCalledWith(selection, false);
    expect(options.onWorkspaceChanged).not.toHaveBeenCalled();
    install = true;
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(300);
    expect(options.synchronize).toHaveBeenLastCalledWith(selection, true);
    await scheduler.stop();
  });

  it.each(['conflict', 'invalid', 'paused'] as const)('holds %s until an explicit new session', async state => {
    const { options, scheduler } = setup({ synchronize: vi.fn(async () => status(state)) });
    await vi.advanceTimersByTimeAsync(300);
    for (let i = 0; i < 5; i++) scheduler.wake();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(options.synchronize).toHaveBeenCalledTimes(1);
    expect(options.onStatus).toHaveBeenCalledWith(status(state));
    await scheduler.stop();
  });

  it('rejects a response from another history without refreshing or automatically retrying', async () => {
    const { options, scheduler } = setup({ synchronize: vi.fn(async () => ({ ...status('installed'), selection: { ...selection, generation: 'other' } })) });
    await vi.advanceTimersByTimeAsync(300);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(options.synchronize).toHaveBeenCalledTimes(1);
    expect(options.onStatus).not.toHaveBeenCalled();
    expect(options.onWorkspaceChanged).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('does not let focus storms bypass a network error backoff', async () => {
    const { options, scheduler } = setup({ synchronize: vi.fn(async () => { throw new Error('offline'); }) });
    await vi.advanceTimersByTimeAsync(300);
    for (let i = 0; i < 10; i++) {
      scheduler.wake();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(options.synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(options.synchronize).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('retries a failed workspace refresh before another native mutation', async () => {
    const refresh = vi.fn(async (_signal: AbortSignal) => {});
    refresh.mockRejectedValueOnce(new Error('local read failed'));
    const synchronize = vi.fn(async () => status('idle')).mockResolvedValueOnce(status('installed'));
    const { scheduler } = setup({ synchronize, onWorkspaceChanged: refresh });
    await vi.advanceTimersByTimeAsync(300);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(refresh.mock.invocationCallOrder[1]).toBeLessThan(synchronize.mock.invocationCallOrder[1]);
    await scheduler.stop();
  });

  it('cancels once, waits for a native response and suppresses callbacks after stopping', async () => {
    let finish!: (value: BusinessCycleStatus) => void;
    const { options, scheduler } = setup({ synchronize: vi.fn(() => new Promise<BusinessCycleStatus>(resolve => { finish = resolve; })) });
    await vi.advanceTimersByTimeAsync(300);
    const stop = scheduler.stop();
    expect(scheduler.stop()).toBe(stop);
    let drained = false;
    void stop.then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(300);
    expect(drained).toBe(false);
    expect(options.pauseNative).toHaveBeenCalledTimes(1);
    finish(status('installed'));
    await stop;
    expect(options.onStatus).not.toHaveBeenCalled();
    expect(options.onWorkspaceChanged).not.toHaveBeenCalled();
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(options.synchronize).toHaveBeenCalledTimes(1);
  });
});
