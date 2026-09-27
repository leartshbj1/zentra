import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5357';
const results = [];
for (const engine of ['edge', 'webkit']) {
  const browser = await (engine === 'edge' ? chromium : webkit).launch(engine === 'edge' ? {channel:'msedge'} : {});
  const page = await browser.newPage({viewport:{width:engine === 'edge' ? 1440 : 390,height:900}, reducedMotion:'reduce'});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      const rows = Array.from({length:3001}, (_, i) => ({id:`catalog-${i}`,kind:i%2?'service':'product',name:`Article ${String(i).padStart(4,'0')}`,sku:`ART-${i}`,unit:'pièce',description:'Contenu client',sales_price_cents:12345,purchase_cost_cents:6543,vat_bp:810,track_stock:i%2?0:1,stock_quantity_milli:i===0?-1000:3000,reorder_level_milli:1000,archived_at:null,created_at:'2026-09-01T12:00:00Z',updated_at:'2026-09-01T12:00:00Z'}));
      sessionStorage.setItem('catalog-form-store',JSON.stringify({catalog_items:rows,stock_movements:[]}));
    });
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&catalogForm=1`);
    await page.locator('.navigation-launcher:visible,.sidebar__search:visible').first().waitFor();
    const later = page.getByRole('button',{name:'Découvrir plus tard',exact:true});
    if(await later.isVisible())await later.click();
    await page.locator('.navigation-launcher:visible,.sidebar__search:visible').first().click();
    await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Produits & services');
    const started = performance.now();
    await page.locator('.navigation-palette__results button').filter({has:page.getByText('Produits & services',{exact:true})}).click();
    await page.getByText('Article 0000',{exact:true}).waitFor();
    const initialMs = Math.round(performance.now()-started);
    assert.equal(await page.locator('.catalog-item').count(),20);
    assert.equal(await page.locator('.catalog-overview').getAttribute('open'),null);
    assert.ok(await page.locator('.stock-alert').isVisible(), 'low stock stays visible with collapsed summary and filters');
    assert.match(await page.locator('.stock-alert').innerText(),/Article 0000/);
    assert.equal(await page.locator('.catalog-item').first().getByRole('button',{name:'Sortie',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'Rechercher et filtrer',exact:true}).click();
    const searchStart = performance.now();
    await page.locator('.catalog-filter-search input').fill('Article 3000');
    await page.getByText('Article 3000',{exact:true}).waitFor();
    assert.equal(await page.locator('.catalog-item').count(),1);
    const searchMs = Math.round(performance.now()-searchStart);
    await page.getByRole('button',{name:'Réinitialiser les filtres',exact:true}).click();
    await page.getByRole('button',{name:'Page suivante',exact:true}).first().click();
    await page.getByText('Article 0020',{exact:true}).waitFor();
    assert.equal(await page.locator('.catalog-list-toolbar').evaluate(el => document.activeElement===el),true);
    await page.evaluate(async()=>{
      const rows=window.catalogFixture.state.stored.catalog_items;
      window.__catalogRemoved=rows.splice(5);window.catalogFixture.persist();await window.__qaCatalogRefresh();
    });
    await page.waitForFunction(()=>document.querySelectorAll('.catalog-item').length===5);
    await page.getByText('Article 0000',{exact:true}).waitFor();
    await page.evaluate(async()=>{
      window.catalogFixture.state.stored.catalog_items.push(...window.__catalogRemoved);
      window.catalogFixture.persist();await window.__qaCatalogRefresh();
    });
    await page.waitForFunction(()=>document.querySelectorAll('.catalog-item').length===20);
    await page.getByText('Article 0000',{exact:true}).waitFor();
    await page.locator('.catalog-filter-search input').fill('introuvable-test');
    await page.getByText('Aucun résultat',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Réinitialiser les filtres',exact:true}).last().click();
    await page.getByText('Article 0000',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    assert.deepEqual(errors,[]);
    results.push({engine,items:3001,rendered:20,initialMs,searchMs,lowStockVisible:true,disabledNegativeStockExit:true,clampAfterRefresh:true,doesNotResurrectOldPage:true,keyboardFocus:true,emptyFilterRecovery:true,errors});
  } finally {await browser.close();}
}
await writeFile('.impeccable/review/catalogue/boundaries.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
