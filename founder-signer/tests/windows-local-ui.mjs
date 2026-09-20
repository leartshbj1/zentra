import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const root=process.env.ZENTRA_INSTALL_ROOT||path.join(process.env.LOCALAPPDATA,'ZentraFondateur');
const state=JSON.parse(await readFile(path.join(root,'local-session.json'),'utf8'));
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1140,height:850}});page.setDefaultTimeout(45000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const output=fileURLToPath(new URL('../artifacts/qa/',import.meta.url));await mkdir(output,{recursive:true});
const request=action=>page.evaluate(action=>window.__TAURI__.core.invoke('founder_request',{action}),action);
const ready=()=>page.waitForFunction(()=>!document.querySelector('#lookup').disabled);
const email='qa-windows-local-20260920@example.invalid';
const lookup=()=>request({operation:'lookup',email});
const check=async()=>{if(await page.locator('#error').isVisible())throw Error(await page.locator('#error').textContent());};
let started=false;
async function cleanup(){const current=await lookup();if(current.record&&['pending','active'].includes(current.record.status))await request({operation:'revoke',email,note:'Vérification Windows terminée',expectedRevision:current.record.revision,operationId:crypto.randomUUID()});}
try{
 await page.goto(`http://127.0.0.1:${state.port}/launch/${state.launchToken}`);await ready();await check();started=true;
 await cleanup();await page.locator('#email').fill(email);await page.locator('#lookup').click();await ready();await check();await page.locator('#grant').click();await ready();await check();
 const granted=await lookup();assert.equal(granted.record.status,'pending');assert(Math.abs(Date.parse(granted.record.expiresAt)-Date.parse(granted.serverTime)-14*86400000)<60000);
 await page.locator('.duration').filter({hasText:'Un mois'}).click();await page.locator('#grant').click();await ready();await check();
 const extended=await lookup();assert.equal(extended.record.revision,granted.record.revision+1);assert(Date.parse(extended.record.expiresAt)>Date.parse(granted.record.expiresAt)+27*86400000);
 await page.locator('.duration').filter({hasText:'Personnalisée'}).click();const until=new Date(Date.now()+7*86400000).toISOString().slice(0,10);await page.locator('#custom-date').fill(until);await page.locator('#grant').click();await ready();await check();
 const custom=await lookup();assert.equal(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(custom.record.expiresAt)),until);
 await page.reload();await ready();await check();await page.locator('.record').filter({hasText:email}).click();await ready();
 await page.locator('#revoke').click();await page.locator('#confirm-revoke').click();await ready();await check();assert.equal((await lookup()).record.status,'revoked');
 await page.locator('#new').click();await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:output+'/windows-compatible-ready.png',fullPage:true,mask:[page.locator('#records')]});
 await page.locator('a[href="signature.html"]').click();await page.locator('.key-status.ready').waitFor();await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 const signatureStatus=await page.evaluate(()=>window.__TAURI__.core.invoke('status'));assert(signatureStatus.keyReady);assert(signatureStatus.devices.length>=6);
 const verified=await page.evaluate(async()=>{const token=await window.__TAURI__.core.invoke('load_token',{reference:'owner-license-token-iphone.dpapi'});const check=await window.__TAURI__.core.invoke('verify_activation',{token});return {accepted:check.accepted,status:check.status};});assert(verified.accepted);
 await page.locator('a[href="index.html"]').click();await ready();await check();assert.deepEqual(errors,[]);
 const report={installedLocalApp:true,version:'1.2.0',browserUiReady:true,liveLookup:true,grant14Days:true,extendMonth:true,customDate:true,reloadPreserved:true,testGrantRevoked:true,legacyVaultVerified:true,ownerLicenseAccepted:verified.accepted,pageErrors:errors};
 await writeFile(output+'/windows-compatible-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{if(started)await cleanup().catch(()=>{});await browser.close();}
