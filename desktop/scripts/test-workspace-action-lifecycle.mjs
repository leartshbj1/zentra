/** Real App/React DOM regression with synthetic, closed account/business dependencies.
 * Run using the desired Node executable, or set ZENTRA_NODE_PATH. Optional paths:
 * ZENTRA_PLAYWRIGHT_MODULE, ZENTRA_EDGE_PATH; output: ZENTRA_QA_OUTPUT.
 * No installed app, OS clipboard, account, network API or user data is used.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as freePortServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
if (process.env.ZENTRA_NODE_PATH && resolve(process.env.ZENTRA_NODE_PATH).toLowerCase() !== resolve(process.execPath).toLowerCase()) {
  const child = spawn(process.env.ZENTRA_NODE_PATH, [script], { stdio: 'inherit', env: { ...process.env, ZENTRA_NODE_PATH: '' } });
  const exitCode = await new Promise((yes, no) => { child.once('error', no); child.once('exit', code => yes(code ?? 1)); });
  process.exit(exitCode);
}
const desktop = resolve(dirname(script), '..');
const out = resolve(process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), `zentra-workspace-action-lifecycle-${Date.now()}`));
await mkdir(out, { recursive: true });
const require = createRequire(join(desktop, 'package.json'));
const vite = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href);
const playwrightModule = process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright';
const imported = await import(playwrightModule.startsWith('file:') ? playwrightModule : pathToFileURL(isAbsolute(playwrightModule) ? playwrightModule : require.resolve(playwrightModule)).href);
const pw = imported.default ?? imported;
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceNames = [
  'src/App.tsx', 'src/WorkspaceApp.tsx', 'src/CompanyAccountGate.tsx', 'src/useWorkspaceRecovery.ts',
  'src/ContactForms.tsx', 'src/workspaceCreation.ts', 'src/workspaceMutation.ts', 'src/cloudAccessRevalidation.ts',
  'tests/mobile-harness.tsx', 'tests/app-draft-identity-fixture.ts', 'tests/workspace-action-lifecycle-fixture.ts',
];
const hashes = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, sha(await readFile(join(desktop, name)))])));
const report = {
  startedAt: new Date().toISOString(), node: { version: process.version, executable: process.execPath },
  before: await hashes(), cases: [],
  contract: 'Real App, CompanyAccountGate, keyed draft provider, WorkspaceApp act, ContactForm and createWorkspaceEntity. Synthetic already-verified account B is returned by pending App revalidation. Native choose_remote is modeled; the actual Gate open button is clicked before receiving B. Old snapshots must not replace B, writes must not repeat, ordinary success and existing recovery must still work.',
  limits: 'This proves frontend publication with assembled synthetic snapshots, not native DB acceptance or a real session switch. A foreign organization from /me on the same native session remains refused by production. All non-static/API/external requests are blocked.',
};
const original = await readFile(join(desktop, 'tests/app-draft-identity-fixture.ts'), 'utf8');
assert.equal(original.split('export function installAppDraftIdentityFixture(').length, 2, 'Expected account fixture entry point');
const fixture = original.replace('export function installAppDraftIdentityFixture(', 'function installOriginalAppDraftIdentityFixture(') + `
import { installWorkspaceActionLifecycleFixture } from './workspace-action-lifecycle-fixture';
export function installAppDraftIdentityFixture(workspace: Workspace) {
  installWorkspaceActionLifecycleFixture(workspace, installOriginalAppDraftIdentityFixture);
}
`;
const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, join(desktop, 'vite.config.ts'));
const probe = freePortServer();
await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
const port = probe.address().port;
await new Promise(ok => probe.close(ok));
assert.notEqual(port, 5363, 'User preview must remain untouched');
const origin = `http://127.0.0.1:${port}`;
const server = await vite.createServer({
  ...loaded.config, configFile: false, root: desktop,
  plugins: [{
    name: 'closed-workspace-action-fixture', enforce: 'pre',
    load(id) { if (id.replaceAll('\\', '/').split('?')[0].endsWith('/tests/app-draft-identity-fixture.ts')) return fixture; },
  }, ...loaded.config.plugins],
  cacheDir: join(tmpdir(), `zentra-workspace-action-lifecycle-vite-${port}`),
  resolve: { ...loaded.config.resolve, dedupe: ['react', 'react-dom'] },
  optimizeDeps: { entries: [join(desktop, 'tests/mobile-harness.html')], noDiscovery: true, include: [
    'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react',
    'qrcode.react', '@tauri-apps/api/core', '@tauri-apps/api/event', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs',
  ] },
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/src-tauri/**'] } },
  logLevel: 'silent',
});

async function screen(page, label) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
  await page.locator('.navigation-palette').waitFor({ state: 'detached' });
}
async function snapshot(page) {
  return page.evaluate(() => ({
    visibleB: document.body.textContent.includes('Client fictif B'),
    visibleA: document.body.textContent.includes('CLIENT SAVED A'),
    appVisible: !!document.querySelector('.desktop-app'),
    dialogs: [...document.querySelectorAll('[role=dialog]')].map(node => node.textContent.slice(0, 200)),
    database: window.__qaActParent.database(), proof: structuredClone(window.__qaActParent.proof),
    companyResolutions: structuredClone(window.__qaAppDraftIdentity.proof.companyResolutions),
    identityReads: structuredClone(window.__qaAppDraftIdentity.proof.identityReads),
  }));
}

try {
  await server.listen(); report.origin = origin;
  for (const engine of ['chromium', 'webkit']) {
    const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' ? process.env.ZENTRA_EDGE_PATH ? { executablePath: process.env.ZENTRA_EDGE_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {} : {}) });
    try {
      for (const scenario of ['late-success', 'late-catch-read', 'recovery-cleanup', 'ordinary-success-control']) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
        const item = { engine, browserVersion: browser.version(), scenario, errors: [], blockedRequests: [] };
        report.cases.push(item); page.setDefaultTimeout(15000);
        page.on('pageerror', error => item.errors.push(error.message));
        await page.route('**/*', route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin === origin && request.method() === 'GET' && !/^\/api(?:\/|$)/.test(url.pathname)) return route.continue();
          item.blockedRequests.push({ method: request.method(), pathname: url.pathname, origin: url.origin });
          return route.abort();
        });
        await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
        await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__qaAppDraftIdentity?.proof.identityReads.some(read => read.pending));
        await page.evaluate(() => {
          window.__qaAppDraftIdentity.identityMode('ready');
          for (const read of window.__qaAppDraftIdentity.proof.identityReads.filter(read => read.pending)) window.__qaAppDraftIdentity.releaseIdentity(read.id);
        });
        await page.locator('.desktop-app').waitFor(); await screen(page, 'Clients');
        await page.getByRole('button', { name: 'Nouveau client', exact: true }).click();
        const form = page.getByRole('dialog', { name: 'Nouveau client', exact: true });
        for (const [name, value] of Object.entries({ company: 'CLIENT SAVED A', street: 'Rue fictive', postalCode: '1000', city: 'Lausanne' })) await form.locator(`[name=${name}]`).fill(value);
        await page.evaluate(mode => window.__qaActParent.begin(mode), scenario === 'ordinary-success-control' ? 'control' : scenario);
        await form.getByRole('button', { name: 'Enregistrer', exact: true }).click();
        await page.waitForFunction(() => window.__qaActParent.proof.writes === 1);
        if (scenario === 'ordinary-success-control') {
          await form.waitFor({ state: 'detached' }); await page.getByText('CLIENT SAVED A', { exact: true }).first().waitFor();
          item.after = await snapshot(page);
          assert.equal(item.after.proof.writes, 1); assert.equal(item.after.visibleA, true);
          item.controlPassed = true;
        } else {
          await page.waitForFunction(() => window.__qaActParent.proof.reads.some(read => read.kind === 'action-final' && read.pending));
          const first = await page.evaluate(() => window.__qaActParent.proof.reads.find(read => read.kind === 'action-final').id);
          let late = first;
          if (scenario !== 'late-success') {
            await page.evaluate(id => window.__qaActParent.settle(id, true), first);
            await page.waitForFunction(() => window.__qaActParent.proof.reads.some(read => read.kind === 'act-or-recovery' && read.pending));
            late = await page.evaluate(() => window.__qaActParent.proof.reads.find(read => read.kind === 'act-or-recovery' && read.pending).id);
            if (scenario === 'recovery-cleanup') {
              await page.evaluate(id => window.__qaActParent.settle(id, true), late);
              const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
              await recovery.waitFor();
              await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
              await page.waitForFunction(() => window.__qaActParent.proof.reads.some(read => read.kind === 'act-or-recovery' && read.pending));
              late = await page.evaluate(() => window.__qaActParent.proof.reads.find(read => read.kind === 'act-or-recovery' && read.pending).id);
            }
          }
          item.oldRead = await snapshot(page);
          await page.evaluate(() => window.__qaActParent.switchVerifiedAccount());
          await page.getByRole('button', { name: 'Ouvrir l’espace du compte', exact: true }).click();
          await page.locator('.desktop-app').waitFor(); await screen(page, 'Clients');
          await page.getByText('Client fictif B', { exact: true }).first().waitFor();
          item.beforeRelease = await snapshot(page);
          assert.equal(item.beforeRelease.database.scope, 'synthetic-company-b'); assert.equal(item.beforeRelease.visibleB, true);
          await page.evaluate(id => window.__qaActParent.settle(id), late);
          // Allow real React's promise continuations and passive effects to run;
          // no forced flushSync or extracted hook host changes the event batch.
          await page.waitForTimeout(200);
          item.after = await snapshot(page);
          assert.equal(item.after.database.scope, 'synthetic-company-b'); assert.equal(item.after.proof.writes, 1);
          assert.equal(item.after.visibleB, true); assert.equal(item.after.visibleA, false);
          assert.equal(item.after.dialogs.length, 0);
          assert.equal(item.after.companyResolutions.length, 2, 'Old receipt must not repeat admission');
          assert.equal(item.after.proof.reads.filter(read => read.pending).length, 0);
          if (scenario === 'recovery-cleanup') item.controlPassed = true; else item.regressionPassed = true;
        }
        assert.deepEqual(item.errors, []); assert.deepEqual(item.blockedRequests, []);
        if (process.env.ZENTRA_QA_SCREENSHOTS === '1') await page.screenshot({ path: join(out, `${engine}-${scenario}.png`) });
        item.completed = true;
        console.log(JSON.stringify({ engine, scenario, passed: true }));
        await page.close();
      }
    } finally { await browser.close(); }
  }
  report.after = await hashes();
  assert.deepEqual(report.after, report.before, 'Source bytes unchanged while testing');
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  await server.close(); report.previewClosed = true; report.finishedAt = new Date().toISOString();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: out, cases: report.cases.length, failure: report.failure ?? null, previewClosed: true }));
}
