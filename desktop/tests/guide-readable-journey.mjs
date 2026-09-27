import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const pw = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5367';
const germanOnly = process.env.ZENTRA_QA_GUIDE_GERMAN_ONLY === 'true';
const output = germanOnly ? '.qa/guide-readable-german-final' : '.qa/guide-readable';
await mkdir(output, { recursive: true });
const configurations = [
  { language:'de', width:320, height:568, scale:200, theme:'dark' },
  { language:'fr', width:390, height:844, scale:200, theme:'light' },
  { language:'it', width:320, height:568, scale:200, theme:'light' },
  { language:'en', width:1440, height:900, scale:200, theme:'dark' },
  { language:'fr', width:320, height:568, scale:100, theme:'light' },
  { language:'de', width:844, height:390, scale:100, theme:'dark' },
  { language:'en', width:1440, height:900, scale:100, theme:'light' },
];
const report = [];
for (const engine of ['chromium','webkit']) {
  const browser = await pw[engine].launch({ headless:true, ...(engine === 'chromium' ? { channel:'msedge' } : {}) });
  try {
    for (const config of configurations.filter(config=>!germanOnly||(config.language==='de'&&config.scale===200))) {
      const { language,width,height,scale,theme } = config;
      const page = await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});
      page.setDefaultTimeout(12000);
      const errors=[]; page.on('pageerror',error=>errors.push(error.message));
      const name=`${engine}-${language}-${width}-${height}-${scale}`;
      const card=page.locator('.guided-tour__card');
      let checked=0;
      try {
        await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
        await page.addInitScript(({language,scale,theme})=>{
          localStorage.setItem('zentra.interface.language.v1',language);
          localStorage.setItem('zentra.text-size.v1',String(scale));
          localStorage.setItem('zentra.appearance.v1',theme);
        },config);
        await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1`);
        await card.waitFor();
        await page.waitForFunction(async language=>{const s=(await import('/src/language.ts')).getLanguageState();return s.ready&&s.language===language;},language);
        async function check(index, first=false) {
          await page.waitForFunction(index=>document.querySelector('.guided-tour__progress')?.getAttribute('aria-valuenow')===String(index+1),index);
          await page.waitForFunction(()=>document.querySelector('.guided-tour__card')?.scrollTop===0);
          const metrics=await card.evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,lessonHeight:el.querySelector('.guided-tour__lesson').clientHeight}));
          assert.ok(metrics.lessonHeight>=80,`Explanation remains readable: ${JSON.stringify(metrics)}`);
          assert.ok(metrics.scrollWidth<=metrics.width+1,'No horizontal clipping in the guide');
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Viewport fits');
          assert.equal(await page.locator('.app-main').evaluate(el=>el.inert),true);
          if(first) await page.screenshot({path:`${output}/${name}-intro.png`,animations:'disabled'});
          const paragraph=card.locator('.guided-tour__text');
          await paragraph.scrollIntoViewIfNeeded();
          const p=await paragraph.boundingBox(),box=await card.boundingBox();
          assert.ok(p&&box&&p.height>0&&p.y<box.y+box.height&&p.y+p.height>box.y,'Explanation is reachable');
          await card.locator('.guided-tour__tip').scrollIntoViewIfNeeded();
          const next=card.locator('footer .button').last();
          await next.scrollIntoViewIfNeeded();
          const b=await next.boundingBox();
          assert.ok(b&&b.y>=0&&b.y+b.height<=height+1&&b.height>=43.5,`Next action stays reachable: ${JSON.stringify(b)}`);
          if(first) await page.screenshot({path:`${output}/${name}-actions.png`,animations:'disabled'});
          if(scale>100||height<500) assert.ok(await card.evaluate(el=>el.scrollTop)>0,'Whole guide scrolls instead of hiding the lesson');
          checked++;
        }
        for(let index=0;index<3;index++) {
          await check(index,index===0);
          await card.locator('footer .button').last().click();
        }
        await card.waitFor({state:'hidden'});
        assert.equal(await page.locator('.app-main').evaluate(el=>el.inert),false);
        const desktopOpen=page.locator('.tour-launcher');
        const menu=page.locator('.menu-button');
        const compact=!(await desktopOpen.isVisible());
        const open=compact?menu:desktopOpen;
        async function openGuide(){
          if(compact){await menu.click();await page.locator('.sidebar__guide').click();}
          else await desktopOpen.click();
        }
        await openGuide();
        const select=card.locator('select');
        const count=await select.locator('option').count(); assert.ok(count>=16);
        for(let index=0;index<count;index++) {await select.selectOption(String(index));await check(index);}
        await select.selectOption('4');
        await card.locator('footer .button').first().click();
        await openGuide(); assert.equal(await card.locator('select').inputValue(),'4');
        await page.keyboard.press('Escape'); await card.waitFor({state:'hidden'});
        assert.equal(await page.locator('.app-main').evaluate(el=>el.inert),false);
        assert.equal(await open.evaluate(el=>el===document.activeElement),true);
        assert.deepEqual(errors,[]);
        report.push({engine,...config,checkedSteps:checked,resumeAndFocus:true,passed:true});
      } catch(error) {
        await page.screenshot({path:`${output}/${name}-failure.png`});
        report.push({engine,...config,checkedSteps:checked,error:String(error.stack)});
      } finally {await page.close();await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));}
    }
  } finally {await browser.close();}
}
console.log(JSON.stringify(report));
if(report.some(row=>!row.passed))process.exitCode=1;
