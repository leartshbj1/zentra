import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startBusinessBootstrapScheduler,
  type BusinessBootstrapStatus,
} from './businessBootstrapScheduler';

const status = (
  state: BusinessBootstrapStatus['state'],
): BusinessBootstrapStatus => ({
  state,
  replication_active: false,
});

describe('prepared business history background sender', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('sends nothing offline and resumes when the network returns', async () => {
    let online = false;
    const synchronize = vi.fn(async () => status('uploading'));
    const sender = startBusinessBootstrapScheduler({
      synchronize,
      isOnline: () => online,
    });
    await vi.advanceTimersByTimeAsync(123_000);
    expect(synchronize).not.toHaveBeenCalled();
    online = true;
    sender.wake();
    await vi.advanceTimersByTimeAsync(300);
    expect(synchronize).toHaveBeenCalledTimes(1);
    sender.stop();
  });

  it('coalesces wake events without overlapping a slow native request', async () => {
    let finish!: (value: BusinessBootstrapStatus) => void;
    const synchronize = vi.fn(
      () =>
        new Promise<BusinessBootstrapStatus>((resolve) => {
          finish = resolve;
        }),
    );
    const sender = startBusinessBootstrapScheduler({
      synchronize,
      isOnline: () => true,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    for (let index = 0; index < 20; index++) sender.wake();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(synchronize).toHaveBeenCalledTimes(1);
    finish(status('uploading'));
    await vi.advanceTimersByTimeAsync(499);
    expect(synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(synchronize).toHaveBeenCalledTimes(2);
    sender.stop();
    finish(status('history_uploaded'));
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each(['not_prepared', 'history_uploaded'] as const)(
    'keeps %s quiet and does not infer active replication',
    async (state) => {
      const synchronize = vi.fn(async () => status(state));
      const onStatus = vi.fn();
      const sender = startBusinessBootstrapScheduler({
        synchronize,
        onStatus,
        isOnline: () => true,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(onStatus).toHaveBeenLastCalledWith({
        state,
        replication_active: false,
      });
      await vi.advanceTimersByTimeAsync(299_999);
      expect(synchronize).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(synchronize).toHaveBeenCalledTimes(2);
      sender.stop();
    },
  );

  it('continues pending chunks quickly but waits for an account connection', async () => {
    const synchronize = vi
      .fn()
      .mockResolvedValueOnce(status('uploading'))
      .mockResolvedValueOnce(status('sending'))
      .mockResolvedValue(status('waiting_for_connection'));
    const sender = startBusinessBootstrapScheduler({
      synchronize,
      isOnline: () => true,
    });
    await vi.advanceTimersByTimeAsync(13_000);
    expect(synchronize).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(synchronize).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(synchronize).toHaveBeenCalledTimes(4);
    sender.stop();
  });

  it('backs off failed requests up to five minutes and resets after success', async () => {
    const onError = vi.fn();
    const synchronize = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(status('uploading'));
    const sender = startBusinessBootstrapScheduler({
      synchronize,
      onError,
      isOnline: () => true,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    for (const [index, delay] of [
      60_000, 120_000, 240_000, 300_000,
    ].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(synchronize).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(synchronize).toHaveBeenCalledTimes(index + 2);
    }
    expect(onError).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(synchronize).toHaveBeenCalledTimes(6);
    sender.stop();
  });

  it('does not let a wake during a failed request bypass retry backoff', async () => {
    let fail!: (reason: Error) => void;
    const synchronize = vi.fn(
      () =>
        new Promise<BusinessBootstrapStatus>((_, reject) => {
          fail = reject;
        }),
    );
    const sender = startBusinessBootstrapScheduler({
      synchronize,
      isOnline: () => true,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    sender.wake();
    fail(new Error('unavailable'));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(synchronize).toHaveBeenCalledTimes(2);
    sender.stop();
    fail(new Error('stopped'));
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each(['resolve', 'reject'] as const)(
    'stops safely during a request (%s)',
    async (outcome) => {
      let finish!: (value: BusinessBootstrapStatus) => void;
      let fail!: (reason: Error) => void;
      const synchronize = vi.fn(
        () =>
          new Promise<BusinessBootstrapStatus>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      );
      const onStatus = vi.fn();
      const onError = vi.fn();
      const sender = startBusinessBootstrapScheduler({
        synchronize,
        onStatus,
        onError,
        isOnline: () => true,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      sender.wake();
      sender.stop();
      sender.wake();
      if (outcome === 'resolve') finish(status('uploading'));
      else fail(new Error('late failure'));
      await vi.advanceTimersByTimeAsync(600_000);
      expect(synchronize).toHaveBeenCalledTimes(1);
      expect(onStatus).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
