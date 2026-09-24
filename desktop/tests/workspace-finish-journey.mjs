import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5331';
const engine=process.env.ZENTRA_QA_BROWSER||'edge';
const output=`.qa/automation-arrival/screens-${engine}`;await mkdir(output,{recursive:true});
const browser=await(engine==='webkit'?webkit.launch():chromium.launch({channel:'msedge'}));
const report=[];
const cases=engine==='webkit'?[{width:390,height:844,theme:'dark',language:'fr'}]:[
  {width:1440,height:900,theme:'light',language:'fr'}, {width:1440,height:900,theme:'dark',language:'fr'},
  {width:390,height:844,theme:'light',language:'fr'}, {width:390,height:844,theme:'dark',language:'it'},
  {width:320,height:568,theme:'light',language:'de'}, {width:1024,height:800,theme:'dark',language:'en'},
];
try{for(const config of cases){
  const {width,height,theme,language}=config;const page=await browser.newPage({viewport:{width,height},hasTouch:width<900,reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=1&payroll=1&bank=1&agendaGuided=1&theme=${theme}&language=${language}`);
  await page.locator('.desktop-app').waitFor();
  const stages=[];const prefix=`${width}-${theme}-${language}`;
  async function inspect(name){
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('.deferred-view, .page-content .settings-cloud-status:has(.spin), .bank-loading')).every(el=>!el.getClientRects().length));
    await page.evaluate(()=>{window.scrollTo(0,0);document.querySelector('.app-main')?.scrollTo(0,0);});
    await page.waitForTimeout(250);
    const measurements=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,heading:document.querySelector('.page-header h1')?.textContent,dialogs:document.querySelectorAll('[role="dialog"]').length}));
    stages.push({name,...measurements});
    await page.screenshot({path:`${output}/${prefix}-${name}.png`});
  }
  await page.locator(width>860?'.sidebar__search':'.navigation-launcher').click();await page.locator('.navigation-palette').waitFor();
  const destinations=await page.locator('.navigation-palette__results strong').allTextContents();await page.keyboard.press('Escape');
  for(const destination of destinations){
    await page.locator(width>860?'.sidebar__search':'.navigation-launcher').click();await page.locator('.navigation-palette__results button').filter({has:page.getByText(destination,{exact:true})}).click();
    const view=await page.locator('.desktop-app').getAttribute('data-view');await inspect(view);
    if(view==='automation'){
      for(const target of ['work','settings','tools']){await page.evaluate(target=>window.dispatchEvent(new CustomEvent('zentra-automation-hub',{detail:target})),target);await inspect(`automation-${target}`);}
    }
    if(view==='settings'){
      const ids=await page.locator('[data-settings-link]').evaluateAll(els=>els.map(el=>el.dataset.settingsLink));
      for(const id of ids){
        const back=page.locator('.settings-browser__back');if(width<=1100&&await back.isVisible())await back.click();
        await page.locator(`[data-settings-link="${id}"]`).click();
        await page.locator(`[data-settings-id="${id}"][open]`).waitFor();await inspect(`settings-${id}`);
      }
    }
  }
  report.push({config,stages,errors});console.log(JSON.stringify({config,stages:stages.length,overflows:stages.filter(s=>s.overflow>1),errors}));await page.close();
}}catch(e){report.push({failed:String(e.stack)});process.exitCode=1;}finally{await browser.close();await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));}
if(report.some(r=>r.errors?.length||r.stages?.some(s=>s.overflow>1)))process.exitCode=1;
