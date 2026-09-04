const endpoint = process.env.ZENTRA_CDP_ENDPOINT ?? 'http://127.0.0.1:9223';
const pageUrl = process.argv[2];
const timeoutMs = Number(process.env.ZENTRA_SMOLVLM_TIMEOUT_MS ?? 20 * 60 * 1_000);

if (!pageUrl) {
  console.error('Usage: node probe-cdp.mjs <harness-url>');
  process.exit(2);
}

const target = await fetch(`${endpoint}/json/new?${encodeURIComponent(pageUrl)}`, {
  method: 'PUT',
}).then(async (response) => {
  if (!response.ok) {
    throw new Error(`Chrome DevTools target: ${response.status} ${await response.text()}`);
  }
  return response.json();
});

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let sequence = 0;

socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await command('Runtime.enable');
const startedAt = Date.now();
let previousSummary = '';

try {
  while (Date.now() - startedAt < timeoutMs) {
    const evaluation = await command('Runtime.evaluate', {
      expression: `JSON.stringify({
        ready: document.readyState,
        status: document.querySelector('#status')?.textContent ?? '',
        progress: Number(document.querySelector('#progress')?.value ?? 0),
        result: globalThis.__ZENTRA_SMOLVLM_E2E__ ?? null
      })`,
      returnByValue: true,
    });
    const snapshot = JSON.parse(evaluation.result.value);
    const summary = JSON.stringify({
      ready: snapshot.ready,
      status: snapshot.status,
      progress: Math.round(snapshot.progress * 10) / 10,
      state: snapshot.result?.state ?? null,
    });
    if (summary !== previousSummary) {
      console.log(summary);
      previousSummary = summary;
    }
    if (snapshot.result?.state === 'passed') {
      console.log(JSON.stringify({ ...snapshot.result, probeElapsedMs: Date.now() - startedAt }, null, 2));
      process.exitCode = 0;
      break;
    }
    if (snapshot.result?.state === 'failed') {
      console.error(JSON.stringify({ ...snapshot.result, probeElapsedMs: Date.now() - startedAt }, null, 2));
      process.exitCode = 1;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (process.exitCode === undefined) {
    console.error(`Timeout after ${timeoutMs} ms.`);
    process.exitCode = 2;
  }
} finally {
  socket.close();
  try {
    await fetch(`${endpoint}/json/close/${encodeURIComponent(target.id)}`);
  } catch {
    // The browser can disappear first; target cleanup is best-effort only.
  }
}
