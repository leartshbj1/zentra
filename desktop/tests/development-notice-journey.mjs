import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,channel:'msedge'});
const page=await browser.newPage(); const report=[];const errors=[];
await page.emulateMedia({reducedMotion:'reduce'});
page.on('pageerror',e=>errors.push(e.message));
await mkdir('.qa/development-notice',{recursive:true});
try {
 await page.goto('http://127.0.0.1:5176/tests/mobile-harness.html?finance=1&notice=1');
 const tour=page.getByRole('button',{name:'Ne plus afficher automatiquement',exact:true});if(await tour.isVisible())await tour.click();
 const notice=page.locator('.license-banner--development'); const summary=notice.locator(':scope > summary');
 for(const width of [320,390,768,1024,1440]) {
  await page.setViewportSize({width,height:900});
  await summary.waitFor();
  assert.equal(await notice.getAttribute('open'),null);
  const box=await notice.boundingBox();assert(box.height>=44 && box.height<=60,JSON.stringify(box));
  assert(box.x>=0 && box.x+box.width<=width);
  if(width<=860){const nav=await page.locator('.mobile-navigation').boundingBox();assert(box.y+box.height<=nav.y);}
  await page.screenshot({path:`.qa/development-notice/${width}-closed.png`});
  await summary.focus();await page.keyboard.press('Enter');
  await page.getByText('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',{exact:true}).waitFor();
  assert.notEqual(await notice.getAttribute('open'),null);
  const open=await notice.boundingBox();assert(open.x>=0 && open.x+open.width<=width && open.y>=0);
  await page.screenshot({path:`.qa/development-notice/${width}-open.png`});
  await summary.focus();await page.keyboard.press('Space');
  assert.equal(await notice.getAttribute('open'),null);
  if(width<=860){await page.evaluate(()=>document.documentElement.classList.add('keyboard-open'));assert.equal(await notice.isVisible(),false);await page.evaluate(()=>document.documentElement.classList.remove('keyboard-open'));}
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  report.push({width,collapsedHeight:box.height,expandedHeight:open.height,keyboardToggle:true,navigationClear:true});
 }
 await page.emulateMedia({media:'print'});assert.equal(await notice.isVisible(),false);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'PASS',views:report.length,report}));
} catch(error){report.push({fatal:error.stack});await page.screenshot({path:'.qa/development-notice/failure.png'});console.error(error);process.exitCode=1;}
finally{await writeFile('.qa/development-notice/report.json',JSON.stringify({report,errors},null,2));await browser.close();}
