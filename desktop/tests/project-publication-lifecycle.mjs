/** Real WorkspaceApp/React, deterministic local API receipts; no native or server claims. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const before = process.argv.includes('--before');
const output = resolve(desktop, 'artifacts/runtime-audit-20261002', `project-publication-browser-v2-${before ? 'before' : 'after'}`);
await mkdir(output, { recursive: true });
const originals = new Map();
if (before) for (const name of ['projectFileSessions.ts', 'WorkspaceApp.tsx']) {
  const path = `desktop/src/${name}`;
  originals.set(resolve(desktop, 'src', name).replaceAll('\\', '/'), execFileSync('git', ['show', `674ebe106f8b89b943875f6289cc1aa71b9d6491:${path}`], { cwd: desktop, encoding: 'utf8' }));
}
const server = await createServer({ root: desktop, server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'verified-before-sources', enforce: 'pre',
  load(id) { return originals.get(id.replaceAll('\\', '/').split('?')[0]); },
}] });
await server.listen();
const port = server.httpServer.address().port;
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const rows = [];
try {
  for (const [engine, type] of [['edge', chromium], ['webkit', webkit]]) {
    const browser = await type.launch({ headless: true, ...(engine === 'edge' ? { channel: 'msedge' } : {}) });
    try {
      for (const operation of ['upload', 'delete', 'preview_scope']) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
        const errors = [], external = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => { if (!request.url().startsWith(`http://127.0.0.1:${port}`) && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) external.push(request.url()); });
        try {
          await page.goto(`http://127.0.0.1:${port}/tests/mobile-harness.html?browsing=1&projectNavigation=1&emptyScreens=1`);
          await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
          await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
          await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Projets');
          await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Projets', { exact: true }) }).click();
          await page.getByRole('button', { name: 'Projet A · Plans et documents', exact: true }).click();
          const folder = page.locator('.project-folder');
          if (operation !== 'upload') {
            await folder.locator('input[type=file]').first().setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') });
            await folder.getByRole('button', { name: 'Enregistrer 1 fichier', exact: true }).click();
            await folder.locator('.project-pending-files').waitFor({ state: 'hidden' });
          }
          await page.evaluate(operation => {
            const api = window.__qaDesktopApi;
            const original = operation === 'upload' ? api.loadWorkspace : operation === 'delete' ? api.deleteProjectDocument : api.readProjectDocument;
            const proof = window.__projectPublication = { pending: false, reads: 0, deletions: 0, released: false };
            if (operation === 'upload') api.loadWorkspace = async () => {
              proof.reads++;
              const value = await original();
              if (proof.reads > 1) return value;
              proof.pending = true;
              return new Promise(resolve => { proof.release = () => { proof.pending = false; proof.released = true; resolve(value); }; });
            };
            else if (operation === 'delete') api.deleteProjectDocument = async id => {
              proof.deletions++;
              const value = await original(id); proof.pending = true;
              return new Promise(resolve => { proof.release = () => { proof.pending = false; proof.released = true; resolve(value); }; });
            };
            else api.readProjectDocument = async id => {
              const value = await original(id); proof.pending = true;
              return new Promise(resolve => { proof.release = () => { proof.pending = false; proof.released = true; resolve(value); }; });
            };
          }, operation);
          if (operation === 'upload') {
            await folder.locator('input[type=file]').first().setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') });
            await folder.getByRole('button', { name: 'Enregistrer 1 fichier', exact: true }).click();
          } else if (operation === 'delete') {
            await folder.getByRole('button', { name: 'Supprimer synthetic.txt', exact: true }).click();
            await page.getByRole('dialog', { name: 'Supprimer le document ?', exact: true }).getByRole('button', { name: 'Supprimer', exact: true }).click();
          } else await folder.getByRole('button', { name: /synthetic\.txt/, exact: false }).first().click();
          await page.waitForFunction(() => window.__projectPublication.pending);
          // Simulate the parent publication of a concurrently confirmed local or
          // shared change. Storage and the old held UI receipt stay independent.
          await page.evaluate(operation => {
            const client = { id: 'synthetic-new-client', name: 'Synthetic client', company: '', email: '', phone: '', address: '', currency: 'CHF', archivedAt: null };
            window.projectNavigation.stored.clients = [client];
            if (operation === 'preview_scope') {
              window.projectNavigation.stored.workNotesScope = 'synthetic-new-workspace';
              window.__emptyScreensPatch({ clients: [client], workNotesScope: 'synthetic-new-workspace' });
            } else window.__emptyScreensPatch({ clients: [client] });
          }, operation);
          await page.waitForFunction(() => document.querySelector('.project-folder__header p')?.textContent !== undefined);
          await page.waitForTimeout(80);
          await page.evaluate(() => window.__projectPublication.release());
          if (operation === 'preview_scope') {
            await page.waitForTimeout(100);
            const dialogs = await page.getByRole('dialog', { name: 'synthetic.txt', exact: true }).count();
            assert.equal(dialogs, before ? 1 : 0, 'A preview from the previous workspace must not open in the new one');
            assert.deepEqual(errors, []); assert.deepEqual(external, []);
            rows.push({ engine, operation, dialogs, pageErrors: errors, externalRequests: external, result: before ? 'reproduced-old-preview' : 'pass' });
            continue;
          }
          await folder.getByRole('button', { name: 'Projets', exact: true }).waitFor({ state: 'visible' });
          await page.waitForFunction(() => !document.querySelector('.project-folder [data-project-file-save]:disabled') && !document.querySelector('.project-folder p[role=status]')?.textContent?.startsWith('Actualisation'));
          // Navigate to the actual client list to observe the resulting parent state.
          await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
          await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Clients');
          await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Clients', { exact: true }) }).click();
          await page.waitForTimeout(100);
          const visible = await page.getByText('Synthetic client', { exact: true }).count();
          const proof = await page.evaluate(() => ({ ...window.__projectPublication, release: undefined, uploads: window.projectNavigation.uploads.length, storedClients: window.projectNavigation.stored.clients.length }));
          assert.equal(proof.storedClients, 1);
          assert.equal(visible, before ? 0 : 1, `${engine}/${operation}: confirmed client must remain visible`);
          assert.equal(proof.uploads, 1);
          if (operation === 'delete') assert.equal(proof.deletions, 1);
          else assert.equal(proof.reads, before ? 1 : 2);
          assert.deepEqual(errors, []); assert.deepEqual(external, []);
          rows.push({ engine, operation, visibleClients: visible, proof, pageErrors: errors, externalRequests: external, result: before ? 'reproduced-old-publication' : 'pass' });
        } finally { await page.close(); }
      }
    } finally { await browser.close(); }
  }
} finally {
  await server.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ capturedAt: new Date().toISOString(), before, rows, limitations: ['Synthetic API receipts and storage', 'No native execution', 'No live server or database loss demonstrated'] }, null, 2));
}
console.log(JSON.stringify({ before, cases: rows.length, report: resolve(output, 'report.json') }));
