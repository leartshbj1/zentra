import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const out=fileURLToPath(new URL('../.qa/onboarding-account-header/',import.meta.url));
await mkdir(out,{recursive:true});
const results=[];
for(const engine of [chromium,webkit]){
 const browser=await engine.launch({headless:true,...(engine===chromium&&process.platform==='win32'?{channel:'msedge'}:{})});
 try{for(const config of [
  {width:320,height:640,language:'fr',theme:'light',insets:false},
  {width:320,height:844,language:'de',theme:'dark',insets:true},
  {width:390,height:844,language:'it',theme:'light',insets:true},
  {width:1440,height:900,language:'en',theme:'dark',insets:false},
 ]){
  const page=await browser.newPage({viewport:{width:config.width,height:config.height},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5367'}/tests/onboarding-preview.html?language=${config.language}&theme=${config.theme}`);
  await page.locator('.zentra-arrival__start').click();
  await page.locator('.first-run--account').waitFor();
  if(config.insets)await page.evaluate(()=>{for(const [key,value] of Object.entries({top:59,bottom:34,left:20,right:20}))document.documentElement.style.setProperty(`--safe-${key}`,`${value}px`);});
  await page.waitForTimeout(320);
  const layout=await page.evaluate(()=>{
   const box=selector=>{const b=document.querySelector(selector).getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height};};
   return {brand:box('.first-run__brand .zentra-brand-identity'),preferences:box('.first-run__preferences'),
    selectors:[...document.querySelectorAll('.first-run__preferences select')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,fontSize:parseFloat(getComputedStyle(e).fontSize)};}),
    width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,
    theme:document.documentElement.dataset.appTheme,meta:document.querySelector('meta[name="theme-color"]').content,
    panelBackground:getComputedStyle(document.querySelector('.cloud-account-panel')).backgroundColor};
  });
  const b=layout.brand;
  for(const p of layout.selectors)assert.ok(b.right<=p.left+1||p.right<=b.left+1||b.bottom<=p.top+1||p.bottom<=b.top+1,`Brand overlaps preferences: ${JSON.stringify({config,layout})}`);
  assert.ok(layout.scrollWidth<=layout.width+1,'No horizontal page overflow');
  assert.equal(layout.theme,config.theme,'Intro does not overwrite chosen appearance');
  assert.equal(layout.meta,config.theme==='dark'?'#141416':'#f5f5f7','Browser chrome restored after intro');
  assert.equal(layout.panelBackground,'rgba(0, 0, 0, 0)','Account control has no mismatched dark rectangle');
  for(const select of layout.selectors){assert.ok(select.height>=44);if(config.width<700)assert.ok(select.fontSize>=16);}
  if(config.insets)assert.ok(b.top>=59,'Logo stays below native top inset');
  await page.screenshot({path:`${out}/${engine.name()}-${config.width}-${config.language}.png`,fullPage:true});
  // The real recovery action remains reachable after the header moves to two rows.
  const create=page.locator('.first-run__actions .button--primary');
  assert.equal((await create.innerText()).trim(),{fr:'Créer une entreprise',de:'Unternehmen erstellen',it:'Crea un’azienda',en:'Create a company'}[config.language]);
  await create.click();await page.locator('.first-run__stage--identity').waitFor();
  assert.deepEqual(errors,[]);
  results.push({...config,engine:engine.name(),layout,createCompanyReachable:true});await page.close();
 }}finally{await browser.close();}
}
await writeFile(`${out}/report.json`,JSON.stringify({passed:true,cases:results},null,2));
console.log(JSON.stringify({passed:true,cases:results.length}));
