// Server-only transport. Installations authenticate with the account gateway;
// Supabase credentials and private channels never reach the application.
export type RealtimeConfiguration = { url: string; secretKey: string };
export type RevisionHead = { organizationId: string; revision: number; enabled: boolean };
type Socket = Pick<WebSocket, 'send' | 'close' | 'addEventListener' | 'removeEventListener'> & { accept(): void };
export type RealtimeDependencies = {
  fetch: typeof fetch;
  configuration: RealtimeConfiguration;
  head: () => Promise<RevisionHead>;
};
function endpoint(configuration: RealtimeConfiguration, path: string) {
  const url = new URL(configuration.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !configuration.secretKey) {
    throw new Error('Realtime configuration unavailable');
  }
  url.pathname = `/realtime/v1/${path}`;
  return url;
}
export async function announceCompanyRevision(configuration: RealtimeConfiguration, organization: string, revision: number, send: typeof fetch = (...args) => fetch(...args)) {
  const response = await send(endpoint(configuration, 'api/broadcast'), {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(3000),
    headers: { apikey: configuration.secretKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ topic: `zentra:company:${organization}`, event: 'revision', private: true, payload: { revision } }] }),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('Realtime notification unavailable');
}

/** A request-local private subscription with a 25 s waiting budget.
 * Read the durable head after joining, and again on notification/timeout. A
 * missed, duplicate or reordered notification cannot lose a revision. Keep I/O
 * request-local: Workers cannot safely reuse sockets across request contexts.
 */
export async function watchCompanyRevision(organization: string, after: number, signal: AbortSignal, dependencies: RealtimeDependencies) {
  const startedAt = Date.now();
  const topic = `realtime:zentra:company:${organization}`;
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let joinTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let handshake: AbortController | undefined;
  let joined = false;
  let joinAcknowledged = false;
  let stopped = false;
  let resolveNotification!: (head?: RevisionHead) => void;
  const notified = new Promise<RevisionHead | undefined>(resolve => { resolveNotification = resolve; });
  // Release the subscription as soon as it wakes, before the final database
  // read. A slow database must not retain extra sockets, timers or listeners.
  const releaseSubscription = () => {
    clearTimeout(timer); clearTimeout(joinTimer); clearTimeout(handshakeTimer); clearInterval(heartbeat);
    if (!socket) return;
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('error', disconnected);
    socket.removeEventListener('close', disconnected);
    try { socket.close(1000, 'Watch completed'); } catch { /* Already closed. */ }
    socket = undefined;
  };
  const finish = (head?: RevisionHead) => {
    if (stopped) return;
    stopped = true;
    releaseSubscription();
    handshake?.abort();
    resolveNotification(head);
  };
  const disconnected = () => { joined = false; finish(); };
  const aborted = () => finish();
  function onMessage(event: MessageEvent) {
    if (stopped) return;
    try {
      if (typeof event.data !== 'string' || event.data.length > 4096) return;
      const message = JSON.parse(event.data);
      if (message.topic !== topic) return;
      if (message.event === 'phx_reply' && message.ref === 'join') {
        // One ack can trigger one durable read, even if the peer repeats it.
        if (joinAcknowledged) return;
        joinAcknowledged = true;
        if (message.payload?.status !== 'ok') { disconnected(); return; }
        joined = true; clearTimeout(joinTimer);
        void (async () => {
          try {
            // Covers a commit between the initial SELECT and subscribe ack.
            const head = await dependencies.head();
            if (!stopped && (!head.enabled || head.revision > after)) finish(head);
          } catch { if (!stopped) disconnected(); }
        })();
      }
      if (message.event === 'broadcast' && message.payload?.event === 'revision' &&
          Number.isSafeInteger(message.payload?.payload?.revision) && message.payload.payload.revision > after) finish();
      if (message.event === 'phx_error' || message.event === 'phx_close') disconnected();
    } catch { /* Discard malformed notices; the durable head is authoritative. */ }
  }
  signal.addEventListener('abort', aborted, { once: true });
  try {
    signal.throwIfAborted();
    const first = await dependencies.head();
    signal.throwIfAborted();
    if (!first.enabled || first.revision > after) return { ...first, realtime: false };
    const remaining = 25_000 - (Date.now() - startedAt);
    if (remaining <= 0) return { ...first, realtime: false };
    // Include handshake time instead of adding another 25 s after it; native
    // account requests time out at 30 s, including authentication and reads.
    timer = setTimeout(() => finish(), remaining);
    const url = endpoint(dependencies.configuration, 'websocket');
    url.searchParams.set('apikey', dependencies.configuration.secretKey);
    url.searchParams.set('vsn', '1.0.0');
    handshake = new AbortController();
    handshakeTimer = setTimeout(() => handshake?.abort(), 5000);
    const response = await dependencies.fetch(url, {
      headers: { Upgrade: 'websocket' }, redirect: 'manual',
      signal: AbortSignal.any([signal, handshake.signal]),
    });
    clearTimeout(handshakeTimer);
    socket = (response as Response & { webSocket?: Socket }).webSocket;
    if (!socket) { await response.body?.cancel(); throw new Error(`Realtime handshake unavailable (${response.status})`); }
    // Workers requires acceptance even to close a socket. A response can race
    // with abort/timeout, so acquire it before either early-exit check.
    const activeSocket = socket;
    activeSocket.accept();
    signal.throwIfAborted();
    if (stopped) {
      releaseSubscription();
      const head = await dependencies.head();
      signal.throwIfAborted();
      return { ...head, realtime: false };
    }
    activeSocket.addEventListener('message', onMessage);
    activeSocket.addEventListener('error', disconnected);
    activeSocket.addEventListener('close', disconnected);
    joinTimer = setTimeout(() => finish(), 5000);
    heartbeat = setInterval(() => {
      try { activeSocket.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 'heartbeat' })); }
      catch { disconnected(); }
    }, 15_000);
    activeSocket.send(JSON.stringify({ topic, event: 'phx_join', ref: 'join', payload: {
      config: { private: true, broadcast: { self: false, ack: false }, presence: { enabled: false } },
    } }));
    if (signal.aborted) finish();
    const observed = await notified;
    signal.throwIfAborted();
    // An advanced durable head found by the post-join read already proves a
    // change. Reuse it; subsequent changes are recovered by the next watch.
    // A broadcast can never supply a revision: always read after that wake.
    const head = observed ?? await dependencies.head();
    signal.throwIfAborted();
    return { ...head, realtime: joined };
  } finally {
    stopped = true;
    releaseSubscription();
    signal.removeEventListener('abort', aborted);
  }
}
