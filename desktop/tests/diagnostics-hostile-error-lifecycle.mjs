import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Rust command_error returns a string. These synthetic unknown JS rejections
// test the logger's best-effort boundary, not a claimed native business failure.
// Run the actual diagnostics module and Tauri JS SDK; only IPC is simulated.
const desktop = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(desktop, 'package.json'));
const pw = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const ts = require('typescript');
const output = process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), 'zentra-diagnostics-hostile-errors');
await mkdir(output, { recursive: true });
const source = await readFile(join(desktop, 'src/diagnostics.ts'), 'utf8');
const tauri = dirname(require.resolve('@tauri-apps/api/package.json'));
const dataUrl = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64');
const tslib = dataUrl(await readFile(join(tauri, 'external/tslib/tslib.es6.js'), 'utf8'));
const coreSource = await readFile(join(tauri, 'core.js'), 'utf8');
assert.ok(coreSource.includes("'./external/tslib/tslib.es6.js'"));
const core = dataUrl(coreSource.replace("'./external/tslib/tslib.es6.js'", JSON.stringify(tslib)));
assert.ok(source.includes("'@tauri-apps/api/core'"));
const compiled = ts.transpileModule(source.replace("'@tauri-apps/api/core'", JSON.stringify(core)), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const moduleUrl = dataUrl(compiled.outputText);
const report = {
  scope: 'Unknown JS error robustness; actual diagnostics and Tauri SDK with synthetic IPC, real browser event listeners, no raw error content',
  sourceHash: createHash('sha256').update(source).digest('hex'),
  results: [],
};
for (const engine of ['chromium', 'webkit']) {
  const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32'
    ? { executablePath: process.env.ZENTRA_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : {}) });
  const page = await browser.newPage();
  let pageErrorCount = 0;
  page.on('pageerror', () => { pageErrorCount++; });
  await page.route('**/*', route => route.abort());
  try {
    const result = await page.evaluate(async moduleUrl => {
      let nativeReason;
      window.__TAURI_INTERNALS__ = { invoke: async command => { if (command === 'read_workspace') throw nativeReason; } };
      const d = await import(moduleUrl);
      const coercionError = (accessor, method) => {
        const original = new Error(''), accessFault = new Error('');
        const message = method === 'primitive' ? { [Symbol.toPrimitive]() { throw accessFault; } }
          : { toString() { throw accessFault; } };
        Object.defineProperty(original, 'message', accessor ? { get() { return message; } } : { value: message });
        return { kind: `${method}_message_${accessor ? 'accessor' : 'value'}`, original, accessFault };
      };
      const fixtures = () => [
        { kind: 'normal_error', original: new Error('') },
        (() => {
          const original = new Error(''), accessFault = new Error('');
          Object.defineProperty(original, 'message', { get() { throw accessFault; } });
          return { kind: 'error_message_getter_throws', original, accessFault };
        })(),
        (() => {
          const accessFault = new Error('');
          const original = new Proxy(new Error(''), { getPrototypeOf() { throw accessFault; } });
          return { kind: 'error_proxy_get_prototype_throws', original, accessFault };
        })(),
        (() => {
          const accessFault = new Error(''), original = { get message() { throw accessFault; } };
          return { kind: 'plain_object_message_getter_throws', original, accessFault };
        })(),
        coercionError(false, 'primitive'), coercionError(true, 'primitive'),
        coercionError(false, 'string'), coercionError(true, 'string'),
        { kind: 'numeric_message', expectedCode: 'SESSION', original: Object.defineProperty(new Error(''), 'message', { value: 401 }) },
        { kind: 'coercible_message', expectedCode: 'NETWORK', original: Object.defineProperty(new Error(''), 'message', {
          value: { toString() { return 'network timeout'; } },
        }) },
      ];
      const operations = [], invocations = [];
      for (const fixture of fixtures()) {
        await d.diagnosticsApi.clear();
        let caught;
        try { await d.diagnosticOperation('command', 'read_workspace', async () => { throw fixture.original; }); }
        catch (reason) { caught = reason; }
        const events = d.recentDiagnosticEvents();
        let classifier, classificationEscaped = false;
        try { classifier = d.classifyDiagnosticError(fixture.original); }
        catch (reason) { classificationEscaped = fixture.accessFault !== undefined && reason === fixture.accessFault; }
        operations.push({ kind: fixture.kind, classifier, classificationEscaped, expectedCode: fixture.expectedCode || 'INTERNAL',
          originalPreserved: caught === fixture.original,
          replacedByAccessFault: fixture.accessFault !== undefined && caught === fixture.accessFault,
          phases: events.map(event => event.phase), codes: events.filter(event => event.errorCode).map(event => event.errorCode) });
      }
      for (const fixture of fixtures()) {
        await d.diagnosticsApi.clear(); nativeReason = fixture.original;
        let caught;
        try { await d.diagnosticInvoke('read_workspace'); } catch (reason) { caught = reason; }
        invocations.push({ kind: fixture.kind, originalPreserved: caught === fixture.original,
          replacedByAccessFault: fixture.accessFault !== undefined && caught === fixture.accessFault });
      }
      await d.diagnosticsApi.clear(); d.installDiagnosticCapture();
      let active;
      window.addEventListener('error', event => {
        if (active) active.observedErrors.push({ matchesOriginal: event.error === active.original,
          matchesAccessFault: active.accessFault !== undefined && event.error === active.accessFault });
      });
      window.addEventListener('unhandledrejection', event => {
        if (active) active.originalReasonObserved = event.reason === active.original;
      });
      const captures = [];
      for (const fixture of fixtures()) {
        await d.diagnosticsApi.clear(); active = { ...fixture, observedErrors: [], originalReasonObserved: false };
        window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: fixture.original }));
        await new Promise(resolve => setTimeout(resolve, 20));
        const events = d.recentDiagnosticEvents();
        captures.push({ kind: fixture.kind, originalReasonObserved: active.originalReasonObserved,
          loggerProducedWindowErrors: active.observedErrors,
          events: events.map(event => ({ operation: event.operation, phase: event.phase, errorCode: event.errorCode })),
          recordKeysValid: events.every(event => Object.keys(event).every(key =>
            ['id', 'sessionId', 'timestamp', 'area', 'operation', 'phase', 'durationMs', 'errorCode'].includes(key))) });
        active = undefined;
      }
      await d.flushDiagnostics(true);
      return { operations, invocations, captures };
    }, moduleUrl);
    report.results.push({ engine, ...result, pageErrorCount });
  } finally { await browser.close(); }
}
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
for (const result of report.results) {
  for (const row of [...result.operations, ...result.invocations]) {
    assert.equal(row.originalPreserved, true, `${result.engine}: ${row.kind} must preserve the rejection`);
    assert.equal(row.replacedByAccessFault, false);
  }
  for (const row of result.operations) {
    assert.equal(row.classificationEscaped, false);
    assert.equal(row.classifier, row.expectedCode);
    assert.deepEqual(row.phases, ['start', 'failure']);
    assert.deepEqual(row.codes, [row.expectedCode]);
  }
  for (const row of result.captures) {
    assert.equal(row.originalReasonObserved, true);
    assert.deepEqual(row.loggerProducedWindowErrors, [], `${result.engine}: ${row.kind} capture must not throw`);
    assert.deepEqual(row.events, [{ operation: 'client.unhandled_rejection', phase: 'failure', errorCode: 'UNHANDLED' }]);
    assert.equal(row.recordKeysValid, true);
  }
  assert.equal(result.pageErrorCount, 0);
}
console.log(JSON.stringify({ output, engines: report.results.map(result => result.engine), passed: true }));
