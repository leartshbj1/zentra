/** Real WorkspaceApp/ProjectForm, synthetic receipts and parent scope changes. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer as freePortServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const desktop=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(join(desktop,'package.json'));
const vite=await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')),'dist/node/index.js')).href);
const imported=await import(pathToFileURL(process.env.ZENTRA_PLAYWRIGHT_MODULE||require.resolve('playwright')).href),pw=imported.default??imported;
const revision=process.env.ZENTRA_QA_REVISION,out=process.env.ZENTRA_QA_OUTPUT||join(tmpdir(),'zentra-project-form-publication');
await mkdir(out,{recursive:true});
const names=['WorkspaceApp.tsx','bridge.ts','ProjectFolder.tsx','useWorkspaceRecovery.ts','workspaceMutation.ts'];
const sources={};
for(const name of names)sources[name]=revision?execFileSync('git',['show',`${revision}:desktop/src/${name}`],{cwd:desktop,encoding:'utf8'}):await readFile(join(desktop,'src',name),'utf8');
const harness=await readFile(join(desktop,'tests/mobile-harness.tsx'),'utf8');
// Observe settlement without changing the handler's values, rejection or control
// flow. This outer finally also runs after the form itself has been unmounted.
const source=sources['WorkspaceApp.tsx'],start=source.indexOf('function ProjectForm('),end=source.indexOf('function EmployeeForm(',start);
assert.ok(start>=0&&end>start,'Expected actual ProjectForm source');
let form=source.slice(start,end);
const opening='onSubmit={submitForm(async (form) => {';
const open=form.indexOf(opening),close=form.indexOf('})}',open);
assert.ok(open>=0&&close>open,'Expected real submit callback');
form=form.slice(0,close)+'} finally { window.__qaProjectForm?.settled(); } '+form.slice(close);
form=form.replace(opening,opening+' try {');
const observedSource=source.slice(0,start)+form+source.slice(end);
const loaded=await vite.loadConfigFromFile({command:'serve',mode:'development'},join(desktop,'vite.config.ts'));
const probe=freePortServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));const origin=`http://127.0.0.1:${port}`;
const server=await vite.createServer({...loaded.config,configFile:false,root:desktop,
  cacheDir:join(tmpdir(),'zentra-project-form-publication-vite'),
  plugins:[{name:'project-form-publication-fixture',enforce:'pre',load(id){
    id=id.replaceAll('\\','/').split('?')[0];
    if(id.endsWith('/tests/mobile-harness.tsx'))return harness
      .replace('function Harness() {','function Harness() { const [present,setPresent]=useState(true); Object.assign(window,{__qaUnmountProject:()=>setPresent(false)});')
      .replace('return <><WorkspaceApp cloudAccount=','return <>{present&&<WorkspaceApp cloudAccount=')
      .replace('setWorkspace={(next) => { setWorkspace(next);','setWorkspace={(next) => { window.__qaProjectForm?.published(next); setWorkspace(next);')
      .replace('window.projectNavigation.publications++; }} />','window.projectNavigation.publications++; }} />} {!present&&<p>Workspace unmounted</p>}');
    if(id.endsWith('/src/WorkspaceApp.tsx'))return observedSource;
    for(const name of names)if(id.endsWith('/src/'+name))return sources[name];
  }},...loaded.config.plugins],server:{host:'127.0.0.1',port,strictPort:true,watch:{ignored:['**/src-tauri/**']}},logLevel:'silent'});
const report={revision:revision||'working-tree',head:execFileSync('git',['rev-parse','HEAD'],{cwd:desktop,encoding:'utf8'}).trim(),capturedAt:new Date().toISOString(),hashes:Object.fromEntries(Object.entries(sources).map(([name,value])=>[name,createHash('sha256').update(value).digest('hex')])),
  observedWorkspaceAppSha256:createHash('sha256').update(observedSource).digest('hex'),
  scope:'Actual React/WorkspaceApp/ProjectForm; synthetic API receipts, files and parent-prop scope/unmount transitions. Test adds only an outer finally observer. No native binary, user account or server access.',cases:[]};
async function navigate(page,label){
  await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
  await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill(label);
  await page.locator('.navigation-palette__results button').filter({has:page.getByText(label,{exact:true})}).click();
}
const scenarios=(process.env.ZENTRA_QA_CASES||'scope-resolve,scope-reject,unmount-resolve,unmount-reject,read-failure-retry,retry-scope-change,read-failure-fallback-success').split(',');
try{
  await server.listen();
  for(const engine of ['chromium','webkit']){
    const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.ZENTRA_EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{})});
    try{for(const scenario of scenarios){
      const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[],external=[];
      page.setDefaultTimeout(8_000);page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
      let result,expectedSettled=1,retryMode,confirmedReceiptVisible,receiptStayedDuringRead,readGuidanceVisible;
      try{
        await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
        await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&emptyScreens=1`);await page.locator('.desktop-app').waitFor();
        await page.evaluate(async scenario=>{
          const api=window.__qaDesktopApi;let stored={...await api.loadWorkspace(),workNotesScope:'synthetic-project-scope-a'};
          stored.clients=[{id:'client-qa',company:'Synthetic client A',name:'',email:'',phone:'',address:'',notes:'',archivedAt:null}];
          stored.projects=[];stored.attachments=[];
          let reads=0,saves=0,adds=0,settled=0,held;const publications=[],scopes=[];
          api.saveProject=async(input,id)=>{
            saves++;const projectId=id||'synthetic-saved-project';stored={...stored,projects:stored.projects.filter(row=>row.id!==projectId).concat({id:projectId,clientId:input.clientId,name:input.name,status:input.status,address:input.addressLine1,notes:input.notes})};return projectId;
          };
          api.addProjectDocument=async(projectId,file,signal,scope)=>{
            adds++;scopes.push(scope);stored={...stored,attachments:stored.attachments.concat({id:'synthetic-file-'+adds,projectId,entityId:projectId,entityType:'project',originalName:file.name,sizeBytes:file.size,mimeType:file.type,sha256:'synthetic',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})};
          };
          api.loadWorkspace=async()=>{
            const index=++reads,snapshot=structuredClone(stored);
            if(scenario==='read-failure-fallback-success'&&index===1)throw Error('Synthetic first read failure; next read succeeds');
            if(['read-failure-retry','retry-scope-change'].includes(scenario)){
              if(index<=2)throw Error('Synthetic read interruption after confirmed project/files');
              if(scenario==='read-failure-retry')return snapshot;
            }
            if(index===1||scenario==='retry-scope-change'&&index===3)return new Promise((resolve,reject)=>held={resolve:()=>resolve(snapshot),reject:()=>reject(Error('Synthetic held read failure'))});
            // An unmounted form must not start a recovery that can never settle.
            if(scenario==='unmount-reject')throw Error('Synthetic read still unavailable after unmount');
            return snapshot;
          };
          window.__qaProjectForm={published(next){publications.push({scope:next?.workNotesScope,projects:next?.projects?.map(row=>row.name),clients:next?.clients?.map(row=>row.company)});},settled(){settled++;},
            proof:()=>({reads,saves,adds,settled,publications,scopes,held:!!held,storedScope:stored.workNotesScope,storedProjects:stored.projects.length,storedFiles:stored.attachments.length}),
            release(fail=false){const job=held;held=null;fail?job?.reject():job?.resolve();},
            scopeChange(){stored={...stored,workNotesScope:'synthetic-project-scope-b',projects:[],attachments:[],clients:[{id:'synthetic-client-b',company:'Synthetic client B',name:'',email:'',phone:'',address:'',notes:'',archivedAt:null}]};window.__emptyScreensPatch(stored);}
          };
          window.__emptyScreensPatch(stored);
        },scenario);
        await navigate(page,'Projets');await page.getByRole('button',{name:'Nouveau projet',exact:true}).click();
        const form=page.getByRole('dialog',{name:'Nouveau projet',exact:true});
        await form.locator('[name=name]').fill('Synthetic confirmed project A');await form.locator('[name=clientId]').selectOption('client-qa');
        await form.locator('input[type=file]').first().setInputFiles(['synthetic-plan.txt','synthetic-notes.txt'].map(name=>({name,mimeType:'text/plain',buffer:Buffer.from('Synthetic fixture')})));
        await form.getByRole('button',{name:'Enregistrer',exact:true}).click();
        await page.waitForFunction(()=>window.__qaProjectForm.proof().saves===1&&window.__qaProjectForm.proof().adds===2);
        if(scenario==='read-failure-fallback-success'){
          await page.waitForFunction(()=>window.__qaProjectForm.proof().reads===2&&window.__qaProjectForm.proof().settled===1);
        }else if(['read-failure-retry','retry-scope-change'].includes(scenario)){
          await page.waitForFunction(()=>window.__qaProjectForm.proof().reads===2);
          const recovery=page.getByRole('dialog',{name:'Enregistrement effectué',exact:true});
          // The old implementation retained the original submit inside global
          // recovery. The corrected form reports the committed result locally;
          // explicit resubmission must only retry its read, not its writes.
          await page.waitForFunction(()=>window.__qaProjectForm.proof().settled>0||document.querySelector('.workspace-recovery'));
          if(await recovery.count()){
            retryMode='global-read-recovery';
            await recovery.getByRole('button',{name:'Actualiser les données',exact:true}).click();
          }else{
            retryMode='confirmed-form-read-retry';expectedSettled=2;
            const confirmed=form.getByText('Le projet et les fichiers confirmés sont enregistrés.',{exact:false});
            await confirmed.waitFor({state:'attached'});
            const receipt=form.getByRole('status').filter({hasText:'Le projet est enregistré.'});
            confirmedReceiptVisible=await receipt.isVisible();
            const recoveryCopy=await form.locator('.error-guidance__recovery').innerText();
            readGuidanceVisible=await form.getByText('Actualiser la liste des projets',{exact:true}).isVisible()
              &&recoveryCopy.includes('Réessayez le chargement.')&&!recoveryCopy.includes('Avant un nouvel enregistrement');
            const retry=form.getByRole('button',{name:'Enregistrer',exact:true});await retry.waitFor();
            await retry.click();
          }
          if(scenario==='read-failure-retry'){
            await recovery.waitFor({state:'detached'});await form.waitFor({state:'detached'});
          }else{
            await page.waitForFunction(()=>window.__qaProjectForm.proof().held);
            if(retryMode==='confirmed-form-read-retry')receiptStayedDuringRead=await form.getByRole('status').filter({hasText:'Le projet est enregistré.'}).isVisible();
            await page.evaluate(()=>window.__qaProjectForm.scopeChange());await page.waitForTimeout(100);
            await page.evaluate(()=>window.__qaProjectForm.release());
          }
        }else{
          await page.waitForFunction(()=>window.__qaProjectForm.proof().held);
          if(scenario.startsWith('unmount')){
            await page.evaluate(()=>window.__qaUnmountProject());await page.getByText('Workspace unmounted',{exact:true}).waitFor();
          }
          await page.evaluate(()=>window.__qaProjectForm.scopeChange());await page.waitForTimeout(100);
          await page.evaluate(fail=>window.__qaProjectForm.release(fail),scenario.endsWith('reject'));
        }
        await page.waitForTimeout(300);
        const proof=await page.evaluate(()=>window.__qaProjectForm.proof());
        const body=await page.locator('body').innerText(),recoveryPending=await page.locator('.workspace-recovery').count()>0;
        const normalScope=['read-failure-retry','read-failure-fallback-success'].includes(scenario);
        const checks={oneSavedProject:proof.saves===1,filesNeverReplayed:proof.adds===2,handlerSettled:proof.settled===expectedSettled,
          noInfiniteRecovery:!recoveryPending,noStalePublication:normalScope||!proof.publications.some(row=>row.scope==='synthetic-project-scope-a'),
          currentScopePreserved:normalScope||proof.storedScope==='synthetic-project-scope-b',
          noPageErrors:errors.length===0,noExternalRequests:external.length===0};
        if(!revision)checks.originalScopeForwarded=proof.scopes.length===2&&proof.scopes.every(scope=>scope==='synthetic-project-scope-a');
        if(retryMode==='confirmed-form-read-retry'){
          checks.confirmedReceiptVisible=confirmedReceiptVisible===true;
          checks.readGuidanceVisible=readGuidanceVisible===true;
          if(scenario==='retry-scope-change'){
            checks.receiptStayedDuringRead=receiptStayedDuringRead===true;
            checks.oldReceiptClearedAfterScope=await page.getByRole('status').filter({hasText:'Le projet est enregistré.'}).count()===0;
          }
        }
        if(scenario==='read-failure-retry'){
          checks.recoveryReadOnly=proof.reads===3&&proof.storedProjects===1&&proof.storedFiles===2;
          checks.visibleConfirmedProject=body.includes('Synthetic confirmed project A');
        }else checks.boundedReads=proof.reads===(scenario==='retry-scope-change'?4:2);
        if(scenario==='read-failure-fallback-success'){
          checks.confirmedFormClosed=await form.count()===0;
          checks.noResidualReadReceipt=!body.includes('Le projet est enregistré. Reprenez pour actualiser la liste');
          // A closed form and the confirmed project in the refreshed real list
          // are the success contract; no additional global toast is required.
          checks.visibleConfirmedProject=await page.getByText('Synthetic confirmed project A',{exact:true}).isVisible();
          checks.noResidualReadError=await page.locator('.error-guidance__message').filter({hasText:'Les informations n’ont pas pu être chargées.'}).count()===0;
          checks.confirmedWorkspacePublished=proof.publications.length===1&&proof.publications[0].projects?.includes('Synthetic confirmed project A');
          checks.onlyConfirmedRecords=proof.storedProjects===1&&proof.storedFiles===2;
        }
        result={engine,scenario,passed:Object.values(checks).every(Boolean),checks,proof,retryMode,expectedSettled,confirmedReceiptVisible,receiptStayedDuringRead,readGuidanceVisible,body,errors,external};
      }catch(reason){result={engine,scenario,passed:false,error:String(reason),proof:await page.evaluate(()=>window.__qaProjectForm?.proof()).catch(()=>null),body:await page.locator('body').innerText().catch(()=>''),errors,external};}
      report.cases.push(result);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
      if(!result.passed)await page.screenshot({path:join(out,`${engine}-${scenario}.png`)});
      await page.close();
    }}finally{await browser.close();}
  }
}finally{await server.close();}
if(!revision){
  report.finalHashes={};
  for(const name of names)report.finalHashes[name]=createHash('sha256').update(await readFile(join(desktop,'src',name),'utf8')).digest('hex');
  report.sourceUnchangedDuringRun=names.every(name=>report.hashes[name]===report.finalHashes[name]);
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify({output:join(out,'report.json'),passed:report.cases.filter(row=>row.passed).length,total:report.cases.length}));
assert.ok(report.cases.every(row=>row.passed),'ProjectForm stale publication or recovery regression; see JSON');
assert.ok(revision||report.sourceUnchangedDuringRun,'Selected production source changed during the run; see hashes');
