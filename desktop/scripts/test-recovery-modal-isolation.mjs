/** Real React DOM coverage for Recovery/shared Modal isolation. Closed local
 * fixture only: no workspace, account, API, native executable or clipboard use.
 * Optional: ZENTRA_NODE_PATH, ZENTRA_PLAYWRIGHT_MODULE, ZENTRA_EDGE_PATH,
 * ZENTRA_QA_OUTPUT. ZENTRA_QA_BEFORE_DIR may serve frozen baseline source bytes.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as freePortServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
if (process.env.ZENTRA_NODE_PATH && resolve(process.env.ZENTRA_NODE_PATH).toLowerCase() !== resolve(process.execPath).toLowerCase()) {
  const child = spawn(process.env.ZENTRA_NODE_PATH, [script], { stdio: 'inherit', env: { ...process.env, ZENTRA_NODE_PATH: '' } });
  process.exit(await new Promise((yes, no) => { child.once('error', no); child.once('exit', code => yes(code ?? 1)); }));
}
const desktop = resolve(dirname(script), '..');
const out = resolve(process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), `zentra-recovery-modal-isolation-${Date.now()}`));
await mkdir(out, { recursive: true });
const require = createRequire(join(desktop, 'package.json'));
const vite = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href);
const module = process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright';
const imported = await import(module.startsWith('file:') ? module : pathToFileURL(isAbsolute(module) ? module : require.resolve(module)).href);
const pw = imported.default ?? imported;
const sha = value => createHash('sha256').update(value).digest('hex');
const names = ['src/WorkspaceRecoveryDialog.tsx', 'src/ui.tsx', 'src/assistantContext.tsx', 'src/ErrorGuidance.tsx', 'src/language.ts', 'src/diagnostics.ts', 'src/userErrors.ts', 'scripts/test-recovery-modal-isolation.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(names.map(async name => [name, sha(await readFile(join(desktop, name)))])));
const overrides = new Map();
if (process.env.ZENTRA_QA_BEFORE_DIR) {
  for (const name of ['WorkspaceRecoveryDialog.tsx', 'ui.tsx']) overrides.set(resolve(desktop, 'src', name).replaceAll('\\', '/'), await readFile(join(process.env.ZENTRA_QA_BEFORE_DIR, name), 'utf8'));
}
const fixture = `
import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { Button, FormActions, Modal, ReadOnlyFormScope } from '/src/ui.tsx';
import { WorkspaceRecoveryDialog } from '/src/WorkspaceRecoveryDialog.tsx';
import { AssistantContext } from '/src/assistantContext.tsx';
const scenario = new URL(location.href).searchParams.get('scenario');
const proof = { reads: 0, writes: 0, dynamicClicks: 0, dismissals: 0 };
let release;
Object.assign(window, { __qaRecoveryFixture: { proof, release() { if (!release) throw Error('No pending synthetic read'); const done=release; release=undefined; done(); } } });
function Fixture() {
  const [recovery,setRecovery]=useState(false), [lower,setLower]=useState(false), [dynamic,setDynamic]=useState(false);
  const assistant={open(){setDynamic(true);},register(){},remove(){},setLauncherHost(){}};
  async function reload() {
    proof.reads++;
    if(scenario==='retry' && proof.reads===1)throw Error('La lecture des données reste indisponible.');
    if(scenario==='dynamic')setDynamic(true);
    await new Promise(done=>{release=done;});
    setRecovery(false);
  }
  return <AssistantContext.Provider value={assistant}>
    <ReadOnlyFormScope readOnly={scenario==='read-only'}>
      <h1>Isolation témoin</h1>
      <Button id="recovery-opener" onClick={()=>{if(scenario==='simultaneous'){setLower(true);setRecovery(true);}else if(scenario==='stacked'||scenario==='existing-attributes')setLower(true);else setRecovery(true);}}>Ouvrir la récupération</Button>
      <form onSubmit={event=>{event.preventDefault();proof.writes++;}}><input aria-label="Saisie conservée" defaultValue="Choix fictifs"/><FormActions busy={false} onCancel={()=>{}} submitLabel="Enregistrer témoin"/></form>
    </ReadOnlyFormScope>
    {lower&&<Modal title="Fiche témoin" assistantHelp={false} onClose={()=>{proof.dismissals++;setLower(false);}}>
      <input aria-label="Saisie de la fiche" defaultValue="Valeur intacte"/>
      <Button id="lower-recovery-opener" onClick={()=>setRecovery(true)}>Vérifier les données de la fiche</Button>
      <Button onClick={()=>setDynamic(true)}>Ajouter une région</Button>
    </Modal>}
    {recovery&&<WorkspaceRecoveryDialog reason="La lecture des données reste indisponible." onReload={reload}/>}
    {dynamic&&createPortal(<div id="dynamic-region"><Button onClick={()=>{proof.dynamicClicks++;}}>Région ajoutée</Button></div>,document.body)}
  </AssistantContext.Provider>;
}
Object.assign(window,{__TAURI_INTERNALS__:{invoke(command){throw Error('Native/API forbidden in modal-only fixture: '+command);}}});
createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
`;
const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>.modal-backdrop{position:fixed;inset:0;background:#eee8;display:grid;place-items:center}.modal{background:white;padding:20px;max-width:650px}button,input{margin:8px;padding:8px}</style></head><body><div id="root"></div><div id="existing-inert" inert aria-hidden="false">Isolation initiale</div><div id="existing-hidden" aria-hidden="true">Visibilité initiale</div><script type="module" src="/__recovery_modal_fixture.tsx"></script></body></html>';
const fixtureHash = sha(fixture), htmlHash = sha(html);
const report = { startedAt: new Date().toISOString(), before: await hashes(), fixtureHash, htmlHash, servedOverrides: Object.fromEntries([...overrides].map(([path, value])=>[path,sha(value)])), cases: [], limits: 'Real React DOM and production Recovery/Modal, including StrictMode effects. Controlled read callbacks only, no App/SDK/DB/session execution. No isolation attribute is forcibly removed, no inaccessible control is clicked, no production handler is replaced. A separate App/SDK acceptance case is owned by Settings.' };
const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, join(desktop, 'vite.config.ts'));
const probe = freePortServer(); await new Promise(ok=>probe.listen(0,'127.0.0.1',ok)); const port=probe.address().port; await new Promise(ok=>probe.close(ok));
assert.notEqual(port,5363); const origin=`http://127.0.0.1:${port}`;
const server=await vite.createServer({ ...loaded.config, configFile:false,root:desktop,
  plugins:[{name:'closed-recovery-modal-fixture',enforce:'pre',
    configureServer(server){server.middlewares.use((request,response,next)=>{if(request.url?.split('?')[0]==='/__recovery_modal_fixture.html'){response.setHeader('Content-Type','text/html');response.end(html);}else next();});},
    resolveId(id){if(id==='/__recovery_modal_fixture.tsx')return resolve(desktop,'__recovery_modal_fixture.tsx');},
    load(id){const path=id.replaceAll('\\','/').split('?')[0];if(path.endsWith('/__recovery_modal_fixture.tsx'))return fixture;if(overrides.has(path))return overrides.get(path);},
  },...loaded.config.plugins],
  cacheDir:join(tmpdir(),`zentra-recovery-modal-vite-${port}`),
  resolve:{...loaded.config.resolve,dedupe:['react','react-dom']},
  optimizeDeps:{entries:[],noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react','@tauri-apps/api/core']},
  server:{host:'127.0.0.1',port,strictPort:true,hmr:false,watch:{ignored:['**/src-tauri/**']}},logLevel:'silent',
});
async function attributes(page){return page.evaluate(()=>({root:{inert:document.getElementById('root').inert,hidden:document.getElementById('root').getAttribute('aria-hidden')},existing:[...document.querySelectorAll('[id^=existing-]')].map(node=>({id:node.id,inert:node.inert,hidden:node.getAttribute('aria-hidden')})),dynamic:document.getElementById('dynamic-region')?{inert:document.getElementById('dynamic-region').inert,hidden:document.getElementById('dynamic-region').getAttribute('aria-hidden')}:null,dialogs:[...document.querySelectorAll('[role=dialog]')].map(node=>({text:node.textContent.slice(0,40),isolated:!!node.closest('[inert]')})),focus:document.activeElement?.id,proof:structuredClone(window.__qaRecoveryFixture.proof)}));}
try {
  await server.listen(); report.origin=origin;
  for(const engine of ['chromium','webkit']){
    const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?process.env.ZENTRA_EDGE_PATH?{executablePath:process.env.ZENTRA_EDGE_PATH}:process.platform==='win32'?{channel:'msedge'}:{}:{})});
    try{for(const scenario of ['ordinary','retry','stacked','simultaneous','existing-attributes','dynamic','read-only']){
      const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}), item={engine,scenario,browserVersion:browser.version(),errors:[],blocked:[]};report.cases.push(item);page.setDefaultTimeout(5000);
      page.on('pageerror',error=>item.errors.push(error.message));
      await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(url.origin===origin&&request.method()==='GET'&&!/^\/api(?:\/|$)/.test(url.pathname))return route.continue();item.blocked.push({origin:url.origin,path:url.pathname,method:request.method()});return route.abort();});
      try{
        await page.goto(`${origin}/__recovery_modal_fixture.html?scenario=${scenario}`); const opener=page.getByRole('button',{name:'Ouvrir la récupération',exact:true});await opener.focus();item.initial=await attributes(page);await page.keyboard.press('Enter');
        if(scenario==='existing-attributes'){
          const lower=page.getByRole('dialog',{name:'Fiche témoin',exact:true});await lower.waitFor();await lower.evaluate(node=>node.focus());
          for(const key of [...Array(8).fill('Tab'),...Array(8).fill('Shift+Tab')]){await page.keyboard.press(key);assert.equal(await lower.evaluate(node=>node.contains(document.activeElement)),true);}
          item.open=await attributes(page);assert.equal(item.open.root.inert,true);assert.equal(item.open.root.hidden,'true');
          await page.keyboard.press('Escape');await lower.waitFor({state:'detached'});await page.waitForTimeout(40);item.after=await attributes(page);
          assert.deepEqual(item.after.root,item.initial.root);assert.deepEqual(item.after.existing,item.initial.existing);assert.equal(item.after.focus,'recovery-opener');assert.equal(item.after.proof.reads,0);assert.equal(item.after.proof.writes,0);assert.deepEqual(item.errors,[]);assert.deepEqual(item.blocked,[]);item.passed=true;
          console.log(JSON.stringify({engine,scenario,passed:true}));continue;
        }
        if(scenario==='stacked'){const childOpener=page.getByRole('button',{name:'Vérifier les données de la fiche',exact:true});await childOpener.focus();await page.keyboard.press('Enter');}
        const recovery=page.getByRole('dialog',{name:'Enregistrement effectué',exact:true});await recovery.waitFor();const reload=recovery.getByRole('button',{name:'Actualiser les données',exact:true});await reload.focus();await page.keyboard.press('Escape');assert.equal(await recovery.count(),1,'Recovery remains nondismissible');
        await recovery.evaluate(node=>node.focus());
        for(const key of [...Array(8).fill('Tab'),...Array(8).fill('Shift+Tab')]){await page.keyboard.press(key);assert.equal(await recovery.evaluate(node=>node.contains(document.activeElement)),true,'Recovery traps keyboard focus');}
        await page.waitForTimeout(40);item.open=await attributes(page);assert.equal(item.open.root.inert,true);assert.equal(item.open.root.hidden,'true');
        if(scenario==='stacked'||scenario==='simultaneous'){assert.equal(await page.getByRole('dialog',{name:'Fiche témoin',exact:true}).count(),0);assert.equal(item.open.dialogs.find(node=>node.text.startsWith('Fiche témoin')).isolated,true);}
        await reload.click();
        if(scenario==='retry'){await recovery.getByText('Actualisation impossible',{exact:true}).waitFor();await page.waitForFunction(()=>window.__qaRecoveryFixture.proof.reads===1);await page.waitForTimeout(40);await reload.click();}
        const expectedReads=scenario==='retry'?2:1;await page.waitForFunction(count=>window.__qaRecoveryFixture.proof.reads===count,expectedReads);
        if(scenario==='dynamic'){await page.waitForTimeout(40);item.dynamicOpen=await attributes(page);assert.deepEqual(item.dynamicOpen.dynamic,{inert:true,hidden:'true'},'New body region stays isolated while Recovery is active');assert.equal(await page.getByRole('button',{name:'Région ajoutée',exact:true}).count(),0);}
        await page.evaluate(()=>window.__qaRecoveryFixture.release());await recovery.waitFor({state:'detached'});await page.waitForTimeout(40);item.afterRecovery=await attributes(page);
        if(scenario==='stacked'||scenario==='simultaneous'){
          const lower=page.getByRole('dialog',{name:'Fiche témoin',exact:true});await lower.waitFor();assert.equal(item.afterRecovery.root.inert,true,'Lower layer continues isolating the root');
          if(scenario==='stacked')assert.equal(item.afterRecovery.focus,'lower-recovery-opener','Focus returns into lower modal');
          else assert.equal(await lower.evaluate(node=>node.contains(document.activeElement)),true,'Focus returns into simultaneous lower modal');
          assert.equal(await lower.getByRole('textbox',{name:'Saisie de la fiche',exact:true}).inputValue(),'Valeur intacte');
          if(scenario==='simultaneous'){await lower.getByRole('button',{name:'Ajouter une région',exact:true}).click();await page.waitForTimeout(40);item.dynamicLower=await attributes(page);assert.deepEqual(item.dynamicLower.dynamic,{inert:true,hidden:'true'},'Reactivated lower protects new body children even if its first RAF was skipped');}
          await page.keyboard.press('Escape');await lower.waitFor({state:'detached'});await page.waitForTimeout(40);
        }
        item.after=await attributes(page);assert.deepEqual(item.after.root,item.initial.root,'No root isolation survives final closure');assert.deepEqual(item.after.existing,item.initial.existing,'Existing body attributes survive unchanged');assert.equal(item.after.proof.reads,expectedReads);assert.equal(item.after.proof.writes,0);assert.equal(item.after.dialogs.length,0);assert.equal(await opener.isEnabled(),true);
        if(scenario==='dynamic'){assert.deepEqual(item.after.dynamic,{inert:false,hidden:null});await page.getByRole('button',{name:'Région ajoutée',exact:true}).click();assert.equal((await attributes(page)).proof.dynamicClicks,1);}
        if(scenario==='read-only'){assert.equal(await page.getByRole('button',{name:'Enregistrer témoin',exact:true}).isDisabled(),true);await page.getByText('Mode lecture seule : les modifications ne peuvent pas être enregistrées.',{exact:true}).waitFor();}
        if(scenario!=='dynamic')assert.equal(item.after.focus,'recovery-opener','Focus returns to the original launcher');
        assert.deepEqual(item.errors,[]);assert.deepEqual(item.blocked,[]);item.passed=true;
      }catch(error){item.failure={name:error.name,message:error.message,stack:error.stack};item.final=await attributes(page).catch(()=>null);}
      finally{await page.close();}
      console.log(JSON.stringify({engine,scenario,passed:!!item.passed,failure:item.failure?.message}));
    }}finally{await browser.close();}
  }
  report.after=await hashes();assert.deepEqual(report.after,report.before,'Source bytes unchanged during DOM coverage');
  report.failed=report.cases.filter(item=>!item.passed).length;if(report.failed)process.exitCode=1;
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;}
finally{await server.close();report.previewClosed=true;report.finishedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output:out,cases:report.cases.length,failed:report.failed,failure:report.failure,previewClosed:true}));}
