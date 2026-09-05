// Read-only diagnostics for an owned CI emulator. Never writes a user profile.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 15000 }).trim();
if (!adb('get-serialno').startsWith('emulator-') || adb('shell', 'getprop', 'ro.kernel.qemu') !== '1') {
  throw new Error('Startup diagnostics are restricted to an emulator');
}
const pid = adb('shell', 'pidof', 'ch.zentra.mobile').split(' ')[0];
if (!/^\d+$/.test(pid)) throw new Error('Application PID unavailable');
adb('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`);
const proof = { pid, commands: [] };
let socket;
try {
  const pages = await (await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(15000) })).json();
  const target = pages.find(page => page.type === 'page' && page.webSocketDebuggerUrl);
  if (!target) throw new Error('No debuggable application page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  async function evaluate(expression) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('CDP response timeout')); }, 15000);
      function receive(event) {
        const response = JSON.parse(event.data);
        if (response.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener('message', receive);
        resolve(response.result?.result?.value ?? { evaluationError: true });
      }
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  }
  proof.page = await evaluate(`({readyState:document.readyState, nativeBridge:typeof window.__TAURI_INTERNALS__?.invoke==='function', loadingVisible:document.body.innerText.includes('Ouverture de votre espace local sécurisé'), resources:performance.getEntriesByType('resource').map(r=>({path:new URL(r.name).pathname,duration:Math.round(r.duration)}))})`);
  for (const command of ['get_app_state', 'get_cloud_account_state', 'get_license_state']) {
    // Record only completion, never the returned settings, identities or tokens.
    const state = await evaluate(`Promise.race([window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}).then(()=> 'resolved',()=> 'rejected'),new Promise(resolve=>setTimeout(()=>resolve('pending_after_8s'),8000))])`);
    proof.commands.push({ command, state });
  }
} catch (error) {
  proof.diagnosticError = error instanceof Error ? error.name : 'unknown';
} finally {
  socket?.close();
  adb('forward', '--remove', 'tcp:9222');
  writeFileSync('desktop/artifacts/android/startup-diagnostic.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
}
