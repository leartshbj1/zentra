/** Actual WorkspaceApp/UI/hooks/SDK; all data and IPC are synthetic. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer as freePortServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const desktop=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(join(desktop,'package.json'));
const vite=await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')),'dist/node/index.js')).href);
const imported=await import(pathToFileURL(process.env.ZENTRA_PLAYWRIGHT_MODULE||require.resolve('playwright')).href);
const pw=imported.default??imported,revision=process.env.ZENTRA_QA_REVISION;
const out=process.env.ZENTRA_QA_OUTPUT||join(tmpdir(),'zentra-inbox-manual-lifecycle');
await mkdir(out,{recursive:true});
const sources={};
for(const name of ['supplierInbox.ts','AppointmentInbox.tsx','SupplierInboxPanel.tsx'])sources[name]=revision
  ?execFileSync('git',['show',`${revision}:desktop/src/${name}`],{cwd:desktop,encoding:'utf8'})
  :await readFile(join(desktop,'src',name),'utf8');
const harnessSource=await readFile(join(desktop,'tests/mobile-harness.tsx'),'utf8');
const loaded=await vite.loadConfigFromFile({command:'serve',mode:'development'},join(desktop,'vite.config.ts'));
const probe=freePortServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`;
const server=await vite.createServer({...loaded.config,configFile:false,root:desktop,
  cacheDir:join(tmpdir(),'zentra-inbox-manual-vite'),
  plugins:[{name:'inbox-manual-baseline',enforce:'pre',load(id){
    if(id.replaceAll('\\','/').endsWith('/tests/mobile-harness.tsx'))return harnessSource
      .replace('function Harness() {','function Harness() { const [present,setPresent]=useState(true); Object.assign(window,{__qaUnmountInbox:()=>setPresent(false)});')
      .replace("const [readOnly, setReadOnly] = useState(new URLSearchParams(location.search).has('readOnly'));", "const [readOnly, setReadOnly] = useState(new URLSearchParams(location.search).has('readOnly')); Object.assign(window,{__qaRenderReadOnly:readOnly});")
      .replace('return <><WorkspaceApp cloudAccount=', 'return <>{present&&<WorkspaceApp cloudAccount=')
      .replace('setWorkspace={(next) => { setWorkspace(next);', 'setWorkspace={(next) => { window.__qaManual?.published(next); setWorkspace(next);')
      .replace("window.projectNavigation.publications++; }} />", "window.projectNavigation.publications++; }} />} {!present&&<p>Workspace unmounted</p>}");
    if(!revision)return;for(const [name,source] of Object.entries(sources))if(id.replaceAll('\\','/').endsWith('/src/'+name))return source;
  }},...loaded.config.plugins],
  server:{host:'127.0.0.1',port,strictPort:true,watch:{ignored:['**/src-tauri/**']}},logLevel:'silent'});
const report={revision:revision||'working-tree',hashes:Object.fromEntries(Object.entries(sources).map(([name,source])=>[name,createHash('sha256').update(source).digest('hex')])),
  scope:'Real WorkspaceApp, modal and SDK transport. Scope/account transitions are synthetic parent-prop updates; no real account, native binary or external requests.',cases:[]};
const cases=(process.env.ZENTRA_QA_CASES||'read-failure,slow-read,scope-change,permission,permission-before,unmount,already-imported,scope-before,scope-during-write,org-during-write,client-during-read').split(',');
try{
  await server.listen();
  for(const engine of ['chromium','webkit']){
    const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.ZENTRA_EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{})});
    try{for(const type of ['supplier','appointment'])for(const scenario of cases){
      const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],external=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
      let result;
      try{
        await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
        await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=active&emptyScreens=1&formDrafts=1&appointmentActivityAudit=1`);
        await page.locator('.desktop-app').waitFor();
        await page.evaluate(async({type,scenario})=>{
          const api=window.__qaDesktopApi;let stored={...await api.loadWorkspace(),workNotesScope:'synthetic-scope-a'};
          stored.suppliers=[{id:'synthetic-supplier',name:'Synthetic supplier',email:'supplier@example.invalid',archivedAt:null}];
          let reads=0,mutations=0,held,heldWrite;const calls=[],publications=[];
          const item={id:'synthetic-manual',organizationId:'automation-qa',state:'needs_review',otherDevice:false,fileName:'SYN-MANUAL.png',mediaType:'image/png',sha256:'synthetic',sender:'supplier@example.invalid',subject:'Synthetic manual invoice',invoiceId:null,automatic:false,createdAt:1,
            extraction:{supplierName:'Synthetic supplier',reference:'SYN-MANUAL',invoiceDate:'2026-10-02',dueDate:'2026-11-02',currency:'CHF',netCents:10000,vatCents:810,totalCents:10810,vatBp:810,category:'materials',confidence:.99,issues:[],evidence:{}}};
          const appointment={id:'synthetic-manual',organizationId:'automation-qa',state:'review',otherDevice:false,sender:'customer@example.invalid',subject:'Synthetic manual appointment',importedAt:null,
            extraction:{title:'Synthetic manual appointment',startDate:'2026-10-02',endDate:'2026-10-02',startTime:'09:00',endTime:'10:00',allDay:false,location:'Synthetic office',notes:'',status:'scheduled',issues:[]}};
          const original=window.__TAURI_INTERNALS__.invoke;
          window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
            if(command==='append_diagnostic_events')return;
            const data=args?.data;calls.push({command,action:data?.action??null});
            if(command==='supplier_inbox_request'){
              if(!data)return{organizationId:'automation-qa',linked:true,autoPost:false,prepareEnabled:false,automationActive:true,items:type==='supplier'?[structuredClone(item)]:[]};
              if(data.action==='document')return{base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5aQAAAAASUVORK5CYII='};
              if(data.action==='import'){
                mutations++;item.state='imported';item.invoiceId=item.id;
                stored={...stored,supplierInvoices:[...stored.supplierInvoices,{id:item.id,supplierId:'synthetic-supplier',supplierName:'Synthetic supplier',documentStatus:'validated',reference:'SYN-MANUAL',currency:'CHF',documentDate:'2026-10-02',dueDate:'2026-11-02',totalCents:10810,paidCents:0,balanceCents:10810,lines:[],payments:[],attachments:[]}]};
                if(['permission','unmount','scope-during-write','org-during-write'].includes(scenario))await new Promise(resolve=>heldWrite=resolve);
                if(scenario==='already-imported')return{id:item.id,alreadyImported:true};
                return{id:item.id,saved:true,posted:true};
              }
            }
            if(command==='appointment_inbox_request'){
              if(!data)return{organizationId:'automation-qa',active:true,automatic:false,items:type==='appointment'?[structuredClone(appointment)]:[]};
              if(data.action==='import'){
                mutations++;appointment.state='imported';stored={...stored,agendaEvents:[...stored.agendaEvents,{...appointment.extraction,id:appointment.id,kind:'appointment',projectId:null,employeeId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]};
                if(['permission','unmount','scope-during-write','org-during-write'].includes(scenario))await new Promise(resolve=>heldWrite=resolve);
                return{id:appointment.id,saved:true};
              }
            }
            return original(command,args);
          };
          api.loadWorkspace=async()=>{
            const index=++reads,snapshot=structuredClone(stored);
            if(index===1&&scenario!=='unmount'){if(scenario==='read-failure')throw Error('Synthetic read failed after confirmed import');return await new Promise(resolve=>held=()=>resolve(snapshot));}
            return snapshot;
          };
          api.createEntity=async(entity,input)=>{
            if(entity!=='clients')throw Error('Only synthetic clients');
            stored={...stored,clients:[...stored.clients,{id:'synthetic-new-client',company:input.company,name:input.contactPerson,email:input.email,phone:input.phone,address:input.street,notes:input.notes,archivedAt:null}]};return structuredClone(stored);
          };
          window.__qaManual={published(next){publications.push({scope:next?.workNotesScope,clients:next?.clients?.map(row=>row.company)});},proof:()=>({reads,mutations,calls,publications,held:!!held,heldWrite:!!heldWrite,storedScope:stored.workNotesScope}),release(){const job=held;held=null;job?.();},releaseWrite(){const job=heldWrite;heldWrite=null;job?.();},
            scopeChange(){stored={...stored,workNotesScope:'synthetic-scope-b',clients:[{id:'synthetic-b-client',company:'Synthetic scope B client',name:'',email:'',phone:'',address:'',notes:'',archivedAt:null}]};window.__emptyScreensPatch(stored);}};
          window.__emptyScreensPatch(stored);window.dispatchEvent(new Event('focus'));
          window.dispatchEvent(new CustomEvent('zentra-automation-hub',{detail:type==='supplier'?'invoices':'appointments'}));
        },{type,scenario});
        if(type==='supplier')await page.getByRole('button',{name:'Vérifier · SYN-MANUAL',exact:true}).click();
        else await page.locator('.automation-appointments').getByRole('button',{name:'Vérifier',exact:true}).click();
        const dialog=page.getByRole('dialog',{name:type==='supplier'?'Votre facture est préparée':'Vérifier le rendez-vous',exact:true});
        const submit=dialog.getByRole('button',{name:type==='supplier'?'Confirmer et comptabiliser':'Ajouter à l’agenda',exact:true});
        if(scenario==='permission-before'){
          await page.evaluate(()=>window.__qaSetReadOnly(true));await page.waitForFunction(()=>window.__qaRenderReadOnly===true);
          if(type==='appointment')await submit.click();
          const proof=await page.evaluate(()=>window.__qaManual.proof());
          result={engine,type,scenario,passed:proof.mutations===0&&errors.length===0&&external.length===0,proof,errors,external};
          report.cases.push(result);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await page.close();continue;
        }
        if(scenario==='scope-before'){
          await page.evaluate(()=>window.__qaManual.scopeChange());await dialog.waitFor({state:'detached',timeout:1_000}).catch(()=>{});
          const proof=await page.evaluate(()=>window.__qaManual.proof());
          result={engine,type,scenario,passed:await dialog.count()===0&&proof.mutations===0&&errors.length===0&&external.length===0,proof,errors,external};
          report.cases.push(result);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await page.close();continue;
        }
        await submit.click();
        await page.waitForFunction(()=>window.__qaManual.proof().mutations===1);
        if(scenario==='permission'){
          await page.waitForFunction(()=>window.__qaManual.proof().heldWrite);
          await page.evaluate(()=>window.__qaSetReadOnly(true));await page.waitForFunction(()=>window.__qaRenderReadOnly===true);
          await page.evaluate(()=>window.__qaManual.releaseWrite());
        }
        if(scenario==='unmount'){
          await page.waitForFunction(()=>window.__qaManual.proof().heldWrite);
          await page.evaluate(()=>window.__qaUnmountInbox());await page.getByText('Workspace unmounted',{exact:true}).waitFor();
          await page.evaluate(()=>window.__qaManual.scopeChange());await page.evaluate(()=>window.__qaManual.releaseWrite());await page.waitForTimeout(500);
          const proof=await page.evaluate(()=>window.__qaManual.proof());
          result={engine,type,scenario,passed:proof.reads===0&&proof.publications.length===0&&proof.mutations===1&&errors.length===0&&external.length===0,proof,errors,external};
          report.cases.push(result);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await page.close();continue;
        }
        if(scenario==='scope-during-write'||scenario==='org-during-write'){
          await page.waitForFunction(()=>window.__qaManual.proof().heldWrite);
          await page.evaluate(scenario=>{window.__qaManual.scopeChange();if(scenario==='org-during-write')window.__qaSetProjectAccount('synthetic-org-b');},scenario);
          await dialog.waitFor({state:'detached',timeout:1_000}).catch(()=>{});
          await page.evaluate(()=>window.__qaManual.releaseWrite());await page.waitForTimeout(150);
          const proof=await page.evaluate(()=>window.__qaManual.proof());
          result={engine,type,scenario,passed:proof.reads===0&&proof.publications.length===0&&proof.mutations===1&&await dialog.count()===0&&errors.length===0&&external.length===0,proof,errors,external};
          report.cases.push(result);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await page.close();continue;
        }
        if(scenario==='read-failure'){
          await page.waitForTimeout(800);
        }else{
          await page.waitForFunction(()=>window.__qaManual.proof().held);
          if(scenario==='scope-change'){await page.evaluate(()=>window.__qaManual.scopeChange());await page.waitForTimeout(30);}
          const closedBeforeRead=await dialog.count()===0;
          result={closedBeforeRead};
          if(scenario==='client-during-read'){
            await dialog.waitFor({state:'detached',timeout:1_000});
            await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
            await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Clients');
            await page.locator('.navigation-palette__results button').filter({has:page.getByText('Clients',{exact:true})}).click();
            await page.getByRole('button',{name:'Nouveau client',exact:true}).click();
            const form=page.getByRole('dialog',{name:'Nouveau client',exact:true});
            for(const [name,value] of Object.entries({company:'Synthetic client during manual read',street:'Synthetic street',postalCode:'1000',city:'Lausanne'}))await form.locator(`[name=${name}]`).fill(value);
            await form.getByRole('button',{name:'Enregistrer',exact:true}).click();
            await form.waitFor({state:'detached'});await page.getByText('Synthetic client during manual read',{exact:true}).waitFor();
          }
          await page.evaluate(()=>window.__qaManual.release());await page.waitForTimeout(800);
        }
        const dialogClosed=await dialog.count()===0;let proof=await page.evaluate(()=>window.__qaManual.proof());
        // A failed read must not offer the already committed mutation again.
        let repeated=false;
        if(scenario==='read-failure'&&!dialogClosed){await submit.click();await page.waitForTimeout(150);proof=await page.evaluate(()=>window.__qaManual.proof());repeated=proof.mutations>1;}
        if(scenario==='scope-change'){
          await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
          await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Clients');
          await page.locator('.navigation-palette__results button').filter({has:page.getByText('Clients',{exact:true})}).click();
        }
        const body=await page.locator('body').innerText();
        const checks={receiptClosesDialog:dialogClosed,confirmedWriteNotRepeated:!repeated&&proof.mutations===1,
          ...(scenario==='scope-change'?{currentScopePreserved:await page.evaluate(()=>window.__qaManual.proof().storedScope)==='synthetic-scope-b'&&body.includes('Synthetic scope B client')}:{}),
          ...(scenario==='client-during-read'?{newClientPreserved:body.includes('Synthetic client during manual read')&&proof.publications.every(row=>row.clients.includes('Synthetic client during manual read'))}:{}),
          ...(scenario!=='read-failure'?{receiptBeforeRead:result.closedBeforeRead}:{}),noPageErrors:errors.length===0,noExternalRequests:external.length===0};
        if(type==='supplier'&&scenario==='already-imported')checks.honestReceipt=!body.includes('Brouillon enregistré avec son justificatif.');
        if(type==='supplier'&&scenario==='already-imported'){
          const copies={fr:'Facture déjà enregistrée. Retrouvez son état dans les achats.',de:'Rechnung bereits erfasst. Prüfen Sie ihren Status unter Einkäufe.',it:'Fattura già registrata. Consulta il suo stato negli acquisti.',en:'Invoice already saved. Check its status in purchases.'};
          for(const [language,copy] of Object.entries(copies)){
            await page.evaluate(async language=>{const module=await import('/src/language.ts');await module.setAppLanguage(language);},language);
            await page.getByText(copy,{exact:false}).waitFor({timeout:3_000});
          }
          checks.fourLanguageReceipt=true;
        }
        result={engine,type,scenario,passed:Object.values(checks).every(Boolean),checks,proof,repeated,errors,external,body};
      }catch(reason){result={engine,type,scenario,passed:false,error:String(reason),body:await page.locator('body').innerText().catch(()=>''),proof:await page.evaluate(()=>window.__qaManual?.proof()).catch(()=>null),errors,external};}
      report.cases.push(result);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
      if(!result.passed)await page.screenshot({path:join(out,`${engine}-${type}-${scenario}.png`)});
      await page.close();
    }}finally{await browser.close();}
  }
}finally{await server.close();}
console.log(JSON.stringify({output:join(out,'report.json'),passed:report.cases.filter(row=>row.passed).length,total:report.cases.length}));
assert.ok(report.cases.every(row=>row.passed),'Manual inbox import lifecycle regression; see JSON evidence');
