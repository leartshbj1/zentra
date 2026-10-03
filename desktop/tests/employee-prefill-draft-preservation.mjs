/** Actual App/EmployeeForm/import/provider: an analysis cannot replace newer input.
 * Worker and account/IPC fixtures are closed;
 * no model, API, native mutation or duplicate implementation of applyDocument.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer as freePortServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
let root=process.env.ZENTRA_QA_REPO?resolve(process.env.ZENTRA_QA_REPO):dirname(fileURLToPath(import.meta.url));
while(!existsSync(join(root,'desktop/package.json'))){const parent=dirname(root);assert.notEqual(parent,root,'Set ZENTRA_QA_REPO to the Zentra checkout');root=parent;}
const desktop=join(root,'desktop'),require=createRequire(join(desktop,'package.json'));
const vite=await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')),'dist/node/index.js')).href);
const imported=await import(pathToFileURL(process.env.ZENTRA_PLAYWRIGHT_MODULE||require.resolve('playwright')).href),pw=imported.default??imported;
const out=process.env.ZENTRA_QA_OUTPUT||join(tmpdir(),'zentra-employee-prefill-draft-preservation');await mkdir(out,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourcePaths=['src/App.tsx','src/WorkspaceApp.tsx','src/EmployeeDocumentImport.tsx','src/payrollLocalAi.ts','src/useFormDraft.tsx','src/useNativeFormDraft.ts','src/formDrafts.ts','src/bridge.ts','tests/mobile-harness.tsx','tests/app-draft-identity-fixture.ts'];
const hashes=async()=>Object.fromEntries(await Promise.all(sourcePaths.map(async name=>[name,sha(await readFile(join(desktop,name)))])));
const before=await hashes(),override=process.env.ZENTRA_QA_WORKSPACE_OVERRIDE;
const workspaceSource=override?await readFile(override,'utf8'):undefined;
const originalIdentity=await readFile(join(desktop,'tests/app-draft-identity-fixture.ts'),'utf8');
assert.equal(originalIdentity.split('export function installAppDraftIdentityFixture(').length,2);
const fixture=originalIdentity.replace('export function installAppDraftIdentityFixture(','function installOriginalAppDraftIdentityFixture(')+`
export function installAppDraftIdentityFixture(workspace:Workspace){
 installOriginalAppDraftIdentityFixture(workspace);
 const qa=(window as any).__qaAppDraftIdentity;qa.identityMode('ready');qa.accountMode('ready');
 const native=(window as any).__TAURI_INTERNALS__,previous=native.invoke;
 const proof={calls:[] as any[],writes:[] as string[],blocked:[] as string[]};
 native.invoke=async(command:string,args:any)=>{
  proof.calls.push({command,args:args??null});
  if(['get_form_draft_identity','append_diagnostic_events'].includes(command))return previous(command,args);
  if(['automation_request','supplier_inbox_request','appointment_inbox_request'].includes(command)&&args?.data==null)return previous(command,args);
  if(command==='get_company_sync_state')return{enabled:false,organizationId:'automation-qa'};
  proof.blocked.push(command);if(/update|create|save|confirm|delete|record|stage|apply/.test(command))proof.writes.push(command);
  throw Error('Closed employee prefill fixture blocks '+command);
 };
 (window as any).__qaEmployeePrefill={proof,scope:workspace.workNotesScope,member:'synthetic-member-a'};
}
`;
const scenarios=(process.env.ZENTRA_QA_CASES||'late-salary,late-mode,empty-control,prefilled-control').split(',');
assert(scenarios.every(value=>['late-salary','late-mode','empty-control','prefilled-control'].includes(value)));
const engines=(process.env.ZENTRA_QA_ENGINES||'chromium,webkit').split(',');assert(engines.every(value=>['chromium','webkit'].includes(value)));
const report={startedAt:new Date().toISOString(),before,override:override?{path:override,sha256:sha(workspaceSource)}:null,fixtureSha256:sha(fixture),cases:[],limits:[
 'Actual React App/EmployeeForm/EmployeeDocumentImport/payrollLocalAi and draft hooks; only closed IPC/account fixture and controlled Worker.',
 'Generated 1x1 PNG executes the real image preparation path. No model/OCR/API, native SQL or customer/account data.',
 'Ordinary user fill/select/click only. No setter/onRead replacement, React hook mock, or copied salary logic.',
 'Optional source override exists only to evaluate an explicitly supplied reviewed candidate; default runs tracked product source.'
]};
const snapshot=page=>page.evaluate(()=>({
 fields:Object.fromEntries([...document.querySelectorAll('.employee-form input,.employee-form select')].filter(node=>['name','role','salaryMode','grossSalary'].includes(node.name)).map(node=>[node.name,node.value])),
 drafts:Object.keys(localStorage).filter(key=>key.startsWith('zentra.forms.drafts.v1.')).map(key=>({key,record:JSON.parse(localStorage.getItem(key))})),
 analysis:structuredClone(window.__qaEmployeeWorker.proof),transport:structuredClone(window.__qaEmployeePrefill),
}));
const portProbe=freePortServer();await new Promise(ok=>portProbe.listen(0,'127.0.0.1',ok));const port=portProbe.address().port;await new Promise(ok=>portProbe.close(ok));assert.notEqual(port,5363);
const origin=`http://127.0.0.1:${port}`,loaded=await vite.loadConfigFromFile({command:'serve',mode:'development'},join(desktop,'vite.config.ts'));
const server=await vite.createServer({...loaded.config,configFile:false,root:desktop,cacheDir:join(tmpdir(),`zentra-employee-prefill-${port}`),
 plugins:[{name:'closed-employee-prefill-preservation',enforce:'pre',load(id){const path=id.replaceAll('\\','/').split('?')[0];if(path.endsWith('/tests/app-draft-identity-fixture.ts'))return fixture;if(workspaceSource&&path.endsWith('/src/WorkspaceApp.tsx'))return workspaceSource;}},...loaded.config.plugins],
 optimizeDeps:{entries:[join(desktop,'tests/mobile-harness.html')],noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react','qrcode.react','@tauri-apps/api/core','@tauri-apps/api/event','@tauri-apps/plugin-dialog','@tauri-apps/plugin-fs']},
 resolve:{...loaded.config.resolve,dedupe:['react','react-dom']},server:{host:'127.0.0.1',port,strictPort:true,hmr:false,watch:{ignored:['**/src-tauri/**']}},logLevel:'silent'});
try{
 await server.listen();
 for(const engine of engines){
  const executable=engine==='chromium'?process.env.ZENTRA_EDGE_PATH:process.env.ZENTRA_WEBKIT_PATH;
  const browser=await pw[engine].launch({headless:true,...(executable?{executablePath:executable}:engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
  try{for(const mode of scenarios){
   const row={mode,engine,version:browser.version(),errors:[],external:[]};report.cases.push(row);
   const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(12000);
   page.on('pageerror',error=>row.errors.push(error.message));
   await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(url.origin===origin&&request.method()==='GET'&&!/^\/api(?:\/|$)/.test(url.pathname))return route.continue();row.external.push(url.origin+url.pathname);return route.abort();});
   await page.addInitScript(()=>{
    localStorage.setItem('elyko-guided-tour-v3','completed');
    const proof={messages:[],terminated:0,releases:0},workers=[];
    class ControlledWorker{
     listeners=new Map();terminated=false;request=null;
     constructor(url){if(!String(url).includes('payrollAi.worker'))throw Error('Unapproved Worker');workers.push(this);}
     addEventListener(type,callback){this.listeners.set(type,[...(this.listeners.get(type)||[]),callback]);}
     postMessage(message){proof.messages.push(structuredClone(message));if(message.type!=='analyze')throw Error('Unexpected worker command');this.request=message;}
     terminate(){if(!this.terminated){this.terminated=true;proof.terminated++;}}
     emit(data){for(const listener of this.listeners.get('message')||[])listener({data});}
    }
    window.Worker=ControlledWorker;
    window.__qaEmployeeWorker={proof,release(){const worker=workers.find(worker=>worker.request&&!worker.terminated);if(!worker)throw Error('No pending analysis');proof.releases++;worker.emit({type:'analysis',requestId:worker.request.requestId,primaryOutput:'{}',mode:'wasm',employeeDraft:{fields:{name:'SYNTHETIC IMPORTED NAME',role:'SYNTHETIC IMPORTED ROLE',salaryMode:'monthly',grossSalary:'5000'},warnings:[]}});}};
   });
   try{
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1`);
    await page.locator('.desktop-app').waitFor();await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Équipe & salaires');
    await page.locator('.navigation-palette__results button').filter({has:page.getByText('Équipe & salaires',{exact:true})}).click();
    await page.getByRole('button',{name:'Nouvelle fiche de personnel',exact:true}).click();await page.locator('.employee-form').waitFor();const form=page.locator('.employee-form');
    if(mode==='prefilled-control'){
     await form.locator('input[name=name]').fill('SYNTHETIC MANUAL NAME');await form.locator('input[name=role]').fill('SYNTHETIC MANUAL ROLE');await form.getByRole('button',{name:'Continuer',exact:true}).click();
     await form.locator('select[name=salaryMode]').selectOption('monthly');await form.locator('input[name=grossSalary]').fill('6500');await form.getByRole('button',{name:'Retour',exact:true}).click();
    }
    const image=Buffer.from(await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const context=canvas.getContext('2d');if(!context)throw Error('Synthetic image fixture has no canvas');context.fillStyle='#fff';context.fillRect(0,0,1,1);return canvas.toDataURL('image/png').split(',')[1];}),'base64');
    await form.getByText('Préremplir avec une fiche de salaire existante',{exact:true}).click();await form.locator('.employee-document-import input[type=file]').setInputFiles({name:'synthetic-only.png',mimeType:'image/png',buffer:image});
    await page.waitForFunction(()=>window.__qaEmployeeWorker.proof.messages.some(message=>message.type==='analyze'));
    if(mode==='late-salary'||mode==='late-mode'){
     await form.locator('input[name=name]').fill('SYNTHETIC MANUAL NAME');await form.locator('input[name=role]').fill('SYNTHETIC MANUAL ROLE');await form.getByRole('button',{name:'Continuer',exact:true}).click();
     await form.locator('select[name=salaryMode]').selectOption(mode==='late-mode'?'hourly':'monthly');if(mode==='late-salary')await form.locator('input[name=grossSalary]').fill('6500');
    }
    row.held=await snapshot(page);await page.evaluate(()=>window.__qaEmployeeWorker.release());
    await page.waitForFunction(()=>window.__qaEmployeeWorker.proof.terminated===1);await page.waitForTimeout(150);row.after=await snapshot(page);
    assert.deepEqual(row.errors,[]);assert.deepEqual(row.external,[]);assert.deepEqual(row.after.transport.proof.writes,[]);assert.deepEqual(row.after.transport.proof.blocked,[]);
    assert.equal(row.after.analysis.releases,1);assert.equal(row.after.analysis.messages.filter(message=>message.type==='analyze').length,1);assert.equal(row.after.transport.scope,'synthetic-company-a');
    const expectedSalary=mode==='late-salary'||mode==='prefilled-control'?'6500':'5000',expectedMode=mode==='late-mode'?'hourly':'monthly';
    row.oracle={expectedSalary,expectedMode,manualPreserved:row.after.fields.salaryMode===expectedMode&&(mode==='late-mode'||row.after.fields.grossSalary===expectedSalary)};
    if(mode!=='empty-control')assert.equal(row.after.fields.name,'SYNTHETIC MANUAL NAME');
    assert.equal(row.after.fields.salaryMode,expectedMode,'Analysis replaced the current salary mode');
    if(mode!=='late-mode')assert.equal(row.after.fields.grossSalary,expectedSalary,'Analysis replaced the current salary');row.passed=true;
   }catch(error){row.failure=error.stack;row.last=await snapshot(page).catch(()=>null);await page.screenshot({path:join(out,`${engine}-${mode}-failure.png`)}).catch(()=>{});}
   finally{await page.close();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));}
  }}finally{await browser.close();}
 }
}finally{await server.close();report.after=await hashes();report.changed=sourcePaths.filter(name=>before[name]!==report.after[name]);report.resourcesClosed=true;report.finishedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({cases:report.cases.length,passed:report.cases.filter(row=>row.passed).length,failed:report.cases.filter(row=>row.failure).length,changed:report.changed,out}));
if(report.cases.some(row=>row.failure)||report.changed.length)process.exitCode=1;
