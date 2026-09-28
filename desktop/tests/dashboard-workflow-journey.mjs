import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5342';
const output=process.env.ZENTRA_QA_OUTPUT||'../.impeccable/review/dashboard-workflow';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
const results=[];
try {
 for(const [width,theme,language,size] of [[1440,'light','fr',100],[1440,'dark','fr',100],[390,'light','it',100],[390,'dark','fr',100],[320,'light','de',200],[1024,'dark','en',100]]) {
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce',hasTouch:width<500});
  page.setDefaultTimeout(15000);
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&collectionTest=1&theme=${theme}&language=${language}`);
  await page.locator('[data-personalized-actions] button').first().waitFor();
  await page.evaluate(async size=>(await import('/src/textSize.ts')).setTextSize(size),size);
  await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,textScale:Number(getComputedStyle(document.documentElement).getPropertyValue('--zentra-ui-text-scale')),actions:[...document.querySelectorAll('[data-personalized-actions] button')].map(button=>({height:button.getBoundingClientRect().height,width:button.getBoundingClientRect().width,disabled:button.disabled})),order:[...document.querySelector('.dashboard-grid--daily')?.children||[]].map(child=>({class:child.className,top:child.getBoundingClientRect().top,height:child.getBoundingClientRect().height}))}));
  assert.ok(geometry.scroll<=width+1,JSON.stringify(geometry));
  assert.equal(geometry.textScale,size/100,'Exercise the actual saved text-size setting');
  assert.ok(geometry.actions.every(button=>button.height>=44&&button.width>=44));
  if(width===1440) {
   const actions=geometry.order.find(row=>row.class.includes('dashboard-personal-actions'));
   assert.ok(actions.top<700,'Creation shortcuts must precede the empty project panel');
   assert.ok(actions.height<150,'Desktop shortcuts must remain a compact toolbar');
   assert.ok(geometry.actions.every(button=>button.height<=70),'Desktop shortcuts must not stretch vertically');
  }
  const name=`${width}-${theme}-${language}-${size}`;
  await page.screenshot({path:`${output}/${name}.png`,fullPage:true});
  if(width===320) {
   const legibility=await page.evaluate(()=>({
    money:[...document.querySelectorAll('.responsive-money__number')].map(node=>({text:node.textContent,width:node.clientWidth,scroll:node.scrollWidth,whiteSpace:getComputedStyle(node).whiteSpace,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})),
    navigation:[...document.querySelectorAll('.mobile-navigation button')].map(node=>{const label=node.querySelector('span');const rect=node.getBoundingClientRect();return {label:label.textContent,width:label.clientWidth,scroll:label.scrollWidth,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,height:rect.height};}),
   }));
   assert.ok(legibility.money.length>=3,'Exercise balance and mixed-currency revenue');
   assert.ok(legibility.money.every(row=>row.scroll<=row.width+1&&row.left>=0&&row.right<=width+1&&row.whiteSpace==='nowrap'),JSON.stringify(legibility));
   assert.equal(legibility.navigation.length,5,'Keep the four chosen destinations and Menu');
   assert.ok(legibility.navigation.every(row=>row.scroll<=row.width+1&&row.left>=0&&row.right<=width+1&&row.top>=0&&row.bottom<=900&&row.height>=44),JSON.stringify(legibility));
   // Full-page captures place the fixed dock mid-document. Also expose the balance
   // in the real viewport to prove that scrolling reveals the entire amount.
   await page.locator('.mobile-home__balance').evaluate(node=>node.scrollIntoView({block:'start'}));
   await page.screenshot({path:`${output}/320-enlarged-balance.png`,fullPage:false});
   const shortcuts=page.locator('.mobile-navigation__shortcuts button');
   for(let index=0;index<4;index++) {
    await shortcuts.nth(index).tap();
    await page.waitForFunction(index=>document.querySelectorAll('.mobile-navigation__shortcuts button')[index]?.getAttribute('aria-current')==='page',index);
   }
   await shortcuts.first().focus();
   await page.keyboard.press('Enter');
   await page.waitForFunction(()=>document.querySelector('.mobile-navigation__shortcuts button')?.getAttribute('aria-current')==='page');
   const menu=page.locator('.mobile-navigation > button');
   await menu.focus();await page.keyboard.press('Enter');
   assert.equal(await menu.getAttribute('aria-expanded'),'true');
   await page.keyboard.press('Escape');
   results.push({enlargedText:legibility,touchDestinations:4,keyboardHomeAndMenu:true});
  }
  if(width===1440&&theme==='light') {
   const target=page.locator('.deadline-list button').first();
   const reference=await target.locator('strong').innerText();
   const title=await target.locator('small').innerText();
   await target.click();
   await page.getByRole('dialog').waitFor();
   assert.equal(await page.getByRole('dialog').locator('input[name="title"]').inputValue(),title,'Open the selected invoice directly');
   await page.screenshot({path:`${output}/selected-invoice.png`,fullPage:false});
   await page.keyboard.press('Escape');
   await page.getByRole('dialog').waitFor({state:'detached'});
   results.push({selectedInvoice:reference,title});
  }
  await page.evaluate(()=>window.__qaSetReadOnly(true));
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-personalized-actions] button')].every(button=>button.disabled));
  assert.deepEqual(errors,[]);
  results.push({name,...geometry,errors,readOnlyPreserved:true});
  await page.close();
 }
 await writeFile(`${output}/report.json`,JSON.stringify(results,null,2));
 console.log(JSON.stringify({passed:6,screenshots:8,directInvoice:true,readOnlyPreserved:true,enlargedTextAndNavigation:true}));
} finally {await browser.close();}
