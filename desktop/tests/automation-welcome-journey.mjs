import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5331';
const output = '.qa/automation-arrival';
await mkdir(output, { recursive: true });
const reports = [];
const browser = await (process.env.ZENTRA_QA_BROWSER === 'webkit' ? webkit.launch() : chromium.launch({channel:'msedge'}));
const welcome = page => page.locator('.automation-welcome');
async function open(page, query='automation=1') {
  await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automationWelcome=1&${query}`);
  await page.locator('.desktop-app').waitFor();
}
async function update(page, patch) {
  await page.evaluate(patch => {
    Object.assign(window.__automationWelcomeQa.state, patch);
    window.__automationWelcomeQa.refresh();
  }, patch);
}
try {
  for (const viewport of [{width:1440,height:900}, {width:390,height:844}, {width:320,height:568}, {width:844,height:390}]) {
    const page = await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await open(page);await welcome(page).waitFor();
    await page.waitForFunction(()=>document.querySelector('.zentra-arrival')?.getAttribute('data-phase')==='quote');
    assert.equal(await page.locator('.zentra-arrival__quote blockquote').innerText(),'Place à ce qui compte.');
    await page.screenshot({path:`${output}/welcome-quote-${viewport.width}.png`});
    if (viewport.width===1440 || viewport.width===390) {
      await page.waitForFunction(()=>document.querySelector('.zentra-arrival')?.getAttribute('data-phase')==='light');
      await page.waitForTimeout(850);await page.screenshot({path:`${output}/welcome-light-${viewport.width}.png`});
      await page.waitForFunction(()=>document.querySelector('.zentra-arrival')?.getAttribute('data-phase')==='ready');
    } else await page.getByRole('button',{name:'Passer l’introduction',exact:true}).click();
    await page.waitForTimeout(700);await page.screenshot({path:`${output}/welcome-ready-${viewport.width}.png`});
    const box=await page.getByRole('button',{name:'Découvrir Automation',exact:true}).boundingBox();
    assert.ok(box.x>=0&&box.x+box.width<=viewport.width+1&&box.y>=0&&box.y+box.height<=viewport.height+1,'Primary action remains reachable');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.getByRole('button',{name:'Découvrir Automation',exact:true}).click();
    await page.locator('.desktop-app[data-view="automation"]').waitFor();
    await page.reload();await page.waitForTimeout(1300);assert.equal(await welcome(page).count(),0,'Already welcomed company does not interrupt again');
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('zentra-automation-hub',{detail:'settings'})));
    await page.getByRole('button',{name:'Revoir l’introduction',exact:true}).click();
    await welcome(page).waitFor();await page.keyboard.press('Escape');await welcome(page).waitFor({state:'detached'});
    assert.deepEqual(errors,[]);reports.push({viewport,sequence:true,skipReplay:true,onceOnly:true,reachable:true});await page.close();
  }
  const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await open(page,'automation=inactive');await page.waitForTimeout(1300);assert.equal(await welcome(page).count(),0);
  // An ordinary dialog must finish before the entitlement welcome is shown.
  await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
  await update(page,{active:true});await page.waitForTimeout(1300);assert.equal(await welcome(page).count(),0);
  await page.keyboard.press('Escape');await welcome(page).waitFor();
  assert.equal(await page.locator('.zentra-arrival').getAttribute('data-phase'),'ready');
  assert.equal(await page.locator('.zentra-arrival__light').isVisible(),false);
  await update(page,{active:false});await welcome(page).waitFor({state:'detached'});
  await update(page,{active:true,organizationId:'wrong-company'});await page.waitForTimeout(1300);assert.equal(await welcome(page).count(),0);
  await update(page,{organizationId:'automation-qa'});await welcome(page).waitFor();
  await page.evaluate(()=>{window.__automationWelcomeQa.state.organizationId='second-company';window.__qaSetWelcomeAccount('second-company');});
  await welcome(page).waitFor();await page.getByRole('button',{name:'Découvrir Automation',exact:true}).click();
  assert.equal(await page.evaluate(()=>localStorage.getItem('zentra.automation.welcome.v1:second-company')),'seen');
  assert.equal(await page.evaluate(()=>localStorage.getItem('zentra.automation.welcome.v1:automation-qa')),null,'Another company was not marked by switching');
  reports.push({activation:true,dialogDeferred:true,revocation:true,companyIsolation:true,reducedMotion:true});await page.close();
  for(const language of ['fr','de','it','en']) {
    const page=await browser.newPage({viewport:{width:320,height:568},reducedMotion:'reduce'});
    await open(page,`automation=setup&language=${language}`);await welcome(page).waitFor();
    await page.locator('.zentra-arrival__start').click();await page.locator('.automation-settings__consent').waitFor();
    assert.equal(await page.locator('.automation-settings__consent input').isChecked(),false,'No consent granted by animation');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    reports.push({language,configurationRoute:true,consentPreserved:true});await page.close();
  }
} catch(error) {reports.push({failed:String(error.stack)});process.exitCode=1;}
finally {await browser.close();await writeFile(`${output}/welcome-${process.env.ZENTRA_QA_BROWSER||'edge'}.json`,JSON.stringify(reports,null,2));}
console.log(JSON.stringify(reports,null,2));
