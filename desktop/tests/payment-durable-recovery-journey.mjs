/** Local browser regression. Real WorkspaceApp/PaymentForm/bridge, closed IPC fixture.
 * No production/cloud/native SQL call, no act/recovery mock, no visual overrides.
 * ZENTRA_QA_URL/DIR/WIDTHS/ENGINES/CASES/TIMEOUT and ZENTRA_PLAYWRIGHT_MODULE.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const imported=await import(pathToFileURL(require.resolve(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright')).href),pw=imported.default??imported;
const origin=new URL(process.env.ZENTRA_QA_URL||'http://127.0.0.1:5271');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(origin.hostname),'Only an explicitly local preview is allowed.');
const engines=(process.env.ZENTRA_QA_ENGINES||process.env.ZENTRA_QA_ENGINE||'chromium,webkit').split(',');
const widths=(process.env.ZENTRA_QA_WIDTHS||'390,1440').split(',').map(Number);
assert.ok(widths.every(value=>Number.isInteger(value)&&value>=320&&value<=2560));
const selected=process.env.ZENTRA_QA_CASES?.split(','),timeout=Number(process.env.ZENTRA_QA_TIMEOUT||15000);
const directory=resolve(process.env.ZENTRA_QA_DIR||'.qa/payment-durable-recovery');await mkdir(directory,{recursive:true});
const requestPrefix='zentra.payment-request.v1.',draftPrefix='zentra.forms.drafts.v1.';
const sample={amount:'10,25',date:'2026-05-02',method:'TWINT',reference:'REC-001',notes:'Première partie\nMerci'};
const report={startedAt:new Date().toISOString(),url:origin.href,engines,widths,cases:[],infrastructureNotices:[],limits:[
 'Actual WorkspaceApp global act/recovery, PaymentForm and bridge run in the mobile harness; only native IPC is simulated.',
 'Reload is a browser page remount with persistent localStorage/sessionStorage, not an OS process restart.',
 'Fixture serializes mutations and models normalized UUID identity, aliases and journal proof. It cannot prove native SQLite rollback, company merge or concurrency.',
 'Faults are explicit fixture modes, storage quota injection and replacement of an existing local receipt. No UI, act, recovery, payment calculation or CSS override.',
 'The two competing variants case calls the actual bridge concurrently against the serialized IPC double; native coverage is a separate requirement.',
 'During navigation only, dashboard notices are read and dismissed through their real close button; payment failures and recovery dialogs remain observable.',
]};
const state=page=>page.evaluate(()=>{const s=window.paymentGuidedFixture.state;return {attempts:s.attempts,reads:s.reads,writes:s.writes,replayCount:s.replayCount,blockRead:s.blockRead,payments:s.stored.payments,journals:s.stored.journal_entries,aliases:s.stored.payment_aliases};});
const configure=(page,patch)=>page.evaluate(patch=>window.paymentGuidedFixture.configure(patch),patch);
const receipts=page=>page.evaluate(prefix=>Object.keys(localStorage).filter(key=>key.startsWith(prefix)).map(key=>({key,raw:localStorage.getItem(key),record:JSON.parse(localStorage.getItem(key))})),requestPrefix);
const drafts=page=>page.evaluate(prefix=>Object.keys(localStorage).filter(key=>key.startsWith(prefix)&&JSON.parse(localStorage.getItem(key)).scope.includes('customer-payment')).map(key=>({key,raw:localStorage.getItem(key),record:JSON.parse(localStorage.getItem(key))})),draftPrefix);
const paymentDialog=page=>page.getByRole('dialog',{name:'Enregistrer un paiement',exact:true});
async function noOverflow(page){
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page horizontal overflow');
 for(const dialog of await page.getByRole('dialog').all())assert.ok(await dialog.evaluate(el=>{const body=el.querySelector('.modal__body');return el.scrollWidth<=el.clientWidth+1&&(!body||body.scrollWidth<=body.clientWidth+1);}), 'dialog horizontal overflow');
}
async function invoices(page){
 const dismiss=page.getByRole('button',{name:'Fermer le message',exact:true});
 await page.addLocatorHandler(dismiss,async()=>{const notice=page.locator('.notice');report.infrastructureNotices.push((await notice.innerText()).slice(0,1000));await dismiss.click();});
 try{
  await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
  await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Factures');
  await page.locator('.navigation-palette__results button').filter({has:page.getByText('Factures',{exact:true})}).click();
 }finally{await page.removeLocatorHandler(dismiss);}
}
async function open(page){
 const disclosure=page.locator('summary').filter({has:page.getByText('Actions du document',{exact:true})});
 if(await disclosure.count()&&!await disclosure.evaluate(el=>el.closest('details').open))await disclosure.click();
 await page.getByTitle('Enregistrer un paiement',{exact:true}).click();
 await paymentDialog(page).waitFor();await noOverflow(page);
}
async function load(page,identity={}){
 const url=new URL('/tests/mobile-harness.html',origin);url.searchParams.set('paymentGuided','1');
 for(const [key,value] of Object.entries(identity))url.searchParams.set(key,value);
 await page.goto(url.href);await page.waitForFunction(()=>!!window.paymentGuidedFixture&&!!window.__qaDesktopApi);
 const guide=page.getByRole('button',{name:'Fermer le guide automatique',exact:true});if(await guide.count())await guide.click();
 await invoices(page);await open(page);
}
async function fill(page,value=sample){
 const dialog=paymentDialog(page);
 for(const field of ['amount','date','method'])await dialog.locator(`[name="${field}"]`).fill(value[field]);
 const summary=dialog.locator('summary').filter({hasText:'Référence et note'});
 if(!await summary.evaluate(el=>el.closest('details').open))await summary.click();
 for(const field of ['reference','notes'])await dialog.locator(`[name="${field}"]`).fill(value[field]);
 await noOverflow(page);
}
async function fields(page,value=sample){for(const field of Object.keys(value))assert.equal(await paymentDialog(page).locator(`[name="${field}"]`).inputValue(),value[field],`retained ${field}`);}
async function restore(page,required=false){
 const button=paymentDialog(page).getByRole('button',{name:'Reprendre ma saisie',exact:true});
 if(required)await button.waitFor();if(await button.count())await button.click();
 const keep=paymentDialog(page).getByRole('button',{name:'Conserver ma saisie',exact:true});if(await keep.count())await keep.click();
}
async function review(page){await paymentDialog(page).getByRole('button',{name:'Vérifier le paiement',exact:true}).click();await paymentDialog(page).getByRole('button',{name:'Enregistrer le paiement',exact:true}).waitFor();await noOverflow(page);}
const save=page=>paymentDialog(page).getByRole('button',{name:'Enregistrer le paiement',exact:true}).click();
async function alertReady(page){
 await paymentDialog(page).locator('.credit-allocation-alert[role="alert"]').waitFor();
 await page.waitForFunction(()=>{const root=document.querySelector('.credit-allocation-modal');return root&&!Array.from(root.querySelectorAll('button')).some(el=>el.textContent==='Vérification…');});
 assert.equal(await page.getByRole('dialog').count(),1,'local failure must not create a parent recovery dialog');await noOverflow(page);
}
async function probe(page){await paymentDialog(page).getByRole('button',{name:'Vérifier l’enregistrement',exact:true}).click();}
async function editable(page){await paymentDialog(page).locator('[name="amount"]').waitFor();await restore(page);await page.waitForFunction(()=>{const input=document.querySelector('.credit-allocation-modal [name="amount"]');return input&&!input.matches(':disabled');});assert.equal(await page.getByRole('dialog').count(),1);}
async function confirmed(page,count=1){await paymentDialog(page).waitFor({state:'hidden'});const s=await state(page);assert.equal(s.writes,count);assert.equal(s.payments.length,count);assert.equal(s.journals.length,count);assert.equal((await receipts(page)).length,0);await noOverflow(page);}
const cases={
 async 'draft-close-reopen'(page){
  await load(page);await fill(page);const before=await drafts(page);assert.equal(before.length,1);assert.deepEqual(before[0].record.value,sample);
  await paymentDialog(page).getByRole('button',{name:'Annuler',exact:true}).click();await open(page);await restore(page,true);await fields(page);assert.equal((await state(page)).attempts.length,0);assert.equal((await receipts(page)).length,0);
  await paymentDialog(page).getByRole('button',{name:'Annuler',exact:true}).click();await page.reload();await invoices(page);await open(page);await restore(page,true);await fields(page);assert.equal((await state(page)).attempts.length,0);
 },
 async 'quota-before-write'(page){
  await load(page);await fill(page);await review(page);
  await page.evaluate(prefix=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===localStorage&&key.startsWith(prefix))throw new DOMException('Injected receipt quota','QuotaExceededError');return original.call(this,key,value);};window.__qaRestoreStorage=()=>Storage.prototype.setItem=original;},requestPrefix);
  try{await save(page);await alertReady(page);assert.equal((await state(page)).attempts.length,0);assert.equal((await receipts(page)).length,0);await paymentDialog(page).getByRole('button',{name:'Modifier',exact:true}).click();await fields(page);assert.deepEqual((await drafts(page))[0].record.value,sample);}
  finally{await page.evaluate(()=>window.__qaRestoreStorage());}
 },
 async 'confirmed-draft-retirement-failed-keeps-receipt'(page){
  await load(page);await fill(page);await review(page);const oldDraft=(await drafts(page))[0];assert.deepEqual(oldDraft.record.value,sample);
  await configure(page,{proofHold:true});
  await page.evaluate(({draftPrefix,completedPrefix})=>{
   const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem,get=Storage.prototype.getItem;
   Storage.prototype.setItem=function(key,value){if(this===localStorage&&(key.startsWith(completedPrefix)||(key.startsWith(draftPrefix)&&get.call(this,key)!==null)))throw new DOMException('Injected draft retirement failure','QuotaExceededError');return set.call(this,key,value);};
   Storage.prototype.removeItem=function(key){if(this===localStorage&&key.startsWith(draftPrefix))throw new DOMException('Injected draft deletion failure','QuotaExceededError');return remove.call(this,key);};
   window.__qaRestoreDraftRetirementStorage=()=>{Storage.prototype.setItem=set;Storage.prototype.removeItem=remove;};
  },{draftPrefix,completedPrefix:'zentra.forms.completed.v1.'});
  try{
   await save(page);await page.waitForFunction(()=>window.paymentGuidedFixture.state.writes===1&&window.paymentGuidedFixture.state.proofWaiting);const retained=(await receipts(page))[0];assert.equal(retained.record.variants[0].amountCents,1025);
   await page.evaluate(()=>window.paymentGuidedFixture.releaseProof());await alertReady(page);
   await paymentDialog(page).getByText('Ce paiement est confirmé. Consultez son historique avant de préparer un autre encaissement.',{exact:true}).waitFor();
   const submit=paymentDialog(page).locator('button[type="submit"]');assert.ok(await submit.count()===0||await submit.isDisabled(),'confirmed payment must not be sendable');
   assert.equal((await receipts(page))[0].raw,retained.raw,'failed draft retirement must retain the immutable financial receipt');assert.equal((await drafts(page))[0].raw,oldDraft.raw);const before=await state(page);assert.equal(before.attempts.length,1);assert.equal(before.writes,1);assert.equal(before.payments.length,1);assert.equal(before.payments[0].amount_cents,1025);assert.equal(before.journals.length,1);
   // Reload destroys the old JS realm, including its in-memory completion map
   // and these fault injections; only the persisted draft/receipt/store survive.
   await page.reload();await invoices(page);await open(page);assert.equal((await receipts(page))[0].raw,retained.raw);assert.equal((await drafts(page))[0].raw,oldDraft.raw);assert.equal(await paymentDialog(page).locator('[name="amount"]').count(),0);assert.equal(await paymentDialog(page).getByRole('button',{name:'Reprendre ma saisie',exact:true}).count(),0);const reopened=await state(page);assert.equal(reopened.attempts.length,1);assert.equal(reopened.reads.length,before.reads.length,'reopening must neither probe nor replay automatically');
   await probe(page);await confirmed(page);const after=await state(page);assert.equal(after.attempts.length,1);assert.equal(after.replayCount,0);assert.equal(after.payments[0].id,retained.record.variants[0].requestId);assert.equal((await drafts(page)).length,0,'explicit recorded proof safely retires the old editable draft');
  }finally{await page.evaluate(()=>window.__qaRestoreDraftRetirementStorage?.());}
 },
 async 'closed-period-correct-same-uuid'(page){
  await load(page);await fill(page);await review(page);await configure(page,{mode:'period'});await save(page);await alertReady(page);await editable(page);await fields(page);
  const original=(await receipts(page))[0];assert.equal(original.record.variants.length,1);assert.equal((await state(page)).writes,0);
  const corrected={...sample,date:'2026-05-03',notes:'Date corrigée'};await fill(page,corrected);await review(page);await configure(page,{hold:true});await save(page);
  await page.waitForFunction(()=>window.paymentGuidedFixture.state.attempts.length===2&&window.paymentGuidedFixture.state.writeWaiting);const changed=(await receipts(page))[0];assert.deepEqual(changed.record.variants[0],original.record.variants[0]);assert.equal(changed.record.variants.length,2);assert.equal(changed.record.variants[1].requestId,original.record.variants[0].requestId);
  await page.evaluate(()=>window.paymentGuidedFixture.releaseWrite());await confirmed(page);const s=await state(page);assert.equal(new Set(s.attempts.map(row=>row.args.input.request_id)).size,1);assert.equal(s.payments[0].date,corrected.date);assert.equal(s.replayCount,0);
 },
 async 'unknown-write-read-failed'(page){
  await load(page);await fill(page);await review(page);await configure(page,{mode:'unknown',readMode:'throw'});await save(page);await alertReady(page);
  const retained=(await receipts(page))[0];assert.equal((await state(page)).writes,0);assert.equal(await paymentDialog(page).locator('[name="amount"]').count(),0);
  await probe(page);await editable(page);await fields(page);assert.equal((await receipts(page))[0].raw,retained.raw);assert.equal((await state(page)).attempts.length,1);
  await review(page);await save(page);await confirmed(page);assert.equal((await state(page)).attempts[1].args.input.request_id,retained.record.variants[0].requestId);
 },
 async 'lost-ack-reload-explicit-proof'(page){
  await load(page);await fill(page);await review(page);await configure(page,{mode:'lost-unreadable'});await save(page);await alertReady(page);
  const retained=(await receipts(page))[0],before=await state(page);assert.equal(before.writes,1);assert.equal(before.attempts.length,1);
  await paymentDialog(page).getByRole('button',{name:'Fermer',exact:true}).click();await page.reload();await invoices(page);await open(page);
  assert.equal((await receipts(page))[0].raw,retained.raw);assert.equal((await state(page)).attempts.length,1);assert.equal((await state(page)).reads.length,before.reads.length,'no proof/replay on mount');
  await page.evaluate(()=>window.paymentGuidedFixture.unlockReads());await probe(page);await confirmed(page);const s=await state(page);assert.equal(s.attempts.length,1);assert.equal(s.replayCount,0);assert.equal(s.payments[0].id,retained.record.variants[0].requestId);
 },
 async 'canonical-alias-proof'(page){
  await load(page);await fill(page);await review(page);await configure(page,{mode:'alias-lost',proofHold:true});await save(page);
  await page.waitForFunction(()=>window.paymentGuidedFixture.state.reads.length===1&&window.paymentGuidedFixture.state.writes===1&&window.paymentGuidedFixture.state.proofWaiting);const retained=(await receipts(page))[0],s=await state(page),original=retained.record.variants[0].requestId;
  assert.notEqual(s.payments[0].id,original);assert.equal(s.aliases[original],s.payments[0].id);assert.equal(s.journals[0].source_id,s.payments[0].id);
  await page.evaluate(()=>window.paymentGuidedFixture.releaseProof());await confirmed(page);assert.equal((await state(page)).attempts.length,1);assert.equal((await state(page)).replayCount,0);
 },
 async 'racing-variants-one-payment'(page){
  await load(page);await fill(page);await review(page);await configure(page,{mode:'unknown',readMode:'throw'});await save(page);await alertReady(page);
  const retained=(await receipts(page))[0],input=retained.record.variants[0],other={...input,amountCents:2000,notes:'Variante concurrente'};
  const outcome=await page.evaluate(async({input,other})=>{const api=window.__qaDesktopApi;return Promise.allSettled([api.writePaymentRequest(input.invoiceId,input,'qa-payment-company'),api.writePaymentRequest(other.invoiceId,other,'qa-payment-company')]).then(rows=>rows.map(row=>row.status));},{input,other});
  assert.deepEqual(outcome.sort(),['fulfilled','rejected']);assert.equal((await state(page)).writes,1);assert.equal((await state(page)).payments.length,1);
  const proof=await page.evaluate(({input,other})=>window.__qaDesktopApi.readPaymentRequest([input,other,{...input,expectedReview:{...input.expectedReview,balanceCents:9999}}],'qa-payment-company'),{input,other});assert.equal(proof.status,'recorded');assert.equal(proof.variantIndex,0,'first identical financial payload wins');
  await probe(page);await confirmed(page);assert.equal((await state(page)).attempts.length,3);assert.equal((await state(page)).replayCount,0);
 },
 async 'member-company-organization-isolation'(page){
  await load(page);await fill(page);await review(page);await configure(page,{mode:'unknown',readMode:'throw'});await save(page);await alertReady(page);const retained=(await receipts(page))[0];
  await paymentDialog(page).getByRole('button',{name:'Fermer',exact:true}).click();
  for(const identity of [{paymentMember:'qa-payment-other-member'},{paymentCompany:'qa-payment-other-company'},{paymentOrganization:'qa-payment-other-org'}]){
   await load(page,identity);assert.equal(await paymentDialog(page).getByRole('button',{name:'Vérifier l’enregistrement',exact:true}).count(),0);assert.equal(await paymentDialog(page).getByRole('button',{name:'Reprendre ma saisie',exact:true}).count(),0);assert.equal(await paymentDialog(page).locator('[name="amount"]').inputValue(),'');assert.equal((await state(page)).attempts.length,1);assert.equal((await receipts(page))[0].raw,retained.raw);
   await paymentDialog(page).getByRole('button',{name:'Annuler',exact:true}).click();
  }
  await load(page);assert.equal(await paymentDialog(page).getByRole('button',{name:'Vérifier l’enregistrement',exact:true}).count(),1);assert.equal((await receipts(page))[0].raw,retained.raw);assert.equal((await state(page)).attempts.length,1);
 },
 async 'newer-receipt-cas-blocks-clear'(page){
  await load(page);await fill(page);await review(page);await configure(page,{mode:'lost',proofHold:true});await save(page);
  await page.waitForFunction(()=>window.paymentGuidedFixture.state.reads.length===1&&window.paymentGuidedFixture.state.writes===1&&window.paymentGuidedFixture.state.proofWaiting);const retained=(await receipts(page))[0];
  const newer=await page.evaluate(({key,record})=>{const changed={...record,savedAt:record.savedAt+1};const raw=JSON.stringify(changed);localStorage.setItem(key,raw);return raw;},retained);
  await page.evaluate(()=>window.paymentGuidedFixture.releaseProof());await alertReady(page);assert.equal((await receipts(page))[0].raw,newer);assert.equal((await state(page)).attempts.length,1);assert.equal((await state(page)).writes,1);
  await probe(page);await confirmed(page);assert.equal((await state(page)).attempts.length,1);
 },
 async 'newer-receipt-cas-blocks-send'(page){
  await load(page);await fill(page);await review(page);await configure(page,{mode:'unknown',readMode:'throw'});await save(page);await alertReady(page);await probe(page);await editable(page);await fields(page);await review(page);
  const retained=(await receipts(page))[0];const newer=await page.evaluate(({key,record})=>{const raw=JSON.stringify({...record,savedAt:record.savedAt+1});localStorage.setItem(key,raw);return raw;},retained);
  await save(page);await alertReady(page);assert.equal((await receipts(page))[0].raw,newer);assert.equal((await state(page)).attempts.length,1);assert.equal((await state(page)).writes,0);await paymentDialog(page).getByRole('button',{name:'Modifier',exact:true}).click();await fields(page);
 },
 async 'read-only-probe-without-write'(page){
  await load(page);await fill(page);await page.evaluate(()=>window.__qaSetReadOnly(true));await page.waitForFunction(()=>document.querySelector('.credit-allocation-modal [name="amount"]')?.matches(':disabled'));assert.equal(await paymentDialog(page).getByRole('button',{name:'Vérifier le paiement',exact:true}).isDisabled(),true);assert.equal((await state(page)).attempts.length,0);
  await page.evaluate(()=>window.__qaSetReadOnly(false));await review(page);await configure(page,{mode:'lost-unreadable'});await save(page);await alertReady(page);await page.evaluate(()=>window.__qaSetReadOnly(true));await page.evaluate(()=>window.paymentGuidedFixture.unlockReads());assert.equal(await paymentDialog(page).getByRole('button',{name:'Vérifier l’enregistrement',exact:true}).isEnabled(),true);await probe(page);await confirmed(page);assert.equal((await state(page)).attempts.length,1);
 },
 async 'stale-bank-balance-correctable'(page){
  await load(page);await fill(page);await review(page);await configure(page,{hold:true});await save(page);await page.waitForFunction(()=>window.paymentGuidedFixture.state.attempts.length===1&&window.paymentGuidedFixture.state.writeWaiting);
  await page.evaluate(()=>{const f=window.paymentGuidedFixture;f.state.stored.accounting_settings.bank_account_id='bank2';f.state.stored.invoices[0].credited_cents=1000;f.persist();f.releaseWrite();});
  await alertReady(page);await editable(page);await fields(page);assert.equal((await state(page)).writes,0);const retained=(await receipts(page))[0];
  await review(page);await configure(page,{hold:true});await save(page);await page.waitForFunction(()=>window.paymentGuidedFixture.state.attempts.length===2&&window.paymentGuidedFixture.state.writeWaiting);const changed=(await receipts(page))[0];assert.equal(changed.record.variants.length,2);assert.deepEqual(changed.record.variants[0],retained.record.variants[0]);assert.deepEqual(changed.record.variants[1].expectedReview,{balanceCents:9000,bankAccountId:'bank2'});
  await page.evaluate(()=>window.paymentGuidedFixture.releaseWrite());await confirmed(page);const s=await state(page);assert.equal(new Set(s.attempts.map(row=>row.args.input.request_id)).size,1);assert.equal(s.journals[0].bank_account_id,'bank2');
 },
 async 'conflicting-proof-keeps-retry'(page){
  await load(page);await fill(page);await review(page);await configure(page,{mode:'lost-unreadable'});await save(page);await alertReady(page);const retained=(await receipts(page))[0];
  await page.evaluate(()=>window.paymentGuidedFixture.unlockReads());await configure(page,{readMode:'conflict'});await probe(page);await alertReady(page);assert.equal(await paymentDialog(page).locator('[name="amount"]').count(),0);assert.equal(await paymentDialog(page).getByRole('button',{name:'Vérifier l’enregistrement',exact:true}).isEnabled(),true);assert.equal((await receipts(page))[0].raw,retained.raw);assert.equal((await state(page)).attempts.length,1);
  await probe(page);await confirmed(page);assert.equal((await state(page)).attempts.length,1);
 },
};
if(selected)assert.ok(selected.every(name=>Object.hasOwn(cases,name)),'Unknown QA case');
let failures=0;
try{
 for(const engine of engines){
  assert.ok(['chromium','webkit','firefox'].includes(engine));let browser;
  try{
   browser=await pw[engine].launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
   for(const width of widths)for(const [name,run] of Object.entries(cases).filter(([name])=>!selected||selected.includes(name))){
    const context=await browser.newContext({viewport:{width,height:width<860?844:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(timeout);const errors=[],external=[];
    page.on('pageerror',cause=>errors.push(cause.message));page.on('dialog',dialog=>dialog.dismiss());
    await context.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin.origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.origin);return route.abort();});
    try{
     await run(page);await noOverflow(page);assert.deepEqual(errors,[],'browser errors');assert.deepEqual(external,[],'external request attempted');const s=await state(page);report.cases.push({engine,width,name,status:'pass',attempts:s.attempts.length,reads:s.reads.length,writes:s.writes,replayCount:s.replayCount});console.log(`PASS ${engine} ${width} ${name}`);
    }catch(cause){
     failures++;report.cases.push({engine,width,name,status:'fail',error:cause.stack||String(cause),browserErrors:errors,external,state:await state(page).catch(()=>null)});console.error(`FAIL ${engine} ${width} ${name}: ${cause.message}`);
     await page.screenshot({path:join(directory,`${engine}-${width}-${name}-failure.png`)}).catch(()=>{});await writeFile(join(directory,`${engine}-${width}-${name}-failure.txt`),await page.locator('body').innerText().catch(()=>''));
    }finally{await context.close();}
   }
  }finally{await browser?.close();}
 }
}finally{report.finishedAt=new Date().toISOString();report.failures=failures;await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));}
assert.equal(failures,0,`${failures} failed local payment recovery cases; see ${directory}`);
