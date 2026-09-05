import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
await mkdir('.qa/sales-fulfillment', { recursive: true });
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', (error) => report.push({ width, error: error.message }));
    page.on('dialog', (dialog) => dialog.accept());
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?fulfillment=1', { waitUntil: 'domcontentloaded' });
    const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
    if (await tour.isVisible()) await tour.click();
    const navigate = async (name) => {
      await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
      await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
      await page.locator('.navigation-palette').waitFor({ state: 'detached' });
    };
    const mode = (operation, failure) => page.evaluate(({ operation, failure }) => sessionStorage.setItem(`qa-sales-${operation}-failure`, failure), { operation, failure });
    const attempts = (operation) => page.evaluate((operation) => JSON.parse(sessionStorage.getItem(`qa-sales-${operation}-attempts`) || '[]'), operation);
    const persisted = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-sales-persisted')));
    const capture = async (name) => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: page overflow ${width}`);
      const dialog = page.getByRole('dialog');
      if (await dialog.count()) assert.ok(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), `${name}: modal overflow ${width}`);
      const smallText = await page.locator('.guided-lines-section strong, .guided-lines-section p, .guided-lines-section small, .invoice-preview-card strong, .invoice-preview-card small, .order-line-card small, .order-progress small').evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length && parseFloat(getComputedStyle(node).fontSize) < 12).map((node) => node.textContent));
      assert.deepEqual(smallText, [], `${name}: document quantities and explanations must remain readable at ${width}`);
      if (name.endsWith('refused') || name === 'save-committed-read-failed') {
        await page.waitForFunction(() => {
          const dialog = document.querySelector('[role="dialog"]');
          const panel = dialog?.querySelector('.error-panel'); const body = dialog?.querySelector('.modal__body'); const actions = dialog?.querySelector('.form-actions');
          if (!panel || !body || !actions) return false;
          const error = panel.getBoundingClientRect(); const frame = body.getBoundingClientRect(); const footer = actions.getBoundingClientRect();
          return error.top >= Math.max(0, frame.top) - 1 && error.bottom <= Math.min(innerHeight, frame.bottom, footer.top) + 1;
        });
        assert.equal(await page.locator('.notice--floating').count(), 0, 'local error must not cover the modal heading with a duplicate toast');
      }
      await page.screenshot({ path: `.qa/sales-fulfillment/${width}-${name}.png` });
    };
    await navigate('Commandes & livraisons');
    await page.locator('.sales-order-card').click();
    await capture('order');
    await page.getByRole('button', { name: 'Préparer la livraison', exact: true }).click();
    let dialog = page.getByRole('dialog');
    const quantity = dialog.getByRole('spinbutton', { name: 'Quantité livrée pour Panneaux acoustiques pour la salle de réunion', exact: true });
    await quantity.fill('2');
    await dialog.locator('input[name="reference"]').fill('Livraison bureau / lot 1');
    await dialog.locator('textarea[name="notes"]').fill('Entrée côté cour, prévenir avant l’arrivée.');
    await mode('save', 'reject');
    await dialog.getByRole('button', { name: 'Enregistrer le bon brouillon', exact: true }).click();
    await dialog.getByText('Refus save : la période comptable est fermée.', { exact: true }).waitFor();
    assert.equal(await quantity.inputValue(), '2');
    await capture('save-refused');
    await mode('save', 'refresh_twice');
    await dialog.getByRole('button', { name: 'Enregistrer le bon brouillon', exact: true }).click();
    await page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true }).waitFor();
    assert.equal((await persisted()).deliveries, 1);
    await capture('save-awaiting-refresh');
    await page.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal((await persisted()).deliveries, 1, 'retry must not create another delivery');
    const saves = await attempts('save');
    assert.equal(saves.length, 2, 'manual refresh only rereads the acknowledged write');
    assert.ok(saves[0].id);
    assert.equal(new Set(saves.map((input) => input.id)).size, 1);
    assert.ok(saves.every((input) => input.lines[0].quantityMilli === 2000 && input.reference === 'Livraison bureau / lot 1'));

    await page.getByRole('button', { name: 'Contrôler le bon', exact: true }).click();
    dialog = page.getByRole('dialog');
    await mode('issue', 'reject');
    await dialog.getByRole('button', { name: 'Confirmer et émettre le bon', exact: true }).click();
    await dialog.getByText('Refus issue : la période comptable est fermée.', { exact: true }).waitFor();
    await capture('issue-refused');
    await mode('issue', 'refresh_once');
    await dialog.getByRole('button', { name: 'Confirmer et émettre le bon', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal((await persisted()).issued, 1);
    const issues = await attempts('issue');
    assert.equal(new Set(issues.map((input) => input.requestId)).size, 1);
    assert.equal(issues.length, 2, 'a recovered read must not issue the delivery again');
    await page.getByRole('button', { name: 'Extourner', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.locator('textarea[name="reason"]').fill('Erreur de préparation signalée par le client');
    await mode('reverse', 'reject');
    await dialog.getByRole('button', { name: 'Créer l’extourne', exact: true }).click();
    await dialog.getByText('Refus reverse : la période comptable est fermée.', { exact: true }).waitFor();
    assert.equal(await dialog.locator('textarea[name="reason"]').inputValue(), 'Erreur de préparation signalée par le client');
    await capture('reverse-refused');
    await dialog.getByRole('button', { name: 'Annuler', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Créer la facture suivante', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByText('Facture de situation', { exact: true }).waitFor();
    await mode('invoice', 'reject');
    await dialog.getByRole('button', { name: 'Créer le brouillon contrôlé', exact: true }).click();
    await dialog.getByText('Refus invoice : la période comptable est fermée.', { exact: true }).waitFor();
    assert.ok(await dialog.getByRole('button', { name: 'Créer le brouillon contrôlé', exact: true }).isEnabled());
    await capture('invoice-refused');
    await mode('invoice', 'refresh_once');
    await dialog.getByRole('button', { name: 'Créer le brouillon contrôlé', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal((await persisted()).invoices, 1);
    const invoices = await attempts('invoice');
    assert.equal(invoices.length, 2);
    assert.equal(new Set(invoices.map((input) => input.requestId)).size, 1);
    assert.equal(invoices[1].allocations.find((line) => line.salesOrderLineId === 'sales-line-product').quantityMilli, 2000);
    await page.getByRole('button', { name: 'Contrôler la facture', exact: true }).waitFor();
    await capture('invoice-created');
    const search = page.getByRole('searchbox', { name: 'Rechercher dans Ventes', exact: true });
    await search.fill('introuvable');
    await page.getByText('Aucune commande ne correspond à cette recherche.', { exact: true }).waitFor();
    await search.fill('amenagement');
    await page.locator('.sales-order-card').waitFor();
    assert.equal(await page.locator('.sales-order-card').count(), 1);
    await page.locator('.sales-order-card').click();
    await search.fill('');
    await page.locator('.sales-order-card').waitFor();
    assert.equal(await page.locator('.sales-order-card').count(), 1, 'clearing the search also restores the list');

    await navigate('Comptabilité');
    if (width <= 860) await page.getByRole('button', { name: 'Tous les modules', exact: true }).click();
    const navigation = page.getByRole('navigation', { name: 'Navigation principale', exact: true });
    const contained = async () => navigation.evaluate((node) => {
      const active = node.querySelector('[aria-current="page"]');
      const frame = node.getBoundingClientRect(); const rect = active.getBoundingClientRect();
      return rect.top >= frame.top - 1 && rect.bottom <= frame.bottom + 1;
    });
    assert.ok(await contained(), `active menu must be fully visible at ${width}`);
    await page.setViewportSize({ width, height: 650 });
    await page.waitForFunction(() => { const nav = document.querySelector('.sidebar__nav'); const active = nav.querySelector('[aria-current="page"]'); return active.getBoundingClientRect().bottom <= nav.getBoundingClientRect().bottom + 1; });
    assert.ok(await contained(), `active menu after height resize ${width}`);
    await capture('navigation');
    report.push({ width, result: 'PASS partial delivery, rejection inside dialogs, saved draft plus two read failures and read-only recovery, issue and invoice creation recovered without second write, stable references and quantities, active navigation visible after resize, no overflow' });
    await page.close();
  }
  assert.deepEqual(report.filter((item) => item.error), []);
} catch (error) {
  report.push({ fatal: error.stack }); process.exitCode = 1;
  const page = browser.contexts().flatMap((context) => context.pages()).at(-1);
  if (page) { await page.screenshot({ path: '.qa/sales-fulfillment/failure.png', fullPage: true }); await writeFile('.qa/sales-fulfillment/failure.html', await page.content()); }
} finally {
  await writeFile('.qa/sales-fulfillment/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); await browser.close();
}
