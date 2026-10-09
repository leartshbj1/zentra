/** Scheduling only. Authorization, cursors and application fences belong to the
 * admitted transports and their owner. No mutation, persistence or global bus. */
export interface UsBackgroundSyncOptions {
  tick(): Promise<void>;
  ready?: () => boolean;
  onError?: (error: unknown) => void | false;
  intervalMs?: number;
  maximumBackoffMs?: number;
  visible?: () => boolean;
  online?: () => boolean;
  subscribe?: (changed: () => void) => () => void;
  now?: () => number;
}
export interface UsBackgroundSync { wake(): void; dispose(): void; }

function browserSubscription(changed: () => void): () => void {
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', changed);
  if (typeof window !== 'undefined') { window.addEventListener('online', changed); window.addEventListener('offline', changed); }
  return () => {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', changed);
    if (typeof window !== 'undefined') { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); }
  };
}
function retryAfter(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'retryAfterMs');
  return descriptor && 'value' in descriptor && Number.isSafeInteger(descriptor.value) && descriptor.value > 0 ? Math.min(descriptor.value, 300_000) : 0;
}

export function createUsBackgroundSync(options: UsBackgroundSyncOptions): UsBackgroundSync {
  const interval = options.intervalMs ?? 3_000, maximumBackoff = options.maximumBackoffMs ?? 60_000;
  if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 60_000 || !Number.isSafeInteger(maximumBackoff) || maximumBackoff < interval || maximumBackoff > 300_000) throw new Error('invalid_sync_interval');
  const visible = options.visible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const online = options.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const now = options.now ?? Date.now;
  let disposed = false, running = false, requested = false, failures = 0, notBefore = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  const active = () => !disposed && visible() && online();
  function clear() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function dispose() { if (disposed) return; disposed = true; clear(); requested = false; unsubscribe?.(); unsubscribe = undefined; }
  function schedule(delay: number) { clear(); if (active()) timer = setTimeout(() => { timer = undefined; void run(); }, delay); }
  function wake() { if (!active()) return; requested = true; if (!running) schedule(Math.max(0, notBefore - now())); }
  async function run() {
    if (!active() || running) return;
    if (notBefore > now()) { schedule(notBefore - now()); return; }
    if (options.ready && !options.ready()) { requested = false; schedule(interval); return; }
    running = true; requested = false;
    try { await options.tick(); failures = 0; notBefore = 0; }
    catch (error) {
      if (!disposed) {
        failures = Math.min(failures + 1, 10);
        notBefore = now() + Math.max(Math.min(maximumBackoff, interval * 2 ** failures), retryAfter(error));
        try { if (options.onError?.(error) === false) dispose(); } catch { /* A UI callback must not create an unhandled polling rejection. */ }
      }
    } finally {
      running = false;
      if (active()) schedule(Math.max(requested ? 0 : interval, notBefore - now()));
    }
  }
  unsubscribe = (options.subscribe ?? browserSubscription)(() => {
    if (!active()) { clear(); return; }
    // A return from offline/background merits one immediate admitted check.
    failures = 0; notBefore = 0; wake();
  });
  wake();
  return { wake, dispose };
}
