import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5331';
const output='.qa/onboarding-arrival';await mkdir(output,{recursive:true});
const results=[];const browser=await chromium.launch({channel:'msedge'});
try {
 for(const width of [1293,390]) {
  const page=await browser.newPage({viewport:{width,height:width===1293?911:844},reducedMotion:'no-preference'});const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.__rafTimes=[];const original=window.requestAnimationFrame;window.requestAnimationFrame=callback=>original.call(window,stamp=>{window.__rafTimes.push(stamp);callback(stamp);});});
  await page.goto(`${origin}/tests/onboarding-preview.html`);
  const intro=page.locator('.zentra-arrival');
  await page.waitForFunction(()=>document.querySelector('.zentra-arrival')?.getAttribute('data-phase')==='quote');
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.zentra-arrival__quote blockquote')),true,'Entry focuses exposed quotation');
  assert.ok(!(await page.locator('.zentra-arrival').ariaSnapshot()).includes('heading'),'Hidden heading stays outside accessibility tree');
  await page.screenshot({path:`${output}/intro-quote-${width}.png`,fullPage:true});
  await page.waitForFunction(()=>document.querySelector('.zentra-arrival')?.getAttribute('data-phase')==='light');
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.zentra-arrival__skip')),true,'Light phase keeps focus on skip');
  await page.waitForTimeout(900);await page.screenshot({path:`${output}/intro-light-${width}.png`,fullPage:true});
  await page.waitForFunction(()=>document.querySelector('.zentra-arrival')?.getAttribute('data-phase')==='logo');
  await page.waitForTimeout(600);await page.screenshot({path:`${output}/intro-logo-${width}.png`,fullPage:true});
  await page.waitForFunction(()=>document.querySelector('.zentra-arrival')?.getAttribute('data-phase')==='ready');
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.zentra-arrival__start')),true,'Natural completion focuses visible start');
  await page.waitForTimeout(1100);await page.screenshot({path:`${output}/intro-ready-${width}.png`,fullPage:true});
  const frames=await page.evaluate(()=>window.__rafTimes);await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>window.__rafTimes.length),frames.length,'RAF stops at rest');
  assert.equal(await page.evaluate(()=>localStorage.getItem('zentra.onboarding.intro.v1')),'seen');
  await page.locator('.zentra-arrival__replay').click();assert.equal(await intro.getAttribute('data-phase'),'quote');assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.zentra-arrival__quote blockquote')),true,'Replay retains focus');
  await page.getByRole('button',{name:'Passer l’introduction',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await intro.getAttribute('data-phase'),'ready');
  await page.locator('.zentra-arrival__start').click();await page.locator('.first-run--account').waitFor();
  await page.waitForTimeout(320);await page.screenshot({path:`${output}/account-ready-${width}.png`,fullPage:true});
  const connectionBox=await page.locator('.first-run-connect').boundingBox();assert.ok(connectionBox.height<=64,'Connection label stays on a single line');assert.ok(connectionBox.width>=Math.min(490,width-48)-2,'Connection uses the full column');
  await page.getByRole('button',{name:'Se connecter',exact:true}).click();await page.getByText('TEST-1234',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.onboardingFixture.calls.slice(0,2)),['start-link','open-link']);
  await page.locator('.first-run__actions .button--ghost').click();assert.equal(await intro.getAttribute('data-phase'),'ready','Returning does not replay');
  await page.reload();assert.equal(await intro.getAttribute('data-phase'),'ready','Reload does not replay');
  await page.locator('.zentra-arrival__replay').click();await page.locator('.first-run__preferences select').first().focus();await page.waitForFunction(()=>document.querySelector('.zentra-arrival')?.getAttribute('data-phase')==='ready');assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'SELECT','Animation does not steal preference focus');
  assert.deepEqual(errors,[]);
  const times=frames.slice(1).map((x,i)=>x-frames[i]).filter(x=>x>1).sort((a,b)=>a-b);
  results.push({width,passed:true,frames:times.length,p95FrameMs:times[Math.floor(times.length*.95)],stopsAtRest:true,skipKeyboard:true,replay:true,connection:true});await page.close();
 }
 const page=await browser.newPage({reducedMotion:'reduce',viewport:{width:390,height:844}});
 await page.goto(`${origin}/tests/onboarding-preview.html`);assert.equal(await page.locator('.zentra-arrival').getAttribute('data-phase'),'ready');
 assert.equal(await page.locator('.zentra-arrival__light').isVisible(),false);await page.locator('.zentra-arrival__start').click();await page.locator('.first-run--account').waitFor();await page.close();results.push({reducedMotion:true,passed:true});
} catch(error){results.push({failed:String(error.stack)});process.exitCode=1;}finally{await browser.close();}
await writeFile(`${output}/motion-results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
