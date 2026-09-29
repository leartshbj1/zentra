import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5377';
const before = process.argv.includes('--before');
const out = new URL('../.qa/accounting-readable/', import.meta.url);
await mkdir(out, { recursive: true });
const results = [];
for (const [engine,width,height,scale,theme,language] of [
  ['edge',1440,1000,100,'light','fr'], ['webkit',390,844,100,'light','it'],
  ['webkit',390,1000,200,'dark','fr'], ['webkit',320,1000,200,'light','de'],
  ['edge',844,390,200,'dark','en'],
]) {
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? {channel:'msedge'} : {}) });
  try {
    const page = await browser.newPage({ viewport:{width,height}, reducedMotion:'reduce' });
    const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1`);
    await page.getByRole('button',{name:'Découvrir plus tard',exact:true}).click();
    await page.evaluate(async ({scale,theme,language})=>{
      const { desktopApi:api } = await import('/src/bridge.ts');
      const continuity=api.getAccountingContinuity;
      api.getAccountingContinuity=async()=>({...await continuity(),enabled:true,mappingReady:true,journalEntryCount:3});
      const income=api.getIncomeStatement;
      api.getIncomeStatement=async(...args)=>({...await income(...args),revenueCents:123456,expenseCents:4567,profitCents:118889});
      (await import('/src/textSize.ts')).setTextSize(scale);
      (await import('/src/appearance.ts')).setAppearance(theme);
      await (await import('/src/language.ts')).setAppLanguage(language);
      window.dispatchEvent(new CustomEvent('zentra-automation-navigate',{detail:'accounting'}));
    },{scale,theme,language});
    await page.waitForFunction(()=>document.querySelector('.finance-overview__figures')?.getAttribute('aria-busy')==='false');
    const metrics=await page.evaluate(()=>{
      const rect=selector=>{const element=document.querySelector(selector);const bounds=element.getBoundingClientRect();const style=getComputedStyle(element);return {width:bounds.width,height:bounds.height,x:bounds.x,right:bounds.right,font:style.fontSize,lineHeight:style.lineHeight,text:element.textContent,hyphens:style.hyphens};};
      return {title:rect('.page-header h1'),intro:rect('.finance-overview__intro'),summary:rect('.finance-overview__intro summary'),button:rect('.finance-overview__intro > button'),overflow:document.documentElement.scrollWidth>innerWidth+1};
    });
    const name=`${engine}-${width}-${language}-${scale}`;
    await page.screenshot({path:fileURLToPath(new URL(`${before?'before':'after'}-${name}.png`,out))});
    if(!before){
      assert.equal(metrics.overflow,false,name);
      assert.ok(metrics.summary.width>=Math.min(150,metrics.intro.width-2),`${name}: readable summary width ${metrics.summary.width}`);
      const lineHeight=Number.parseFloat(metrics.summary.lineHeight)||Number.parseFloat(metrics.summary.font)*1.5;
      assert.ok(metrics.summary.height<=Math.max(44,lineHeight*3)+1,`${name}: excessive word breaking`);
      assert.ok(metrics.button.right<=width+1,`${name}: clipped configuration action`);
      assert.ok(metrics.button.height>=44 || width>860,`${name}: touch target`);
      const disclosure=page.locator('.finance-overview__intro details');
      await disclosure.locator('summary').click();assert.equal(await disclosure.getAttribute('open'),'');
      await disclosure.locator('summary').click();assert.equal(await disclosure.getAttribute('open'),null);
      await page.locator('.finance-overview__intro > button').click();
      await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
      assert.deepEqual(errors,[],name);
    }
    results.push({engine,width,height,scale,theme,language,metrics,errors});
  } finally {await browser.close();}
}
await writeFile(new URL(`${before?'before':'after'}.json`,out),JSON.stringify({synthetic:true,physicalDevice:false,results},null,2));
console.log(`${results.length} accounting layout configurations ${before?'observed':'passed'}`);
