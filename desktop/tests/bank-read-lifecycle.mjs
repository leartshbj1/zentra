import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Actual WorkspaceApp, BankScreen and ClientForm; all bridge data is synthetic.
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5401';
const before = process.argv.includes('--before');
const output = process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), `zentra-bank-read-lifecycle-${before ? 'before' : 'after'}`);
await mkdir(output, { recursive: true });

async function navigate(page, screen) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(screen);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(screen, { exact: true }) }).click();
  await page.locator('.navigation-palette').waitFor({ state: 'detached' });
}

async function fixture(browser, result) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => result.errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/')) {
      result.blocked.push(url.origin + url.pathname);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(`${origin}/tests/mobile-harness.html?finance=1&bank=1`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click();
  await page.evaluate(async () => {
    const api = window.__qaDesktopApi;
    await api.importCamtFile('releve-fictif.xml', false);
    window.__bankAuditStore = await api.loadWorkspace();
    window.__bankAuditEvents = [];
    api.loadWorkspace = async () => {
      const snapshot = structuredClone(window.__bankAuditStore);
      if (window.__bankAuditHold) {
        window.__bankAuditHold = false;
        window.__bankAuditEvents.push('old-read-started');
        return new Promise(resolve => {
          window.__bankAuditRelease = () => {
            window.__bankAuditEvents.push('old-read-resolved');
            resolve(snapshot);
          };
        });
      }
      return snapshot;
    };
    api.createEntity = async (entity, input) => {
      if (entity !== 'clients') throw new Error('Synthetic clients only');
      window.__bankAuditStore.clients.push({ ...input, id: 'audit-new-client', archivedAt: null });
      window.__bankAuditEvents.push('new-client-committed');
      return structuredClone(window.__bankAuditStore);
    };
  });
  await navigate(page, 'Banque');
  await page.locator('.bank-movements-panel').getByRole('button', { name: 'Actualiser', exact: true }).waitFor();
  return page;
}

