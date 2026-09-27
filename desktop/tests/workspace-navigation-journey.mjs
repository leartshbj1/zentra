import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
import fs from 'node:fs/promises';
const root=process.env.ZENTRA_NAV_QA_OUTPUT||'.qa/workspace-navigation';
await fs.mkdir(root+'/screens',{recursive:true});
const proof=[];const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
for(const [engine,browserType] of [['edge',chromium],['webkit',webkit]]){
 const browser=await browserType.launch({headless:true,...(engine==='edge'?{channel:'msedge'}:{})});
 try{for(const width of [320,390,1440])for(const language of ['fr','de','it','en']){
 const page=await browser.newPage({viewport:{width,height:844},reducedMotion:'reduce'});page.setDefaultTimeout(6000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
 await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
 try{
 await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=active&personalization=1&language=${language}&theme=${width===320?'dark':'light'}`);
 await page.locator('.desktop-app').waitFor();
 for(const screen of ['projects','clients','expenses','quotes']){
 await page.evaluate(screen=>window.dispatchEvent(new CustomEvent('zentra-automation-navigate',{detail:screen==='expenses'?'purchases':screen})),screen);
 await page.locator('.desktop-app[data-view='+screen+']').waitFor();
 const launcher=page.locator('#workspace-automation-launcher');await launcher.waitFor();
 const splitWords=await page.locator('.creation-action > button').evaluateAll(nodes=>nodes.flatMap(el=>{
  const result=[],walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;
  while(node=walker.nextNode())for(const match of node.textContent.matchAll(/[\p{L}]{8,}/gu)){
   const range=document.createRange();range.setStart(node,match.index);range.setEnd(node,match.index+match[0].length);if(range.getClientRects().length>1)result.push(match[0]);
  }return result;
 }));assert.deepEqual(splitWords,[],'Primary action words are not fragmented');
 await page.locator('#workspace-automation-tools').waitFor({state:'hidden'});
 await launcher.click();await page.locator('#workspace-automation-tools .automation-tools__content').waitFor();
 await page.waitForFunction(()=>document.activeElement?.id==='workspace-automation-title');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'overflow '+screen);
 if((language==='de'&&width===320&&engine==='webkit'&&screen==='expenses')||(language==='fr'&&width===1440&&engine==='edge'&&screen==='projects')) await page.screenshot({path:`${root}/screens/new-${engine}-${width}-${language}-${screen}-tools.png`});
 await page.keyboard.press('Escape');await page.locator('#workspace-automation-tools').waitFor({state:'hidden'});
 assert.equal(await launcher.evaluate(el=>el===document.activeElement),true,'focus restore');
 if(width<861){const bounds=await launcher.boundingBox();const heading=await page.locator('.page-header h1').boundingBox();assert.ok(bounds.y>=heading.y+heading.height,'Separate heading and tools');assert.equal(await launcher.locator('span').isVisible(),true,'Named mobile action');}
 if(screen==='projects'){
  if(width<861){assert.equal(await page.locator('.mobile-company-shortcut').isVisible(),true);assert.equal(await page.locator('.account-launcher').isVisible(),false);assert.equal(await page.locator('.global-search input').evaluate(el=>el.getBoundingClientRect().height>=44),true);}
  if(language==='fr'&&((width===390&&engine==='webkit')||(width===1440&&engine==='edge')))await page.screenshot({path:`${root}/screens/new-${engine}-${width}-${language}-${screen}.png`});
 }
 }
 await page.evaluate(async()=>{window.__personalizationSync({enabled:true,organizationId:'automation-qa',revision:1,pending:false,conflict:true});});
 const indicator=page.locator('.company-sync-indicator:visible,.mobile-company-shortcut:visible');await page.waitForFunction(()=>document.querySelector('.mobile-company-shortcut')?.dataset.syncState==='attention');
 if(width<861)assert.equal(await indicator.getAttribute('data-sync-state'),'attention');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 if(language==='en'&&width===320&&engine==='webkit')await page.screenshot({path:`${root}/screens/new-${engine}-${width}-${language}-sync.png`});
 await indicator.click();await page.locator('.desktop-app[data-view=settings]').waitFor();await page.locator('[data-settings-id=account]').waitFor();
 assert.deepEqual(errors,[]);proof.push({engine,width,language,modules:4,overflow:false,focus:true,mobileCompany:width<861,errors});
 }catch(error){await page.screenshot({path:`${root}/screens/new-FAIL-${engine}-${width}-${language}.png`});proof.push({engine,width,language,error:String(error),errors});throw error;}
 finally{await page.close();}
 }}finally{await browser.close();await fs.writeFile(root+'/navigation-current.json',JSON.stringify(proof,null,2));}
}
console.log(JSON.stringify({passed:proof.length,proof:root+'/navigation-current.json'}));


