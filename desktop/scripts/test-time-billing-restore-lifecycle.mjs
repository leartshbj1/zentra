/** Real App/React DOM restoration lifecycle regression with closed synthetic transports.
 * Run with the desired Node executable or set ZENTRA_NODE_PATH.
 * Optional: ZENTRA_PLAYWRIGHT_MODULE, ZENTRA_EDGE_PATH, ZENTRA_QA_OUTPUT.
 * Normal mode uses followed App/WorkspaceApp/bridge/Wizard; no product-source overlays.
 * Existing test-only identity hook installs synthetic dependencies, never an act/setter override.
 * These 12 cases hold time billing before ACK; onCreated success is covered separately.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile,writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as freePort } from 'node:net';
import { dirname,isAbsolute,join,resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath,pathToFileURL } from 'node:url';
const script=fileURLToPath(import.meta.url);
if(process.env.ZENTRA_NODE_PATH&&resolve(process.env.ZENTRA_NODE_PATH).toLowerCase()!==resolve(process.execPath).toLowerCase()){
 const child=spawn(process.env.ZENTRA_NODE_PATH,[script],{stdio:'inherit',env:{...process.env,ZENTRA_NODE_PATH:''}});
 const code=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',value=>yes(value??1));});process.exit(code);
}
const desktop=resolve(dirname(script),'..');
const out=resolve(process.env.ZENTRA_QA_OUTPUT||join(tmpdir(),'zentra-time-billing-restore-'+Date.now()));
await mkdir(out,{recursive:true});
const require=createRequire(join(desktop,'package.json'));
const vite=await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')),'dist/node/index.js')).href);
const playwrightModule=process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright';
const imported=await import(playwrightModule.startsWith('file:')?playwrightModule:pathToFileURL(isAbsolute(playwrightModule)?playwrightModule:require.resolve(playwrightModule)).href),pw=imported.default??imported;
const sha=b=>createHash('sha256').update(b).digest('hex');
const sourceNames=['src/App.tsx','src/CompanyAccountGate.tsx','src/WorkspaceApp.tsx','src/TimeBillingWizard.tsx','src/timeBilling.ts','src/useWorkspaceRecovery.ts','src/companySync.tsx','src/bridge.ts','src-tauri/src/commands.rs','src-tauri/src/time_billing.rs','tests/mobile-harness.tsx','tests/app-draft-identity-fixture.ts','tests/time-billing-restore-lifecycle-fixture.ts','scripts/test-time-billing-restore-lifecycle.mjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(sourceNames.map(async n=>[n,sha(await readFile(join(desktop,n)))])));
const report={startedAt:new Date().toISOString(),node:{version:process.version,executable:process.execPath},mode:'normal followed sources; no product overlay',before:await hashes(),cases:[],closureErrors:[],limits:'Real App/Gate/SettingsScreen/TimeBillingWizard/act and production restore/create bridge/Tauri SDK. All state/ACK/DB are synthetic; no LocalStore/SQL executed. Billing command intentionally held before any simulated financial commit. No root setter or act replaced. Same-scope restore is a defensive component contract; normal native restore regenerates scope. Verified account replacement is synthetic, exercised after ACK while only final GET is held. No Cloud/native/device claim.'};
const original=await readFile(join(desktop,'tests/app-draft-identity-fixture.ts'),'utf8');
assert.equal(original.split('export function installAppDraftIdentityFixture(').length,2,'Expected identity fixture hook');
const injected=original.replace('export function installAppDraftIdentityFixture(','function originalIdentityFixture(')+"\nimport { installTimeBillingRestoreLifecycleFixture } from './time-billing-restore-lifecycle-fixture';\nexport function installAppDraftIdentityFixture(workspace: Workspace) { installTimeBillingRestoreLifecycleFixture(workspace,originalIdentityFixture); }\n";
const portProbe=freePort();await new Promise(ok=>portProbe.listen(0,'127.0.0.1',ok));const port=portProbe.address().port;await new Promise(ok=>portProbe.close(ok));assert.notEqual(port,5363,'User preview must remain untouched');
const origin='http://127.0.0.1:'+port;
const config=await vite.loadConfigFromFile({command:'serve',mode:'development'},join(desktop,'vite.config.ts'));
let server;
async function closeResource(resource,name){if(!resource)return;try{await resource.close();}catch(reason){report.closureErrors.push({resource:name,error:String(reason)});process.exitCode=1;}}
async function screen(page,label){await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill(label);await page.locator('.navigation-palette__results button').filter({has:page.getByText(label,{exact:true})}).click();await page.locator('.navigation-palette').waitFor({state:'detached'});}
const state=page=>page.evaluate(()=>({company:document.querySelector('.sidebar__company strong')?.textContent,rootInert:document.getElementById('root').inert,dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>e.textContent.slice(0,100)),database:window.__qaTimeBillingScope.database(),proof:structuredClone(window.__qaTimeBillingScope.proof),receiveAllowed:window.__qaTimeBillingScope.receiveAllowed()}));
try{
server=await vite.createServer({...config.config,configFile:false,root:desktop,plugins:[{name:'closed-time-billing-restore-fixture',enforce:'pre',load(id){if(id.replaceAll('\\','/').split('?')[0].endsWith('/tests/app-draft-identity-fixture.ts'))return injected;}},...config.config.plugins],cacheDir:join(tmpdir(),'time-billing-'+port),resolve:{...config.config.resolve,dedupe:['react','react-dom']},optimizeDeps:{entries:[join(desktop,'tests/mobile-harness.html')],noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react','qrcode.react','@tauri-apps/api/core','@tauri-apps/api/event','@tauri-apps/plugin-dialog','@tauri-apps/plugin-fs']},server:{host:'127.0.0.1',port,strictPort:true,hmr:false,watch:{ignored:['**/src-tauri/**']}},logLevel:'silent'});
await server.listen();report.origin=origin;for(const engine of ['chromium','webkit']){const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?process.env.ZENTRA_EDGE_PATH?{executablePath:process.env.ZENTRA_EDGE_PATH}:process.platform==='win32'?{channel:'msedge'}:{}:{})});try{for(const scenario of ['restore-navigation','current-modal-guard','recovery','late-account','picker','same-scope']){const row={engine,scenario,errors:[],consoleErrors:[],responses:[],blocked:[],confirmations:0};report.cases.push(row);const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);page.on('pageerror',e=>row.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')row.consoleErrors.push(m.text());});page.on('response',r=>{if(r.status()>=400)row.responses.push({status:r.status(),url:r.url()});});page.on('dialog',dialog=>{row.confirmations++;return dialog.accept();});await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===origin&&route.request().method()==='GET'&&!/^\/api(?:\/|$)/.test(u.pathname))return route.continue();row.blocked.push(u.origin+u.pathname);return route.abort();});try{
 await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
 await page.goto(origin+'/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1');
 await page.waitForFunction(()=>window.__qaAppDraftIdentity?.proof.identityReads.some(r=>r.pending));await page.evaluate(()=>{window.__qaAppDraftIdentity.identityMode('ready');for(const r of window.__qaAppDraftIdentity.proof.identityReads.filter(r=>r.pending))window.__qaAppDraftIdentity.releaseIdentity(r.id);});await page.locator('.desktop-app').waitFor();

 const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 if(scenario!=='current-modal-guard'){
  await screen(page,'Paramètres');
  if(scenario==='same-scope'){
   await page.locator('[data-settings-link=company]').click();
   assert.equal(await page.locator('input[name=legalName]').inputValue(),'UI COMPANY A');
   await page.locator('input[name=legalName]').fill('UNSAVED OLD FORM');
  }
  await page.locator('[data-settings-link=storage]').click();
  await page.evaluate(mode=>window.__qaTimeBillingScope.begin(mode),scenario);
  await page.locator('.manual-backup').getByRole('button',{name:'Restaurer',exact:true}).click();
  if(scenario==='picker'){
   await page.waitForFunction(()=>window.__qaTimeBillingScope.proof.pickerPending);
   await screen(page,'Temps');await page.evaluate(()=>window.__qaTimeBillingScope.releasePicker());await frames();
   row.after=await state(page);assert.equal(row.after.proof.restores,0);assert.equal(row.confirmations,0);assert.equal(row.after.company,'UI COMPANY A');assert.equal(row.after.proof.timeCommands.length,0);
  }else{
   await page.waitForFunction(()=>window.__qaTimeBillingScope.proof.restores===1);
   if(scenario!=='same-scope'){await screen(page,'Temps');assert(await page.getByRole('button',{name:/Facturer les heures/}).isDisabled());}
   await page.evaluate(()=>window.__qaTimeBillingScope.releaseRestore());
   if(scenario==='recovery'){
    await page.getByRole('dialog',{name:'Enregistrement effectué',exact:true}).waitFor();await page.waitForFunction(()=>document.getElementById('root').inert);
    row.recovery=await state(page);assert.equal(row.recovery.proof.reads,2);assert.equal(row.recovery.proof.restores,1);assert.equal(row.recovery.proof.timeCommands.length,0);assert.equal(row.recovery.receiveAllowed,false);assert(await page.locator('.time-hero__actions button').filter({hasText:'Facturer les heures'}).isDisabled());
    await page.getByRole('button',{name:'Actualiser les données',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.sidebar__company strong')?.textContent==='RESTORED COMPANY B');await page.getByRole('dialog').waitFor({state:'detached'});
    row.after=await state(page);assert.equal(row.after.proof.reads,3);assert.equal(row.after.proof.restores,1);assert.equal(row.after.proof.timeCommands.length,0);assert.equal(row.after.company,'RESTORED COMPANY B');
   }else if(scenario==='late-account'){
    await page.waitForFunction(()=>window.__qaTimeBillingScope.proof.readPending);
    await page.evaluate(()=>window.__qaTimeBillingScope.switchVerifiedAccount());
    await page.getByRole('button',{name:'Ouvrir l’espace du compte',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.sidebar__company strong')?.textContent==='CURRENT COMPANY C');
    row.beforeOldRead=await state(page);await page.evaluate(()=>window.__qaTimeBillingScope.releaseRead());await frames();
    row.after=await state(page);assert.equal(row.after.company,'CURRENT COMPANY C');assert.equal(row.after.database.scope,'synthetic-company-c');assert.equal(row.after.proof.restores,1);assert.equal(row.after.proof.reads,2);assert.equal(row.after.proof.timeCommands.length,0);assert.equal(row.after.proof.readPending,false);
   }else{
    await page.waitForFunction(()=>document.querySelector('.sidebar__company strong')?.textContent==='RESTORED COMPANY B');
    row.after=await state(page);assert.equal(row.after.proof.restores,1);assert.equal(row.after.proof.reads,1);
    if(scenario==='same-scope'){
     assert.equal(row.after.database.scope,'synthetic-company-a');await page.locator('[data-settings-link=company]').click();
     row.settingsName=await page.locator('input[name=legalName]').inputValue();assert.equal(row.settingsName,'RESTORED COMPANY B');assert.equal(row.after.proof.timeCommands.length,0);
    }else{
     await screen(page,'Temps');await page.getByRole('button',{name:/Facturer les heures/}).click();
     await page.getByRole('dialog',{name:'Facturer les heures',exact:true}).waitFor();await page.waitForFunction(()=>document.getElementById('root').inert);
     await page.getByRole('button',{name:'Créer la facture brouillon',exact:true}).click();await page.waitForFunction(()=>window.__qaTimeBillingScope.proof.timeCommands.length===1);row.after=await state(page);
     assert.equal(row.after.proof.timeCommands[0].databaseScope,'synthetic-restored-scope-b');assert.equal(row.after.company,'RESTORED COMPANY B');
    }
   }
  }
 }else{
  await screen(page,'Temps');await page.getByRole('button',{name:/Facturer les heures/}).click();
  await page.getByRole('dialog',{name:'Facturer les heures',exact:true}).waitFor();await page.waitForFunction(()=>document.getElementById('root').inert);
  row.beforeSubmit=await state(page);assert.equal(row.beforeSubmit.receiveAllowed,false);assert.equal(row.beforeSubmit.rootInert,true);
  await page.getByRole('button',{name:'Créer la facture brouillon',exact:true}).click();await page.waitForFunction(()=>window.__qaTimeBillingScope.proof.timeCommands.length===1);row.after=await state(page);assert.equal(row.after.proof.timeCommands[0].databaseScope,'synthetic-company-a');
 }
 await page.screenshot({path:join(out,'parent-final-'+engine+'-'+scenario+'.png')});assert.deepEqual(row.errors,[]);assert.deepEqual(row.blocked,[]);row.observed=true;

 }catch(e){row.failure=e.stack;try{row.failureState=await page.evaluate(()=>({text:document.body.innerText,identity:window.__qaAppDraftIdentity?.proof,time:window.__qaTimeBillingScope?.proof}));}catch(capture){row.captureFailure=String(capture);}throw e;}finally{await closeResource(page,'page '+engine+' '+scenario);}}}finally{await closeResource(browser,'browser '+engine);}}}catch(e){report.failure=e.stack;process.exitCode=1;}finally{await closeResource(server,'Vite server');report.resourcesClosed=report.closureErrors.length===0;report.after=await hashes();report.sourcesStable=JSON.stringify(report.before)===JSON.stringify(report.after);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));}assert(report.sourcesStable);assert(report.resourcesClosed);console.log(JSON.stringify({observed:report.cases.filter(r=>r.observed).length,cases:report.cases.length,failure:!!report.failure,resourcesClosed:report.resourcesClosed,sourcesStable:report.sourcesStable,report:join(out,'report.json')}));