async function unmountedRefresh(browser, engine, result) {
  const page = await fixture(browser, result);
  await page.evaluate(() => { window.__bankAuditHold = true; });
  await page.locator('.bank-movements-panel').getByRole('button', { name: 'Actualiser', exact: true }).click();
  await page.waitForFunction(() => typeof window.__bankAuditRelease === 'function');
  await navigate(page, 'Clients');
  await page.getByRole('button', { name: 'Nouveau client', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Nouveau client', exact: true });
  for (const [name, value] of Object.entries({ company: 'Client ajouté après la lecture', street: 'Rue fictive', postalCode: '1000', city: 'Lausanne' })) {
    await dialog.locator(`input[name=${name}]`).fill(value);
  }
  await dialog.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  const label = page.getByText('Client ajouté après la lecture', { exact: true });
  await label.first().waitFor();
  const visibleBefore = await label.count();
  await page.screenshot({ path: join(output, `${engine}-client-before-old-read.png`) });
  await page.evaluate(() => window.__bankAuditRelease());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const visibleAfter = await label.count();
  const stored = await page.evaluate(() => window.__bankAuditStore.clients.some(client => client.id === 'audit-new-client'));
  assert.ok(visibleBefore > 0);
  assert.equal(visibleAfter > 0, !before, 'An unmounted bank read must not replace the workspace after a later save');
  assert.equal(stored, true, 'The fixture confirms UI staleness, not database deletion');
  result.cases.push({ name: 'unmounted-refresh-after-client-save', visibleBefore, visibleAfter, stored, events: await page.evaluate(() => window.__bankAuditEvents) });
  await page.screenshot({ path: join(output, `${engine}-client-after-old-read.png`) });
  await page.close();
}

async function concurrentReads(browser, result, latestFails) {
  const page = await fixture(browser, result);
  await page.evaluate(async latestFails => {
    const api = window.__qaDesktopApi;
    const originalBankRead = api.getBankWorkspace;
    const bank = await originalBankRead();
    window.__bankAuditReads = [{}, {}];
    let workspaceIndex = 0, bankIndex = 0;
    api.loadWorkspace = async () => {
      const index = workspaceIndex++;
      const snapshot = structuredClone(window.__bankAuditStore);
      if (index === 1) snapshot.clients.push({ ...snapshot.clients[0], id: 'latest-read-client', name: 'Client de la lecture récente', company: 'Client de la lecture récente' });
      return new Promise((resolve, reject) => {
        window.__bankAuditReads[index].workspace = () => index === 1 && latestFails ? reject(new Error('Lecture fictive récente indisponible.')) : resolve(snapshot);
      });
    };
    api.getBankWorkspace = async () => {
      const index = bankIndex++;
      const snapshot = structuredClone(bank);
      snapshot.accounts[0].accountId = index === 1 ? 'Compte de la lecture récente' : 'Compte de la lecture ancienne';
      return new Promise(resolve => { window.__bankAuditReads[index].bank = () => resolve(snapshot); });
    };
    // Retain the real handler to model two already-admitted reads before React
    // updates the disabled prop. No production-only API or test hook is added.
    const button = [...document.querySelectorAll('.bank-movements-panel button')].find(node => node.textContent.trim() === 'Actualiser');
    const props = button[Object.keys(button).find(key => key.startsWith('__reactProps$'))];
    props.onClick(); props.onClick();
  }, latestFails);
  await page.waitForFunction(() => window.__bankAuditReads.every(read => read.workspace && read.bank));
  await page.evaluate(() => { window.__bankAuditReads[1].workspace(); window.__bankAuditReads[1].bank(); });
  await page.getByText(/Compte de la lecture récente · CHF/).waitFor();
  if (latestFails) await page.getByText('Actualisation incomplète', { exact: true }).waitFor();
  await page.evaluate(() => { window.__bankAuditReads[0].workspace(); window.__bankAuditReads[0].bank(); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const currentAccountRemains = await page.getByText(/Compte de la lecture récente · CHF/).count() > 0;
  assert.equal(currentAccountRemains, !before, 'The newer bank snapshot must survive an older response');
  const warningRemains = await page.getByText('Données à actualiser', { exact: true }).count() > 0;
  if (latestFails) assert.equal(warningRemains, !before, 'An older successful read must not clear a newer refresh warning');
  if (!latestFails) {
    await navigate(page, 'Clients');
    const latestClientRemains = await page.getByText('Client de la lecture récente', { exact: true }).count() > 0;
    assert.equal(latestClientRemains, !before, 'The older read must not replace the newer global workspace');
  }
  result.cases.push({ name: latestFails ? 'older-success-after-newer-incomplete-read' : 'older-read-after-newer-success', currentAccountRemains, warningRemains });
  await page.close();
}

async function committedImportRecovery(browser, result) {
  const page = await fixture(browser, result);
  await page.locator('.bank-hero').getByRole('button', { name: 'Importer un relevé XML', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Importer un relevé bancaire', exact: true });
  await dialog.getByRole('button', { name: 'Choisir le relevé XML', exact: true }).click();
  await dialog.getByRole('checkbox').uncheck();
  await page.evaluate(() => sessionStorage.setItem('qa-bank-fail-import-refresh', '1'));
  await dialog.getByRole('button', { name: 'Importer ce relevé', exact: true }).click();
  await dialog.getByText('Import enregistré, affichage à actualiser', { exact: true }).waitFor();
  const attempts = await page.evaluate(() => Number(sessionStorage.getItem('qa-bank-import-attempts')));
  assert.equal(attempts, 2, 'One fixture seed plus one explicit UI import');
  assert.equal(await page.locator('.bank-refresh-state').count(), 1);
  await page.evaluate(() => ['qa-bank-fail-import-refresh', 'qa-bank-workspace-refresh-fail', 'qa-bank-refresh-fail'].forEach(key => sessionStorage.removeItem(key)));
  await dialog.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
  await dialog.getByRole('button', { name: 'Voir les mouvements à vérifier', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('qa-bank-import-attempts'))), attempts, 'Refresh must not replay the committed import');
  assert.equal(await page.locator('.bank-refresh-state').count(), 0);
  assert.equal(await page.locator('.bank-hero').getByRole('button', { name: 'Importer un relevé XML', exact: true }).isEnabled(), true);
  result.cases.push({ name: 'committed-import-incomplete-read-and-read-only-recovery', attempts, refreshOnly: true });
  await page.close();
}

async function run(engine) {
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { executablePath: process.env.ZENTRA_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : {}) });
  const result = { engine, cases: [], errors: [], blocked: [] };
  try {
    await unmountedRefresh(browser, engine, result);
    await concurrentReads(browser, result, false);
    await concurrentReads(browser, result, true);
    await committedImportRecovery(browser, result);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.blocked, []);
    result.passed = true;
  } catch (error) { result.passed = false; result.failure = error.stack; }
  finally { await browser.close(); }
  return result;
}

const results = await Promise.all(['chromium', 'webkit'].map(run));
await writeFile(join(output, 'report.json'), JSON.stringify({ origin, before, results }, null, 2));
console.log(JSON.stringify({ output, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
