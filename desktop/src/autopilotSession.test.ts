import { afterEach, expect, it, vi } from 'vitest';
import { createAutopilotSession, type AutopilotCycleGuard } from './autopilotSession';

afterEach(() => vi.useRealTimers());
const context = { scope: 'organization:workspace:member', available: true, visible: true, online: true };
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

it('runs one physical cycle despite repeated focus and refresh requests', async () => {
  vi.useFakeTimers(); const pending = deferred<'idle'>();
  const perform = vi.fn(() => pending.promise), session = createAutopilotSession({ perform });
  session.update(context); session.start(); await drain();
  for (let i = 0; i < 10; i++) { void session.wake(); void session.refresh(); }
  expect(perform).toHaveBeenCalledTimes(1);
  pending.resolve('idle'); await drain(); expect(perform).toHaveBeenCalledTimes(1);
  session.stop();
});

it('waits for the old physical request and rejects its result after a workspace change', async () => {
  vi.useFakeTimers(); const pending = deferred<'idle'>(); const guards: AutopilotCycleGuard[] = [];
  const perform = vi.fn((guard: AutopilotCycleGuard) => { guards.push(guard); return guards.length === 1 ? pending.promise : Promise.resolve('idle' as const); });
  const session = createAutopilotSession({ perform }); session.update(context); session.start(); await drain();
  session.update({ ...context, scope: 'another:workspace:member' }); await drain();
  expect(guards[0].current()).toBe(false); expect(perform).toHaveBeenCalledTimes(1);
  pending.resolve('idle'); await drain(); await vi.advanceTimersByTimeAsync(0);
  expect(perform).toHaveBeenCalledTimes(2); expect(guards[1].scope).toBe('another:workspace:member'); session.stop();
});

it('keeps a stopped physical request single-flight through a Strict Mode restart', async () => {
  vi.useFakeTimers(); const pending = deferred<'idle'>(), guards: AutopilotCycleGuard[] = [];
  const perform = vi.fn((guard: AutopilotCycleGuard) => { guards.push(guard); return pending.promise; });
  const session = createAutopilotSession({ perform }); session.update(context); session.start(); await drain();
  session.stop(); session.start(); await drain(); expect(perform).toHaveBeenCalledTimes(1); expect(guards[0].current()).toBe(false);
  pending.resolve('idle'); await drain(); await vi.advanceTimersByTimeAsync(0); expect(perform).toHaveBeenCalledTimes(2); session.stop();
});

it.each(['online', 'available'] as const)('does not execute while %s is false and resumes when restored', async key => {
  vi.useFakeTimers(); const perform = vi.fn().mockResolvedValue('idle'); const session = createAutopilotSession({ perform });
  session.update({ ...context, [key]: false }); session.start(); await vi.advanceTimersByTimeAsync(60_000); expect(perform).not.toHaveBeenCalled();
  session.update(context); await drain(); expect(perform).toHaveBeenCalledTimes(1); session.stop();
});

it('keeps working in the background at a calmer pace and resumes promptly when shown', async () => {
  vi.useFakeTimers(); const perform = vi.fn().mockResolvedValue('idle'); const session = createAutopilotSession({ perform });
  session.update({ ...context, visible: false }); session.start(); await drain(); expect(perform).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(59_999); expect(perform).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(perform).toHaveBeenCalledTimes(2);
  session.update(context); await drain(); expect(perform).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(15_000); expect(perform).toHaveBeenCalledTimes(4); session.stop();
});

it('backs off transport failures without focus events causing a tight retry loop', async () => {
  vi.useFakeTimers(); const perform = vi.fn().mockRejectedValue(Error('transport'));
  const onError = vi.fn(), session = createAutopilotSession({ perform, onError }); session.update(context); session.start(); await drain();
  expect(perform).toHaveBeenCalledTimes(1); for(let i=0;i<10;i++) void session.wake();
  await vi.advanceTimersByTimeAsync(2_999); expect(perform).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(perform).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5_999); expect(perform).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(perform).toHaveBeenCalledTimes(3);
  expect(onError).toHaveBeenCalledTimes(3); session.stop();
});

it('uses bounded idle, continuation and blocked delays without replaying in a loop', async () => {
  vi.useFakeTimers(); const perform = vi.fn().mockResolvedValueOnce('more').mockResolvedValueOnce('blocked').mockResolvedValue('idle');
  const session = createAutopilotSession({ perform }); session.update(context); session.start(); await drain();
  await vi.advanceTimersByTimeAsync(14_999); expect(perform).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(perform).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(29_999); expect(perform).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(perform).toHaveBeenCalledTimes(3); session.stop();
});

it('backs off an explicit quota refusal without a five-second retry loop', async () => {
  vi.useFakeTimers(); const perform = vi.fn().mockResolvedValue('rate_limited');
  const session = createAutopilotSession({ perform }); session.update(context); session.start(); await drain();
  await vi.advanceTimersByTimeAsync(299_999); expect(perform).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(perform).toHaveBeenCalledTimes(2); session.stop();
});

it('serializes explicit consent with background work and refuses stale consent results', async () => {
  vi.useFakeTimers(); const perform = vi.fn().mockResolvedValue('idle'), session = createAutopilotSession({ perform });
  session.update(context); session.start(); await drain();
  const pending = deferred<string>(), consent = vi.fn(() => pending.promise);
  const change = session.exclusive(consent); await drain();
  expect(await session.exclusive(consent)).toEqual({ status: 'busy' }); void session.refresh(); expect(perform).toHaveBeenCalledTimes(1);
  session.update({ ...context, scope: 'new:workspace:member' }); pending.resolve('saved');
  expect(await change).toEqual({ status: 'context_changed' }); session.stop();
});

it('does not start a consent or cycle in a disconnected company', async () => {
  const perform = vi.fn(), consent = vi.fn(), session = createAutopilotSession({ perform });
  session.start(); expect(await session.exclusive(consent)).toEqual({ status: 'unavailable' });
  await session.wake(); expect(perform).not.toHaveBeenCalled(); expect(consent).not.toHaveBeenCalled(); session.stop();
});
