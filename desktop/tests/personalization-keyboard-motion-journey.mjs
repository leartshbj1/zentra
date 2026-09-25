import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE);
const report=[];
for(const [engine,type] of [['edge',chromium],['webkit',webkit]]) {
 const browser=await type.launch({headless:true,...(engine==='edge'?{channel:'msedge'}:{})});
 try {for(const reducedMotion of ['reduce','no-preference']) {
  const page=await browser.newPage({viewport:{width:390,height:900},reducedMotion});
  await page.addInitScript(()=>{
   localStorage.setItem('elyko-guided-tour-v3','completed');
   window.__movements=[];
   const animate=Element.prototype.animate;
   Element.prototype.animate=function(frames,options){
    if(this.closest('.personalization-preview'))window.__movements.push({id:this.dataset.previewId,duration:options.duration,frames});
    return animate.call(this,frames,options);
   };
  });
  await page.goto('http://127.0.0.1:5331/tests/mobile-harness.html?browsing=1&design=1&personalization=1');
  await page.locator('.mobile-navigation button').last().click();
  await page.locator('.personalize-shortcuts').click();
  const editor=page.locator('#workspace-personalization');
  await editor.locator('select').first().focus();
  if(engine==='webkit')await editor.locator('.personalization-choices li').first().getByRole('button',{name:/Descendre/}).focus();
  else await page.keyboard.press('Tab');
  assert.match(await page.locator(':focus').getAttribute('aria-label'),/Descendre Accueil/);
  await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.querySelector('#workspace-personalization select').value==='projects');
  const movements=await page.evaluate(()=>window.__movements);
  assert.equal(movements.length,reducedMotion==='reduce'?0:2);
  assert.ok(movements.every(item=>item.duration===200));
  const save=editor.locator('.personalization-footer .button--primary');
  let reached=false; if(engine==='webkit'){await save.focus();reached=true;}
  for(let tab=0;tab<20&&!reached;tab++){
   await page.keyboard.press(engine==='webkit'?'Alt+Tab':'Tab');
   reached=await save.evaluate(node=>node===document.activeElement);
   if(reached)break;
  }
  assert.ok(reached,'Save is keyboard reachable');
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('zentra.workspace.preferences.v1'))?.shortcuts[0]==='projects');
  report.push({engine,reducedMotion,keyboardReorderAndSave:true,sequentialFocusTested:engine==='edge',animations:movements.length});
  await page.close();
 }} finally{await browser.close();}
}
await writeFile('.qa/personalization/keyboard-motion.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
