import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
await mkdir('.qa/design', { recursive: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
await page.emulateMedia({ reducedMotion: 'reduce' });
page.on('pageerror', error => report.push({ error: error.message }));
page.setDefaultTimeout(15000);
async function capture(name) {
  await page.screenshot({ path: `.qa/design/${name}.png`, fullPage: !await page.getByRole('dialog').count() });
  const geometry = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, overflowing: [...document.querySelectorAll('.page-content *, .modal *, .topbar *')].filter(el => { const rect = el.getBoundingClientRect(); return !(el.closest('details:not([open])') && !el.closest('summary')) && rect.width && rect.right > innerWidth + 2 && !el.closest('[hidden], [aria-hidden=true]') && !el.parentElement?.closest('table, .tab-strip, .project-folder__tabs'); }).slice(0, 16).map(el => ({ tag: el.tagName, class: el.className, right: Math.round(el.getBoundingClientRect().right) })) }));
  report.push({ screen: name, ...geometry });
}
async function gotoModule(label) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Rechercher un écran' });
  await search.fill(label);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
  await page.locator('.navigation-palette').waitFor({ state: 'detached' });
  await page.locator('.settings-cloud-status').filter({hasText: /Ouverture/}).waitFor({ state: 'detached' });
}
try {
  await page.goto(process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5175/tests/mobile-harness.html');
  const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
  if (await tour.isVisible()) await tour.click();
  await capture('390-dashboard');
  await page.getByRole('button', { name: 'Voir les 6 étapes', exact: true }).click();
  assert.equal(await page.locator('.getting-started__steps').isVisible(), true);
  await page.getByRole('button', { name: 'Masquer les étapes', exact: true }).click();
  await gotoModule('Projets');
  await page.getByRole('button', { name: 'Nouveau projet', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nom du projet' }).fill('Aménagement du bureau de Lausanne');
  await page.getByLabel('Client', { exact: false }).selectOption('client-qa');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'notes-projet.txt', mimeType: 'text/plain', buffer: Buffer.from('Documents du projet') });
  await capture('390-create-project');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByLabel('État du projet').selectOption('completed');
  assert.equal(await page.getByRole('heading', { name: 'Aucun résultat', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Tous les états', exact: true }).click();
  await page.getByRole('button', { name: 'Aménagement du bureau de Lausanne', exact: true }).click();
  await page.getByText('notes-projet.txt', { exact: true }).waitFor();
  await capture('390-project-folder');
  await page.getByRole('button', { name: 'Nouveau devis', exact: true }).click();
  await page.getByRole('textbox', { name: 'Titre du document' }).fill('Étude du bureau');
  assert.ok(await page.locator('select[name=projectId]').inputValue());
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Étude du projet');
  await page.getByRole('spinbutton', { name: 'Quantité', exact: true }).fill('1');
  await page.getByRole('textbox', { name: 'Unité', exact: true }).fill('forfait');
  await page.getByRole('spinbutton', { name: 'Prix unitaire', exact: true }).fill('200');
  await page.locator('.line-editor').scrollIntoViewIfNeeded();
  await capture('390-quote-editor');
  await page.getByRole('button', { name: /Enregistrer.*brouillon/i }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.match(await page.locator('.project-document-list').allTextContents().then(x=>x.join(' ')), /200/);
  await page.getByRole('button', { name: 'Nouvelle facture', exact: true }).click();
  await page.getByRole('textbox', { name: 'Titre du document' }).fill('Prestation bureau');
  await page.getByLabel('Type de document').selectOption('standard');
  await page.getByLabel('Début de la prestation').fill('2026-09-05');
  await page.getByLabel('Fin de la prestation').fill('2026-09-05');
  assert.ok(await page.locator('select[name=projectId]').inputValue());
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Prestation du projet');
  await page.getByRole('spinbutton', { name: 'Quantité', exact: true }).fill('1');
  await page.getByRole('textbox', { name: 'Unité', exact: true }).fill('forfait');
  await page.getByRole('spinbutton', { name: 'Prix unitaire', exact: true }).fill('250');
  await page.getByRole('button', { name: /Enregistrer.*brouillon/i }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await capture('390-project-documents');
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const label of ['Tableau de bord','Agenda','Projets','Clients','Produits & services','Devis','Factures','Commandes & livraisons','Relances','Temps','Équipe & salaires','Achats & fournisseurs','Banque','Rapports','Comptabilité','Paramètres']) {
      await gotoModule(label);
      await capture(`${width}-${label.replace(/[^\p{L}\p{N}]+/gu,'-')}`);
    }
    for (const category of ['État de la configuration', 'Compte et accès', 'Entreprise et facturation', 'Comptabilité', 'Temps et coûts', 'Équipe et paie', 'Sauvegardes et mises à jour']) {
      await page.locator('.settings-category > summary').filter({hasText:category}).click();
      await capture(`${width}-settings-${category.replace(/[^\p{L}\p{N}]+/gu,'-')}`);
    }
  }
  await page.locator('.settings-category > summary').filter({hasText:'Entreprise et facturation'}).click();
  await page.getByRole('textbox', {name:'Raison sociale'}).fill('Saisie conservée pendant la navigation');
  await page.locator('.settings-category > summary').filter({hasText:'Temps et coûts'}).click();
  await page.locator('.settings-category > summary').filter({hasText:'Entreprise et facturation'}).click();
  assert.equal(await page.getByRole('textbox', {name:'Raison sociale'}).inputValue(), 'Saisie conservée pendant la navigation');
  await page.getByRole('button', {name:'Ouvrir les mises à jour de Zentra'}).click();
  await page.locator('.settings-category[open]').filter({hasText:'Sauvegardes et mises à jour'}).waitFor({state:'visible'});
  assert.equal(await page.locator('.settings-category').filter({hasText:'Sauvegardes et mises à jour'}).getAttribute('open'), '');
  await page.keyboard.press('Control+k');
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('comptabilite');
  assert.equal(await page.locator('.navigation-palette__results button').count() >= 1, true);
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('introuvable-xyz');
  assert.equal(await page.locator('.navigation-palette__results button').count(), 0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('factures');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Nouvelle facture', exact: true }).waitFor();
  assert.equal(report.filter(x=>x.error).length, 0, 'No application runtime error');
  assert.deepEqual(report.filter(x=>x.document > x.width), [], 'No page-level horizontal overflow');
  report.push({ journey: 'PASS project + attachment + quote + invoice + filters + module navigation + keyboard' });
} catch (error) { report.push({ fatal: error.stack }); await page.screenshot({path:'.qa/design/failure.png',fullPage:true}); process.exitCode = 1; }
finally { await writeFile('.qa/design/report.json', JSON.stringify(report,null,2)); console.log(JSON.stringify({ screens: report.filter(x=>x.screen).length, failures: report.filter(x=>x.error||x.fatal||x.document>x.width), journey: report.find(x=>x.journey)?.journey },null,2)); await browser.close(); }
