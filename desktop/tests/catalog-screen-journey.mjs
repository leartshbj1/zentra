import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5357';
const out = '.impeccable/review/catalogue';
await mkdir(out, { recursive: true });
const results = [];
const configurations = ['fr', 'de', 'it', 'en'].flatMap(lang => [
  { engine: 'webkit', width: 390, theme: 'dark', lang },
  { engine: 'webkit', width: 1440, theme: 'light', lang },
]);
configurations.push(...[390, 1440].map(width => ({engine: 'edge', width, theme: width === 390 ? 'light' : 'dark', lang: 'fr'})));
configurations.push({engine: 'webkit', width: 320, theme: 'light', lang: 'de', scale: 2});
for (const config of configurations) {
  const {engine, width, theme, lang, scale} = config;
  const browser = await (engine === 'edge' ? chromium : webkit).launch(engine === 'edge' ? {channel:'msedge'} : {});
  const page = await browser.newPage({viewport:{width,height:width < 800 ? 844 : 1000},reducedMotion:'reduce'});
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      const items = Array.from({length:61}, (_, i) => ({id:`catalog-${i}`,kind:i%2?'service':'product',name:`Article ${String(i).padStart(3,'0')} – données client`,sku:`ART-${i}`,unit:'pièce',description:'Description commerciale conservée — été & hiver',sales_price_cents:123456,purchase_cost_cents:65432,vat_bp:810,track_stock:i%2?0:1,stock_quantity_milli:1234567,reorder_level_milli:1000,archived_at:i===60?'2026-09-26T12:00:00Z':null,created_at:'2026-09-01T12:00:00Z',updated_at:'2026-09-01T12:00:00Z'}));
      sessionStorage.setItem('catalog-form-store', JSON.stringify({catalog_items:items,stock_movements:[]}));
    });
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&catalogForm=1&language=${lang}&theme=${theme}`);
    await page.locator('.navigation-launcher:visible,.sidebar__search:visible').first().waitFor();
    const tr = source => page.evaluate(async source => (await import('/src/language.ts')).t(source), source);
    const later = page.getByRole('button',{name:await tr('Découvrir plus tard'),exact:true});
    if(await later.isVisible()) await later.click();
    await page.locator('.navigation-launcher:visible,.sidebar__search:visible').first().click();
    const title=await tr('Produits & services');
    await page.getByRole('searchbox',{name:await tr('Rechercher un écran')}).fill(title);
    await page.locator('.navigation-palette__results button').filter({has:page.getByText(title,{exact:true})}).click();
    await page.locator('.catalog-screen').waitFor();
    if(scale) await page.evaluate(async scale => (await import('/src/textSize.ts')).setTextSize(scale * 100), scale);
    const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
    assert.equal(await page.locator('.catalog-item').count(),20);
    assert.equal(await page.locator('.global-search').count(),0);
    assert.equal(await page.locator('.catalog-filters').isVisible(),false);
    assert.equal(await overflow(),false);
    assert.equal(await page.locator('.catalog-stock-balances strong').evaluateAll(nodes => nodes.some(node => node.getBoundingClientRect().height > parseFloat(getComputedStyle(node).lineHeight) * 1.5)), false, 'stock quantities stay on one readable line');
    if(scale) assert.equal(await page.locator('.catalog-item__actions .button,.catalog-item__movement-actions .button').evaluateAll(nodes => nodes.some(node => node.getBoundingClientRect().width < 200)), false, 'enlarged article actions use the available row width');
    const itemTop=await page.locator('.catalog-item').first().evaluate(el=>el.getBoundingClientRect().top);
    if(!scale)assert.ok(itemTop < (width<800?600:500),`first item visible: ${itemTop}`);
    await page.screenshot({path:`${out}/${engine}-${width}-${theme}-${lang}${scale?'-large':''}.png`,fullPage:true});
    await page.locator('.catalog-overview summary').click();
    await page.getByText(await tr('Références actives'),{exact:true}).waitFor();
    await page.locator('.catalog-overview summary').click();
    await page.getByRole('button',{name:await tr('Page suivante'),exact:true}).first().click();
    await page.getByText('Article 020 – données client',{exact:true}).waitFor();
    await page.getByRole('button',{name:await tr('Rechercher et filtrer'),exact:true}).click();
    await page.locator('.catalog-filter-search input').fill('Article 059');
    await page.waitForFunction(()=>document.querySelectorAll('.catalog-item').length===1);
    await page.getByText('Article 059 – données client',{exact:true}).waitFor();
    await page.getByRole('button',{name:await tr('Réinitialiser les filtres'),exact:true}).click();
    await page.getByText('Article 000 – données client',{exact:true}).waitFor();
    assert.equal(await page.locator('.catalog-item').count(),20);
    await page.locator('.catalog-filters select').nth(1).selectOption('archived');
    await page.getByText('Article 060 – données client',{exact:true}).waitFor();
    assert.equal(await page.locator('.catalog-item').count(),1);
    assert.equal(await overflow(),false);
    if(lang!=='fr') {
      const text=await page.locator('.catalog-screen').innerText();
      for(const french of ['Prix de vente hors TVA','Quantités','Réservé','Disponible','Mouvements','Réactiver','Historique (','Tous les types']) assert.ok(!text.includes(french),`${lang} has untranslated ${french}`);
      assert.ok(text.includes('Description commerciale conservée — été & hiver'));
    }
    await page.getByRole('button',{name:await tr('Réinitialiser les filtres'),exact:true}).click();
    await page.locator('.catalog-item__movement-actions .catalog-history-button').first().click();
    await page.getByText(await tr('Aucun mouvement enregistré.'),{exact:true}).waitFor();
    await page.evaluate(()=>window.__qaSetReadOnly(true));
    await page.waitForFunction(()=>document.querySelector('.catalog-heading-actions button')?.disabled);
    assert.equal(await page.getByRole('button',{name:await tr('Nouvelle référence'),exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:await tr('Importer Excel'),exact:true}).isDisabled(),true);
    for(const button of await page.locator('.catalog-item__actions button').all()) assert.equal(await button.isDisabled(),true);
    assert.deepEqual(errors,[]);
    results.push({...config,firstItemTop:itemTop,overflow:false,pageReset:true,searchAcrossPages:true,archivedFilter:true,history:true,readOnly:true,errors});
  } finally { await browser.close(); }
}
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
