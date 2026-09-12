import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const output = '.qa/project-navigation';
await mkdir(output, { recursive: true });
const report = [];
const names = ['Projet A · Plans et documents', 'Projet B · Photos du dossier', 'Projet C · Nouveau dossier'];
const files = ['Plan du projet.pdf.txt', 'Copie à reprendre.txt', 'Conditions du projet.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`Contenu ${name}`) }));
async function navigate(page, title) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(title);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(title, { exact: true }) }).click();
}
for (const [engine, type] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1440, 900]]) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(12000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`${base}/tests/mobile-harness.html?browsing=1&projectNavigation=1`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await navigate(page, 'Projets');
        await page.getByRole('button', { name: names[0], exact: true }).click();
        const folder = page.locator('.project-folder');
        const activity = page.getByRole('complementary', { name: 'Documents de projet en cours' });
        const activityFor = name => activity.locator('.info-strip').filter({ has: page.getByText(name, { exact: true }) });
        const resume = name => activityFor(name).getByRole('button', { name: 'Retrouver les documents', exact: true }).click();
        await folder.locator('input[type=file]').first().setInputFiles(files);
        await navigate(page, 'Devis');
        await activityFor(names[0]).getByText(/3 fichiers à ajouter/).waitFor();
        await resume(names[0]);
        assert.equal(await folder.locator('.project-pending-files li').count(), 3);
        await page.evaluate(name => { window.projectRecovery.holdUpload = true; window.projectRecovery.uploadFailures[name] = 1; window.projectRecovery.readsFail = 2; }, files[1].name);
        await folder.getByRole('button', { name: 'Enregistrer 3 fichiers', exact: true }).click();
        await page.waitForFunction(() => window.projectRecovery.uploads.length === 1);
        await navigate(page, 'Factures');
        await activityFor(names[0]).getByText(/Ajout 1\/3/).waitFor();
        await navigate(page, 'Projets');
        await page.getByRole('button', { name: names[1], exact: true }).click();
        const bFiles = ['Photo du second projet.txt', 'Plan du second projet.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) }));
        await folder.locator('input[type=file]').first().setInputFiles(bFiles);
        await navigate(page, 'Devis');
        assert.equal(await activity.locator('.info-strip').count(), 2);
        assert.ok(await activity.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        await page.screenshot({ path: `${output}/${engine}-${width}-background.png` });
        await page.evaluate(() => window.projectRecovery.releaseUpload());
        await activityFor(names[0]).getByText(/liste à actualiser/).waitFor();
        await resume(names[0]);
        const recovery = folder.locator('.project-file-recovery');
        await recovery.waitFor();
        assert.equal(await folder.locator('.project-document-list__open').count(), 0, 'Native writes do not mutate the UI snapshot');
        assert.equal(await folder.locator('.project-pending-files li').count(), 1);
        await recovery.getByRole('button', { name: 'Actualiser la liste', exact: true }).click();
        await page.waitForFunction(() => window.projectRecovery.readsFail === 0);
        await recovery.getByRole('button', { name: 'Actualiser la liste', exact: true }).click();
        await recovery.waitFor({ state: 'hidden' });
        assert.equal(await folder.locator('.project-document-list__open').count(), 2);
        await folder.getByRole('button', { name: 'Enregistrer 1 fichier', exact: true }).click();
        await folder.locator('.project-pending-files').waitFor({ state: 'hidden' });
        assert.equal(await folder.locator('.project-document-list__open').count(), 3);
        await resume(names[1]);
        assert.equal(await folder.locator('.project-pending-files li').count(), 2);
        assert.equal(await folder.locator('.project-document-list__open').count(), 0);
        await folder.getByRole('button', { name: 'Projets', exact: true }).click();
        await page.getByRole('button', { name: `Supprimer le projet ${names[1]}`, exact: true }).click();
        await page.getByText('Terminez l’ajout des fichiers ou retirez la sélection avant de supprimer ce projet.', { exact: true }).waitFor();
        assert.equal(await folder.locator('.project-pending-files li').count(), 2);
        await page.getByRole('button', { name: 'Fermer le message', exact: true }).click();
        await page.evaluate(() => { window.projectRecovery.holdUpload = true; });
        await folder.getByRole('button', { name: 'Enregistrer 2 fichiers', exact: true }).click();
        await page.waitForFunction(() => window.projectRecovery.uploads.length === 5);
        await page.evaluate(() => window.__qaSetReadOnly(true));
        await folder.locator('.project-file-picker').waitFor({ state: 'detached' });
        await page.evaluate(() => window.projectRecovery.releaseUpload());
        await page.waitForFunction(() => window.projectNavigation.uploads.length === 4);
        await navigate(page, 'Devis');
        await activityFor(names[1]).getByText(/1 fichier à ajouter/).waitFor();
        await page.evaluate(() => window.__qaSetReadOnly(false));
        await resume(names[1]);
        assert.equal(await folder.locator('.project-pending-files li').count(), 1);
        await folder.getByRole('button', { name: 'Enregistrer 1 fichier', exact: true }).click();
        await folder.locator('.project-pending-files').waitFor({ state: 'hidden' });
        assert.equal(await folder.locator('.project-document-list__open').count(), 2);
        const stored = await page.evaluate(() => window.projectNavigation.uploads);
        assert.deepEqual(stored.map(row => row.project), ['project-navigation-a', 'project-navigation-a', 'project-navigation-a', 'project-navigation-b', 'project-navigation-b']);
        assert.deepEqual(stored.map(row => row.name), [files[0].name, files[2].name, files[1].name, bFiles[0].name, bFiles[1].name]);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

        // A background addition reads the workspace while another project's
        // deletion is waiting. The late deletion must still disappear from the UI.
        await folder.getByRole('button', { name: 'Projets', exact: true }).click();
        await page.getByRole('button', { name: names[0], exact: true }).click();
        await folder.locator('input[type=file]').first().setInputFiles({ name: 'Dernier plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Plan supplémentaire') });
        await page.evaluate(() => { window.projectRecovery.holdUpload = true; });
        await folder.getByRole('button', { name: 'Enregistrer 1 fichier', exact: true }).click();
        await page.waitForFunction(() => window.projectRecovery.uploads.length === 7);
        await folder.getByRole('button', { name: 'Projets', exact: true }).click();
        await page.getByRole('button', { name: names[1], exact: true }).click();
        await page.evaluate(() => { window.projectRecovery.holdDelete = true; });
        await folder.getByRole('button', { name: `Supprimer ${bFiles[0].name}`, exact: true }).click();
        const confirm = page.getByRole('dialog', { name: 'Supprimer le document ?', exact: true });
        await confirm.getByRole('button', { name: 'Supprimer', exact: true }).click();
        await page.waitForFunction(() => window.projectRecovery.deletes.length === 1);
        await page.evaluate(() => window.projectRecovery.releaseUpload());
        await activityFor(names[0]).waitFor({ state: 'hidden' });
        assert.equal(await folder.locator('.project-document-list__open').count(), 2);
        await page.evaluate(() => window.projectRecovery.releaseDelete());
        await confirm.waitFor({ state: 'hidden' });
        assert.equal(await folder.locator('.project-document-list__open').count(), 1);
        assert.equal(await folder.locator('.project-document-list__open').filter({ hasText: bFiles[0].name }).count(), 0);
        assert.equal(await page.evaluate(() => window.projectRecovery.deletes.length), 1);

        // A project removed elsewhere must not strand a local, unsaved selection.
        await folder.getByRole('button', { name: 'Projets', exact: true }).click();
        await page.getByRole('button', { name: names[2], exact: true }).click();
        await folder.locator('input[type=file]').first().setInputFiles(files.slice(0, 2));
        await navigate(page, 'Devis');
        await page.evaluate(() => window.__qaRemoveProject('project-navigation-c'));
        const orphan = activity.locator('.info-strip').filter({ has: page.getByText('Projet indisponible', { exact: true }) });
        await orphan.getByText('Voir les fichiers conservés', { exact: true }).click();
        assert.equal(await orphan.locator('li').count(), 2);
        await orphan.getByLabel('Récupérer la sélection dans un projet', { exact: true }).selectOption('project-navigation-b');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: `${output}/${engine}-${width}-orphan.png` });
        const attemptsBeforeMove = await page.evaluate(() => window.projectRecovery.uploads.length);
        await orphan.getByRole('button', { name: 'Déplacer la sélection', exact: true }).click();
        assert.equal(await folder.locator('.project-pending-files li').count(), 2);
        assert.equal(await page.evaluate(() => window.projectRecovery.uploads.length), attemptsBeforeMove);
        assert.equal(await folder.locator('.project-document-list__open').count(), 1);

        // Changing account scope discards pending selections and ignores an old completion.
        await page.evaluate(() => { window.projectRecovery.holdUpload = true; });
        await folder.getByRole('button', { name: 'Enregistrer 2 fichiers', exact: true }).click();
        await page.waitForFunction(() => window.projectRecovery.uploads.length === 8);
        const visibleBeforeScopeChange = await folder.locator('.project-document-list__open').allTextContents();
        await page.evaluate(() => window.__qaSetProjectAccount('another-company'));
        await folder.locator('.project-pending-files').waitFor({ state: 'hidden' });
        await page.evaluate(() => window.projectRecovery.releaseUpload());
        await page.waitForFunction(() => window.projectNavigation.uploads.length === 7);
        assert.deepEqual(await folder.locator('.project-document-list__open').allTextContents(), visibleBeforeScopeChange, 'An old completion cannot publish its files; account refreshes may legitimately publish their own snapshot');
        assert.equal(await page.evaluate(() => window.projectRecovery.uploads.length), 8);
        assert.equal(await folder.locator('.project-document-list__open').count(), 1);
        assert.deepEqual(errors, []);
        report.push({ engine, width, height, selectionRetained: true, backgroundUpload: true, isolatedProjects: true, recovery: true, readOnlyPause: true, lateDeletionReconciled: true, orphanSelectionRecovered: true, oldScopeIgnored: true });
        console.log(JSON.stringify(report.at(-1)));
      } catch (error) {
        await page.screenshot({ path: `${output}/${engine}-${width}-failure.png` });
        await writeFile(`${output}/${engine}-${width}-failure.txt`, `${error.stack}\n${await page.locator('body').innerText()}`);
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
