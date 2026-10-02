/** Real React callers, synthetic API transport. No native execution claim. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const before = process.argv.includes('--before');
const output = resolve(desktop, 'artifacts/runtime-audit-20261002', `project-file-scope-browser-${before ? 'before' : 'after'}`);
await mkdir(output, { recursive: true });
const old = new Map();
if (before) for (const name of ['WorkspaceApp.tsx', 'ProjectFolder.tsx']) {
  old.set(resolve(desktop, 'src', name).replaceAll('\\', '/'), execFileSync('git', ['show', `f1e6de99:desktop/src/${name}`], { cwd: desktop, encoding: 'utf8' }));
}
const server = await createServer({ root: desktop, cacheDir: resolve(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'actual-before-project-callers', enforce: 'pre',
  load(id) { return old.get(id.replaceAll('\\', '/').split('?')[0]); },
}] });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const rows = [];
try {
  for (const [engine, type] of [['edge', chromium], ['webkit', webkit]]) {
    const browser = await type.launch({ headless: true, ...(engine === 'edge' ? { channel: 'msedge' } : {}) });
    try {
      for (const caller of ['workspace', 'standalone']) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
        const errors = [], external = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
          const url = route.request().url();
          if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
          external.push(url); return route.abort();
        });
        try {
          await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&projectNavigation=1&emptyScreens=1`);
          await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
          await page.evaluate(() => {
            window.projectNavigation.stored.workNotesScope = 'synthetic-origin';
            window.__emptyScreensPatch({ workNotesScope: 'synthetic-origin' });
            const api = window.__qaDesktopApi, calls = window.__scopeCalls = [];
            const add = api.addProjectDocument, read = api.readProjectDocument, remove = api.deleteProjectDocument;
            api.addProjectDocument = async (...args) => { calls.push({ operation: 'add', scope: args[3] ?? null }); return add(...args); };
            api.readProjectDocument = async (...args) => { calls.push({ operation: 'read', scope: args[1] ?? null }); return read(...args); };
            api.deleteProjectDocument = async (...args) => { calls.push({ operation: 'delete', scope: args[1] ?? null }); return remove(...args); };
          });
          if (caller === 'workspace') {
            await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
            await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Projets');
            await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Projets', { exact: true }) }).click();
            await page.getByRole('button', { name: 'Projet A · Plans et documents', exact: true }).click();
          } else await page.evaluate(async () => { window.__scopeFixture = await (await import('/tests/project-file-scope-fixture.tsx')).mountProjectFileScopeFixture(); });
          const folder = page.locator('.project-folder:visible');
          await folder.locator('input[type=file]').first().setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic file') });
          await folder.getByRole('button', { name: 'Enregistrer 1 fichier', exact: true }).click();
          await folder.locator('.project-pending-files').waitFor({ state: 'hidden' });
          await folder.locator('.project-document-list__open').filter({ hasText: 'synthetic.txt' }).click();
          const preview = page.getByRole('dialog', { name: 'synthetic.txt', exact: true });
          await preview.waitFor({ state: 'visible' });
          await preview.getByRole('button', { name: 'Fermer « synthetic.txt »', exact: true }).click();
          await folder.getByRole('button', { name: 'Supprimer synthetic.txt', exact: true }).click();
          await page.getByRole('dialog', { name: 'Supprimer le document ?', exact: true }).getByRole('button', { name: 'Supprimer', exact: true }).click();
          await page.getByRole('dialog', { name: 'Supprimer le document ?', exact: true }).waitFor({ state: 'hidden' });
          const calls = await page.evaluate(() => window.__scopeCalls);
          assert.deepEqual(calls, ['add', 'read', 'delete'].map(operation => ({ operation, scope: before ? null : 'synthetic-origin' })));
          assert.deepEqual(errors, []); assert.deepEqual(external, []);
          rows.push({ engine, caller, calls, result: before ? 'reproduced-missing-native-scope' : 'pass', errors, external });
        } finally { await page.close(); }
      }
    } finally { await browser.close(); }
  }
} finally {
  await server.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ before, rows, limitations: ['Synthetic API receipts', 'No native execution', 'No production requests'] }, null, 2));
}
console.log(JSON.stringify({ before, cases: rows.length, output }));
