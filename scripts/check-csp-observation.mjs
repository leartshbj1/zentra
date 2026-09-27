import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5361';
const output='outputs/csp-observation';await mkdir(output,{recursive:true});
const browser=await pw.chromium.launch({headless:true,channel:'msedge'});const proof=[];
try{for(const path of ['/connexion','/mot-de-passe','/support/demo','/download']){
  const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
  await page.addInitScript(()=>{window.__cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__cspViolations.push({directive:e.effectiveDirective,disposition:e.disposition,blocked:e.blockedURI==='inline'?'inline':'other'}));});
  const response=await page.goto(origin+path,{waitUntil:'networkidle'});
  assert.equal(response.status(),200,path);
  const headers=await response.allHeaders();
  assert.equal(headers['strict-transport-security'],'max-age=86400');
  const observed=path!=='/download';
  const policy=headers['content-security-policy-report-only'];
  assert.equal(Boolean(policy),observed,path);
  let scripts=[];
  if(observed){
    const nonce=policy.match(/'nonce-([^']+)'/)[1];
    scripts=await page.locator('script').evaluateAll(nodes=>nodes.filter(n=>!n.src&&(!n.type||n.type==='module'||n.type==='text/javascript')).map(n=>({nonce:n.nonce,length:n.textContent.length})));
    assert.ok(scripts.length>0,'Expected actual SSR bootstrap scripts');
    assert.ok(scripts.every(s=>s.nonce===nonce),`${path}: unnonced inline script`);
    assert.equal(headers['cache-control'],'private, no-store');
  }
  const violations=await page.evaluate(()=>window.__cspViolations);
  assert.deepEqual(violations,[],path);assert.deepEqual(errors,[],path);
  await page.screenshot({path:`${output}/${path.slice(1).replaceAll('/','-')}.png`});
  proof.push({path,status:response.status(),observation:observed,inlineScripts:scripts.length,hsts:true,violations,errors});
  await page.close();
}}finally{await browser.close();}
await writeFile(`${output}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
