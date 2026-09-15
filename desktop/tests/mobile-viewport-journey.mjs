import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const proof=[];
for(const engine of ['chromium','webkit']){
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
  await page.goto('http://127.0.0.1:5273/tests/mobile-harness.html?browsing=1&design=1');
  await page.getByRole('button',{name:'Fermer le guide automatique',exact:true}).click();
  const check=await page.evaluate(()=>{
   const shell=document.querySelector('.desktop-app');
   const gesture=new Event('gesturestart',{bubbles:true,cancelable:true});shell.dispatchEvent(gesture);
   const pinch=new Event('touchmove',{bubbles:true,cancelable:true});Object.defineProperty(pinch,'touches',{value:[{},{}]});shell.dispatchEvent(pinch);
   const single=new Event('touchmove',{bubbles:true,cancelable:true});Object.defineProperty(single,'touches',{value:[{}]});shell.dispatchEvent(single);
   return {meta:document.querySelector('meta[name=viewport]').content,gesture:gesture.defaultPrevented,pinch:pinch.defaultPrevented,single:single.defaultPrevented};
  });
  assert.ok(check.meta.includes('maximum-scale=1'));assert.equal(check.gesture,true);assert.equal(check.pinch,true);assert.equal(check.single,false);
  await page.locator('.menu-button').click();await page.locator('.sidebar__nav button').filter({hasText:'Ventes'}).first().click();
  const input=page.getByPlaceholder('Rechercher dans Ventes');
  assert.ok(await input.evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16));
  await page.locator('.document-preview-action').first().click();
  const preview=page.locator('[data-touch-document]');await preview.waitFor();
  // Native-style touch events travel through the production pinch handler.
  const before=await preview.evaluate(el=>el.querySelector('[style*="transform"]')?.getAttribute('style')||el.innerHTML);
  await preview.evaluate(el=>{
   const rect=el.getBoundingClientRect();
   const fire=(name,spacing)=>{const e=new Event(name,{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:[{clientX:rect.left+80,clientY:rect.top+100},{clientX:rect.left+80+spacing,clientY:rect.top+100}]});el.dispatchEvent(e);};
   fire('touchstart',60);fire('touchmove',130);
  });
  await page.waitForTimeout(150);
  const after=await preview.evaluate(el=>el.querySelector('[style*="transform"]')?.getAttribute('style')||el.innerHTML);
  assert.notEqual(after,before,'document pinch remains operational');
  await page.setViewportSize({width:1280,height:900});
  await page.waitForFunction(()=>!document.documentElement.classList.contains('mobile-viewport-fixed'));
  assert.ok(!(await page.locator('meta[name=viewport]').getAttribute('content')).includes('maximum-scale=1'));
  proof.push({engine,shellPinchBlocked:true,singleFingerScrollPreserved:true,inputAtLeast16px:true,documentPinchPreserved:true,desktopZoomRestored:true});
 }finally{await browser.close();}
}
console.log(JSON.stringify(proof));
