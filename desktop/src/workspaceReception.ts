/** Reconcile confirmed inbox writes without replaying them or replacing newer UI data. */
export function createWorkspaceReception<T>(options: {
  read: () => Promise<T>;
  current: () => T;
  scope: () => string;
  publish: (workspace: T) => void;
  available: () => boolean;
  canPublish: () => boolean;
  matchesScope: (workspace: T) => boolean;
  onError?: (reason: unknown) => void;
  onScopeMismatch?: () => void;
}) {
  let active = false, epoch = 0, generation = 0, pending = false;
  let scopeMismatchReported = false;
  let flight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 300;
  const current = (token: number, scope: string) => active && token === epoch && scope === options.scope();
  function clearTimer() { clearTimeout(timer); timer = undefined; }
  function schedule() {
    clearTimer();
    if (!active || !pending || !options.available()) return;
    timer = setTimeout(() => {
      timer = undefined;
      const token = epoch, scope = options.scope();
      void run().catch(reason => {
        if (!current(token, scope)) return;
        // Diagnostics cannot create an unhandled rejection or stop a retry.
        try { options.onError?.(reason); } catch { /* best-effort diagnostics */ }
      });
    }, delay);
    delay = Math.min(3_000, delay * 2);
  }
  async function pass() {
    const token = epoch, scope = options.scope();
    // A stream of mutations must not keep a hook awaiting an endless reread.
    // After two reads, leave the latest UI intact and reconcile in a later pass.
    for (let attempt = 0; attempt < 2 && pending && current(token, scope); attempt++) {
      if (!options.available() || !options.canPublish()) return;
      const before = options.current(), requested = generation;
      let workspace: T;
      try { workspace = await options.read(); }
      catch (reason) {
        if (current(token, scope)) throw reason;
        return;
      }
      if (!current(token, scope)) return;
      if (!options.available() || !options.canPublish()) return;
      if (before !== options.current() || requested !== generation) continue;
      if (!options.matchesScope(workspace)) {
        if (!scopeMismatchReported) {
          scopeMismatchReported = true;
          // No snapshot, scope or company data crosses this diagnostic hook.
          try { options.onScopeMismatch?.(); } catch { /* best-effort diagnostics */ }
        }
        continue;
      }
      // Publication and the current ref update are synchronous at this boundary.
      options.publish(workspace);
      pending = false;
      delay = 300;
      scopeMismatchReported = false;
      return;
    }
  }
  function run(): Promise<void> {
    if (flight) return flight;
    clearTimer();
    if (!active || !pending || !options.available()) return Promise.resolve();
    const job = pass().finally(() => {
      if (flight === job) flight = null;
      schedule();
    });
    flight = job;
    return job;
  }
  return {
    start() { active = true; epoch++; delay = 300; scopeMismatchReported = false; },
    stop() { active = false; epoch++; pending = false; scopeMismatchReported = false; clearTimer(); },
    request(): Promise<void> {
      if (!active) return Promise.resolve();
      pending = true; generation++;
      return run();
    },
    wake() {
      if (active && pending && !flight) { delay = 300; schedule(); }
    },
    suspend: clearTimer,
  };
}
