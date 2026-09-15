import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const out='.qa/company1711';await mkdir(out,{recursive:true});
const proof=[];
for(const engine of ['chromium','webkit']){
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:844},hasTouch:width===390});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5273'}/tests/mobile-harness.html?browsing=1&design=1&companyRealtime=1`);
  await page.getByRole('button',{name:'Fermer le guide automatique',exact:true}).click();
  await page.waitForFunction(()=>window.companyRealtimeFixture?.calls.some(c=>c.command==='sync_company_workspace'));
  const amount=width===390?page.locator('.mobile-home__amount'):page.locator('.metric-card').filter({hasText:'Reste à recevoir'}).locator('strong');
  const baseline=await amount.innerText();
  await page.evaluate(()=>window.companyRealtimeFixture.issue());
  const start=Date.now();
  await page.waitForFunction(({width,baseline})=>{
   const area=width===390?document.querySelector('.mobile-home__amount'):[...document.querySelectorAll('.metric-card')].find(e=>e.textContent.includes('Reste à recevoir'))?.querySelector('strong');
   return area?.innerText!==baseline;
  },{width,baseline},{timeout:5500});
  const issued=await amount.innerText();assert.notEqual(issued,baseline);
  const issueDelay=Date.now()-start;
  await page.evaluate(()=>window.companyRealtimeFixture.pay());
  await page.waitForFunction(({width,issued})=>{
   const area=width===390?document.querySelector('.mobile-home__amount'):[...document.querySelectorAll('.metric-card')].find(e=>e.textContent.includes('Reste à recevoir'))?.querySelector('strong');
   return area?.innerText!==issued;
  },{width,issued},{timeout:5500}).catch(async error=>{console.log(await page.evaluate(()=>({calls:window.companyRealtimeFixture.calls,body:document.body.innerText,local:window.__qaDesktopApi.loadWorkspace().then(w=>({invoices:w.invoices,payments:w.payments}))})));throw error;});
  const paid=await amount.innerText();assert.notEqual(paid,issued);
  // A real visible editor defers the swap; hidden forms and search fields do not.
  await page.evaluate(()=>{const form=document.createElement('form');form.id='qa-editor';form.className='editor-panel';form.innerHTML='<input value="Saisie à conserver">';document.querySelector('main').append(form);form.querySelector('input').focus();window.companyRealtimeFixture.issue();});
  const count=await page.evaluate(()=>window.companyRealtimeFixture.calls.filter(c=>c.command==='apply_company_update').length);
  await page.waitForTimeout(3500);
  assert.equal(await page.evaluate(()=>window.companyRealtimeFixture.calls.filter(c=>c.command==='apply_company_update').length),count);
  assert.equal(await page.locator('#qa-editor input').inputValue(),'Saisie à conserver');
  await page.evaluate(()=>{document.querySelector('#qa-editor').remove();const search=document.createElement('input');search.type='search';search.id='qa-search';document.querySelector('main').append(search);search.focus();const hidden=document.createElement('div');hidden.hidden=true;hidden.innerHTML='<form class="editor-panel">Masqué</form>';document.body.append(hidden);});
  await page.waitForFunction(count=>window.companyRealtimeFixture.calls.filter(c=>c.command==='apply_company_update').length>count,count,{timeout:5000});
  await page.waitForFunction(()=>!document.getElementById('root').inert);
  // Even a slow local swap keeps the dashboard visible. The narrow write
  // guard must release and restore search focus on both success and failure.
  await page.locator('#qa-search').fill('Recherche conservée');
  for(const fail of [false,true]){
   const before=await amount.innerText();
   await page.evaluate(()=>{window.companyRealtimeFixture.holdNextApply();window.companyRealtimeFixture.issue();});
   await page.waitForFunction(()=>document.getElementById('root').inert,{timeout:5500});
   assert.equal(await page.locator('.company-receiving, .splash-screen').count(),0);
   assert.equal(await amount.innerText(),before);
   assert.equal(await amount.isVisible(),true);
   assert.equal(await page.locator('#qa-search').inputValue(),'Recherche conservée');
   await page.screenshot({path:`${out}/${engine}-${width}-${fail?'failure':'receiving'}.png`});
   await page.evaluate(fail=>window.companyRealtimeFixture.finishApply(fail),fail);
   await page.waitForFunction(()=>!document.getElementById('root').inert);
   assert.equal(await page.evaluate(()=>document.activeElement?.id),'qa-search');
   if(fail)assert.equal(await amount.innerText(),before);
   else assert.notEqual(await amount.innerText(),before);
  }
  assert.deepEqual(errors,[]);
  proof.push({engine,width,issueDelay,baseline,issued,paid,automaticReception:true,editorPreserved:true,searchDoesNotBlock:true,noLoadingOverlay:true,screenVisibleDuringReception:true,focusRestoredAfterSuccessAndFailure:true});
  await page.close();
 }}finally{await browser.close();}
}
await writeFile(`${out}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
