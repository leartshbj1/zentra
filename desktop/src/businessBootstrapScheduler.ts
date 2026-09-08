export type BusinessBootstrapStatus = {
  state:
    | 'not_prepared'
    | 'sending'
    | 'waiting_for_connection'
    | 'uploading'
    | 'history_uploaded'
    | 'files_uploading'
    | 'files_uploaded';
  transfer_id?: string;
  confirmed_chunks?: number;
  total_chunks?: number;
  sent_chunks?: number;
  files_pending?: number;
  replication_active: false;
};

// This sender only resumes an explicitly prepared history. It neither chooses
// a company history nor activates replication. Project files have their own loop.
export function startBusinessBootstrapScheduler(options: {
  synchronize: () => Promise<BusinessBootstrapStatus>;
  isOnline: () => boolean;
  onStatus?: (status: BusinessBootstrapStatus) => void;
  onError?: (reason: unknown) => void;
}) {
  let active = true;
  let running = false;
  let wakePending = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(delay: number) {
    clearTimeout(timer);
    if (active) timer = setTimeout(() => void tick(), delay);
  }

  async function tick() {
    if (!active || running) return;
    if (!options.isOnline()) {
      schedule(60_000);
      return;
    }
    running = true;
    let nextDelay = 60_000;
    try {
      const status = await options.synchronize();
      failures = 0;
      if (active) options.onStatus?.(status);
      if (
        status.state === 'uploading' ||
        status.state === 'sending' ||
        status.state === 'files_uploading'
      ) {
        nextDelay = 5_000;
      } else if (
        status.state === 'not_prepared' ||
        status.state === 'history_uploaded' ||
        status.state === 'files_uploaded'
      ) {
        nextDelay = 300_000;
      }
    } catch (reason) {
      failures++;
      nextDelay = Math.min(300_000, 30_000 * 2 ** Math.min(failures, 4));
      if (active) options.onError?.(reason);
    } finally {
      running = false;
      // Focus storms must not turn a failing request into a tight retry loop.
      schedule(wakePending && failures === 0 ? 500 : nextDelay);
      wakePending = false;
    }
  }

  schedule(3_000);
  return {
    wake() {
      if (!active) return;
      if (running) wakePending = true;
      else schedule(300);
    },
    stop() {
      active = false;
      clearTimeout(timer);
    },
  };
}
