import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const output = '.qa/project-recovery';
await mkdir(output, { recursive: true });
const report = [];
const files = ['Plan du projet avec les mesures et les conditions de livraison.txt', 'Copie à reprendre.txt', 'Notes du projet.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`Contenu de recette ${name}`) }));
async function geometry(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page overflow');
  for (const alert of await page.getByRole('alert').all()) {
    if (await alert.isVisible()) assert.ok(await alert.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'The whole error fits its container');
  }
}
for (const [engine, type] of (process.env.ZENTRA_QA_SMOKE ? [['edge', chromium]] : [['edge', chromium], ['webkit', webkit]])) {
  const browser = await type.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of (process.env.ZENTRA_QA_SMOKE ? [390] : [320, 390, 1440])) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(16000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`${base}/tests/project-files-harness.html?recovery=1`);
        await page.locator('input[type=file]').first().setInputFiles(files);
        await page.evaluate(name => { const s = window.projectRecovery; s.uploadFailures[name] = 1; s.readsFail = 2; s.holdUpload = true; }, files[1].name);
        await page.getByRole('button', { name: 'Enregistrer 3 fichiers', exact: true }).click();
        await page.waitForFunction(() => window.projectRecovery.uploads.length === 1);
        assert.ok(await page.getByRole('button', { name: 'Ajouter des documents', exact: true }).isDisabled());
        assert.ok(await page.locator('input[type=file]').first().isDisabled());
        await page.evaluate(() => window.projectRecovery.releaseUpload());
        const recovery = page.locator('.project-file-recovery');
        await recovery.waitFor();
        await page.waitForFunction(() => {
          const panel = document.querySelector('.project-file-recovery');
          const bounds = panel?.getBoundingClientRect();
          return document.activeElement === panel && bounds.top >= 0 && bounds.bottom <= innerHeight;
        });
        assert.equal(await page.locator('.project-document-list__open').count(), 0, 'A failed read keeps the previous workspace snapshot');
        assert.equal(await page.locator('.project-pending-files li').count(), 1);
        assert.match(await page.locator('.project-pending-files').innerText(), /Copie à reprendre/);
        assert.match(await page.locator('.project-file-notice').innerText(), /2 fichiers enregistrés/);
        await geometry(page);
        await page.screenshot({ path: `${output}/${engine}-${width}-partial.png` });
        await recovery.getByRole('button', { name: 'Actualiser la liste', exact: true }).click();
        await page.waitForFunction(() => window.projectRecovery.reads === 2);
        await recovery.getByRole('button', { name: 'Actualiser la liste', exact: true }).click();
        await recovery.waitFor({ state: 'hidden' });
        assert.equal(await page.locator('.project-document-list__open').count(), 2);
        assert.equal(await page.evaluate(() => window.projectRecovery.uploads.length), 3);
        await page.getByRole('button', { name: 'Enregistrer 1 fichier', exact: true }).click();
        await page.locator('.project-pending-files').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('.project-document-list__open').count(), 3);
        assert.deepEqual(await page.evaluate(() => window.projectRecovery.uploads), [files[0].name, files[1].name, files[2].name, files[1].name]);
        assert.match(await page.locator('.project-document-list__open').first().innerText(), /Copie à reprendre/);
        await page.evaluate(() => { window.projectRecovery.deleteFailures = 1; });
        await page.getByRole('button', { name: `Supprimer ${files[0].name}`, exact: true }).click();
        const confirm = page.getByRole('dialog', { name: 'Supprimer le document ?', exact: true });
        await confirm.getByRole('button', { name: 'Supprimer', exact: true }).click();
        await confirm.getByRole('alert').waitFor();
        assert.match(await confirm.getByRole('alert').innerText(), /encore utilisé/);
        await geometry(page);
        await page.screenshot({ path: `${output}/${engine}-${width}-delete-error.png` });
        await page.evaluate(() => { window.projectRecovery.deleteReadFailures = 1; window.projectRecovery.readsFail = 1; });
        await confirm.getByRole('button', { name: 'Supprimer', exact: true }).click();
        await confirm.waitFor({ state: 'hidden' });
        await recovery.waitFor();
        await recovery.getByRole('button', { name: 'Actualiser la liste', exact: true }).click();
        await page.waitForFunction(() => window.projectRecovery.readsFail === 0);
        await recovery.getByRole('button', { name: 'Actualiser la liste', exact: true }).click();
        await recovery.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => window.projectRecovery.deletes.length), 2, 'Only refused and confirmed deletion commands; refresh never deletes again');
        assert.equal(await page.locator('.project-document-list__open').count(), 2);

        await page.goto(`${base}/tests/mobile-harness.html?browsing=1&design=1&projectRecovery=1`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Projets');
        await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Projets', { exact: true }) }).click();
        await page.getByRole('button', { name: 'Nouveau projet', exact: true }).click();
        const form = page.getByRole('dialog', { name: 'Nouveau projet', exact: true });
        await form.locator('[name=name]').fill('Projet dont les documents sont conservés');
        await form.locator('[name=clientId]').selectOption('client-qa');
        await form.locator('input[type=file]').first().setInputFiles(files.slice(0, 2));
        await page.evaluate(name => { window.projectRecovery.projectFailures = 1; window.projectRecovery.uploadFailures[name] = 1; }, files[1].name);
        await form.getByRole('button', { name: 'Enregistrer', exact: true }).click();
        await form.getByRole('alert').waitFor();
        assert.match(await form.getByRole('alert').innerText(), /nom du projet/);
        assert.equal(await form.locator('[name=name]').inputValue(), 'Projet dont les documents sont conservés');
        assert.equal(await page.evaluate(() => window.projectRecovery.uploads.length), 0);
        await page.evaluate(() => { window.projectRecovery.holdUpload = true; });
        await form.getByRole('button', { name: 'Enregistrer', exact: true }).click();
        await page.waitForFunction(() => window.projectRecovery.uploads.length === 1);
        assert.ok(await form.locator('[name=name]').isDisabled());
        await page.keyboard.press('Escape');
        assert.ok(await form.isVisible());
        await page.evaluate(() => window.projectRecovery.releaseUpload());
        await form.getByText(/Le projet est enregistré. Ces fichiers restent à ajouter/).waitFor();
        assert.equal(await form.locator('.project-pending-files li').count(), 1);
        await geometry(page);
        await page.screenshot({ path: `${output}/${engine}-${width}-project-saved.png` });
        await page.evaluate(() => { window.projectRecovery.readsFail = 3; });
        await form.getByRole('button', { name: 'Enregistrer', exact: true }).click();
        const reload = page.getByRole('button', { name: 'Actualiser les données', exact: true });
        await reload.waitFor();
        await reload.click();
        await page.waitForFunction(() => window.projectRecovery.readsFail === 0);
        await reload.click();
        await form.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => window.projectRecovery.saves.length), 2, 'A refused save and a confirmed save; attaching the remaining file never rewrites the same project');
        assert.equal(await page.evaluate(() => window.projectRecovery.savedIds.length), 1);
        assert.deepEqual(await page.evaluate(() => window.projectRecovery.uploads), [files[0].name, files[1].name, files[1].name]);
        await geometry(page);
        assert.deepEqual(errors, []);
        report.push({ engine, width, partialFilesRetained: true, uploadAndDeleteReadRecovery: true, visibleDeleteError: true, oneCreatedProject: true, untouchedSavedFiles: true });
      } catch (error) {
        await page.screenshot({ path: `${output}/${engine}-${width}-failure.png` });
        await writeFile(`${output}/failure.txt`, `${error.stack}\n${await page.locator('body').innerText()}`);
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
