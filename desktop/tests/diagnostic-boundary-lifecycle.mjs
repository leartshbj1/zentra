import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as freePortServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The actual boundary, React renderer, diagnostic module and Vite language
// plugins run here. Only the child throwing the exception is synthetic.
// Optional baseline loading reads Git without changing the working tree.
const desktop = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(desktop, 'package.json'));
const vite = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href);
const imported = await import(pathToFileURL(process.env.ZENTRA_PLAYWRIGHT_MODULE || require.resolve('playwright')).href);
const pw = imported.default ?? imported;
const revision = process.env.ZENTRA_BOUNDARY_REVISION;
const source = revision
  ? execFileSync('git', ['show', `${revision}:desktop/src/DiagnosticBoundary.tsx`], { cwd: desktop, encoding: 'utf8' })
  : await readFile(join(desktop, 'src/DiagnosticBoundary.tsx'), 'utf8');
const output = process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), 'zentra-diagnostic-boundary-lifecycle.json');
const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, join(desktop, 'vite.config.ts'));
const portProbe = freePortServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const entry = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {DiagnosticBoundary} from '/src/DiagnosticBoundary.tsx';
  import {installDiagnosticCapture,recentDiagnosticEvents} from '/src/diagnostics.ts';
  installDiagnosticCapture();
  const root=createRoot(document.getElementById('probe'));
  root.render(React.createElement(DiagnosticBoundary,null,React.createElement('p',null,'Fixture ready')));
  let Broken;
  window.probe=kind=>{
    let reason;
    if(kind==='native_string')reason='Synthetic native failure';
    else if(kind==='normal_error')reason=new Error('Synthetic JS failure');
    else if(kind==='message_getter'){
      reason=new Error('');
      Object.defineProperty(reason,'message',{get(){throw new Error('Synthetic accessor failure');}});
    }else reason=new Proxy(new Error(''),{getPrototypeOf(){throw new Error('Synthetic prototype failure');}});
    Broken=()=>{throw reason;};
    root.render(React.createElement(DiagnosticBoundary,null,React.createElement(Broken)));
  };
  window.rerender=()=>root.render(React.createElement(DiagnosticBoundary,null,React.createElement(Broken)));
  window.events=()=>recentDiagnosticEvents().map(({id,operation,phase,errorCode})=>({id,operation,phase,errorCode}));
  window.ready=true;
`;
const fixture = {
  name: 'diagnostic-boundary-fixture',
  enforce: 'pre',
  resolveId(id) { if (id === 'virtual:boundary-fixture') return '\0' + id; },
  load(id) {
    if (id === '\0virtual:boundary-fixture') return entry;
    if (revision && id.replaceAll('\\', '/').endsWith('/src/DiagnosticBoundary.tsx')) return source;
  },
  configureServer(server) {
    server.middlewares.use('/__boundary_fixture', async (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(await server.transformIndexHtml('/__boundary_fixture', '<!doctype html><html><head></head><body><div id="probe"></div><script type="module" src="/@id/__x00__virtual:boundary-fixture"></script></body></html>'));
    });
  },
};
const server = await vite.createServer({ ...loaded.config, configFile: false, root: desktop,
  cacheDir: join(tmpdir(), 'zentra-boundary-lifecycle-vite'), optimizeDeps: { entries: [] },
  plugins: [fixture, ...loaded.config.plugins],
  server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } }, logLevel: 'silent',
});
const report = { revision: revision || 'working-tree', sourceSha256: createHash('sha256').update(source).digest('hex'),
  scope: 'Actual React boundary, synthetic child exceptions, local browser only; no native binary or physical-device certification', results: [] };
try {
  await server.listen();
  for (const engine of ['chromium', 'webkit']) {
    const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32'
      ? { executablePath: process.env.ZENTRA_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : {}) });
    try {
      for (const kind of ['native_string', 'normal_error', 'message_getter', 'prototype_proxy']) {
        const page = await browser.newPage();
        let pageErrors = 0, external = 0;
        page.on('pageerror', () => { pageErrors++; });
        await page.route('**/*', route => {
          if (route.request().url().startsWith(origin + '/')) return route.continue();
          external++; return route.abort();
        });
        await page.goto(origin + '/__boundary_fixture');
        await page.waitForFunction(() => window.ready === true, null, { timeout: 15_000 });
        await page.evaluate(kind => window.probe(kind), kind);
        await page.waitForTimeout(250);
        const incident = page.locator('.error-guidance__incident code');
        const code = await incident.count() ? await incident.textContent() : null;
        const events = await page.evaluate(() => window.events());
        const renderEvents = events.filter(event => event.operation === 'client.react_render');
        const beforeRerender = await page.locator('body').innerText();
        await page.evaluate(() => window.rerender());
        await page.waitForTimeout(100);
        const rerenderCode = await incident.count() ? await incident.textContent() : null;
        const retry = page.getByRole('button', { name: 'Actualiser l’affichage', exact: true });
        let resumed = false;
        if (await retry.count()) {
          await Promise.all([page.waitForEvent('load'), retry.click()]);
          await page.waitForFunction(() => window.ready === true && document.body.textContent.includes('Fixture ready'), null, { timeout: 15_000 });
          resumed = await page.getByText('Fixture ready', { exact: true }).isVisible();
        }
        const checks = { visibleFallback: beforeRerender.includes('Cet écran ne peut pas être affiché.'),
          oneRenderIncident: renderEvents.length === 1 && renderEvents[0].phase === 'failure' && renderEvents[0].errorCode === 'RENDER',
          linkedReference: renderEvents.length === 1 && code === 'ZT-' + renderEvents[0].id,
          stableReference: !!code && rerenderCode === code, noPresentationIncident: !events.some(event => event.operation === 'client.present_error'),
          resumed, noBlankScreen: !!beforeRerender.trim(), noUnhandledErrors: pageErrors === 0, noExternalRequests: external === 0 };
        report.results.push({ engine, kind, passed: Object.values(checks).every(Boolean), checks, pageErrors, external });
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, passed: report.results.filter(result => result.passed).length, total: report.results.length }));
assert.equal(report.results.length, 8);
assert.ok(report.results.every(result => result.passed), 'Boundary fallback, incident or explicit recovery regression; see JSON evidence');
