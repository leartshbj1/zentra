/** Real App/React/SDK regression; synthetic transport only, no native/SMTP/account/API.
 * Node/Playwright/Edge paths and evidence output are configurable through ZENTRA_* env.
 * The production callback is never overlaid or extracted by this maintained runner.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer as freePortServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const script=fileURLToPath(import.meta.url);
if(process.env.ZENTRA_NODE_PATH&&resolve(process.env.ZENTRA_NODE_PATH).toLowerCase()!==resolve(process.execPath).toLowerCase()){const child=spawn(process.env.ZENTRA_NODE_PATH,[script],{stdio:'inherit',env:{...process.env,ZENTRA_NODE_PATH:''}});process.exit(await new Promise((yes,no)=>{child.once('error',no);child.once('exit',code=>yes(code??1));}));}
const desktop=resolve(dirname(script),'..');
const out=resolve(process.env.ZENTRA_QA_OUTPUT||join(tmpdir(),'zentra-mail-settings-lifecycle-'+Date.now()));await mkdir(out,{recursive:true});
const require=createRequire(join(desktop,'package.json'));
const vite=await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')),'dist/node/index.js')).href);
const pwPath=process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright';
const module=await import(pwPath.startsWith('file:')?pwPath:pathToFileURL(isAbsolute(pwPath)?pwPath:require.resolve(pwPath)).href),pw=module.default??module;
const sha=data=>createHash('sha256').update(data).digest('hex');
const names=['src/App.tsx','src/WorkspaceApp.tsx','src/MailSettings.tsx','src/outgoingMail.ts','src/OutgoingMailEntry.tsx','src/CompanyAccountGate.tsx','src/CompanySettingsSync.tsx','src/SettingsCategory.tsx','src/bridge.ts','src/companySync.tsx','src/ui.tsx','tests/app-draft-identity-fixture.ts','tests/mobile-harness.tsx','tests/mail-settings-lifecycle-fixture.ts','scripts/test-mail-settings-lifecycle.mjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(names.map(async name=>[name,sha(await readFile(join(desktop,name)))])));
const knownScenarios=['late-switch','foreign','same-space-navigation','current','permission-refused','read-only','refresh-rejected','late-ack-switch','late-ack-navigation','recovery-current','recovery-foreign-fallback','recovery-foreign-retry'];
const scenarios=process.env.ZENTRA_QA_SCENARIOS?process.env.ZENTRA_QA_SCENARIOS.split(','):knownScenarios;
assert.ok(scenarios.every(name=>knownScenarios.includes(name)),'Unknown closed-fixture scenario');
const engines=(process.env.ZENTRA_QA_ENGINES||'chromium,webkit').split(',');
assert.ok(engines.every(name=>['chromium','webkit'].includes(name)),'Unknown browser engine');
const report={startedAt:new Date().toISOString(),before:await hashes(),cases:[],contract:'True App/SettingsScreen/MailSettings/desktopApi/outgoingMail/SDK, synthetic raw responses only. No native DB acceptance or actual session replacement is certified.'};
const correctedBehavior=true;
const original=await readFile(join(desktop,'tests/app-draft-identity-fixture.ts'),'utf8');
const injected=original.replace('export function installAppDraftIdentityFixture(','function installOriginalAppDraftIdentityFixture(')+"\nimport {installMailSettingsAuditFixture} from '/tests/mail-settings-lifecycle-fixture.ts';\nexport function installAppDraftIdentityFixture(workspace:Workspace){installMailSettingsAuditFixture(workspace,installOriginalAppDraftIdentityFixture);}\n";
const loaded=await vite.loadConfigFromFile({command:'serve',mode:'development'},join(desktop,'vite.config.ts'));
const probe=freePortServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));assert.notEqual(port,5363);
const origin='http://127.0.0.1:'+port;
const server=await vite.createServer({...loaded.config,configFile:false,root:desktop,plugins:[{name:'closed-mail-settings-audit',enforce:'pre',
load(id){if(id.replaceAll('\\','/').split('?')[0].endsWith('/tests/app-draft-identity-fixture.ts'))return injected;}},...loaded.config.plugins],
cacheDir:join(tmpdir(),'zentra-mail-settings-'+port),resolve:{...loaded.config.resolve,dedupe:['react','react-dom']},
optimizeDeps:{entries:[join(desktop,'tests/mobile-harness.html')],noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react','qrcode.react','@tauri-apps/api/core','@tauri-apps/api/event','@tauri-apps/plugin-dialog','@tauri-apps/plugin-fs']},
server:{host:'127.0.0.1',port,strictPort:true,hmr:false,watch:{ignored:['**/src-tauri/**']}},logLevel:'silent'});
async function screen(page,label){await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill(label);await page.locator('.navigation-palette__results button').filter({has:page.getByText(label,{exact:true})}).click();await page.locator('.navigation-palette').waitFor({state:'detached'});}
async function snapshot(page){return page.evaluate(()=>({...window.__qaMailSettings.state(),company:document.querySelector('.sidebar__company strong')?.textContent,desktop:!!document.querySelector('.desktop-app'),visibleNewClient:document.body.textContent.includes('CLIENT ADMITTED AFTER MAIL'),visibleB:document.body.textContent.includes('Client fictif B'),notice:document.querySelector('.mail-notice')?.textContent,error:document.querySelector('.mail-settings .error-panel')?.textContent,gate:document.querySelector('.company-account-opening')?.textContent,rootInert:document.getElementById('root')?.inert,choices:structuredClone(window.__qaAppDraftIdentity.proof.companyResolutions),pendingIdentities:window.__qaAppDraftIdentity.proof.identityReads.filter(r=>r.pending).length}));}
try{
 await server.listen();report.origin=origin;
 for(const engine of engines){
  const browser=await pw[engine].launch({headless:true,...engine==='chromium'?(process.env.ZENTRA_EDGE_PATH?{executablePath:process.env.ZENTRA_EDGE_PATH}:process.platform==='win32'?{channel:'msedge'}:{}):{}});
  try{for(const scenario of scenarios){
   const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(12000);
   const item={engine,scenario,browserVersion:browser.version(),errors:[],blockedRequests:[]};report.cases.push(item);
   page.on('pageerror',e=>item.errors.push(e.message));
   await page.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(url.origin===origin&&req.method()==='GET'&&!/^\/api(?:\/|$)/.test(url.pathname))return route.continue();item.blockedRequests.push({method:req.method(),pathname:url.pathname,origin:url.origin});return route.abort();});
   await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
   try{
    await page.goto(origin+'/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__qaAppDraftIdentity?.proof.identityReads.some(r=>r.pending));
    await page.evaluate(()=>{window.__qaAppDraftIdentity.identityMode('ready');for(const r of window.__qaAppDraftIdentity.proof.identityReads.filter(r=>r.pending))window.__qaAppDraftIdentity.releaseIdentity(r.id);});
    await page.locator('.desktop-app').waitFor();await screen(page,'Paramètres');await page.locator('[data-settings-link=mail]').click();
    const mail=page.locator('.mail-settings');await mail.getByRole('button',{name:'Devis',exact:true}).click();
    const form=mail.locator('form');
    if(scenario==='read-only'){
     await page.evaluate(()=>window.__qaMailSettings.makeReadOnly());await page.getByText('Accès « Lecture seule » : consultation et exports autorisés, modifications bloquées sur ce poste.',{exact:true}).waitFor();
     assert.equal(await form.getByRole('button',{name:'Enregistrer les modèles',exact:true}).isDisabled(),true);
     await form.evaluate(f=>f.requestSubmit());item.after=await snapshot(page);assert.equal(item.after.proof.saveCalls,0);item.controlPassed=true;
    }else{
     await form.locator('input').first().fill('SYNTHETIC SAVED QUOTE A');
     await page.evaluate(mode=>window.__qaMailSettings.begin(mode),scenario);
     await form.getByRole('button',{name:'Enregistrer les modèles',exact:true}).click();
     await page.waitForFunction(()=>window.__qaMailSettings.proof.saveCalls===1);
     if(['permission-refused','current'].includes(scenario)){
      await page.waitForFunction(()=>document.querySelector('.mail-settings button[type=submit]')?.textContent.includes('Enregistrer'));
      item.after=await snapshot(page);assert.equal(item.after.proof.saveCalls,1);assert.equal(item.after.proof.accepted,scenario==='current'?1:0);
      if(scenario==='current')assert.ok(item.after.notice?.includes('Modèles enregistrés'));else assert.equal(item.after.notice,undefined);
      item.controlPassed=true;
     }else if(scenario.startsWith('late-ack-')){
      await page.waitForFunction(()=>window.__qaMailSettings.proof.saveAckPending);await form.evaluate(f=>f.requestSubmit());item.pending=await snapshot(page);assert.equal(item.pending.proof.saveCalls,1);
      if(scenario==='late-ack-switch'){await page.evaluate(()=>window.__qaMailSettings.switchVerifiedAccount());await page.getByRole('button',{name:'Ouvrir l’espace du compte',exact:true}).click();await page.locator('.desktop-app').waitFor();await screen(page,'Clients');await page.getByText('Client fictif B',{exact:true}).first().waitFor();}else await screen(page,'Clients');
      item.beforeRelease=await snapshot(page);await page.evaluate(()=>window.__qaMailSettings.releaseAck());await page.waitForTimeout(250);item.after=await snapshot(page);
      item.oracle={noPostUnmountRead:item.after.proof.reads.length===item.beforeRelease.proof.reads.length,oneMailSave:item.after.proof.accepted===1};assert.ok(item.oracle.noPostUnmountRead,'Stale callback must not admit a new GET');assert.equal(item.after.notice,undefined);item.controlPassed=true;
     }else{
      await page.waitForFunction(()=>window.__qaMailSettings.proof.reads.some(r=>r.afterMailSave&&r.pending));
      const late=await page.evaluate(()=>window.__qaMailSettings.proof.reads.find(r=>r.afterMailSave&&r.pending).id);
      await form.evaluate(f=>f.requestSubmit());item.pending=await snapshot(page);assert.equal(item.pending.proof.saveCalls,1,'Double submit never repeats save');assert.equal(item.pending.receiveAllowed,false,'Ordinary reception blockers preserved');
      if(scenario.startsWith('recovery-')){
       async function heldRead(){await page.waitForFunction(()=>window.__qaMailSettings.proof.reads.some(r=>r.afterMailSave&&r.pending));return page.evaluate(()=>window.__qaMailSettings.proof.reads.find(r=>r.afterMailSave&&r.pending).id);}
       await page.evaluate(id=>window.__qaMailSettings.settle(id,true),late);const fallback=await heldRead();
       await page.evaluate(({id,failure})=>window.__qaMailSettings.settle(id,failure),{id:fallback,failure:scenario!=='recovery-foreign-fallback'});
       const recovery=page.getByRole('dialog',{name:'Enregistrement effectué',exact:true});await recovery.waitFor();item.beforeRecovery=await snapshot(page);assert.equal(item.beforeRecovery.company,'Atelier du Léman');assert.equal(item.beforeRecovery.proof.accepted,1);
       if(scenario==='recovery-foreign-retry'){
        await page.evaluate(()=>window.__qaMailSettings.nextForeignRead());await recovery.getByRole('button',{name:'Actualiser les données',exact:true}).click();const foreign=await heldRead();await page.evaluate(id=>window.__qaMailSettings.settle(id),foreign);await page.waitForTimeout(200);item.afterForeignRetry=await snapshot(page);assert.equal(item.afterForeignRetry.company,'Atelier du Léman');assert.ok(await recovery.isVisible());
       }
       if(scenario!=='recovery-current')await page.evaluate(()=>window.__qaMailSettings.restoreOrigin());
       await recovery.getByRole('button',{name:'Actualiser les données',exact:true}).click();const useful=await heldRead();await page.evaluate(id=>window.__qaMailSettings.settle(id),useful);await recovery.waitFor({state:'detached'});await page.waitForFunction(()=>document.querySelector('.mail-settings button[type=submit]')?.textContent.includes('Enregistrer'));
       item.after=await snapshot(page);assert.equal(item.after.company,'Atelier du Léman');assert.equal(item.after.proof.saveCalls,1);assert.equal(item.after.proof.accepted,1);assert.ok(item.after.notice?.includes('Modèles enregistrés'));assert.equal(await form.locator('input').first().inputValue(),'SYNTHETIC SAVED QUOTE A');assert.equal(item.after.rootInert,false);item.controlPassed=true;
      }else if(scenario==='late-switch'){
       await page.evaluate(()=>window.__qaMailSettings.switchVerifiedAccount());const choose=page.getByRole('button',{name:'Ouvrir l’espace du compte',exact:true});await choose.waitFor();
       item.gateBeforeClick=await snapshot(page);assert.equal(item.gateBeforeClick.rootInert,false);
       await choose.click();await page.locator('.desktop-app').waitFor();await screen(page,'Clients');await page.getByText('Client fictif B',{exact:true}).first().waitFor();
       item.beforeRelease=await snapshot(page);assert.equal(item.beforeRelease.database.scope,'synthetic-company-b');assert.equal(item.beforeRelease.company,'SYNTHETIC COMPANY B');
       await page.evaluate(id=>window.__qaMailSettings.settle(id),late);await page.waitForTimeout(250);item.after=await snapshot(page);
       item.oracle={preservesB:item.after.company==='SYNTHETIC COMPANY B'&&item.after.visibleB,noOldNotice:item.after.notice===undefined,oneSave:item.after.proof.accepted===1};item.defectReproduced=!item.oracle.preservesB;item.verdict=item.defectReproduced?'RED':'GREEN';
      }else if(scenario==='foreign'){
       item.beforeRelease=await snapshot(page);assert.notEqual(item.beforeRelease.company,'FOREIGN MAIL COMPANY B');
       await page.evaluate(id=>window.__qaMailSettings.settle(id),late);await page.waitForTimeout(250);item.after=await snapshot(page);
       item.oracle={rejectsForeignRead:item.after.company===item.beforeRelease.company&&!item.after.gate?.includes('FOREIGN MAIL COMPANY B'),oneSave:item.after.proof.accepted===1};item.defectReproduced=!item.oracle.rejectsForeignRead;item.verdict=item.defectReproduced?'RED':'GREEN';
      }else if(scenario==='same-space-navigation'){
       await screen(page,'Clients');const create=page.getByRole('button',{name:'Nouveau client',exact:true});if(correctedBehavior&&await create.isDisabled()){item.concurrentWriteBlocked=true;item.beforeRelease=await snapshot(page);await page.evaluate(id=>window.__qaMailSettings.settle(id),late);await page.waitForTimeout(250);assert.equal(await create.isEnabled(),true,'Read busy releases after old screen cleanup');}
       await create.click();const dialog=page.getByRole('dialog',{name:'Nouveau client',exact:true});
       if(correctedBehavior&&await dialog.locator('[name=company]').isDisabled()){item.concurrentWriteBlocked=true;item.blockedForm=await snapshot(page);await page.evaluate(id=>window.__qaMailSettings.settle(id),late);await page.waitForFunction(()=>!document.querySelector('[role=dialog] input[name=company]')?.disabled);}
       await dialog.locator('[name=company]').fill('CLIENT ADMITTED AFTER MAIL');await dialog.locator('[name=street]').fill('Rue fictive 1');await dialog.locator('[name=postalCode]').fill('1000');await dialog.locator('[name=city]').fill('Lausanne');await dialog.locator('[name=country]').selectOption('CH');
       await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'detached'});await page.getByText('CLIENT ADMITTED AFTER MAIL',{exact:true}).first().waitFor();item.beforeRelease=await snapshot(page);
       if(!item.concurrentWriteBlocked)await page.evaluate(id=>window.__qaMailSettings.settle(id),late);await page.waitForTimeout(250);item.after=await snapshot(page);
       item.oracle={preservesNewClient:item.after.visibleNewClient,databaseRetainsClient:item.after.database.clients.some(c=>c.company==='CLIENT ADMITTED AFTER MAIL'),oneMailSave:item.after.proof.accepted===1,oneClientWrite:item.after.proof.clientWrites===1};item.defectReproduced=!item.oracle.preservesNewClient;item.verdict=item.defectReproduced?'RED':'GREEN';
      }else if(scenario==='refresh-rejected'){
       await page.evaluate(id=>window.__qaMailSettings.settle(id,true),late);await page.waitForTimeout(250);item.after=await snapshot(page);assert.ok(item.after.notice?.includes('Modèles enregistrés'));assert.equal(item.after.proof.accepted,1);assert.equal(item.after.proof.saveCalls,1);assert.equal(item.after.proof.reads.filter(r=>r.afterMailSave).length,correctedBehavior?2:1);item.controlPassed=true;
      }
     }
    }
    assert.equal(item.after.proof.reads.filter(r=>r.pending).length,0);assert.deepEqual(item.errors,[]);assert.deepEqual(item.blockedRequests,[]);assert.ok(!item.after.proof.commands.some(c=>['send_outgoing_mail','send_shared_mail','connect_outgoing_mail'].includes(c)));if(scenario!=='read-only')assert.deepEqual(item.after.proof.saveScopes,['mail-a']);if(item.controlPassed)item.verdict='GREEN-control';assert.notEqual(item.defectReproduced,true,'Old or foreign mail refresh must not publish');
    await page.screenshot({path:join(out,engine+'-'+scenario+'.png')});item.completed=true;
   }catch(error){process.exitCode=1;item.fixtureFailure={name:error.name,message:error.message,stack:error.stack};item.after=await snapshot(page).catch(()=>null);await page.screenshot({path:join(out,engine+'-'+scenario+'-fixture-failure.png')}).catch(()=>{});}
   finally{await page.close();}console.log(JSON.stringify({engine,scenario,completed:item.completed,verdict:item.verdict,failure:item.fixtureFailure??null}));
  }}finally{await browser.close();}
 }
 report.after=await hashes();assert.deepEqual(report.after,report.before,'Tracked source bytes unchanged');
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;}
finally{await server.close();report.previewClosed=true;report.finishedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output:out,cases:report.cases.length,red:report.cases.filter(i=>i.verdict==='RED').length,controls:report.cases.filter(i=>i.controlPassed).length,fixtureFailures:report.cases.filter(i=>i.fixtureFailure).length,previewClosed:true}));}
