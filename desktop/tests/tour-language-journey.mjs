// Visits the production guide in the application shell. Customer data is synthetic.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const { [engine]: driver } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const output = `.qa/tour-language-${engine}${process.env.ZENTRA_QA_LANGUAGES ? "-" + process.env.ZENTRA_QA_LANGUAGES.replaceAll(",", "-") : ""}`, reports = [];
await mkdir(output, { recursive: true });
const languages = (process.env.ZENTRA_QA_LANGUAGES || 'fr,de,it,en').split(',');
assert.ok(languages.length && languages.every(value => ['fr','de','it','en'].includes(value)));
const headings = { fr: 'Bienvenue dans votre espace', de: 'Willkommen in Ihrem Arbeitsbereich', it: 'Benvenuto nel tuo spazio', en: 'Welcome to your workspace' };
async function languageChange(page, language) {
  await page.evaluate(value => { const key='zentra.interface.language.v1'; localStorage.setItem(key,value); window.dispatchEvent(new StorageEvent('storage',{key,newValue:value})); }, language);
  await page.waitForFunction(value => document.documentElement.lang===`${value}-CH`, language);
}
async function geometry(page, label) {
  const issues = await page.locator('.guided-tour__card').evaluate(card => {
    const failures = [], rect = card.getBoundingClientRect();
    if(rect.left<0||rect.right>innerWidth+1||rect.top<0||rect.bottom>innerHeight+1)failures.push('dialog outside viewport');
    if(card.scrollWidth>card.clientWidth+1)failures.push('horizontal dialog overflow');
    for(const el of card.querySelectorAll('strong, button, label, li, .guided-tour__text, .guided-tour__tip, .guided-tour__scroll-hint')) {
      if(el.getClientRects().length&&el.scrollWidth>el.clientWidth+2)failures.push(`clipped: ${el.textContent}`);
    }
    const select=card.querySelector('select'), style=getComputedStyle(select), context=document.createElement('canvas').getContext('2d');
    context.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    if(context.measureText(select.selectedOptions[0].textContent).width>select.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-20)failures.push(`selected topic clipped: ${select.selectedOptions[0].textContent}`);
    const lesson=card.querySelector('.guided-tour__lesson');
    if(lesson.clientHeight<72)failures.push(`reading area too short: ${lesson.clientHeight}`);
    for(const button of card.querySelectorAll('button')) { const r=button.getBoundingClientRect();if(r.top<rect.top||r.bottom>rect.bottom+1)failures.push(`unreachable button: ${button.textContent}`); }
    return failures;
  });
  assert.deepEqual(issues,[],label);
}
try {
  for (const [width,height] of [[320,568],[390,844],[650,360],[844,390],[1440,1000]]) for(const language of languages) {
    const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(value=>localStorage.setItem('zentra.interface.language.v1',value),language);
    try {
      await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271'}/tests/mobile-harness.html?browsing=1&design=1`);
      const guide=page.locator('.guided-tour__card'), selector=guide.locator('select');
      await guide.locator('#guided-tour-title').getByText(headings[language],{exact:true}).waitFor();
      assert.equal(await selector.locator('option').count(),3);
      await geometry(page,`${language} ${width} welcome`);
      for(let i=0;i<3;i++) { await selector.selectOption(String(i)); await geometry(page,`${language} automatic ${i}`); }
      await guide.locator('footer button').last().click();await guide.waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>localStorage.getItem('elyko-guided-tour-v3')),'completed');
      await page.locator('.topbar .tour-launcher').focus();await page.locator('.topbar .tour-launcher').press('Enter');await guide.waitFor();
      assert.equal(await selector.locator('option').count(),16);
      const expected=await page.evaluate(async()=>{
        const source=(name)=>performance.getEntriesByType('resource').map(e=>e.name).findLast(url=>new URL(url).pathname===`/src/${name}`)||`/src/${name}`;
        const {guidedTourSteps}=await import(source('GuidedTour.tsx'));const {guideLessons}=await import(source('guideLessons.ts'));const {t}=await import(source('language.ts'));
        return guidedTourSteps.map(step=>({id:step.id,title:t(step.title),text:t(step.text),actions:guideLessons[step.id].actions.map(action=>t(action)),tip:t(guideLessons[step.id].tip)}));
      });
      for(let i=0;i<16;i++) {
        await selector.selectOption(String(i));
        await guide.locator('#guided-tour-title').getByText(expected[i].title,{exact:true}).waitFor();
        assert.equal(await guide.locator('#guided-tour-description').innerText(),expected[i].text);
        assert.deepEqual(await guide.locator('.guided-tour__actions li').allTextContents(),expected[i].actions);
        assert.ok((await guide.locator('.guided-tour__tip').innerText()).includes(expected[i].tip));
        assert.equal(await guide.locator('[role=progressbar]').getAttribute('aria-valuenow'),String(i+1));
        await geometry(page,`${language} ${width} complete ${i}`);
        const lesson=guide.locator('.guided-tour__lesson');await lesson.evaluate(el=>el.scrollTop=el.scrollHeight);
        await page.waitForFunction(()=>getComputedStyle(document.querySelector('.guided-tour__scroll-hint')).visibility==='hidden');
        if(i===6) {
          const alternate=language==='de'?'en':'de';await page.evaluate(()=>window.qaGuideLesson=document.querySelector('.guided-tour__lesson'));
          await languageChange(page,alternate);assert.equal(await selector.inputValue(),'6');assert.equal(await page.evaluate(()=>window.qaGuideLesson===document.querySelector('.guided-tour__lesson')),true);
          assert.equal(await page.evaluate(()=>localStorage.getItem('zentra-guide-progress-v1')),'recurring-documents');await geometry(page,'language switch');
          await languageChange(page,language);await lesson.evaluate(el=>el.scrollTop=0);await page.screenshot({path:`${output}/${language}-${width}.png`});
        }
      }
      // Closing and reopening restores the same stable topic in every language.
      await selector.selectOption('8');await guide.locator('header button').click();await guide.waitFor({state:'hidden'});
      await page.locator('.topbar .tour-launcher').focus();await page.locator('.topbar .tour-launcher').press('Enter');await guide.waitFor();assert.equal(await selector.inputValue(),'8');
      await guide.locator('header button').focus();await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(()=>document.querySelector('.guided-tour__card').contains(document.activeElement)),true);
      await page.keyboard.press('ArrowLeft');assert.equal(await selector.inputValue(),'7');
      await selector.selectOption('15');await guide.locator('footer button').last().click();await guide.waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>localStorage.getItem('zentra-guide-progress-v1')),null);
      assert.equal(await page.locator('.topbar .tour-launcher').evaluate(el=>el===document.activeElement),true);
      assert.deepEqual(errors,[]);
      reports.push({language,width,height,topics:17,automatic:true,complete:true,progressRetained:true,focusRestored:true,noClipping:true});console.log(`${engine} ${language} ${width}: passed`);
    } catch(error) { await page.screenshot({path:`${output}/failure-${language}-${width}.png`});throw error; } finally { await page.close(); }
  }
} finally { await writeFile(`${output}/report.json`,JSON.stringify(reports,null,2));await browser.close(); }
