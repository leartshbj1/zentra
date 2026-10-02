/** Real WorkspaceApp, hooks and client forms; synthetic transport, no real business request. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5421';
const out=process.env.ZENTRA_QA_OUTPUT || join(tmpdir(),'zentra-workspace-reception-after-20261002');
await mkdir(out,{recursive:true});
const report={source:process.env.ZENTRA_QA_SOURCE || 'unspecified',transport:'Real WorkspaceApp/hooks/act, synthetic SDK IPC and normalized snapshot transport',hashes:{},cases:[]};
for(const name of ['WorkspaceApp.tsx','supplierInbox.ts','AppointmentInbox.tsx','workspaceReception.ts'])report.hashes[name]=createHash('sha256').update(await readFile(new URL(`../src/${name}`,import.meta.url))).digest('hex');
async function navigate(page,label) {
  await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
  await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill(label);
  await page.locator('.navigation-palette__results button').filter({has:page.getByText(label,{exact:true})}).click();
}
async function createClient(page,name) {
  await page.getByRole('button',{name:'Nouveau client',exact:true}).click();
  const form=page.getByRole('dialog',{name:'Nouveau client',exact:true});
  for(const [field,value] of Object.entries({company:name,street:'Synthetic street',postalCode:'1000',city:'Lausanne'}))await form.locator(`[name=${field}]`).fill(value);
  await form.getByRole('button',{name:'Enregistrer',exact:true}).click();
  await form.waitFor({state:'detached'});await page.getByText(name,{exact:true}).waitFor();
}
for(const [engine,kind] of [['Edge',pw.chromium],['WebKit',pw.webkit]]) {
  const browser=await kind.launch(engine==='Edge'?{channel:'msedge',headless:true}:{headless:true});
  try {
    for(const scenario of ['supplier','appointment','shared','burst','batch','failed-offline','hidden','company-receive','company-busy','company-switch','permission'].filter(name=>!process.env.ZENTRA_QA_CASE || name===process.env.ZENTRA_QA_CASE)) {
      const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],external=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.origin+url.pathname);return route.abort();}return route.continue();});
      try {
        await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
        await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=active&emptyScreens=1&formDrafts=1&appointmentActivityAudit=1`);
        await page.locator('.desktop-app').waitFor();await navigate(page,'Clients');
        await page.evaluate(async scenario=>{
          const api=window.__qaDesktopApi;let stored=await api.loadWorkspace();let reads=0,inflight=0,maximum=0,online=true,visible=true;
          const calls=[],held=new Map();
          const supplier={id:'synthetic-supplier',name:'Synthetic supplier',email:'supplier@example.invalid',archivedAt:null};
          if(scenario!=='batch')stored={...stored,suppliers:stored.suppliers.concat(supplier)};
          const items=(scenario==='batch'?[1,2]:[1]).map(n=>({id:`synthetic-mail-${n}`,organizationId:'automation-qa',state:'ready',otherDevice:false,fileName:`SYN-REC-${n}.pdf`,mediaType:'application/pdf',sha256:'synthetic',sender:supplier.email,subject:'Synthetic invoice',invoiceId:null,automatic:true,createdAt:1,extraction:{supplierName:supplier.name,reference:`SYN-REC-${n}`,invoiceDate:'2026-10-02',dueDate:'2026-11-02',currency:'CHF',netCents:10000,vatCents:810,totalCents:10810,vatBp:810,category:'materials',confidence:scenario==='batch'?.5:.99,fieldConfidence:{supplierName:scenario==='batch'?.5:.99},issues:[],evidence:{}}}));
          const supplierState={organizationId:'automation-qa',linked:true,autoPost:scenario!=='batch',prepareEnabled:scenario==='batch',automationActive:true,items:scenario==='appointment'?[]:items};
          const appointment={id:'synthetic-appointment',organizationId:'automation-qa',state:'ready',otherDevice:false,sender:'customer@example.invalid',subject:'Synthetic appointment',importedAt:null,extraction:{title:'Synthetic received appointment',startDate:'2026-10-02',endDate:'2026-10-02',startTime:'09:00',endTime:'10:00',allDay:false,location:'Synthetic office',notes:'',status:'scheduled',issues:[]}};
          const appointmentState={organizationId:'automation-qa',active:true,automatic:true,items:['appointment','shared'].includes(scenario)?[appointment]:[]};
          const original=window.__TAURI_INTERNALS__.invoke;
          window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
            if(command==='append_diagnostic_events')return;
            calls.push({command,action:args?.data?.action??null,id:args?.data?.id});
            if(command==='supplier_inbox_request'){
              if(!args?.data)return structuredClone(supplierState);
              if(args.data.action==='prepareSuppliers') {
                const created=!stored.suppliers.some(row=>row.id===supplier.id);
                if(created)stored={...stored,suppliers:stored.suppliers.concat(supplier)};
                return{results:items.map((row,index)=>({id:row.id,supplierId:supplier.id,created:created&&index===0}))};
              }
              if(args.data.action==='import'){
                const item=items.find(row=>row.id===args.data.id);item.state='imported';item.invoiceId=item.id;
                const stamp=new Date().toISOString();stored={...stored,supplierInvoices:stored.supplierInvoices.concat({id:item.id,supplierId:supplier.id,projectId:null,documentDate:'2026-10-02',dueDate:'2026-11-02',supplierName:supplier.name,reference:item.extraction.reference,currency:'CHF',documentStatus:'validated',paymentStatus:'pending',netCents:10000,vatCents:810,totalCents:10810,paidCents:0,creditedCents:0,balanceCents:10810,matchStatus:'unmatched',validatedAt:stamp,validationJournalEntryId:null,note:'Synthetic',lines:[],payments:[],attachments:[],createdAt:stamp,updatedAt:stamp})};
                return{id:item.id,saved:true,posted:true};
              }
            }
            if(command==='appointment_inbox_request'){
              if(!args?.data)return structuredClone(appointmentState);
              if(args.data.action==='import'){
                appointment.state='imported';const stamp=new Date().toISOString();
                stored={...stored,agendaEvents:stored.agendaEvents.concat({...appointment.extraction,id:appointment.id,kind:'appointment',projectId:null,employeeId:null,createdAt:stamp,updatedAt:stamp})};return{saved:true};
              }
            }
            return original(command,args);
          };
          const heldReads=scenario==='batch'?[3]:scenario==='burst'?[1,2]:[1];
          api.loadWorkspace=async()=>{
            const index=++reads;maximum=Math.max(maximum,++inflight);const snapshot=structuredClone(stored);
            try {
              if(heldReads.includes(index))return await new Promise((resolve,reject)=>held.set(index,{resolve:()=>resolve(snapshot),reject}));
              return snapshot;
            } finally {inflight--;}
          };
          api.createEntity=async(entity,input)=>{
            if(entity!=='clients')throw Error('Only synthetic clients');
            const client={id:`synthetic-local-${stored.clients.length}`,name:input.contactPerson,company:input.company,email:input.email,phone:input.phone,address:input.street,archivedAt:null,notes:input.notes};
            stored={...stored,clients:stored.clients.concat(client)};return structuredClone(stored);
          };
          Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>online});
          Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visible?'visible':'hidden'});
          window.__qaReception={
            proof:()=>({reads,inflight,maximum,calls:structuredClone(calls),held:[...held.keys()],storedClients:stored.clients.length,storedInvoices:stored.supplierInvoices.length}),
            release(index,fail=false){const job=held.get(index);held.delete(index);if(fail)job.reject(new Error('Synthetic network interruption'));else job.resolve();},
            offline(){online=false;window.dispatchEvent(new Event('offline'));},online(){online=true;window.dispatchEvent(new Event('online'));},
            hidden(){visible=false;document.dispatchEvent(new Event('visibilitychange'));},show(){visible=true;document.dispatchEvent(new Event('visibilitychange'));},
            receive(name){const client={id:'synthetic-company-receive',company:name,name:'',email:'',phone:'',address:'',archivedAt:null,notes:''};stored={...stored,clients:stored.clients.concat(client)};window.dispatchEvent(new CustomEvent('zentra-company-workspace-received',{detail:structuredClone(stored)}));},
            observe(name){const values=[];const observer=new MutationObserver(()=>values.push(document.body.textContent.includes(name)));observer.observe(document.body,{subtree:true,childList:true});this.observedVisibility=values;this.stopObserve=()=>observer.disconnect();},
          };
          window.dispatchEvent(new Event('focus'));
          if(scenario==='batch')window.dispatchEvent(new CustomEvent('zentra-automation-hub',{detail:'invoices'}));
        },scenario);
        if(scenario==='batch')await page.getByRole('button',{name:'Vérifier toutes les factures',exact:true}).click();
        const first=scenario==='batch'?3:1;
        await page.waitForFunction(index=>window.__qaReception.proof().held.includes(index),first);
        if(scenario==='batch')await navigate(page,'Clients');
        const client='Synthetic client survives reception';
        if(!['failed-offline','company-receive','company-busy','company-switch','permission'].includes(scenario)) {
          await createClient(page,client);await page.evaluate(name=>window.__qaReception.observe(name),client);
          if(scenario==='burst')await createClient(page,'Synthetic additional client before first release');
        }
        if(scenario==='failed-offline') {
          await page.evaluate(()=>{window.__qaReception.offline();window.__qaReception.release(1,true);});
          await page.waitForTimeout(900);
          assert.equal(await page.evaluate(()=>window.__qaReception.proof().reads),1);
          await page.evaluate(()=>window.__qaReception.online());
        } else if(scenario==='hidden') {
          await page.evaluate(()=>{window.__qaReception.hidden();window.__qaReception.release(1);});
          await page.waitForTimeout(900);
          assert.equal(await page.evaluate(()=>window.__qaReception.proof().reads),1);
          await page.evaluate(()=>window.__qaReception.show());
        } else if(scenario==='company-receive'||scenario==='company-busy') {
          await page.evaluate(({name,busy})=>{if(busy)document.getElementById('root').inert=true;else document.body.dataset.companyDraft='true';window.__qaReception.receive(name);window.__qaReception.release(1);},{name:client,busy:scenario==='company-busy'});
          await page.getByText(client,{exact:true}).waitFor();await page.waitForTimeout(500);
          assert.equal(await page.evaluate(()=>window.__qaReception.proof().reads),1);
          await page.evaluate(()=>{document.getElementById('root').inert=false;delete document.body.dataset.companyDraft;window.dispatchEvent(new Event('pointerup'));});
        } else if(scenario==='company-switch') {
          await page.evaluate(()=>window.__qaSetProjectAccount('synthetic-other'));await page.waitForTimeout(50);
          await page.evaluate(()=>window.__qaSetProjectAccount('automation-qa'));await page.waitForTimeout(50);
          await page.evaluate(name=>window.__qaReception.receive(name),client);await page.getByText(client,{exact:true}).waitFor();
          await page.evaluate(()=>window.__qaReception.release(1));
        } else if(scenario==='permission') {
          await page.evaluate(()=>window.__qaSetReadOnly(true));await page.waitForTimeout(30);
          await page.evaluate(()=>window.__qaReception.release(1));
        } else {
          await page.evaluate(index=>window.__qaReception.release(index),first);
          if(scenario==='burst') {
            await page.waitForFunction(()=>window.__qaReception.proof().held.includes(2));
            await createClient(page,'Synthetic second client after read budget');
            await createClient(page,'Synthetic fourth client before deferred read');await page.evaluate(()=>window.__qaReception.release(2));
          }
        }
        if(!['company-switch','permission'].includes(scenario))await page.waitForFunction(index=>window.__qaReception.proof().reads>index&&window.__qaReception.proof().inflight===0,scenario==='burst'?2:first);
        await page.waitForTimeout(80);
        const proof=await page.evaluate(()=>window.__qaReception.proof());
        if(!['failed-offline','permission'].includes(scenario)) {
          await page.getByText(client,{exact:true}).waitFor();
          assert.equal(await page.getByText(client,{exact:true}).count(),1);
        }
        if(scenario==='burst')for(const name of ['Synthetic second client after read budget','Synthetic additional client before first release','Synthetic fourth client before deferred read'])await page.getByText(name,{exact:true}).waitFor();
        assert.equal(proof.maximum,1,`${engine} ${scenario}: at most one reception GET in flight`);
        const imports=proof.calls.filter(call=>call.action==='import');
        assert.equal(imports.length,scenario==='shared'||scenario==='batch'?2:1,`${engine} ${scenario}: confirmed writes never replayed`);
        assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
        const visible=await page.evaluate(()=>{window.__qaReception.stopObserve?.();return window.__qaReception.observedVisibility||[];});
        assert.ok(!visible.includes(false),`${engine} ${scenario}: a confirmed client never disappears`);
        if(!['appointment','company-switch'].includes(scenario)) {
          await navigate(page,'Achats & fournisseurs');
          await page.getByRole('tab',{name:'Factures & avoirs',exact:false}).click();
          await page.getByText('SYN-REC-1',{exact:true}).waitFor();
        }
        if(scenario==='batch') {
          await page.getByText('SYN-REC-2',{exact:true}).waitFor();
          await page.evaluate(()=>window.dispatchEvent(new CustomEvent('zentra-automation-hub',{detail:'invoices'})));
          const summary=page.getByRole('region',{name:'Résultat de la vérification',exact:true});
          await summary.getByText('Vérification terminée',{exact:true}).waitFor();
          await summary.getByText('2 comptabilisées',{exact:true}).waitFor();
          assert.match(await summary.innerText(),/Fournisseur renseigné sur 2 factures/);
          assert.match(await summary.innerText(),/1 nouveaux fournisseurs/);
        }
        report.cases.push({engine,scenario,...proof,clientObserved:visible,errors,external});
        await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
      } catch(reason) {
        await page.screenshot({path:join(out,`${engine}-${scenario}-failure.png`)});
        report.failure={engine,scenario,message:String(reason),proof:await page.evaluate(()=>window.__qaReception?.proof()).catch(()=>null),body:await page.locator('body').innerText(),errors,external};
        await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
        throw reason;
      } finally {await page.close();}
    }
  } finally {await browser.close();}
}
console.log(JSON.stringify({cases:report.cases.length,output:join(out,'report.json'),errors:0,external:0}));
