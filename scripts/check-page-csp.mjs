import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_CSP_ORIGIN||'https://127.0.0.1:5362',out=process.env.ZENTRA_CSP_OUTPUT||'.qa/csp-enforcement',proof=[];
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname),'Run this injection regression only against a local preview');
await mkdir(out,{recursive:true});
const routes=['/','/features','/download','/pricing','/complet','/automation','/support','/support/demo','/connexion','/mot-de-passe','/compte','/support/espace','/support/admin','/invitation','/paiement/succes','/page-inexistante-recette'];
for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch({headless:true,...(name==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
 try{
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:name==='chromium'?1440:390,height:900},reducedMotion:'reduce'});
  await context.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
  const page=await context.newPage();page.setDefaultTimeout(12000);let errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.__cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__cspViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI,disposition:e.disposition}));});
  for(const route of routes){
   errors=[];const response=await page.goto(origin+route,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>document.readyState==='complete');
   const headers=response.headers(),csp=headers['content-security-policy'];assert.ok(csp,route+' lacks CSP');
   const nonce=csp.match(/'nonce-([^']+)'/)?.[1];assert.ok(nonce,route+' lacks nonce');
   assert.match(headers['cache-control'],/no-store/);assert.ok(!headers['content-security-policy-report-only']);
   const scripts=await page.locator('script').evaluateAll(nodes=>nodes.filter(n=>!n.src&&(!n.type||n.type==='module'||n.type==='text/javascript')).map(n=>n.nonce));
   assert.ok(scripts.length>0);assert.ok(scripts.every(n=>n===nonce),route+' script nonce mismatch');
   assert.deepEqual(await page.evaluate(()=>window.__cspViolations),[],route+' page violates its CSP');
   assert.deepEqual(errors,[],route+' JavaScript errors');
   await page.locator('h1:visible,h2:visible').first().waitFor();
   if(route==='/connexion'){
    await page.getByRole('tab',{name:'Créer un compte',exact:true}).click();
    await page.getByRole('button',{name:'Créer mon compte',exact:true}).waitFor();
    await page.getByRole('tab',{name:'Se connecter',exact:true}).click();
    await page.getByRole('button',{name:'Ouvrir mon espace',exact:true}).waitFor();
   }
   if(route==='/support/demo'){
    const input=page.getByPlaceholder(/Rechercher/).first();
    if(await input.isVisible()){await input.fill('facture');await input.fill('');}
   }
   if(route==='/'||route==='/connexion'||route==='/support/demo')await page.screenshot({path:`${out}/${name}-${route==='/'?'home':route.slice(1).replaceAll('/','-')}.png`});
   proof.push({engine:name,route,status:response.status(),inlineScripts:scripts.length,nonceMatches:true,violations:[],errors:[],hydrated:route==='/connexion'});
   await writeFile(`${out}/progress.json`,JSON.stringify(proof,null,2));
  }
  await page.goto(origin+'/connexion',{waitUntil:'networkidle'});
  const baseline=await page.evaluate(()=>window.__cspViolations.length);
  await page.evaluate(()=>{
   const script=document.createElement('script');script.textContent='window.__unauthorizedScriptRan=true';document.body.append(script);
   const forged=document.createElement('script');forged.nonce='forged';forged.textContent='window.__forgedScriptRan=true';document.body.append(forged);
   const button=document.createElement('button');button.setAttribute('onclick','window.__unauthorizedHandlerRan=true');document.body.append(button);button.click();
   const allowed=document.createElement('script');allowed.nonce=document.querySelector('script[nonce]').nonce;allowed.textContent='window.__authorizedScriptRan=true';document.body.append(allowed);
  });
  await page.waitForFunction(()=>window.__cspViolations.length>=3);
  assert.deepEqual(await page.evaluate(()=>[!!window.__unauthorizedScriptRan,!!window.__forgedScriptRan,!!window.__unauthorizedHandlerRan,!!window.__authorizedScriptRan]),[false,false,false,true]);
  const denied=await page.evaluate(()=>window.__cspViolations);assert.ok(denied.every(v=>v.disposition==='enforce'));
  const first=await context.request.get(origin+'/connexion',{headers:{Accept:'text/html','x-nonce':'forged','Content-Security-Policy':"script-src 'nonce-forged'"}});
  const csp=first.headers()['content-security-policy'],nonce=csp.match(/'nonce-([^']+)'/)[1],html=await first.text();
  assert.notEqual(nonce,'forged');assert.ok(!html.includes('nonce="forged"'));assert.ok(html.includes(`nonce="${nonce}"`));
  const second=await context.request.get(origin+'/connexion',{headers:{Accept:'text/html'}});assert.notEqual(second.headers()['content-security-policy'],csp);
  const oauth=await context.request.get(origin+'/api/support/oauth/zendesk',{headers:{Accept:'text/html'}});
  assert.equal(oauth.headers()['content-security-policy'],"default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  const htmlBefore=await context.request.get(origin+'/',{headers:{Accept:'text/html'}}),home=(await htmlBefore.text());
  const asset=home.match(/src="([^\"]*\/_next\/static\/[^\"]+\.js)"/)?.[1];assert.ok(asset);
  const staticResponse=await context.request.get(new URL(asset,origin).href);assert.match(staticResponse.headers()['cache-control'],/immutable/);
  proof.push({engine:name,case:'blocked-inline-forged-nonce-and-event-handler',baseline,blocked:denied.length,matchingNonceAllowed:true,headerForgeryRejected:true,freshNonce:true,oauthPolicyPreserved:true,staticAssetsImmutable:true});
 }finally{await browser.close();}
}
await writeFile(`${out}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify({checks:proof.length,engines:2,externalTraffic:false,authenticated:false}));
