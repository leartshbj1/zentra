import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startNumberingScheduler, type NumberingStatus } from './numberingScheduler';

function setup(overrides: Partial<Parameters<typeof startNumberingScheduler>[0]> = {}) {
  const options = { replenish: vi.fn(async (): Promise<NumberingStatus> => ({ state: 'ready' })),
    isOnline: () => true, onStatus: vi.fn(), onError: vi.fn(), ...overrides };
  return { options, scheduler: startNumberingScheduler(options) };
}
describe('independent numbering prefetch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it('makes no offline request and resumes on network return', async () => {
    let online = false;
    const { options, scheduler } = setup({ isOnline: () => online });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(options.replenish).not.toHaveBeenCalled();
    online = true; scheduler.wake();
    await vi.advanceTimersByTimeAsync(300);
    expect(options.replenish).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
  it('serializes slow native passes and coalesces focus events', async () => {
    let finish!: (value: NumberingStatus) => void;
    const { options, scheduler } = setup({ replenish: vi.fn(() => new Promise<NumberingStatus>(r => { finish = r; })) });
    await vi.advanceTimersByTimeAsync(1500);
    for (let i = 0; i < 20; i++) scheduler.wake();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(options.replenish).toHaveBeenCalledTimes(1);
    finish({ state: 'ready' });
    await vi.advanceTimersByTimeAsync(300);
    expect(options.replenish).toHaveBeenCalledTimes(2);
    scheduler.stop(); finish({ state: 'ready' });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(options.onStatus).toHaveBeenCalledTimes(1);
    expect(options.replenish).toHaveBeenCalledTimes(2);
  });
  it('continues healthy bounded passes quickly', async () => {
    const replenish = vi.fn(async (): Promise<NumberingStatus> => ({ state: 'preparing', has_more: true }));
    const { scheduler } = setup({ replenish });
    await vi.advanceTimersByTimeAsync(7500);
    expect(replenish).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });
  it.each([false, true])('backs off failed series even with has_more=%s and focus storms', async has_more => {
    const replenish = vi.fn(async (): Promise<NumberingStatus> => ({ state: 'attention', has_more }));
    const { scheduler } = setup({ replenish });
    await vi.advanceTimersByTimeAsync(1500);
    for (let i = 0; i < 20; i++) { scheduler.wake(); await vi.advanceTimersByTimeAsync(1000); }
    expect(replenish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(replenish).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
  it('preserves exponential network backoff despite wake events', async () => {
    const replenish = vi.fn(async (): Promise<NumberingStatus> => { throw new Error('offline'); });
    const { options, scheduler } = setup({ replenish });
    await vi.advanceTimersByTimeAsync(1500);
    for (let i = 0; i < 10; i++) { scheduler.wake(); await vi.advanceTimersByTimeAsync(1000); }
    expect(replenish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(replenish).toHaveBeenCalledTimes(2);
    scheduler.wake(); await vi.advanceTimersByTimeAsync(59_000);
    expect(replenish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(options.onError).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });
  it.each(['local', 'read_only'] as const)('idles for an inactive %s profile', async state => {
    const replenish = vi.fn(async (): Promise<NumberingStatus> => ({ state }));
    const { scheduler } = setup({ replenish });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(replenish).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
