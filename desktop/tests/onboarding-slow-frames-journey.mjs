import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const out=fileURLToPath(new URL('../.qa/onboarding-slow-frames/',import.meta.url));await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
try{
 const page=await browser.newPage({viewport:{width:320,height:640},reducedMotion:'no-preference'});
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.addInitScript(()=>{
  // Exercise the animation at one delivered frame per second, like an
  // overloaded software renderer. Cancellation and real timestamps remain.
  let next=0;const scheduled=new Map();const callbacks=new Map();window.__slowFrameCounts=[];
  window.requestAnimationFrame=callback=>{const id=++next;scheduled.set(id,setTimeout(()=>{
   scheduled.delete(id);const now=performance.now();let record=callbacks.get(callback);
   if(!record){record={calls:0,last:0,minGapMs:null};callbacks.set(callback,record);window.__slowFrameCounts.push(record);}
   if(record.calls)record.minGapMs=Math.min(record.minGapMs??Infinity,now-record.last);
   record.calls++;record.last=now;callback(now);
  },1000));return id;};
  window.cancelAnimationFrame=id=>{clearTimeout(scheduled.get(id));scheduled.delete(id);};
 });
 await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5367'}/tests/onboarding-preview.html?intro=1`);
 await page.locator('.zentra-arrival[data-phase="quote"]').waitFor();
 const started=Date.now();
 try{await page.waitForFunction(()=>document.querySelector('.zentra-arrival')?.getAttribute('data-phase')==='ready',{},{timeout:12000});}
 catch(error){await page.screenshot({path:`${out}/timeout.png`});throw error;}
 const elapsed=Date.now()-started;
 const counts=await page.evaluate(()=>window.__slowFrameCounts);
 const maxFrames=Math.max(...counts.map(record=>record.calls));
 const minGapMs=Math.min(...counts.filter(record=>record.calls>1).map(record=>record.minGapMs));
 assert.ok(elapsed<12000,'A slow device must not turn an eight-second introduction into minutes');
 assert.ok(maxFrames>=8&&maxFrames<15,'Each animation really receives few frames, independent of other callbacks');
 assert.ok(minGapMs>=900,'Repeated callbacks remain limited to one frame per second');
 await page.locator('.zentra-arrival__start').click();
 await page.locator('.first-run--account').waitFor();
 const proof={passed:true,elapsedMs:elapsed,maxFramesPerCallback:maxFrames,minGapMs,configurationReachable:true,nativeDevice:false};
 await page.close();
 const paused=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'no-preference'});
 await paused.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await paused.addInitScript(()=>{
  // Exercise the visibility lifecycle without claiming a physical-device test.
  let hidden=false;Object.defineProperty(document,'hidden',{get:()=>hidden});
  window.__setHidden=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));};
 });
 await paused.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5367'}/tests/onboarding-preview.html?intro=1`);
 await paused.waitForFunction(()=>document.querySelector('.zentra-arrival')?.getAttribute('data-phase')==='light');
 await paused.evaluate(()=>window.__setHidden(true));
 await paused.waitForTimeout(5200);
 assert.equal(await paused.locator('.zentra-arrival').getAttribute('data-phase'),'light','Hidden time does not advance the sequence');
 await paused.evaluate(()=>window.__setHidden(false));
 await paused.waitForTimeout(400);
 assert.notEqual(await paused.locator('.zentra-arrival').getAttribute('data-phase'),'ready','Resuming does not add the hidden duration');
 await paused.waitForFunction(()=>document.querySelector('.zentra-arrival')?.getAttribute('data-phase')==='ready',{},{timeout:6500});
 proof.visibilityLifecyclePaused=true;
 await writeFile(`${out}/report.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{await browser.close();}
