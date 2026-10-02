import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const pw = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5414';
const output = process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), 'zentra-app-draft-identity-after-20261002');
await mkdir(output, { recursive: true });
const copy = {
  fr: { loading:'Vérification de votre compte sur cet appareil…', failure:'Votre compte ne peut pas être vérifié sur cet appareil. Vos données sont conservées.', timeout:'Cette vérification prend trop de temps. Vos données sont conservées.', retry:'Réessayer la vérification' },
  de: { loading:'Ihr Konto wird auf diesem Gerät geprüft…', failure:'Ihr Konto kann auf diesem Gerät nicht geprüft werden. Ihre Daten bleiben erhalten.', timeout:'Diese Prüfung dauert zu lange. Ihre Daten bleiben erhalten.', retry:'Prüfung erneut versuchen' },
  it: { loading:'Verifica del tuo account su questo dispositivo…', failure:'Non è possibile verificare il tuo account su questo dispositivo. I tuoi dati sono conservati.', timeout:'Questa verifica richiede troppo tempo. I tuoi dati sono conservati.', retry:'Riprova la verifica' },
  en: { loading:'Checking your account on this device…', failure:'Your account cannot be verified on this device. Your data is preserved.', timeout:'This check is taking too long. Your data is preserved.', retry:'Retry account check' },
};
const drafts = page => page.evaluate(() => Object.keys(localStorage).filter(key=>key.startsWith('zentra.forms.drafts.v1.')).map(key=>({key,value:JSON.parse(localStorage.getItem(key))})));
const proof = page => page.evaluate(() => structuredClone(window.__qaAppDraftIdentity.proof));
async function fixture(browser, result, query='') {
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page.setDefaultTimeout(10_000);
  page.on('pageerror',error=>result.errors.push(error.message));
  page.on('dialog',async dialog=>{result.prompts.push(dialog.message());await dialog.dismiss();});
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin||url.pathname.startsWith('/api/')){result.blocked.push(url.origin+url.pathname);return route.abort();}return route.continue();});
  await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
  await page.clock.install();
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1${query}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window.__qaAppDraftIdentity);
  return page;
}
async function screen(page,label) {
  await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
  await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill(label);
  await page.locator('.navigation-palette__results button').filter({has:page.getByText(label,{exact:true})}).click();
  await page.locator('.navigation-palette').waitFor({state:'detached'});
}
async function latestIdentity(page) {
  await page.waitForFunction(()=>window.__qaAppDraftIdentity.proof.identityReads.some(read=>read.pending));
  return page.evaluate(()=>window.__qaAppDraftIdentity.proof.identityReads.filter(read=>read.pending).at(-1).id);
}
async function admit(page) {
  const id=await latestIdentity(page);
  await page.evaluate(id=>{window.__qaAppDraftIdentity.identityMode('ready');window.__qaAppDraftIdentity.releaseIdentity(id);},id);
  await page.locator('.desktop-app').waitFor();
  const later=page.getByRole('button',{name:'Découvrir plus tard',exact:true});if(await later.isVisible())await later.click();
}
async function openForm(page,kind='client') {
  await screen(page,kind==='client'?'Clients':'Devis');
  await page.getByRole('button',{name:kind==='client'?'Nouveau client':'Nouveau devis',exact:true}).click();
  return page.getByRole('dialog');
}
async function advanceRevalidation(page) {
  const before=(await proof(page)).accountReads;
  await page.clock.fastForward(15*60*1000+30);
  await page.waitForFunction(before=>window.__qaAppDraftIdentity.proof.accountReads>before,before);
}
async function checkDiagnostics(page) {
  const events=await page.evaluate(()=>window.__qaAppDraftIdentity.diagnostics());
  assert.ok(events.some(event=>event.phase==='start'));
  const keys=new Set(['id','sessionId','timestamp','area','operation','phase','durationMs','errorCode']);
  for(const event of events){assert.equal(event.area,'draft');assert.equal(event.operation,'identity.read');assert.ok(Object.keys(event).every(key=>keys.has(key)));}
  const encoded=JSON.stringify(events);
  assert.doesNotMatch(encoded,/synthetic-member|synthetic-company|automation-qa|example\.invalid|PRIVATE|memberId|organizationId|email|token|message|args/i);
  for(const event of events.filter(event=>['success','failure','info'].includes(event.phase))){assert.ok(events.some(start=>start.id===event.id&&start.phase==='start'));assert.ok(Number.isFinite(event.durationMs));}
  return events;
}
async function initialAdmission(page,kind) {
  await latestIdentity(page);
  assert.equal(await page.locator('.desktop-app').count(),0,'No form is offered while the first scoped identity is pending');
  await page.getByText(copy.fr.loading,{exact:true}).waitFor();
  await admit(page);
  const form=await openForm(page,kind), selector=kind==='client'?'[name=company]':'[name=title]';
  const typed=`${kind.toUpperCase()} AFTER VERIFIED LOCAL IDENTITY`;
  await form.locator(selector).fill(typed);
  assert.equal((await drafts(page)).length,1);
  assert.equal((await proof(page)).companyResolutions.length,1,'Arrival of a member must not repeat company resolution');
  await page.keyboard.press('Escape');
  await form.waitFor({state:'detached'});
  const reopened=await openForm(page,kind);
  await reopened.getByRole('button',{name:'Reprendre ma saisie',exact:true}).click();
  assert.equal(await reopened.locator(selector).inputValue(),typed);
  return {kind,typed,drafts:1,companyResolutions:1,diagnostics:await checkDiagnostics(page)};
}
async function failureRetry(page,mode,language='fr') {
  const first=await latestIdentity(page);
  await page.getByText(copy[language].loading,{exact:true}).waitFor();
  if(mode==='timeout')await page.clock.fastForward(15_020);
  else if(mode==='failure')await page.evaluate(id=>window.__qaAppDraftIdentity.rejectIdentity(id),first);
  else await page.evaluate(id=>window.__qaAppDraftIdentity.releaseIdentity(id,''),first);
  await page.getByRole('alert').getByText(mode==='timeout'?copy[language].timeout:copy[language].failure,{exact:true}).waitFor();
  assert.equal(await page.locator('.desktop-app').count(),0);
  await page.evaluate(()=>window.__qaAppDraftIdentity.identityMode('hold'));
  await page.getByRole('button',{name:copy[language].retry,exact:true}).click();
  const retry=await latestIdentity(page);
  assert.ok(retry>first);
  await page.evaluate(id=>window.__qaAppDraftIdentity.releaseIdentity(id),retry);
  await page.locator('.desktop-app').waitFor();
  if(mode==='timeout'){
    await page.evaluate(id=>window.__qaAppDraftIdentity.releaseIdentity(id,'synthetic-wrong-late-member'),first);
    await page.clock.fastForward(30);
    assert.equal(await page.locator('.desktop-app').isVisible(),true);
  }
  return {mode,language,reads:(await proof(page)).identityReads.length,diagnostics:await checkDiagnostics(page)};
}
async function companyFirst(page) {
  await page.waitForFunction(()=>window.__qaAppDraftIdentity.companyPending().length===1);
  await page.clock.fastForward(20_000);
  assert.equal((await proof(page)).identityReads.length,0,'Company binding does not consume the identity deadline');
  assert.equal(await page.getByRole('button',{name:copy.fr.retry,exact:true}).count(),0);
  await page.evaluate(()=>window.__qaAppDraftIdentity.releaseCompany(1));
  await admit(page);
  assert.equal((await proof(page)).accountReads,1,'Remote account check can remain held while a locally admitted company opens');
  return {identityAfterCompanyAdmission:true,readyWhileAccountCheckHeld:true,diagnostics:await checkDiagnostics(page)};
}
async function revalidation(page) {
  await admit(page);const form=await openForm(page);await form.locator('[name=company]').fill('DRAFT SURVIVES REVALIDATION');
  await page.evaluate(()=>{window.__qaAppDraftIdentity.identityMode('failure');window.__qaAppDraftIdentity.releaseAccount(1);window.__qaAppDraftIdentity.accountMode('ready');});
  await page.waitForFunction(()=>window.__qaAppDraftIdentity.proof.identityReads.some(read=>read.mode==='failure'));
  assert.equal(await form.locator('[name=company]').inputValue(),'DRAFT SURVIVES REVALIDATION');
  await page.evaluate(()=>window.__qaAppDraftIdentity.identityMode('hold'));
  await advanceRevalidation(page);const read=await latestIdentity(page);
  assert.equal(await form.locator('[name=company]').inputValue(),'DRAFT SURVIVES REVALIDATION');
  await page.evaluate(id=>window.__qaAppDraftIdentity.releaseIdentity(id),read);
  assert.equal(await form.locator('[name=company]').inputValue(),'DRAFT SURVIVES REVALIDATION');
  await page.evaluate(()=>window.__qaAppDraftIdentity.accountMode('failure'));
  await advanceRevalidation(page);
  assert.equal(await form.locator('[name=company]').inputValue(),'DRAFT SURVIVES REVALIDATION');
  assert.equal((await drafts(page)).length,1);
  assert.equal((await proof(page)).companyResolutions.length,1);
  return {failedIdentity:true,successfulIdentity:true,failedAccount:true,formPreserved:true,diagnostics:await checkDiagnostics(page)};
}
async function inactiveSameCompany(page,kind) {
  await admit(page);const form=await openForm(page,kind), selector=kind==='client'?'[name=company]':'[name=title]';
  const typed=`${kind.toUpperCase()} KEPT WHEN SUBSCRIPTION INACTIVE`;
  await form.locator(selector).fill(typed);
  await page.evaluate(()=>{window.__qaAppDraftIdentity.setAccount({status:'inactive',organizationId:'automation-qa',organizationName:'Entreprise fictive A',role:'owner'});window.__qaAppDraftIdentity.identityMode('ready');window.__qaAppDraftIdentity.releaseAccount(1);});
  await page.waitForFunction(()=>window.__qaAppDraftIdentity.proof.identityReads.length>=2);
  await page.waitForFunction(selector=>document.querySelector(selector)?.matches(':disabled'),selector);
  assert.equal(await form.locator(selector).inputValue(),typed);
  assert.equal((await drafts(page)).length,1);
  assert.equal((await proof(page)).companyResolutions.length,1);
  await page.evaluate(()=>{window.__qaAppDraftIdentity.accountMode('ready');window.__qaAppDraftIdentity.setAccount({status:'connected',organizationId:'automation-qa',organizationName:'Entreprise fictive A',role:'owner'});});
  await advanceRevalidation(page);
  await page.waitForFunction(selector=>document.querySelector(selector)&&!document.querySelector(selector).matches(':disabled'),selector);
  assert.equal(await form.locator(selector).inputValue(),typed,'An admitted company becoming active again must not close its form');
  assert.equal((await proof(page)).companyResolutions.length,1,'Status alone does not repeat company admission');
  assert.equal((await drafts(page)).length,1);
  return {kind,typed,connectedToInactiveFormPreserved:true,inactiveToConnectedFormPreserved:true,readOnlyWhileInactive:true,companyResolutions:1,diagnostics:await checkDiagnostics(page)};
}
async function initialInactive(page,newOrganization) {
  await admit(page);
  assert.equal((await proof(page)).companyResolutions.length,0,'An initial inactive account has no cached company admission');
  const organizationId=newOrganization?'synthetic-organization-b':'automation-qa';
  await page.evaluate(organizationId=>{window.__qaAppDraftIdentity.companyMode('hold');window.__qaAppDraftIdentity.identityMode('hold');window.__qaAppDraftIdentity.setAccount({status:'connected',organizationId,organizationName:'Entreprise fictive',role:'owner'});window.__qaAppDraftIdentity.releaseAccount(1);},organizationId);
  await page.waitForFunction(()=>window.__qaAppDraftIdentity.companyPending().length===1);
  assert.equal(await page.locator('.desktop-app').count(),0,'Connected admission cannot reuse an initial inactive account');
  await page.evaluate(()=>{window.__qaAppDraftIdentity.identityMode('ready');window.__qaAppDraftIdentity.releaseCompany(1);for(const read of window.__qaAppDraftIdentity.proof.identityReads.filter(read=>read.pending))window.__qaAppDraftIdentity.releaseIdentity(read.id);});
  await page.locator('.desktop-app').waitFor();
  const calls=await proof(page);assert.equal(calls.companyResolutions.length,1);assert.equal(calls.companyResolutions[0].organizationId,organizationId);
  return {newOrganization,freshAdmissionRequired:true,companyResolutions:calls.companyResolutions,diagnostics:await checkDiagnostics(page)};
}
async function switchLocalScope(page) {
  await admit(page);let form=await openForm(page);await form.locator('[name=company]').fill('ONLY ORIGINAL LOCAL SCOPE');
  await page.keyboard.press('Escape');await form.waitFor({state:'detached'});
  await page.evaluate(async()=>{window.__qaAppDraftIdentity.companyMode('hold');window.__qaAppDraftIdentity.identityMode('hold');await window.__qaAppDraftIdentity.receiveScope('synthetic-company-received');});
  await page.waitForFunction(()=>window.__qaAppDraftIdentity.companyPending().length===1);
  assert.equal(await page.locator('.desktop-app').count(),0);
  assert.equal((await proof(page)).identityReads.length,1,'A new local scope must be admitted before reading its identity');
  await page.evaluate(()=>window.__qaAppDraftIdentity.releaseCompany(2));await admit(page);
  form=await openForm(page);assert.equal(await form.locator('[name=company]').inputValue(),'');
  assert.equal(await form.getByRole('button',{name:'Reprendre ma saisie',exact:true}).count(),0);
  await form.locator('[name=company]').fill('ONLY RECEIVED LOCAL SCOPE');
  const retained=await drafts(page);assert.equal(retained.length,2);
  const scopes=retained.map(item=>JSON.parse(decodeURIComponent(item.key.slice('zentra.forms.drafts.v1.'.length))).slice(0,3));
  assert.ok(scopes.some(scope=>scope[0]==='synthetic-company-a'));assert.ok(scopes.some(scope=>scope[0]==='synthetic-company-received'));
  assert.equal((await proof(page)).companyResolutions.length,2);
  return {freshAdmissionRequired:true,scopes,oldDraftNotExposed:true,companyResolutions:2,diagnostics:await checkDiagnostics(page)};
}
async function switchAccount(page,newOrganization) {
  await admit(page);let form=await openForm(page);await form.locator('[name=company]').fill('ONLY MEMBER A DRAFT');
  await page.keyboard.press('Escape');await form.waitFor({state:'detached'});
  const org=newOrganization?'synthetic-organization-b':'automation-qa',scope=newOrganization?'synthetic-company-b':'synthetic-company-a';
  await page.evaluate(({org,scope})=>{window.__qaAppDraftIdentity.link({status:'connected',organizationId:org,organizationName:'Entreprise fictive B',role:'owner'},'synthetic-member-b',scope);window.__qaAppDraftIdentity.identityMode('hold');},{org,scope});
  await page.getByRole('button',{name:'Mon compte',exact:true}).click();
  const account=page.getByRole('dialog');await account.getByRole('button',{name:'Changer d’espace',exact:true}).click();
  await account.getByText('La connexion ne se termine pas ?',{exact:true}).click();
  await account.getByRole('button',{name:'Vérifier maintenant',exact:true}).click();
  const read=await latestIdentity(page);
  assert.equal(await page.locator('.desktop-app').count(),0,'Explicit approval hides all previous forms before a new member is admitted');
  await page.evaluate(id=>window.__qaAppDraftIdentity.releaseIdentity(id),read);
  await page.locator('.desktop-app').waitFor();
  form=await openForm(page);
  assert.equal(await form.locator('[name=company]').inputValue(),'');
  assert.equal(await form.getByRole('button',{name:'Reprendre ma saisie',exact:true}).count(),0,'No previous member/organization draft is offered');
  await form.locator('[name=company]').fill('ONLY MEMBER B DRAFT');
  const retained=await drafts(page);assert.equal(retained.length,2);
  const decoded=retained.map(item=>JSON.parse(decodeURIComponent(item.key.slice('zentra.forms.drafts.v1.'.length))));
  assert.ok(decoded.some(item=>item[2]==='synthetic-member-a'&&item[0]==='synthetic-company-a'));
  assert.ok(decoded.some(item=>item[2]==='synthetic-member-b'&&item[0]===scope&&item[1]===org));
  assert.equal((await proof(page)).companyResolutions.length,newOrganization?2:1,'The gate publishes its received scope without resolving it a second time');
  if(newOrganization){
    await page.evaluate(org=>{window.__qaAppDraftIdentity.accountMode('ready');window.__qaAppDraftIdentity.setAccount({status:'inactive',organizationId:org,organizationName:'Entreprise fictive B',role:'owner'});},org);
    await advanceRevalidation(page);await page.waitForFunction(()=>document.querySelector('[name=company]')?.matches(':disabled'));
    assert.equal(await form.locator('[name=company]').inputValue(),'ONLY MEMBER B DRAFT');
    await page.evaluate(org=>window.__qaAppDraftIdentity.setAccount({status:'connected',organizationId:org,organizationName:'Entreprise fictive B',role:'owner'}),org);
    await advanceRevalidation(page);await page.waitForFunction(()=>document.querySelector('[name=company]')&&!document.querySelector('[name=company]').matches(':disabled'));
    assert.equal(await form.locator('[name=company]').inputValue(),'ONLY MEMBER B DRAFT');assert.equal((await proof(page)).companyResolutions.length,2);
  }
  return {newOrganization,scopes:decoded.map(item=>item.slice(0,3)),oldDraftNotExposed:true,...newOrganization?{receivedScopeStatusReturnPreserved:true,companyResolutions:2}:{},diagnostics:await checkDiagnostics(page)};
}
async function missingLocalScope(page) {
  await page.getByRole('alert').getByText('Votre espace local n’a pas pu être identifié. Vos données sont conservées.',{exact:true}).waitFor();
  assert.equal(await page.locator('.desktop-app').count(),0);
  assert.equal((await proof(page)).identityReads.length,0);
  await page.evaluate(()=>window.__qaAppDraftIdentity.setScope('synthetic-recovered-local-scope'));
  await page.getByRole('button',{name:copy.fr.retry,exact:true}).click();
  await page.locator('.desktop-app').waitFor();
  const form=await openForm(page);await form.locator('[name=company]').fill('SCOPED LOCAL DRAFT');
  const retained=await drafts(page);assert.equal(retained.length,1);
  assert.match(decodeURIComponent(retained[0].key),/synthetic-recovered-local-scope/);
  return {missingScopeBlocked:true,localScopeReRead:true,identityReads:0};
}

