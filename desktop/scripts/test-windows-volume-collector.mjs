#!/usr/bin/env node
/** Offline collector contract tests. No application is started and no network is used. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import {
  CdpConnection, collect, collectionOutcome, normalizeWindowsPath, parseArguments,
  validateFixture, validateWorkspace,
} from './windows-volume-collector.mjs';

let checks = 0;
const check = (name, action) => {
  action();
  checks++;
  console.log(`PASS ${name}`);
};
const marker = {
  synthetic: true, accountOrLicenseAdded: false, companyName: 'Atelier Volume 1909 - FICTIF',
  counts: { invoices: 5000, quotes: 5000, invoice_items: 40000, quote_items: 40000 },
};
const tempParent = realpathSync.native(tmpdir());
const runRoot = mkdtempSync(path.join(tempParent, 'zentra-volume-1909-collector-test-'));
const profile = path.join(runRoot, 'profile');
mkdirSync(profile);
writeFileSync(path.join(runRoot, 'fixture.json'), JSON.stringify(marker));
const savedGlobals = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };

function makeBrowser(scenario) {
  const shown = { getClientRects: () => [{}] };
  const data = {
    settings: { company_name: marker.companyName }, clients: [{ id: 'synthetic-client' }],
    ...Object.fromEntries(Object.entries(marker.counts).map(([key, count]) => [key, Array(count).fill(null)])),
  };
  const calls = [];
  const context = vm.createContext({
    location: { href: 'http://tauri.localhost/' },
    window: { __TAURI_INTERNALS__: { invoke: async command => {
      calls.push(command);
      if (command === 'get_app_state') return { data_dir: scenario.wrongProfile ? path.join(runRoot, 'different-profile') : profile, app_version: scenario.wrongVersion ? '1.90.8' : '1.90.9' };
      if (command === 'get_workspace') return data;
      throw new Error(`Mutation or unexpected IPC requested: ${command}`);
    } } },
    document: {
      querySelector: selector => {
        if (selector === '.license-banner' && scenario.gate === 'licence') return shown;
        if (selector === 'main.company-account-opening' && scenario.gate === 'account') return shown;
        return null;
      },
      querySelectorAll: selector => selector === '[role="dialog"], [aria-modal="true"]' && scenario.gate === 'modal' ? [shown] : [],
    },
    getComputedStyle: () => ({ visibility: 'visible' }),
    requestAnimationFrame: () => { throw new Error('A gated screen must not be claimed ready'); },
    performance, crypto: webcrypto, TextEncoder, Date,
  });
  return { context, calls };
}

function installFakeCdp(scenario) {
  const browser = makeBrowser(scenario);
  const protocol = [];
  const requests = [];
  let socketCount = 0;
  class FakeWebSocket extends EventTarget {
    constructor() {
      super();
      socketCount++;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(encoded) {
      const command = JSON.parse(encoded);
      protocol.push(command.method);
      queueMicrotask(async () => {
        let result = {};
        try {
          if (command.method === 'Runtime.evaluate') {
            result = { result: { value: await vm.runInContext(command.params.expression, browser.context) } };
          }
          if (/^Input\.|Page\.reload|Page\.captureScreenshot/.test(command.method)) throw new Error('A gated UI must not be manipulated');
        } catch (error) {
          result = { exceptionDetails: { text: error.message, exception: { description: error.message } } };
        }
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, result }) }));
      });
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async url => {
    requests.push(url);
    assert.equal(url, 'http://127.0.0.1:19387/json/list');
    return { ok: true, json: async () => scenario.noCdp ? [{ type: 'page', url: 'http://unrelated.local/', webSocketDebuggerUrl: 'ws://127.0.0.1:19387/devtools/page/unrelated' }] : [{ type: 'page', url: 'http://tauri.localhost/', webSocketDebuggerUrl: 'ws://127.0.0.1:19387/devtools/page/synthetic' }] };
  };
  return { ...browser, protocol, requests, socketCount: () => socketCount };
}

async function runScenario(name, scenario) {
  const transport = installFakeCdp(scenario);
  const output = path.join(runRoot, `${name}.json`);
  const result = await collect({ endpoint: 'http://127.0.0.1:19387', profile, version: '1.90.9', output, started: Date.now() - 20, deadline: Date.now() + 30_000 });
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), result.proof);
  return { ...result, ...transport };
}

try {
  check('Windows canonical path comparison', () => assert.equal(normalizeWindowsPath('\\\\?\\C:\\Temporary\\profile\\'), normalizeWindowsPath('c:/temporary/profile')));
  const argv = ['--endpoint', 'http://127.0.0.1:9387', '--profile', profile, '--version', '1.90.9', '--output', path.join(runRoot, 'parsed.json'), '--started-epoch-ms', String(Date.now() - 100), '--deadline-epoch-ms', String(Date.now() + 10_000)];
  check('valid arguments', () => assert.equal(parseArguments(argv).version, '1.90.9'));
  for (const endpoint of ['https://127.0.0.1:9387', 'http://example.com:9387', 'http://localhost:9387', 'http://127.0.0.1:9387/path', 'http://user:pass@127.0.0.1:9387']) {
    check(`refuse endpoint ${endpoint}`, () => { const changed = [...argv]; changed[1] = endpoint; assert.throws(() => parseArguments(changed)); });
  }
  check('refuse duplicate arguments', () => assert.throws(() => parseArguments([...argv, '--version', '1.90.9'])));
  check('valid synthetic marker', () => validateFixture(marker));
  check('refuse non-synthetic marker', () => assert.throws(() => validateFixture({ ...marker, synthetic: false })));
  check('refuse added account/licence', () => assert.throws(() => validateFixture({ ...marker, accountOrLicenseAdded: true })));
  check('refuse wrong fixture count', () => assert.throws(() => validateFixture({ ...marker, counts: { ...marker.counts, invoices: 4999 } })));

  for (const gate of ['licence', 'account', 'modal']) {
    const result = await runScenario(`partial-${gate}`, { gate });
    check(`three IPC complete before ${gate} gate yields partial`, () => {
      assert.equal(result.exitCode, 2);
      assert.equal(result.proof.status, 'partial');
      assert.equal(result.proof.measured, false);
      assert.equal(result.proof.ipcMeasured, true);
      assert.equal(result.proof.uiMeasured, false);
      assert.match(result.proof.uiNotMeasuredReason, /blocked/);
      assert.equal(result.proof.workspace.length, 3);
      assert.equal(result.calls.filter(command => command === 'get_workspace').length, 3);
      assert.deepEqual(result.calls, ['get_app_state', 'get_app_state', 'get_workspace', 'get_app_state', 'get_workspace', 'get_app_state', 'get_workspace']);
      assert.equal(result.proof.navigation.length, 0);
      assert.equal(result.proof.reload, null);
      assert.equal(result.proof.startup, null);
      assert.ok(!result.protocol.some(command => /^Input\.|Page\.reload|Page\.captureScreenshot/.test(command)));
      for (const reading of result.proof.workspace) {
        validateWorkspace(reading);
        assert.equal(Object.hasOwn(reading, 'settings'), false);
        assert.equal(Object.hasOwn(reading, 'invoices'), false);
      }
    });
  }

  for (const key of ['wrongProfile', 'wrongVersion']) {
    const result = await runScenario(key, { [key]: true, gate: 'licence' });
    check(`refuse ${key} before get_workspace or UI interaction`, () => {
      assert.equal(result.exitCode, 1);
      assert.equal(result.proof.status, 'failed');
      assert.equal(result.proof.ipcMeasured, false);
      assert.equal(result.proof.uiMeasured, false);
      assert.deepEqual(result.calls, ['get_app_state']);
      assert.equal(result.proof.workspace.length, 0);
      assert.ok(!result.protocol.includes('Page.bringToFront'));
    });
  }

  check('unresolved IPC cannot become partial success', () => assert.equal(collectionOutcome({ code: 'UI_UNAVAILABLE' }, { ipcMeasured: true, errors: [], unresolvedCommands: ['Runtime.evaluate'] }).status, 'failed'));
  check('renderer error cannot become partial success', () => assert.equal(collectionOutcome({ code: 'UI_UNAVAILABLE' }, { ipcMeasured: true, errors: ['renderer exception'], unresolvedCommands: [] }).status, 'failed'));

  class Socket extends EventTarget { send(value) { this.last = JSON.parse(value); } close() {} }
  const socket = new Socket();
  const pendingProof = { unresolvedCommands: [] };
  const cdp = new CdpConnection(socket, Date.now() + 1000, pendingProof);
  const completed = cdp.send('Runtime.evaluate', {}, 100);
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: socket.last.id, result: { value: 1 } }) }));
  assert.deepEqual(await completed, { value: 1 });
  check('resolved command clears pending work', () => assert.equal(cdp.pending.size, 0));
  await assert.rejects(cdp.send('Runtime.evaluate', {}, 5), /timed out/);
  check('timed-out native command remains explicitly unresolved', () => assert.deepEqual(pendingProof.unresolvedCommands, ['Runtime.evaluate']));
  cdp.on('test', async () => { throw new Error('event failure'); });
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'test', params: {} }) }));
  await assert.rejects(cdp.settleEvents(), /CDP event handling failed/);
  checks++;
  console.log('PASS event failures are awaited and reported');

  console.log('Checking bounded missing CDP discovery (15 seconds, mocked fetch only)…');
  const missingStart = Date.now();
  const missing = await runScenario('missing-cdp', { noCdp: true });
  check('missing exact native CDP target is not measured', () => {
    assert.equal(missing.exitCode, 2);
    assert.equal(missing.proof.status, 'not_measured');
    assert.equal(missing.proof.measured, false);
    assert.equal(missing.proof.ipcMeasured, false);
    assert.equal(missing.proof.uiMeasured, false);
    assert.equal(missing.socketCount(), 0);
    assert.deepEqual(missing.calls, []);
    assert.ok(Date.now() - missingStart < 17_000, 'Discovery exceeded its bounded budget');
  });
  console.log(JSON.stringify({ status: 'passed', offlineChecks: checks, realApplicationStarted: false, networkUsed: false }));
} finally {
  globalThis.fetch = savedGlobals.fetch;
  globalThis.WebSocket = savedGlobals.WebSocket;
  // Delete only this mkdtemp-created test directory, after checking its boundary.
  assert.equal(path.dirname(path.resolve(runRoot)), path.resolve(tempParent));
  assert.ok(path.basename(runRoot).startsWith('zentra-volume-1909-collector-test-'));
  rmSync(runRoot, { recursive: true, force: false });
}
