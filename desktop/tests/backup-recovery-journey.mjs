import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5357';
const out = '.impeccable/review/backup-recovery';
await mkdir(out, { recursive: true });
const results = [];
for (const config of [
  { engine: 'webkit', width: 390, language: 'fr', theme: 'light' },
  { engine: 'edge', width: 1440, language: 'fr', theme: 'dark' },
  { engine: 'webkit', width: 320, language: 'de', theme: 'dark', scale: true },
]) {
  const browser = await (config.engine === 'edge' ? chromium : webkit).launch(config.engine === 'edge' ? { channel: 'msedge' } : {});
  try {
    const page = await browser.newPage({ viewport: { width: config.width, height: 920 }, reducedMotion: 'reduce', hasTouch: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => r.request().url().startsWith(origin) || r.request().url().startsWith('data:') ? r.continue() : r.abort());
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&language=${config.language}&theme=${config.theme}`);
    await page.locator('.desktop-app').waitFor();
    const tr = source => page.evaluate(async source => (await import('/src/language.ts')).t(source), source);
    const later = page.getByRole('button', { name: await tr('Découvrir plus tard'), exact: true });
    if (await later.isVisible()) await later.click();
    if (config.scale) await page.evaluate(async () => (await import('/src/textSize.ts')).setTextSize(200));
    await page.evaluate(async () => {
      const { desktopApi: api } = await import('/src/bridge.ts');
      const { WorkspaceRefreshAfterMutationError } = await import('/src/workspaceMutation.ts');
      const workspace = await api.loadWorkspace();
      window.__backup = { mode: 'success', restores: 0, reads: 0, cloud: 0 };
      let unavailable = false;
      api.loadWorkspace = async () => {
        window.__backup.reads++;
        if (unavailable) { unavailable = false; throw new Error('Lecture de test interrompue.'); }
        return structuredClone(workspace);
      };
      api.chooseRestoreFile = async () => {
        if (window.__backup.mode === 'picker-error') throw new Error('Le fichier n’a pas pu être ouvert. Choisissez à nouveau votre sauvegarde .zentra.');
        return window.__backup.mode === 'cancel' ? null : 'C:\\Sauvegardes\\Mon entreprise.zentra';
      };
      api.restoreBackup = async () => {
        window.__backup.restores++;
        if (window.__backup.mode === 'invalid') throw new Error('Un document ou un logo est absent ou abîmé. Vos données actuelles sont conservées.');
        if (window.__backup.mode === 'reload') { unavailable = true; throw new WorkspaceRefreshAfterMutationError(new Error('Lecture interrompue')); }
        return structuredClone(workspace);
      };
      api.restoreCloudBackup = async () => { window.__backup.cloud++; unavailable = true; throw new WorkspaceRefreshAfterMutationError(new Error('Lecture interrompue')); };
      api.createBackup = async () => {
        workspace.backupStatus = { lastSuccessAt: '2026-09-27T14:00:00Z', lastPath: 'entreprise.zentra', nextScheduledAt: null };
        return { path: 'entreprise.zentra', workspace: structuredClone(workspace) };
      };
      api.getCloudBackupState = async () => ({ enabled: true, connected: true, running: false, backups: [{ backup_id: 'test-copy', installation_id: 'test-installation', created_at: '2026-09-27T14:00:00Z', completed_at: '2026-09-27T14:00:00Z', app_version: '1.90.4', size_bytes: 1000, state: 'complete' }] });
    });
    await page.getByRole('button', { name: await tr('Aller à un écran'), exact: true }).click();
    await page.getByRole('searchbox').fill(await tr('Paramètres'));
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText(await tr('Paramètres'), { exact: true }) }).click();
    await page.locator('[data-settings-link="storage"]').click();
    const manual = page.locator('section').filter({ has: page.locator('[data-backup-status]') }).last();
    const capture = async state => {
      await page.locator('[data-backup-status]').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      if (!process.argv.includes('--verify-only')) await page.screenshot({ path: `${out}/${config.engine}-${config.width}-${config.theme}-${config.language}-${state}.png` });
      results.push({ ...config, state, errors: [] });
    };
    await capture('empty');
    await manual.getByRole('button', { name: await tr('Créer une sauvegarde'), exact: true }).click();
    await page.locator('[data-backup-status]').filter({ hasText: '2026' }).waitFor();
    await capture('created');
    if (config.language !== 'fr') continue;
    const restore = manual.getByRole('button', { name: 'Restaurer', exact: true });
    for (const mode of ['cancel', 'picker-error', 'invalid', 'reload']) {
      await page.evaluate(mode => window.__backup.mode = mode, mode);
      if (['invalid', 'reload'].includes(mode)) page.once('dialog', async dialog => {
        assert.ok(dialog.message().includes('Mon entreprise.zentra'));
        await dialog.accept();
      });
      await restore.click();
      if (mode === 'picker-error') await page.getByText('Le fichier n’a pas pu être ouvert. Choisissez à nouveau votre sauvegarde .zentra.', { exact: true }).waitFor();
      if (mode === 'invalid') await page.getByText('Un document ou un logo est absent ou abîmé. Vos données actuelles sont conservées.', { exact: true }).waitFor();
      if (mode === 'reload') {
        const dialog = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
        await dialog.waitFor();
        const before = await page.evaluate(() => window.__backup.restores);
        await dialog.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => window.__backup.restores), before);
      }
      await capture(mode);
    }
    assert.equal(await page.evaluate(() => window.__backup.restores), 2);
    await page.locator('.cloud-backup-panel').getByRole('button', { name: 'Restaurer', exact: true }).click();
    await page.getByRole('dialog', { name: 'Restaurer cette sauvegarde', exact: true }).getByRole('button', { name: 'Restaurer cette copie', exact: true }).click();
    const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
    await recovery.waitFor();
    await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.__backup.cloud), 1);
    await capture('cloud-reloaded');
  } finally { await browser.close(); }
}
await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
console.log(`${results.length} backup UI checks passed. Native services simulated; no customer data accessed.`);
