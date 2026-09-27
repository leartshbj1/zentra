import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const output='.qa/purchase-inbox-clarity';await mkdir(output,{recursive:true});
const proof=[];
for(const engine of ['chromium','webkit']) {
  const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
  try{for(const width of [320,390,1440]){
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&purchaseInboxAudit=1&theme=${width===390?'light':'dark'}`);
    await page.getByRole('button',{name:'Fermer le guide automatique',exact:true}).click();
    await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
    await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Achats');
    await page.locator('.navigation-palette__results button').filter({has:page.getByText('Achats & fournisseurs',{exact:true})}).click();
    const purchase=page.locator('.purchase-workflow'), summary=purchase.locator('.purchase-workflow__summary>div').first();
    await purchase.locator('.supplier-inbox__list article').first().waitFor();
    assert.equal(await summary.locator('strong').textContent(),'2');
    assert.equal(await purchase.getByText('Tout est traité',{exact:true}).count(),0);
    assert.equal(await purchase.locator('.supplier-inbox').count(),1);
    const firstTop=await purchase.locator('.supplier-inbox__list article').first().evaluate(n=>n.getBoundingClientRect().top);
    if(width<=860) assert.ok(firstTop<620,`First received document too low: ${firstTop}`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:`${output}/${engine}-${width}.png`});
    // One purchase search filters both the received and locally recorded documents.
    const search=purchase.locator('.purchase-search input');await search.fill('LEMAN-2026-091');
    assert.equal(await purchase.locator('.supplier-inbox__list article').count(),1);
    await search.fill('not-present');
    assert.equal(await purchase.locator('.supplier-inbox__list article').count(),0);
    assert.equal(await purchase.getByText('Tout est traité',{exact:true}).count(),0);
    await search.fill('');
    await page.evaluate(()=>window.__purchaseInboxQa.setUnavailable(true));
    await purchase.locator('.supplier-inbox__notice').filter({hasText:'Réception mail indisponible'}).waitFor();
    assert.equal(await summary.locator('strong').textContent(),'—');
    await page.evaluate(()=>window.__purchaseInboxQa.setUnavailable(false));
    await purchase.locator('.supplier-inbox__notice').filter({hasText:'Réception mail indisponible'}).waitFor({state:'hidden'});
    assert.equal(await summary.locator('strong').textContent(),'2');
    // Creation remains available independently of mail reception.
    await page.getByRole('button',{name:'Facture fournisseur',exact:true}).click();
    await page.getByRole('dialog',{name:'Nouvelle facture fournisseur',exact:true}).waitFor();
    assert.deepEqual(errors,[]);
    proof.push({engine,width,firstTop,count:2,noFalseCompletion:true,sharedSearch:true,unavailableDoesNotShowZero:true,creationAvailable:true});
    await page.close();
  }}finally{await browser.close();}
}
await writeFile(`${output}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
