// Compile the isolated fixture with the real reader and application CSP.
// This serves test data only; it does not exercise the native sharing bridge.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const base = resolve(desktop, '../.qa/project-files-production');
await build({ root: desktop, configFile: resolve(desktop, 'vite.config.ts'), define: { __ZENTRA_PLATFORM__: JSON.stringify('android') }, publicDir: false, build: { outDir: base, emptyOutDir: true, rolldownOptions: { input: resolve(desktop, 'tests/project-files-harness.html') } } });
const { app: { security: { csp } } } = JSON.parse(await readFile(resolve(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
const port = Number(process.env.ZENTRA_QA_PORT || 5194);
http.createServer(async (req, res) => {
  try {
    const path = resolve(base, `.${decodeURIComponent(new URL(req.url, 'http://localhost').pathname)}`);
    if (!path.startsWith(base + sep)) { res.writeHead(403).end(); return; }
    const bytes = await readFile(path);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' })[extname(path)] || 'application/octet-stream', 'Content-Security-Policy': csp, 'Cache-Control': 'no-store' });
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
}).listen(port, '127.0.0.1', () => console.log(`Compiled project reader with production CSP: http://127.0.0.1:${port}`));
