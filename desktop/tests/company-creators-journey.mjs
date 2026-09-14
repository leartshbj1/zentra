import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const {webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const browser=await webkit.launch({headless:true});
const results=[];
await mkdir('.qa/company-creators',{recursive:true});
try{
 for(const width of [320,390,1280])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width,height:844},colorScheme:theme});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271'}/tests/mobile-harness.html?browsing=1&design=1&companyCreators=1`);
  await page.locator('.desktop-app').waitFor();
  await page.getByRole('button',{name:'Découvrir plus tard',exact:true}).click();
  await page.getByRole('button',{name:/^Ventes(?:\s+\d+)?$/}).first().click();
  for(const section of ['Devis','Factures']){
   const nav=page.getByRole('button',{name:section,exact:true});
   await nav.first().click();
   const filter=page.getByRole('combobox',{name:'Créateur du document',exact:true});
   if(!(await filter.isVisible()))await page.getByRole('button',{name:'Filtrer et trier',exact:true}).click();
   await filter.waitFor();
   for(const [value,label] of [['user:alice','alice.martin@entreprise-exemple.ch'],['user:bob','bernard.dupont@entreprise-exemple.ch'],['unknown','Créateur non renseigné']]){
    await filter.selectOption(value);
    const authors=page.locator('.sales-document__creator');
    await authors.first().waitFor();
    assert.deepEqual(await authors.allTextContents(),[label]);
   }
   await filter.selectOption('all');
   assert.equal(await page.locator('.sales-document__creator').count(),3);
   await page.screenshot({path:`.qa/company-creators/${theme}-${width}-${section}.png`,fullPage:true});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  }
  assert.deepEqual(errors,[]);results.push({width,theme,passed:true});await context.close();
 }
 await writeFile('.qa/company-creators/results.json',JSON.stringify(results,null,2));
 console.log(JSON.stringify(results));
}finally{await browser.close();}
