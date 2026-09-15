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

/** An authenticated 25 s long poll backed by a private Supabase broadcast.
 * Subscribe BEFORE reading the durable head, and read it again on wake/timeout:
 * a missed, duplicate or reordered notification cannot lose a revision.
 */
export async function watchCompanyRevision(organization: string, after: number, signal: AbortSignal, dependencies: RealtimeDependencies) {
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let joinTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let joined = false;
  let finish!: () => void;
  const notified = new Promise<void>(resolve => { finish = resolve; });
  const aborted = () => finish();
  signal.addEventListener('abort', aborted, { once: true });
  try {
    signal.throwIfAborted();
    const first = await dependencies.head();
    if (!first.enabled || first.revision > after) return { ...first, realtime: false };
    const topic = `realtime:zentra:company:${organization}`;
    const url = endpoint(dependencies.configuration, 'websocket');
    url.searchParams.set('apikey', dependencies.configuration.secretKey);
    url.searchParams.set('vsn', '1.0.0');
    const handshake = new AbortController();
    handshakeTimer = setTimeout(() => handshake.abort(), 5000);
    const response = await dependencies.fetch(url, {
      headers: { Upgrade: 'websocket' }, redirect: 'manual',
      signal: AbortSignal.any([signal, handshake.signal]),
    });
    clearTimeout(handshakeTimer);
    socket = (response as Response & { webSocket?: Socket }).webSocket;
    if (!socket) { await response.body?.cancel(); throw new Error(`Realtime handshake unavailable (${response.status})`); }
    const activeSocket = socket;
    activeSocket.accept();
    activeSocket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 4096) return;
        const message = JSON.parse(event.data);
        if (message.topic !== topic) return;
        if (message.event === 'phx_reply' && message.ref === 'join') {
          if (message.payload?.status !== 'ok') { finish(); return; }
          joined = true; clearTimeout(joinTimer);
          // Covers a commit between the initial SELECT and subscribe ack.
          void dependencies.head().then(head => { if (head.revision > after) finish(); }, finish);
        }
        if (message.event === 'broadcast' && message.payload?.event === 'revision' &&
            Number.isSafeInteger(message.payload?.payload?.revision) && message.payload.payload.revision > after) finish();
        if (message.event === 'phx_error' || message.event === 'phx_close') finish();
      } catch { /* Discard malformed notices; the durable head is authoritative. */ }
    });
    activeSocket.addEventListener('error', finish);
    activeSocket.addEventListener('close', finish);
    timer = setTimeout(finish, 25_000);
    joinTimer = setTimeout(finish, 5000);
    heartbeat = setInterval(() => {
      try { activeSocket.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 'heartbeat' })); }
      catch { finish(); }
    }, 15_000);
    activeSocket.send(JSON.stringify({ topic, event: 'phx_join', ref: 'join', payload: {
      config: { private: true, broadcast: { self: false, ack: false }, presence: { enabled: false } },
    } }));
    if (signal.aborted) finish();
    await notified;
    signal.throwIfAborted();
    return { ...await dependencies.head(), realtime: joined };
  } finally {
    clearTimeout(timer); clearTimeout(joinTimer); clearTimeout(handshakeTimer); clearInterval(heartbeat);
    signal.removeEventListener('abort', aborted);
    try { socket?.close(1000, 'Watch completed'); } catch { /* Already closed. */ }
  }
}
