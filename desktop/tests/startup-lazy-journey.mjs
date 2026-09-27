import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const output='.qa/startup-lazy';await mkdir(output,{recursive:true});const proof=[];
for(const engine of ['chromium','webkit']){
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
 try{for(const width of [390,1440])for(const fresh of [false,true]){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
  const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).pathname));
  await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
  await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&startupPerformance=1${fresh?'&startupFresh=1':''}`);
  const target=fresh?'.first-run__stage--welcome':'.desktop-app';await page.locator(target).waitFor({timeout:6000});
  const opening=await page.evaluate(()=>Number(document.body.dataset.workspaceReadyMs));
  const requestedWizard=requests.some(path=>/^\/src\/Onboarding(?:Journey)?\.tsx?$/.test(path));
  assert.equal(requestedWizard,fresh,'Only first-run loads onboarding code');
  if(!fresh){
   assert.ok(opening<6000,`Local opening blocked by account network: ${opening}`);
   assert.equal(await page.locator('body').getAttribute('data-account-network'),'pending');
   await page.waitForFunction(()=>document.body.dataset.accountNetwork==='complete',{},{timeout:14000});
   assert.equal(await page.locator('body').getAttribute('data-account-network-calls'),'1','Concurrent account checks share one request');
  }else{
   await page.locator('.zentra-arrival__start').click();
   await page.locator('.first-run__stage--account').waitFor();
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('.first-run')).backgroundColor===getComputedStyle(document.querySelector('.first-run__main')).backgroundColor,undefined,{timeout:2000});
  }
  await page.screenshot({path:`${output}/${engine}-${width}-${fresh?'new':'returning'}.png`});
  assert.deepEqual(errors,[]);proof.push({engine,width,fresh,requestedWizard,openingMs:fresh?null:opening,accountRequestShared:!fresh,errors});
  await page.close();
 }}finally{await browser.close();}
}
await writeFile(`${output}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
