export type NumberingStatus = {
  state: 'local' | 'busy' | 'waiting_for_connection' | 'read_only' | 'preparing' | 'ready' | 'attention';
  organization_id?: string;
  attempts?: number;
  confirmed?: number;
  has_more?: boolean;
  issues?: { prefix: string; year: number; message: string }[];
};

export function startNumberingScheduler(options: {
  replenish: () => Promise<NumberingStatus>;
  isOnline: () => boolean;
  onStatus?: (status: NumberingStatus) => void;
  onError?: (reason: unknown) => void;
}) {
  let active = true, running = false, pendingWake = false, failures = 0, retryAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule(delay: number) {
    clearTimeout(timer);
    if (active) timer = setTimeout(() => void tick(), Math.max(delay, retryAt - Date.now()));
  }
  async function tick() {
    if (!active || running) return;
    if (!options.isOnline()) { schedule(60_000); return; }
    running = true;
    let delay = 60_000;
    try {
      const status = await options.replenish();
      if (!active) return;
      failures = 0;
      retryAt = 0;
      if (status.has_more || status.state === 'preparing' || status.state === 'busy') delay = 3_000;
      else if (status.state === 'local' || status.state === 'read_only') delay = 300_000;
      // Even when a pass has more series, failed requests need backoff: a
      // rotating cursor can otherwise report has_more indefinitely offline.
      if (status.state === 'attention') {
        delay = 60_000;
        retryAt = Date.now() + delay;
      }
      options.onStatus?.(status);
    } catch (reason) {
      failures++;
      delay = Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4));
      retryAt = Date.now() + delay;
      if (active) options.onError?.(reason);
    } finally {
      running = false;
      schedule(pendingWake && failures === 0 ? 300 : delay);
      pendingWake = false;
    }
  }
  schedule(1_500);
  return {
    wake() { if (!active) return; if (running) pendingWake = true; else schedule(300); },
    stop() { active = false; clearTimeout(timer); },
  };
}
