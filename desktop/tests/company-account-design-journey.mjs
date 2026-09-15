import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const output='.qa/company171-account';await mkdir(output,{recursive:true});
const proof=[];
for(const engine of ['chromium','webkit']) {
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
 try {for(const width of [320,390,1280])for(const theme of ['light','dark'])for(const language of ['fr','de','it','en']) {
  const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(lang=>localStorage.setItem('zentra.interface.language.v1',lang),language);
  await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5281'}/tests/company-access-harness.html?account=1&theme=${theme}`);
  await page.locator('.settings-cloud-account.is-connected').waitFor();
  assert.equal(await page.locator('.settings-cloud-steps').count(),0);
  assert.equal(await page.locator('.cloud-team form').count(),0);
  assert.equal(await page.locator('.company-sync-panel button').count(),0,'No manual synchronization required');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.screenshot({path:`${output}/${engine}-${width}-${theme}-${language}.png`,fullPage:true});
  await page.locator('.cloud-team__invite-heading button').click();
  await page.locator('.cloud-team input[type=email]').fill('personne@example.test');
  await page.locator('.cloud-team form button[type=submit]').click();
  await page.locator('.cloud-team__link input').waitFor();
  assert.deepEqual(await page.evaluate(()=>({shared:companyFixture.shared,invited:companyFixture.invited})),{shared:0,invited:1},'A connected company does not republish the database before every invitation');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.deepEqual(errors,[]);proof.push({engine,width,theme,language,passed:true});await page.close();
 }} finally {await browser.close();}
}
await writeFile(`${output}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
