/** Scheduling only. Authority, durable recovery and decisions remain native.
 * A scope change invalidates results without pretending to cancel native work. */
export type AutopilotScheduleContext = Readonly<{
  scope: string | null;
  available: boolean;
  visible: boolean;
  online: boolean;
}>;
export type AutopilotCycleResult = 'idle' | 'more' | 'blocked' | 'rate_limited';
export type AutopilotCycleGuard = Readonly<{ scope: string; current: () => boolean }>;
export type AutopilotExclusiveResult<T> =
  | Readonly<{ status: 'completed'; value: T }>
  | Readonly<{ status: 'busy' | 'unavailable' | 'context_changed' }>;

const IDLE_DELAY = 15_000;
const MORE_DELAY = 15_000;
const BLOCKED_DELAY = 30_000;
const RATE_LIMIT_DELAY = 300_000;
const ERROR_DELAY = 3_000;
const MAX_ERROR_DELAY = 60_000;

export function createAutopilotSession({ perform, onError, clock = Date.now,
  schedule = (run, delay) => setTimeout(run, delay), cancel = timer => clearTimeout(timer),
}: {
  perform: (guard: AutopilotCycleGuard) => Promise<AutopilotCycleResult>;
  onError?: (guard: AutopilotCycleGuard, error: unknown) => void;
  clock?: () => number;
  schedule?: (run: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  let context: AutopilotScheduleContext = { scope: null, available: false, visible: false, online: false };
  let live = false, generation = 0, failures = 0, nextAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<unknown> | null = null;
  let resumeAfterPending = false;
  const eligible = () => live && !!context.scope && context.available && context.visible && context.online;
  const clearTimer = () => { if (timer !== null) cancel(timer); timer = null; };
  const guard = (): AutopilotCycleGuard | null => {
    if (!eligible() || !context.scope) return null;
    const scope = context.scope, epoch = generation;
    return Object.freeze({ scope, current: () => eligible() && generation === epoch && context.scope === scope });
  };
  const arm = () => {
    clearTimer();
    if (!eligible() || pending) return;
    timer = schedule(() => { timer = null; void wake(); }, Math.max(0, nextAt - clock()));
  };
  const finish = (operation: Promise<unknown>) => {
    if (pending !== operation) return;
    pending = null;
    if (resumeAfterPending) { resumeAfterPending = false; nextAt = 0; }
    arm();
  };
  const wake = (): Promise<void> => {
    if (!eligible()) return Promise.resolve();
    if (pending) return pending.then(() => {}, () => {});
    if (clock() < nextAt) { arm(); return Promise.resolve(); }
    clearTimer();
    const original = guard();
    if (!original) return Promise.resolve();
    // Start in a microtask so the physical-flight marker exists before perform.
    const operation = Promise.resolve().then(() => original.current() ? perform(original) : null)
      .then(result => {
        if (!original.current() || result === null) return;
        failures = 0;
        nextAt = clock() + (result === 'rate_limited' ? RATE_LIMIT_DELAY : result === 'more' ? MORE_DELAY : result === 'blocked' ? BLOCKED_DELAY : IDLE_DELAY);
      }, error => {
        if (!original.current()) return;
        failures = Math.min(failures + 1, 6);
        nextAt = clock() + Math.min(MAX_ERROR_DELAY, ERROR_DELAY * 2 ** (failures - 1));
        onError?.(original, error);
      });
    pending = operation;
    return operation.finally(() => finish(operation));
  };
  return {
    start() { if (!live) { live = true; nextAt = 0; } void wake(); },
    stop() {
      live = false; generation++; clearTimer(); resumeAfterPending = false;
      // Never clear pending here: the native operation is still physically live.
    },
    update(next: AutopilotScheduleContext) {
      const scopeChanged = next.scope !== context.scope || next.available !== context.available;
      const resumed = (!context.visible && next.visible) || (!context.online && next.online);
      context = { ...next };
      if (scopeChanged) { generation++; failures = 0; nextAt = 0; resumeAfterPending = !!pending; }
      if (resumed) nextAt = 0;
      if (!eligible()) clearTimer();
      else void wake();
    },
    wake,
    refresh() { nextAt = 0; if (pending) resumeAfterPending = true; return wake(); },
    async exclusive<T>(run: (original: AutopilotCycleGuard) => Promise<T>): Promise<AutopilotExclusiveResult<T>> {
      const original = guard();
      if (!original) return { status: 'unavailable' };
      if (pending) return { status: 'busy' };
      clearTimer();
      const operation = Promise.resolve().then(() => {
        if (!original.current()) return { status: 'context_changed' } as const;
        return run(original).then(value => original.current()
          ? { status: 'completed', value } as const : { status: 'context_changed' } as const);
      });
      pending = operation;
      try { return await operation; }
      finally { nextAt = 0; finish(operation); }
    },
  };
}
