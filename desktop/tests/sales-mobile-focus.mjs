import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const output='.qa/sales-mobile-focus';await mkdir(output,{recursive:true});const proof=[];
for(const engine of ['chromium','webkit']){
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
 try{for(const width of [320,390,1440])for(const language of ['fr','de','it','en']){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
  await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=active&language=${language}&theme=${width===320?'dark':'light'}`);
  await page.locator('.desktop-app').waitFor();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('zentra-automation-navigate',{detail:'quotes'})));
  await page.locator('.sales-tabs').waitFor();
  for(const [entity,tab] of [['quotes',0],['invoices',2]]){
   await page.locator('.sales-tabs button').nth(tab).click();
   const list=page.locator(`.sales-documents--${entity}`);await list.waitFor();
   const first=list.locator('tbody tr').first(),total=first.locator('.sales-document__total');
   const tabLabels={fr:['Devis','Commandes','Factures'],de:['Offerten','Aufträge','Rechnungen'],it:['Preventivi','Ordini','Fatture'],en:['Quotes','Orders','Invoices']};
   assert.deepEqual(await page.locator('.sales-tabs button').allTextContents(),tabLabels[language]);
   const previewLabels={fr:'Aperçu',de:'Vorschau',it:'Anteprima',en:'Preview'};
   assert.equal((await first.locator('.document-preview-action').innerText()).trim(),previewLabels[language]);
   const totalBox=await total.boundingBox();
   if(width<861){
    assert.equal(await page.locator('.topbar .global-search').count(),0);
    assert.ok(totalBox&&totalBox.y+totalBox.height<760,`First amount visible before dock: ${JSON.stringify(totalBox)}`);
    assert.equal(await page.locator('.page-content > .automation-tools').count(),0);
   }else assert.equal(await page.locator('.topbar .global-search').count(),1);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No overflow');
   await page.screenshot({path:`${output}/${engine}-${width}-${language}-${entity}.png`});
   const toolbar=list.locator('.document-list-tools');
   if(width<861)await toolbar.locator('.document-list-tools__compact button').click();
   const search=width<861?toolbar.locator('input[type="search"]'):page.locator('.global-search input');
   const count=await list.locator('tbody tr').count();assert.ok(count>1);
   const target=await first.locator('.document-cell small').first().innerText();
   await search.fill(target);assert.equal(await list.locator('tbody tr').count(),1);
   if(width<861){
    await page.keyboard.press('Escape');
    assert.equal(await toolbar.getAttribute('data-expanded'),'false');
    assert.ok(await toolbar.locator('.document-list-tools__compact button').evaluate(el=>el===document.activeElement));
    await toolbar.locator('.document-list-tools__compact button').click();
    assert.equal(await search.inputValue(),target);
    await toolbar.locator('.document-search-clear').click();
    await toolbar.locator('.automation-tools > summary').click();
    await toolbar.locator('.automation-tools__content').waitFor();
    await toolbar.locator('.automation-tools > summary').click();
   }else await search.fill('');
   assert.equal(await list.locator('tbody tr').count(),count);
   const status=toolbar.locator('select').nth(0);await status.selectOption('cancelled');
   assert.equal(await list.locator('tbody tr').count(),0);await status.selectOption('all');
   const order=toolbar.locator('select').nth(1),before=await first.locator('.document-cell small').first().innerText();
   const orderOptions=await order.locator('option').evaluateAll(nodes=>nodes.map(el=>el.value));
   const ascending=orderOptions.find(value=>value.includes('created')&&value.includes('asc'));assert.ok(ascending);await order.selectOption(ascending);
   assert.notEqual(await list.locator('tbody tr').first().locator('.document-cell small').first().innerText(),before);
   await order.selectOption(orderOptions[0]);
   if(width<861){
    await toolbar.locator('.document-filters-done').click();
    const row=list.locator('tbody tr').first();await row.locator('.mobile-details > summary').click();
    assert.ok(await row.locator('.mobile-document-metadata').isVisible());
    await row.locator('.mobile-details > summary').click();
   }
   proof.push({engine,width,language,entity,firstAmountBottom:Math.round(totalBox.y+totalBox.height),search:true,filter:true,sorting:true,actionsRetained:true});
  }
  assert.deepEqual(errors,[]);await page.close();
 }}finally{await browser.close();}
}
await writeFile(`${output}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:proof.length,output}));
