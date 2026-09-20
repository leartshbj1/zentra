export type CompanyRevisionNotice = { enabled: boolean; organizationId?: string; revision?: number; changed?: boolean; realtime?: boolean };

/** One outstanding authenticated watch, paused in the background/offline.
 * Notifications only wake the durable snapshot protocol; they contain no data.
 */
export function startCompanyRealtime(options: {
  watch: (after: number) => Promise<CompanyRevisionNotice>;
  available: () => boolean;
  onRevision: () => void;
  onHealth?: (healthy: boolean) => void;
}) {
  let active = true, running = false, wakePending = false, after = 0, failures = 0;
  let organization: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number) => { clearTimeout(timer); if (active) timer = setTimeout(() => void tick(), delay); };
  async function tick() {
    if (!active || running) return;
    if (!options.available()) { options.onHealth?.(false); schedule(5000); return; }
    running = true;
    let delay = 250;
    try {
      const value = await options.watch(after);
      if (!active) return;
      failures = 0;
      options.onHealth?.(value.enabled === true && value.realtime === true && options.available());
      if (!value.enabled) { after = 0; organization = undefined; delay = 30_000; }
      else {
        if (organization && organization !== value.organizationId) after = 0;
        organization = value.organizationId;
        if (Number.isSafeInteger(value.revision)) after = Math.max(after, value.revision!);
        if (value.changed && options.available()) options.onRevision();
        // Older gateways or an unavailable websocket keep a bounded fallback.
        if (!value.realtime) delay = 5000;
      }
    } catch {
      if (active) options.onHealth?.(false);
      failures++;
      delay = Math.min(60_000, 5000 * 2 ** Math.min(failures - 1, 4));
      // The normal scheduler owns the user-visible error and local outbox.
    } finally {
      running = false;
      schedule(wakePending ? 250 : delay); wakePending = false;
    }
  }
  schedule(1000);
  return {
    wake() { if (!active) return; if (running) wakePending = true; else schedule(250); },
    stop() { active = false; options.onHealth?.(false); clearTimeout(timer); },
  };
}