const scenarios=[
  ['initial-client',page=>initialAdmission(page,'client')],['initial-quote',page=>initialAdmission(page,'quote')],
  ...['failure','timeout','missing'].map(mode=>[`initial-${mode}-retry`,page=>failureRetry(page,mode)]),
  ['company-binding-before-identity',companyFirst,'&identityCompanyHold=1'],
  ['same-account-revalidation',revalidation],...['client','quote'].map(kind=>[`same-org-inactive-return-${kind}`,page=>inactiveSameCompany(page,kind)]),
  ...[false,true].map(newOrganization=>[`initial-inactive-${newOrganization?'other':'same'}-org-admission`,page=>initialInactive(page,newOrganization),'&identityInitiallyInactive=1']),
  ['received-local-scope-admission',switchLocalScope],
  ['explicit-member-switch',page=>switchAccount(page,false)],['explicit-org-switch',page=>switchAccount(page,true)],
  ['missing-local-scope-retry',missingLocalScope,'&identityMissingScope=1&identityLocalAccount=1'],
  ...['de','it','en'].map(language=>[`copy-${language}-timeout-retry`,page=>failureRetry(page,'timeout',language),`&language=${language}`]),
].filter(([name])=>!process.env.ZENTRA_QA_SCENARIO||name===process.env.ZENTRA_QA_SCENARIO);
async function run(engine) {
  const browser=await pw[engine].launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{executablePath:process.env.ZENTRA_EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{})});
  const result={engine,cases:[],errors:[],blocked:[],prompts:[]};let page;
  try {
    for(const [name,action,query]of scenarios){
      page=await fixture(browser,result,query);const details=await action(page);
      await page.screenshot({path:join(output,`${engine}-${name}.png`)});
      result.cases.push({name,...details});await page.close();
    }
    assert.deepEqual(result.errors,[]);assert.deepEqual(result.blocked,[]);assert.deepEqual(result.prompts,[]);result.passed=true;
  }catch(error){result.passed=false;result.failure=error.stack;if(page&&!page.isClosed()){await page.screenshot({path:join(output,`${engine}-failure.png`)});await writeFile(join(output,`${engine}-failure.html`),await page.content());}}
  finally{await browser.close();}
  return result;
}
const results=await Promise.all(['chromium','webkit'].map(run));
await writeFile(join(output,'report.json'),JSON.stringify({origin,component:'real App + CompanyAccountGate + native identity bridge, StrictMode',transport:'synthetic-only',scenariosPerEngine:scenarios.length,results},null,2));
console.log(JSON.stringify({output,results:results.map(({engine,passed,cases,failure,errors,blocked,prompts})=>({engine,passed,cases:cases.length,failure,errors,blocked,prompts}))},null,2));
if(results.some(result=>!result.passed))process.exitCode=1;
