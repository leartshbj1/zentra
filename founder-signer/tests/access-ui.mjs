import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const output=fileURLToPath(new URL('../artifacts/qa/',import.meta.url));await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{
  const name={'/':'index.html','/access.css':'access.css','/access.js':'access.js'}[req.url];
  if(!name){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('js')?'text/javascript':name.endsWith('css')?'text/css':'text/html');res.end(await readFile(new URL('../ui/'+name,import.meta.url)));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true});const report=[];
try{for(const viewport of [{width:1140,height:850},{width:820,height:650}]){
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    const f=JSON.parse(sessionStorage.getItem('fixture')||'{"records":{},"pending":null,"operations":[],"writes":0}');window.fixture=f;
    const save=()=>sessionStorage.setItem('fixture',JSON.stringify(f));
    const result=email=>({email,record:f.records[email]||null,accountKnown:false,accountName:null,serverTime:new Date().toISOString()});
    window.__TAURI__={core:{invoke:async(command,args)=>{
      if(command==='founder_status')return {ready:true,message:'Ready',pending:f.pending};
      if(command!=='founder_request')throw 'Unexpected command';const a=args.action;
      await new Promise(r=>setTimeout(r,25));
      if(a.operation==='list')return {records:Object.values(f.records)};
      if(a.operation==='lookup')return result(a.email);
      f.pending=a;save();
      if(!f.operations.includes(a.operationId)){
        const old=f.records[a.email];f.writes++;f.operations.push(a.operationId);
        const end=a.duration==='custom'?new Date(a.customDate+'T21:59:59Z'):new Date(Math.max(Date.now(),old?.status==='pending'?Date.parse(old.expiresAt):0)+(a.duration==='one_month'?30:14)*86400000);
        f.records[a.email]={email:a.email,expiresAt:end.toISOString(),revision:(old?.revision||0)+1,note:a.note,status:a.operation==='revoke'?'revoked':'pending',accountLinked:false};
      }
      if(f.loseResponse){f.loseResponse=false;save();throw 'Connexion interrompue. Reprenez la demande.';}
      f.pending=null;save();return result(a.email);
    }}};
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/');
  await page.waitForFunction(()=>!document.querySelector('#email').disabled);
  await page.screenshot({path:output+'/access-home-'+viewport.width+'.png',fullPage:true});
  await page.locator('#email').fill('demo@example.invalid');await page.locator('#lookup').click();await page.locator('#account').waitFor();
  await page.locator('#grant').click();await page.locator('#success').waitFor();
  assert.match(await page.locator('#success-description').textContent(),/connectant/);
  await page.screenshot({path:output+'/access-granted-'+viewport.width+'.png',fullPage:true});
  await page.locator('.duration').filter({hasText:'Un mois'}).click();await page.locator('#grant').click();
  await page.waitForFunction(()=>window.fixture.writes===2&&!document.querySelector('#grant').disabled);
  assert.equal(await page.evaluate(()=>window.fixture.records['demo@example.invalid'].revision),2);
  await page.locator('.duration').filter({hasText:'Personnalisée'}).click();await page.locator('#custom-date').fill('2027-03-15');await page.locator('#grant').click();
  await page.waitForFunction(()=>window.fixture.writes===3&&!document.querySelector('#grant').disabled);
  assert.match(await page.locator('#success-title').textContent(),/15 mars 2027/);
  await page.locator('#revoke').click();await page.locator('#cancel-revoke').click();assert.equal(await page.evaluate(()=>window.fixture.writes),3);
  await page.locator('#revoke').click();await page.locator('#confirm-revoke').click();await page.waitForFunction(()=>window.fixture.writes===4&&!document.querySelector('#grant').disabled);
  assert.match(await page.locator('#success-title').textContent(),/retiré/);assert.equal(await page.locator('.record').count(),0);
  await page.locator('#show-all').check();assert.equal(await page.locator('.record').count(),1);
  await page.locator('.duration').filter({hasText:'14 jours'}).click();await page.evaluate(()=>window.fixture.loseResponse=true);await page.locator('#grant').click();
  await page.locator('#pending').waitFor();assert(await page.locator('#grant').isDisabled());
  await page.reload();await page.locator('#pending').waitFor();await page.locator('#retry').click();await page.locator('#success').waitFor();
  await page.waitForFunction(()=>!document.querySelector('#grant').disabled);assert.equal(await page.evaluate(()=>window.fixture.writes),5);
  assert(await page.locator('#pending').isHidden());
  await page.locator('#email').fill('other@example.invalid');assert(await page.locator('#account').isHidden());
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);report.push({viewport,grant:true,month:true,custom:true,revoke:true,pendingRestartAndIdempotentRetry:true,errors});await page.close();
}}finally{await browser.close();server.close();}
await writeFile(output+'/access-ui-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
