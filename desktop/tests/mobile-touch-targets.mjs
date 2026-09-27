import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const out='.impeccable/review/touch-targets';await mkdir(out,{recursive:true});
const results=[];
for(const config of [
 {engine:'webkit',width:320,theme:'light',lang:'de'},
 {engine:'webkit',width:390,theme:'dark',lang:'fr'},
 {engine:'edge',width:768,theme:'light',lang:'it'},
 {engine:'edge',width:1440,theme:'dark',lang:'en'},
]){
 const {engine,width,theme,lang}=config;
 const browser=await(engine==='edge'?chromium:webkit).launch(engine==='edge'?{channel:'msedge'}:{});
 const page=await browser.newPage({viewport:{width,height:900},hasTouch:true,reducedMotion:'reduce'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const dimensions=[];
 try{
  await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
  await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=active&personalization=1&language=${lang}&theme=${theme}`);
  await page.locator('.desktop-app').waitFor();
  const tr=source=>page.evaluate(async source=>(await import('/src/language.ts')).t(source),source);
  const later=page.getByRole('button',{name:await tr('Découvrir plus tard'),exact:true});if(await later.isVisible())await later.click();
  const check=async(locator,label)=>{const b=await locator.boundingBox();assert.ok(b,`${label} visible`);if(width<=860)assert.ok(b.width>=43.9&&b.height>=43.9,`${label}: ${b.width}x${b.height}`);dimensions.push({label,width:b.width,height:b.height});return b;};
  const edgeTap=async(locator,label)=>{const b=await check(locator,label);await page.touchscreen.tap(b.x+3,b.y+b.height/2);};
  if(width<=860){
   await edgeTap(page.locator('.menu-button'),'open-menu');await page.locator('#primary-navigation[aria-modal=true]').waitFor();
   await edgeTap(page.locator('.sidebar__close'),'close-menu');await page.locator('#primary-navigation[aria-modal=true]').waitFor({state:'detached'});
  }
  for(const view of ['invoices','agenda','automation']){
   if(view==='automation'){
    if(width<=860)await page.locator('.menu-button').click();
    await page.locator('.sidebar__nav button').filter({has:page.locator('span').filter({hasText:/Zentra Automation/})}).click();
   }else await page.evaluate(view=>window.dispatchEvent(new CustomEvent('zentra-automation-navigate',{detail:view==='agenda'?'planning':view})),view);
   await page.locator(`.desktop-app[data-view=${view}]`).waitFor();
   await page.evaluate(()=>window.scrollTo(0,0));
   if(view==='invoices'){
    const help=page.locator('.screen-help-launcher');
    if(width<=860){
     const a=await help.boundingBox(),b=await page.locator('.creation-action > .button').boundingBox();
     assert.ok(a&&b);assert.equal(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y,false,'help target must not cover invoice creation');
    }
    await edgeTap(help,'screen-help');
    await page.locator('.screen-help[role=dialog],.screen-help [role=dialog],.modal.screen-help').waitFor();
    await page.waitForFunction(()=>document.querySelector('.modal.screen-help')?.contains(document.activeElement));
    await page.keyboard.press('Escape');await page.locator('.modal.screen-help').waitFor({state:'hidden'});
   }else if(view==='agenda'){
    const controls=page.locator('.agenda-month-controls');const before=await controls.locator('strong').innerText();
    await edgeTap(controls.locator('.button--icon').first(),'previous-period');
    await page.waitForFunction(before=>document.querySelector('.agenda-month-controls strong')?.textContent!==before,before);
    await check(controls.locator('.button--icon').last(),'next-period');
   }else{
    const filters=page.locator('.automation-journal__filters button');await filters.first().waitFor();
    await filters.nth(1).click();await edgeTap(filters.first(),'all-activity');
    assert.equal(await filters.first().getAttribute('aria-pressed'),'true');
   }
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   await page.screenshot({path:`${out}/${engine}-${width}-${theme}-${lang}-${view}.png`,fullPage:true});
  }
  assert.deepEqual(errors,[]);results.push({...config,dimensions,edgeTap:true,overflow:false,errors});
 }finally{await browser.close();}
}
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
