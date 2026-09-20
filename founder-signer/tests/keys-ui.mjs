import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const output=fileURLToPath(new URL('../artifacts/qa/',import.meta.url));await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{const name={'/':'keys.html','/access.css':'access.css','/keys.js':'keys.js'}[req.url];if(!name){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('js')?'text/javascript':name.endsWith('css')?'text/css':'text/html');res.end(await readFile(new URL('../ui/'+name,import.meta.url)));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true});const report=[];
try{for(const viewport of [{width:1140,height:850},{width:820,height:650}]){
 const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  const f=JSON.parse(sessionStorage.getItem('keys-fixture')||'{"configured":false,"revision":"initial","pending":null,"saved":0}');window.fixture=f;const persist=()=>sessionStorage.setItem('keys-fixture',JSON.stringify(f));
  const state=()=>({configured:f.configured,revision:f.revision,updatedAt:f.configured?new Date().toISOString():null});
  window.__TAURI__={core:{invoke:async(command,args)=>{
   if(command==='founder_status')return {ready:true};if(command==='platform_status')return {pending:f.pending};
   if(command==='platform_retry'){f.pending=null;persist();return state();}
   const a=args.action;if(a.operation==='state')return state();if(a.operation==='test')return {...state(),verified:true,supportVerified:true,automationVerified:true};
   assertKey(a);f.saved++;f.configured=true;f.revision='a'.repeat(64);
   if(f.lose){f.lose=false;f.pending={operation:'save_key',operationId:a.operationId};persist();throw Error('Connexion interrompue.');}
   persist();return state();
  }}};
  function assertKey(a){if(a.apiKey!=='test-key-fixture'||a.expectedRevision!==f.revision)throw Error('Invalid command');}
 });
 const ready=()=>page.waitForFunction(()=>!document.querySelector('#reload').disabled);
 await page.goto('http://127.0.0.1:'+server.address().port);await ready();assert(await page.locator('#test').isDisabled());
 await page.locator('#api-key').fill('test-key-fixture');await page.locator('#save').click();await ready();assert.equal(await page.locator('#api-key').inputValue(),'');assert(await page.locator('#error').isHidden());
 await page.locator('#test').click();await ready();assert.match(await page.locator('#success-title').textContent(),/Automation et Support/);
 await page.evaluate(()=>window.fixture.lose=true);await page.locator('#api-key').fill('test-key-fixture');await page.locator('#save').click();await ready();assert(await page.locator('#pending').isVisible());assert(await page.locator('#api-key').isDisabled());assert(!await page.locator('body').textContent().then(v=>v.includes('test-key-fixture')));
 await page.reload();await ready();await page.locator('#retry').click();await ready();assert(await page.locator('#pending').isHidden());assert.equal(await page.evaluate(()=>window.fixture.saved),2);
 await page.screenshot({path:output+'/keys-ui-'+viewport.width+'.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);report.push({viewport,saved:true,bothProductsTested:true,secretCleared:true,resumed:true,errors});await page.close();
}}finally{await browser.close();server.close();}
await writeFile(output+'/keys-ui-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
