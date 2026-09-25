import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5331';
const out = '.qa/personalization';
await mkdir(out,{recursive:true});
const report=[];
const key='zentra.workspace.preferences.v1';
for (const [engine,type] of [['edge',chromium],['webkit',webkit]]) {
  const browser=await type.launch({headless:true,...(engine==='edge'&&process.platform==='win32'?{channel:'msedge'}:{})});
  try {
    for (const [width,language,theme] of [[390,'fr','light'],[320,'de','dark'],[1440,'en','light'],[390,'it','dark']]) {
      const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce',hasTouch:width<800});
      page.setDefaultTimeout(12000);
      const errors=[]; page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
      await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=active&personalization=1&language=${language}&theme=${theme}`);
      const open=async()=>{
        if(width<1101)await page.locator('.mobile-navigation button').last().click();
        await page.locator('.personalize-shortcuts').click();
        await page.locator('#workspace-personalization').waitFor({state:'visible'});
      };
      await open();
      const editor=page.locator('#workspace-personalization'), choices=editor.locator('select');
      assert.equal(await choices.count(),4);
      const before=await page.evaluate(key=>localStorage.getItem(key),key);
      await choices.nth(0).selectOption('clients');
      await choices.nth(1).selectOption('automation');
      await choices.nth(2).selectOption('invoices');
      if(width<1101) {
        await editor.locator('.personalization-footer').scrollIntoViewIfNeeded();
        const controls=await editor.locator('.personalization-footer .button').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();const front=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {visible:r.y>=64&&r.bottom<innerHeight-100,tappable:front===node||node.contains(front)};}));
        assert.ok(controls.every(item=>item.visible&&item.tappable),'Save and Cancel remain above the dock and assistant');
      }
      assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),before,'Preview must not save');
      // Cancel restores both groups; choosing an occupied slot swaps it.
      await editor.locator('.personalization-footer .button--secondary').click();
      assert.equal(await choices.first().inputValue(),'dashboard');
      await choices.first().selectOption('projects');
      assert.equal(await choices.nth(1).inputValue(),'dashboard');
      await choices.first().selectOption('clients');
      await choices.nth(1).selectOption('automation');
      await choices.nth(2).selectOption('invoices');
      await editor.locator('.personalization-footer .button--primary').click();
      assert.equal(await page.locator('.mobile-navigation button').count(),5);
      assert.deepEqual(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).shortcuts,key),['clients','automation','invoices','agenda']);
      await editor.locator('.personalization-switch button').last().click();
      await choices.nth(0).selectOption('agenda');
      await choices.nth(1).selectOption('invoice');
      await editor.locator('.personalization-footer .button--primary').click();
      await page.reload(); await open();
      assert.equal(await choices.first().inputValue(),'clients','Reload preserves navigation');
      await editor.locator('.personalization-switch button').last().click();
      assert.equal(await choices.first().inputValue(),'agenda','Reload preserves home actions');
      await editor.locator('.personalization-switch button').first().click();
      await editor.evaluate(node=>node.scrollIntoView({block:'start'}));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Viewport overflow');
      if(process.env.ZENTRA_CAPTURE!=='0')await page.screenshot({path:`${out}/${engine}-${width}-${language}-${theme}-settings.png`,fullPage:true});
      if(width<1101){
        const sizes=await page.locator('.mobile-navigation button').evaluateAll(nodes=>nodes.map(node=>({w:node.getBoundingClientRect().width,h:node.getBoundingClientRect().height})));
        assert.ok(sizes.every(s=>s.w>=44&&s.h>=44),'Touch targets remain at least 44px');
        await page.locator('.mobile-navigation button').nth(0).click();
        assert.equal(await page.locator('.desktop-app').getAttribute('data-view'),'clients');
        await page.locator('.mobile-navigation button').nth(2).click();
        assert.equal(await page.locator('.desktop-app').getAttribute('data-view'),'invoices');
        await page.locator('.mobile-navigation button').last().click();
      }
      await page.locator('.sidebar nav button').first().click();
      const actions=page.locator('[data-personalized-actions]');
      await actions.waitFor({state:'visible'});
      assert.equal(await actions.locator('button').count(),4,'Home actions appear on phone and desktop');
      await actions.scrollIntoViewIfNeeded();
      if(process.env.ZENTRA_CAPTURE!=='0')await page.screenshot({path:`${out}/${engine}-${width}-${language}-${theme}-home.png`});
      await actions.locator('button').first().click();
      assert.equal(await page.locator('.desktop-app').getAttribute('data-view'),'agenda');
      await open();
      await editor.locator('.personalization-reset').click();
      await editor.locator('.personalization-footer .button--primary').click();
      assert.deepEqual(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).shortcuts,key),['dashboard','projects','quotes','agenda']);
      if(width===390&&language==='fr') {
        await page.evaluate(()=>window.__personalizationSync({enabled:true,organizationId:'automation-qa',revision:1,pending:false,conflict:false},'',true));
        await page.waitForFunction(()=>document.querySelector('.company-sync-indicator')?.dataset.syncState==='current');
        await page.context().setOffline(true);
        await page.waitForFunction(()=>document.querySelector('.company-sync-indicator')?.dataset.syncState==='offline');
        await page.context().setOffline(false);
        await page.evaluate(()=>window.__personalizationSync({enabled:true,organizationId:'automation-qa',revision:1,pending:true,conflict:true}));
        await page.waitForFunction(()=>document.querySelector('.company-sync-indicator')?.dataset.syncState==='attention');
        await page.locator('.company-sync-indicator').click();
        await page.locator('[data-settings-id="account"][open]').waitFor();
        await page.locator('.mobile-navigation button').first().click();
        await page.locator('.automation-brief__day li button').first().click();
        assert.equal(await page.locator('.desktop-app').getAttribute('data-view'),'automation');
      }
      assert.deepEqual(errors,[]);
      report.push({engine,width,language,theme,persisted:true,cancel:true,defaults:true,touch:true,passed:true});
      await page.close();
    }
  } finally {await browser.close();await writeFile(`${out}/results.json`,JSON.stringify(report,null,2));}
}
console.log(JSON.stringify(report));
