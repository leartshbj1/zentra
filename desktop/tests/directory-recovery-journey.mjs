import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5265';
const out = '.qa/directory-recovery';
await mkdir(out, { recursive: true });
const report = [];
const csv = ['Référence;Désignation;Prix achat;Prix de vente;TVA;Type', ...Array.from({ length: 105 }, (_, i) => `${i === 104 ? 'ARCHIVE' : `REF-${i + 1}`};Article ${i + 1};${i === 101 ? 'sur devis' : '5'};10;8,1 %;${i === 0 ? 'Service' : 'Produit'}`)].join('\n');
for (const [engine, type] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      const navigate = async (title, query = title) => {
        await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(query);
        await page.locator('.navigation-palette__results button').filter({ has: page.getByText(title, { exact: true }) }).click();
      };
      const capture = async name => {
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.modal,.modal__body')].every(node => node.scrollWidth <= node.clientWidth + 1)), `${width} ${name} horizontal overflow`);
        await page.screenshot({ path: `${out}/${engine}-${width}-${name}.png` });
      };
      try {
        await page.goto(`${base}/tests/mobile-harness.html?directoryRecovery=1`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await navigate('Produits & services', 'catalogue');
        await page.getByRole('button', { name: 'Importer Excel', exact: true }).click();
        const wizard = page.getByRole('dialog', { name: 'Importer un catalogue fournisseur', exact: true });
        await wizard.locator('input[type=file]').setInputFiles({ name: 'catalogue.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
        await wizard.getByRole('button', { name: 'Corriger la ligne 103', exact: true }).waitFor();
        await wizard.getByText(/Cet article est suivi en stock/).waitFor();
        await wizard.getByRole('button', { name: 'Corriger la ligne 103', exact: true }).click();
        await wizard.getByRole('heading', { name: 'Corriger la ligne 103', exact: true }).waitFor();
        assert.equal(await wizard.locator('[name=purchase]').inputValue(), '');
        await wizard.getByRole('button', { name: 'Appliquer la correction', exact: true }).click();
        await wizard.getByRole('alert').filter({ hasText: 'Prix d’achat requis' }).waitFor();
        await wizard.locator('[name=purchase]').fill('9,50');
        await wizard.locator('[name=vat]').fill('0,5');
        await capture('correction');
        await wizard.getByRole('button', { name: 'Appliquer la correction', exact: true }).click();
        await wizard.getByLabel(/^Références déjà existantes/).selectOption('skip');
        await wizard.getByRole('button', { name: 'Importer (105)', exact: true }).waitFor();
        await wizard.getByRole('checkbox', { name: /^Afficher les lignes à corriger/ }).uncheck();
        await wizard.getByRole('button', { name: 'Suivant', exact: true }).click();
        await wizard.getByText('Page 2 / 2', { exact: true }).waitFor();
        const archivedRow = wizard.locator('tr').filter({ hasText: 'ARCHIVE' });
        await archivedRow.getByText('Fiche conservée', { exact: true }).waitFor();
        await capture('review');
        await page.evaluate(() => sessionStorage.setItem('qa-directory-refuse', '1'));
        await wizard.getByRole('button', { name: 'Importer (105)', exact: true }).click();
        await wizard.getByRole('alert').filter({ hasText: 'Enregistrement momentanément indisponible' }).waitFor();
        assert.equal(await wizard.getByLabel(/^Références déjà existantes/).inputValue(), 'skip');
        await wizard.getByRole('button', { name: 'Importer (105)', exact: true }).click();
        const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
        await recovery.waitFor();
        await page.keyboard.press('Escape');
        assert.ok(await recovery.isVisible());
        assert.ok(await page.locator('.catalog-import-modal').locator('select').last().isDisabled());
        await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await recovery.getByText('Actualisation impossible', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-directory-imports')).length), 1);
        await page.evaluate(() => sessionStorage.removeItem('qa-directory-block-reads'));
        await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await page.locator('.catalog-import-modal').waitFor({ state: 'detached' });
        const items = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-directory-catalog')));
        assert.equal(items.length, 105);
        assert.equal(items.find(row => row.sku === 'REF-1').salesPriceCents, 1234);
        assert.equal(items.find(row => row.sku === 'REF-1').stockQuantityMilli, 5000);
        assert.ok(items.find(row => row.sku === 'ARCHIVE').archivedAt);
        assert.equal(items.find(row => row.sku === 'REF-102').purchaseCostCents, 950);
        assert.equal(items.find(row => row.sku === 'REF-102').vatBp, 50);

        await navigate('Clients');
        await page.getByRole('button', { name: 'Nouveau client', exact: true }).click();
        let form = page.getByRole('dialog', { name: 'Nouveau client', exact: true });
        for (const [name, value] of Object.entries({ contactPerson: 'Camille Exemple', company: 'Atelier Annuaire', street: 'Rue du test', postalCode: '1000', city: 'Lausanne' })) await form.locator(`[name=${name}]`).fill(value);
        await page.evaluate(() => sessionStorage.setItem('qa-directory-refuse', '1'));
        await form.getByRole('button', { name: 'Enregistrer', exact: true }).click();
        await form.getByRole('alert').waitFor();
        assert.equal(await form.locator('[name=contactPerson]').inputValue(), 'Camille Exemple');
        await capture('client-refusal');
        await form.getByRole('button', { name: 'Enregistrer', exact: true }).click();
        await form.waitFor({ state: 'hidden' });
        const client = page.locator('tr').filter({ hasText: 'Atelier Annuaire' });
        await client.getByRole('button', { name: /^Archiver/ }).click();
        await page.getByRole('button', { name: /^Archivés/ }).click();
        await client.getByRole('button', { name: 'Réactiver', exact: true }).click();
        await page.getByRole('button', { name: /^Actifs/ }).click();
        await client.getByText('Atelier Annuaire', { exact: true }).waitFor();
        await navigate('Achats & fournisseurs');
        if (width <= 860) await page.getByRole('combobox', { name: 'Section des achats', exact: true }).selectOption('suppliers');
        else await page.locator('#purchase-tab-suppliers').click();
        await page.getByRole('button', { name: 'Nouveau fournisseur', exact: true }).click();
        form = page.getByRole('dialog', { name: 'Nouveau fournisseur', exact: true });
        await form.locator('[name=name]').fill('Fournisseur Annuaire');
        await form.locator('[name=email]').fill('fournisseur@example.invalid');
        await page.evaluate(() => sessionStorage.setItem('qa-directory-refuse', '1'));
        await form.getByRole('button', { name: 'Ajouter le fournisseur', exact: true }).click();
        await form.getByRole('alert').waitFor();
        assert.equal(await form.locator('[name=email]').inputValue(), 'fournisseur@example.invalid');
        await capture('supplier-refusal');
        await form.getByRole('button', { name: 'Ajouter le fournisseur', exact: true }).click();
        await form.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-directory-writes')).length), 2);
        assert.deepEqual(errors, []);
        report.push({ engine, width, result: 'PASS correction after row 100, invalid price blocked, stock and archive preserved, skip labels, pagination, failed/recovered import once, client refusal and archive/restore, supplier refusal, no horizontal overflow' });
      } catch (error) {
        await page.screenshot({ path: `${out}/${engine}-${width}-failure.png` });
        await writeFile(`${out}/${engine}-${width}-failure.html`, await page.content());
        throw error;
      } finally { await page.close(); }
    }
  } catch (error) { report.push({ engine, fatal: error.stack }); process.exitCode = 1; }
  finally { await browser.close(); }
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
