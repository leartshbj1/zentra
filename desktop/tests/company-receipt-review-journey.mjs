import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const out='.qa/company171-receipt';await mkdir(out,{recursive:true});const proof=[];
for(const engine of ['chromium','webkit']) {
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
 try {for(const width of [320,390,1280]) {
  const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5281'}/tests/company-access-harness.html?account=1&duplicate=1&theme=dark`);
  const button=page.getByRole('button',{name:'Oui, un seul paiement',exact:true});await button.waitFor();
  assert.equal(await page.evaluate(()=>companyFixture.receiptConfirmations),0);
  page.once('dialog',dialog=>dialog.dismiss());await button.click();
  assert.equal(await page.evaluate(()=>companyFixture.receiptConfirmations),0);
  assert.equal(await button.isVisible(),true);
  await page.screenshot({path:`${out}/${engine}-${width}.png`,fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  page.once('dialog',dialog=>{assert.match(dialog.message(),/100/);assert.match(dialog.message(),/F-2026-0100/);return dialog.accept();});
  await button.click();await button.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>companyFixture.receiptConfirmations),1);assert.deepEqual(errors,[]);
  proof.push({engine,width,explicitConfirmation:true,cancelPreservesBoth:true,confirmedOnce:true});await page.close();
 }}finally {await browser.close();}
}
await writeFile(`${out}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
