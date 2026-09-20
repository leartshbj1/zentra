import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const root=process.env.ZENTRA_INSTALL_ROOT||path.join(process.env.LOCALAPPDATA,'ZentraFondateur');
const state=JSON.parse(await readFile(path.join(root,'local-session.json'),'utf8'));
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1140,height:900}});page.setDefaultTimeout(45000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const output=fileURLToPath(new URL('../artifacts/qa/',import.meta.url));await mkdir(output,{recursive:true});
const request=action=>page.evaluate(action=>window.__TAURI__.core.invoke('founder_request',{action}),action);
const email='qa-founder-support-20260920@example.invalid';
const ready=()=>page.waitForFunction(()=>!document.querySelector('#lookup').disabled);
const check=async()=>{if(await page.locator('#error').isVisible())throw Error(await page.locator('#error').textContent());};
const lookup=()=>request({operation:'lookup',product:'support',email});
async function cleanup(){const current=await lookup();if(current.record&&['pending','active'].includes(current.record.status))await request({operation:'revoke',product:'support',email,note:'Vérification terminée',expectedRevision:current.record.revision,operationId:crypto.randomUUID()});}
let started=false;
try{
 await page.goto(`http://127.0.0.1:${state.port}/launch/${state.launchToken}`);await ready();await check();started=true;await cleanup();
 const before=await request({operation:'lookup',email});
 await page.locator('#product').selectOption('support');await ready();await check();await page.locator('#email').fill(email);await page.locator('#lookup').click();await ready();await check();
 await page.locator('#support-plan').selectOption('starter');await page.locator('#grant').click();await ready();await check();let current=await lookup();assert.equal(current.record.plan,'starter');assert(Math.abs(Date.parse(current.record.expiresAt)-Date.parse(current.serverTime)-14*86400000)<60000);
 await page.locator('#support-plan').selectOption('team');await page.locator('.duration').filter({hasText:'Un mois'}).click();await page.locator('#grant').click();await ready();await check();const extended=await lookup();assert.equal(extended.record.plan,'team');assert(Date.parse(extended.record.expiresAt)>Date.parse(current.record.expiresAt)+27*86400000);
 await page.locator('#support-plan').selectOption('business');await page.locator('.duration').filter({hasText:'Personnalisée'}).click();const until=new Date(Date.now()+8*86400000).toISOString().slice(0,10);await page.locator('#custom-date').fill(until);await page.locator('#grant').click();await ready();await check();current=await lookup();assert.equal(current.record.plan,'business');assert.equal(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(current.record.expiresAt)),until);
 await page.reload();await ready();await page.locator('#product').selectOption('support');await ready();await check();await page.locator('.record').filter({hasText:email}).click();await ready();assert.equal(await page.locator('#support-plan').inputValue(),'business');
 await page.locator('#revoke').click();await page.locator('#confirm-revoke').click();await ready();await check();assert.equal((await lookup()).record.status,'revoked');
 const after=await request({operation:'lookup',email});assert.deepEqual(after.record,before.record);
 await page.locator('#new').click();await page.screenshot({path:output+'/support-live-ready.png',fullPage:true,mask:[page.locator('#records')]});assert.deepEqual(errors,[]);
 const report={version:'1.2.0',liveSupport:true,starter14Days:true,teamMonth:true,businessCustom:true,reloadPreserved:true,revoked:true,zentraUnchanged:true,pageErrors:errors};await writeFile(output+'/support-live-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{try{if(started)await cleanup();}finally{await browser.close();}}
