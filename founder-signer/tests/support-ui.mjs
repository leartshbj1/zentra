import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const output=fileURLToPath(new URL('../artifacts/qa/',import.meta.url));await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{const name={'/':'index.html','/access.css':'access.css','/access.js':'access.js'}[req.url];if(!name){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('js')?'text/javascript':name.endsWith('css')?'text/css':'text/html');res.end(await readFile(new URL('../ui/'+name,import.meta.url)));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true});const report=[];
try{for(const viewport of [{width:1140,height:850},{width:820,height:650}]){
 const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  const f=JSON.parse(sessionStorage.getItem('support-fixture')||'{"records":{},"pending":null,"operations":[],"writes":0}');window.fixture=f;
  const save=()=>sessionStorage.setItem('support-fixture',JSON.stringify(f));
  const key=a=>(a.product||'zentra')+':'+a.email;
  const result=a=>({email:a.email,record:f.records[key(a)]||null,accountKnown:false,serverTime:new Date().toISOString()});
  window.__TAURI__={core:{invoke:async(command,args)=>{
   if(command==='founder_status')return {ready:true,pending:f.pending};
   if(command!=='founder_request')throw Error('Unknown command');const a=args.action;await new Promise(r=>setTimeout(r,20));
   if(a.operation==='list')return {records:Object.values(f.records).filter(r=>r.product===a.product)};
   if(a.operation==='lookup')return result(a);
   if(a.operation==='grant'&&a.product==='support'&&!['starter','team','business'].includes(a.plan))throw Error('Plan missing');
   if(a.operation==='revoke'&&a.plan)throw Error('Unexpected plan');
   f.pending=a;save();
   if(!f.operations.includes(a.operationId)){const old=f.records[key(a)];f.operations.push(a.operationId);f.writes++;f.records[key(a)]={email:a.email,product:a.product,plan:a.plan||old?.plan,status:a.operation==='revoke'?'revoked':'pending',note:a.note,revision:(old?.revision||0)+1,expiresAt:new Date(Date.now()+14*86400000).toISOString(),accountLinked:false};}
   if(f.loseResponse){f.loseResponse=false;save();throw Error('Connexion interrompue.');}
   f.pending=null;save();return result(a);
  }}};
 });
 const ready=()=>page.waitForFunction(()=>!document.querySelector('#lookup').disabled);
 const check=async()=>{if(await page.locator('#error').isVisible())throw Error(await page.locator('#error').textContent());};
 const choose=async value=>{await page.locator('#product').selectOption(value);await ready();await check();};
 const lookup=async()=>{await page.locator('#email').fill('demo@example.invalid');await page.locator('#lookup').click();await ready();await check();};
 await page.goto('http://127.0.0.1:'+server.address().port);await ready();await lookup();await page.locator('#grant').click();await ready();
 await choose('support');assert.equal(await page.locator('.record').count(),0);await lookup();
 for(const plan of ['starter','team','business']){await page.locator('#support-plan').selectOption(plan);await page.locator('#grant').click();await ready();await check();assert.equal(await page.locator('#support-plan').inputValue(),plan);}
 assert.match(await page.locator('#success-description').textContent(),/Business/);
 await choose('zentra');await lookup();assert(await page.locator('#support-plan-field').isHidden());assert.equal(await page.evaluate(()=>window.fixture.records['zentra:demo@example.invalid'].revision),1);
 await choose('support');await lookup();await page.locator('#support-plan').selectOption('team');await page.evaluate(()=>window.fixture.loseResponse=true);await page.locator('#grant').click();await page.locator('#pending').waitFor();assert(await page.locator('#product').isDisabled());
 await page.reload();await ready();assert.equal(await page.locator('#product').inputValue(),'support');await page.locator('#retry').click();await ready();await check();assert.equal(await page.locator('#support-plan').inputValue(),'team');assert.equal(await page.evaluate(()=>window.fixture.writes),5);
 await page.locator('#revoke').click();await page.locator('#confirm-revoke').click();await ready();await check();assert.equal(await page.evaluate(()=>window.fixture.records['support:demo@example.invalid'].status),'revoked');assert.equal(await page.evaluate(()=>window.fixture.records['zentra:demo@example.invalid'].status),'pending');
 await page.locator('#show-all').check();await page.locator('.record').click();await ready();await page.screenshot({path:output+'/support-ui-'+viewport.width+'.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);report.push({viewport,allPlans:true,productIsolation:true,pendingRecovery:true,revoke:true,errors});await page.close();
}}finally{await browser.close();server.close();}
await writeFile(output+'/support-ui-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
