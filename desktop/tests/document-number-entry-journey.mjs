import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({ headless:true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel:'msedge' } : {}) });
const folder = `.qa/document-number-entry-${engine}`; await mkdir(folder, { recursive:true }); const report = [];
try {
  for (const width of [320, 390, 1440]) for (const entity of ['quotes', 'invoices']) {
    const page = await browser.newPage({ viewport:{ width, height:844 }, reducedMotion:'reduce' });
    const errors=[]; page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271'}/tests/mobile-harness.html?browsing=1&design=1&wizard=1`);
      await page.getByRole('button', { name:'Fermer le guide automatique', exact:true }).click();
      await page.getByRole('button', { name:'Aller à un écran', exact:true }).click();
      const section = entity === 'quotes' ? 'Devis' : 'Factures';
      await page.getByRole('searchbox', { name:'Rechercher un écran' }).fill(section);
      await page.locator('.navigation-palette__results button').filter({ has:page.getByText(section, { exact:true }) }).click();
      await page.getByRole('button', { name:entity === 'quotes' ? 'Nouveau devis' : 'Nouvelle facture', exact:true }).click();
      const editor=page.locator('.document-editor-dialog');
      const next=()=>editor.getByRole('button', { name:'Continuer', exact:true }).click();
      const calls=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('wizard-documents') || '[]'));
      await editor.locator('[name=title]').fill('Prestations et conseil offert');
      await editor.locator('[name=clientId]').selectOption('client-qa');
      if (entity === 'invoices') await editor.getByLabel('Type de document').selectOption('standard');
      await next();
      const first=editor.getByRole('group', { name:'Prestation 1', exact:true });
      await first.getByLabel('Description', { exact:true }).fill('Prestation détaillée');
      await first.getByLabel('Quantité', { exact:true }).fill('2,125');
      await first.getByLabel('Unité', { exact:true }).fill('h');
      const price=first.getByLabel('Prix unitaire', { exact:true });
      await price.fill('12,'); assert.equal(await price.inputValue(),'12,');
      assert.match(await editor.locator('.document-wizard-footer__total').innerText(), /À compléter/);
      await next(); await editor.getByRole('alert').filter({ hasText:'Ligne 1' }).waitFor();
      await page.waitForFunction(() => {
        const input=document.querySelector('.document-editor-dialog [aria-label="Prix unitaire"]');
        const bounds=input.getBoundingClientRect(); const area=input.closest('.document-form').getBoundingClientRect();
        return input===document.activeElement && bounds.top>=area.top && bounds.bottom<=area.bottom;
      });
      await page.screenshot({ path:`${folder}/${width}-${entity}-number-error.png` });
      assert.equal(await price.evaluate(el=>el===document.activeElement),true);
      await price.fill("1'234,56"); await first.getByLabel('Remise en pour cent', { exact:true }).fill('12,50');
      await first.getByLabel('Taux TVA', { exact:true }).selectOption('810');
      await editor.getByRole('button', { name:'Ligne libre', exact:true }).click();
      const free=editor.getByRole('group', { name:'Prestation 2', exact:true });
      await free.getByLabel('Description', { exact:true }).fill('Conseil offert');
      await free.getByLabel('Quantité', { exact:true }).fill('0'); await next();
      await editor.getByRole('alert').filter({ hasText:'Ligne 2' }).waitFor();
      await free.getByLabel('Quantité', { exact:true }).fill('1'); await free.getByLabel('Unité', { exact:true }).fill('forfait');
      await next(); await editor.getByRole('alert').filter({ hasText:'0 pour une prestation offerte' }).waitFor();
      await free.getByLabel('Prix unitaire', { exact:true }).fill('0'); await free.getByLabel('Remise en pour cent', { exact:true }).fill('');
      await free.getByLabel('Taux TVA', { exact:true }).selectOption('810');
      assert.equal(await free.getByLabel('Prix unitaire', { exact:true }).inputValue(),'0');
      await next();
      if (entity === 'invoices') {
        await editor.getByLabel('Début de la prestation').fill('2026-09-12');
        assert.equal(await editor.getByLabel('Fin de la prestation').inputValue(),'2026-09-12');
      }
      await editor.locator('[name=notes]').fill('Conditions conservées.\nDeuxième ligne.'); await next();
      assert.match(await editor.locator('.document-review').innerText(), /2.?481.45/);
      await page.evaluate(()=>sessionStorage.setItem('wizard-refuse-save','1'));
      await editor.getByRole('button', { name:'Enregistrer le brouillon', exact:true }).click();
      await editor.getByRole('alert').filter({ hasText:'Votre saisie est conservée' }).waitFor();
      assert.equal((await calls()).length,0);
      await page.screenshot({ path:`${folder}/${width}-${entity}-recovery.png`, fullPage:true });
      await page.evaluate(()=>sessionStorage.removeItem('wizard-refuse-save'));
      await editor.getByRole('button', { name:'Enregistrer le brouillon', exact:true }).click(); await editor.waitFor({ state:'hidden' });
      const saved=(await calls())[0]; assert.equal(saved[1].totalCents,248145); assert.equal(saved[2][0].quantity,2.125); assert.equal(saved[2][0].unitPriceCents,123456); assert.equal(saved[2][0].discountBp,1250); assert.equal(saved[2][1].unitPriceCents,0); assert.equal(saved[2][1].discountBp,0);
      if (entity === 'quotes') {
        await page.getByRole('button', { name:'Modifier le devis Prestations et conseil offert', exact:true }).click();
        await editor.getByRole('button', { name:'2. Prestations', exact:true }).click();
        assert.equal(await editor.getByRole('group', { name:'Prestation 2', exact:true }).getByLabel('Prix unitaire', { exact:true }).inputValue(),'0');
        await price.fill('1,234'); await next(); await editor.getByRole('alert').filter({ hasText:'2 décimales' }).waitFor();
        assert.equal((await calls()).length,1);
        assert.equal(await price.inputValue(),'1,234');
        await price.fill('1234,56');
        await editor.getByRole('button', { name:'Ligne libre', exact:true }).click();
        assert.match(await editor.locator('.document-wizard-footer__total').innerText(), /À compléter/);
        await editor.getByRole('group', { name:'Prestation 3', exact:true }).getByRole('button', { name:'Supprimer la ligne', exact:true }).click();
        await next(); await next(); await editor.locator('[data-document-step="3"]:not([hidden])').waitFor();
        assert.equal((await calls()).length,1);
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      assert.deepEqual(errors,[]); report.push({ engine,width,entity,decimalEntry:true,freeLine:true,recovery:true,totalCents:248145 });
    } catch (error) { await writeFile(`${folder}/failure.txt`,String(error)+'\n'+await page.locator('body').innerText()); throw error; }
    finally { await page.close(); }
  }
} finally { await writeFile(`${folder}/report.json`,JSON.stringify(report,null,2)); console.log(JSON.stringify(report)); await browser.close(); }
