import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5331';
const results = [];
await mkdir('.qa/runtime-speed', {recursive:true});
for (const [engine,type] of [['edge',chromium],['webkit',webkit]]) {
  const browser = await type.launch({headless:true,...(engine==='edge'&&process.platform==='win32'?{channel:'msedge'}:{})});
  try { for (const width of [390,1440]) {
    const page = await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
    const start=Date.now();
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&volume=1500&runtimePerformance=1&theme=${width===390?'dark':'light'}`);
    await page.locator('.timer-ribbon strong').waitFor();
    const openMs=Date.now()-start;
    await page.waitForTimeout(1200);
    await page.evaluate(()=>window.__runtimeCommits.splice(0));
    const ticks=[];
    for(let i=0;i<3;i++) {
      const previous=await page.locator('.timer-ribbon strong').innerText();
      await page.waitForFunction(previous=>document.querySelector('.timer-ribbon strong')?.textContent!==previous,previous);
      ticks.push(await page.locator('.timer-ribbon strong').innerText());
    }
    const commits=await page.evaluate(()=>window.__runtimeCommits.splice(0));
    if(width===390) await page.getByRole('button',{name:'Ouvrir la navigation',exact:true}).click();
    await page.locator('.sidebar__nav button').filter({hasText:'Ventes'}).click();
    await page.locator('.sales-tabs button').filter({hasText:'Factures'}).click();
    const search=page.locator('.topbar input[type="search"], .search-field input, input[placeholder*="Rechercher"]').first();
    await search.fill('F-2026-1500');
    await page.getByText('F-2026-1500',{exact:true}).first().waitFor();
    assert.equal(await search.inputValue(),'F-2026-1500');
    const afterTick=await page.locator('.timer-ribbon strong').innerText();
    await page.waitForFunction(previous=>document.querySelector('.timer-ribbon strong')?.textContent!==previous,afterTick);
    assert.equal(await search.inputValue(),'F-2026-1500');
    assert.equal(await search.evaluate(element=>document.activeElement===element),true);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
    assert.equal(overflow,false);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:`.qa/runtime-speed/${process.env.ZENTRA_PERF_PHASE||'after'}-${engine}-${width}.png`});
    results.push({engine,width,invoices:1500,openMs,timerTicks:ticks,timerCommitDurations:commits.map(c=>c.duration),searchAndFocusPreserved:true,overflow,errors});
    await page.close();
  }}finally{await browser.close();}
}
await writeFile(`.qa/runtime-speed/ui-${process.env.ZENTRA_PERF_PHASE||'after'}.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
