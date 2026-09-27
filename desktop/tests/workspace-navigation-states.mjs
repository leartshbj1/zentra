import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';const root='.qa/workspace-navigation';await fs.mkdir(root+'/screens',{recursive:true});const proof=[];
for(const [engine,type] of [['edge',chromium],['webkit',webkit]]){
 const browser=await type.launch({headless:true,...(engine==='edge'?{channel:'msedge'}:{})});
 try{for(const mode of ['inactive','setup','readOnly','text200','landscape']){
 const width=mode==='landscape'?844:320;const page=await browser.newPage({viewport:{width,height:mode==='landscape'?390:844},reducedMotion:'reduce'});page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
 await page.addInitScript(mode=>{localStorage.setItem('elyko-guided-tour-v3','completed');if(mode==='text200')localStorage.setItem('zentra.text-size.v1','200');},mode);
 try{
 await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=${['inactive','setup'].includes(mode)?mode:'active'}&theme=dark&language=${mode==='text200'?'de':'fr'}${mode==='readOnly'?'&readOnly=1':''}`);
 await page.locator('.desktop-app').waitFor();await page.evaluate(()=>window.dispatchEvent(new CustomEvent('zentra-automation-navigate',{detail:'clients'})));await page.locator('.desktop-app[data-view=clients]').waitFor();
 if(['inactive','setup'].includes(mode)){await page.waitForTimeout(900);assert.equal(await page.locator('#workspace-automation-launcher').count(),0);}
 else{
  await page.locator('#workspace-automation-launcher').click();await page.locator('#workspace-automation-tools textarea').waitFor();
  if(mode==='readOnly'){
   await page.locator('#workspace-automation-tools textarea').fill('Préparer un devis pour mon client');await page.getByRole('button',{name:'Analyser',exact:true}).click();
   await page.locator('#workspace-automation-tools').getByRole('button',{name:'Préparer un devis',exact:true}).click();
   await page.getByText('Votre accès permet la consultation uniquement.',{exact:true}).waitFor();assert.equal(await page.locator('[role=dialog]').count(),0);
  }
  if(mode==='text200'){
   assert.equal(await page.locator('html').getAttribute('data-app-text-size'),'200');
   const fragments=await page.evaluate(()=>{
    const problems=[];
    for(const selector of ['.page-header h1','.mobile-company-shortcut > span','#workspace-automation-title','.automation-tools__tabs button'])for(const el of document.querySelectorAll(selector)){
     const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;
     while(node=walker.nextNode())for(const match of node.textContent.matchAll(/[\p{L}]{5,}/gu)){
      const range=document.createRange();range.setStart(node,match.index);range.setEnd(node,match.index+match[0].length);
      if(range.getClientRects().length>1)problems.push({selector,word:match[0]});
     }
    }return problems;
   });assert.deepEqual(fragments,[],'Common words stay intact at 200%');
  }
  if(mode==='landscape')await page.waitForFunction(()=>{
   const el=document.querySelector('#workspace-automation-tools .automation-tools__tabs button');const r=el?.getBoundingClientRect();const dock=document.querySelector('.mobile-navigation')?.getBoundingClientRect();
   if(!r||!dock||r.top<0||r.bottom>dock.top)return false;
   const front=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return el===front||el.contains(front);
  });
  if(mode==='text200'||mode==='landscape')await page.screenshot({path:`${root}/screens/${engine}-${mode}.png`});
  if(mode==='text200') {await page.locator('#workspace-automation-title').scrollIntoViewIfNeeded();await page.screenshot({path:`${root}/screens/${engine}-${mode}-panel.png`});}
  await page.locator('#workspace-automation-tools > header button').click();
 }
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,mode+' overflow');
 if(!['inactive','setup'].includes(mode)){
  await page.context().setOffline(true);await page.waitForFunction(()=>document.querySelector('.mobile-company-shortcut')?.dataset.syncState==='offline');await page.context().setOffline(false);
 }
 assert.deepEqual(errors,[]);proof.push({engine,mode,width,passed:true,errors});
 }catch(e){await page.screenshot({path:`${root}/screens/FAIL-${engine}-${mode}.png`});throw e;}finally{await page.close();}
 }}finally{await browser.close();await fs.writeFile(root+'/states.json',JSON.stringify(proof,null,2));}
}
console.log(JSON.stringify({passed:proof.length,output:root}));

