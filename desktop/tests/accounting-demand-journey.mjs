import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const engine=process.env.ZENTRA_QA_BROWSER||'edge';
const width=Number(process.env.ZENTRA_QA_WIDTH||1440);
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5377';
const baseline=process.argv.includes('--baseline');
const out=new URL('../.qa/accounting-demand/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine!=='webkit'&&process.platform==='win32'?{channel:'msedge'}:{})});
const results=[];
try {
 const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
 const errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1`);
 await page.getByRole('button',{name:'Découvrir plus tard',exact:true}).click();
 await page.evaluate(async()=>{
  const {desktopApi:api}=await import('/src/bridge.ts');
  const continuity=api.getAccountingContinuity;
  api.getAccountingContinuity=async()=>({...await continuity(),enabled:true,mappingReady:true,journalEntryCount:3});
  api.listAccounts=async()=>['bank-test','cash-test'].map((id,index)=>({id,code:String(1020-index*20),name:'Compte fictif '+index,active:true,accountType:'asset',normalBalance:'debit',reportSection:'current_assets'}));
  window.__reportCalls=[];window.__reportControl={};
  for(const name of ['getJournal','getTrialBalance','getLedger','getBalanceSheet','getIncomeStatement']) {
   const original=api[name];
   api[name]=async(...args)=>{
    window.__reportCalls.push({name,args:structuredClone(args)});
    const control=window.__reportControl[name];
    if(control){delete window.__reportControl[name];await new Promise((resolve,reject)=>{window.__reportRelease=()=>control==='reject'?reject(new Error('Lecture fictive interrompue.')):resolve();});}
    const result=await original(...args);
    if(name==='getIncomeStatement'){window.__lastIncomeScope={...result.scope,dateFrom:args[0]?.dateFrom||result.scope.dateFrom,dateTo:args[0]?.dateTo||result.scope.dateTo};return {...result,revenueCents:control==='stale'?990000:123456,expenseCents:4567,profitCents:control==='stale'?985433:118889,scope:window.__lastIncomeScope};}
    if(name==='getBalanceSheet')return {...result,scope:{...result.scope,dateFrom:args[0]?.dateFrom||result.scope.dateFrom,dateTo:args[0]?.dateTo||result.scope.dateTo}};
    return result;
   };
  }
 });
 if(width<500)await page.evaluate(async()=>{(await import('/src/textSize.ts')).setTextSize(200);(await import('/src/appearance.ts')).setAppearance('dark');});
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('zentra-automation-navigate',{detail:'accounting'})));
 await page.locator('.desktop-app[data-view="accounting"]').waitFor();
 await page.waitForFunction(()=>document.querySelector('.finance-overview__figures')?.getAttribute('aria-busy')==='false');
 const initial=await page.evaluate(()=>window.__reportCalls);
 assert.deepEqual(initial.map(call=>call.name).sort(),baseline?['getBalanceSheet','getIncomeStatement','getJournal','getLedger','getTrialBalance']:['getIncomeStatement']);
 const amounts=await page.locator('.finance-overview__figures strong').allTextContents();
 assert.deepEqual(amounts.map(text=>text.replace(/[^0-9.]/g,'')),['1234.56','45.67','1188.89']);
 results.push({step:'initial-overview',commands:initial,amounts});
 if(!baseline) {
  const ready=()=>page.waitForFunction(()=>[...document.querySelectorAll('.accounting-period-bar button')].some(button=>button.textContent.trim()==='Actualiser'&&!button.disabled));
  const clear=()=>page.evaluate(()=>window.__reportCalls=[]);
  const calls=()=>page.evaluate(()=>window.__reportCalls);
  const section=async(tab)=>{
   const labels={overview:'Vue d’ensemble',income:'Résultat',closing:'Dossier de clôture',assets:'Immobilisations',vat:'TVA'};
   const picker=page.getByRole('combobox',{name:'Section comptable',exact:true});
   if(labels[tab]&&await picker.isVisible())await picker.selectOption(tab);
   else if(labels[tab])await page.getByRole('tab',{name:labels[tab],exact:true}).click();
   else await page.getByRole('combobox',{name:'Autres outils comptables',exact:true}).selectOption(tab);
  };
  const check=async(step,expected)=>{
   await ready();const commands=await calls();
   assert.deepEqual(commands.map(call=>call.name).sort(),expected.slice().sort(),step);
   results.push({step,commands});
  };
  await clear();await section('income');await check('income-and-export',['getBalanceSheet','getIncomeStatement']);
  assert.equal(await page.locator('.accounting-export-bar button').isDisabled(),false);
  for(const [tab,expected] of [['journal',['getJournal']],['ledger',['getLedger']],['trial',['getTrialBalance']],['closing',['getTrialBalance','getBalanceSheet','getIncomeStatement']],['accounts',[]],['periods',[]]]) {
   await clear();await section(tab);await check(tab,expected);
  }
  await section('ledger');await ready();await clear();
  await page.locator('.ledger-picker select').selectOption('cash-test');await check('ledger-account-change',['getLedger']);
  assert.equal((await calls())[0].args[0],'cash-test');
  await section('overview');await ready();await clear();
  await page.getByRole('combobox',{name:'Période de la vue d’ensemble',exact:true}).selectOption('month');
  await check('month-only-income',['getIncomeStatement']);
  const month=(await calls())[0].args[0];assert.match(month.dateFrom,/-01$/);
  // A previous request can settle after navigation, but cannot replace the new view or its errors.
  await page.evaluate(()=>window.__reportControl.getIncomeStatement='reject');
  await page.getByRole('combobox',{name:'Période de la vue d’ensemble',exact:true}).selectOption('quarter');
  await page.waitForFunction(()=>typeof window.__reportRelease==='function');
  await section('income');await ready();
  await page.evaluate(()=>{window.__reportRelease();delete window.__reportRelease;});
  await ready();assert.equal(await page.locator('.error-panel').count(),0);
  assert.equal(await page.locator('.accounting-export-bar button').isDisabled(),false);
  results.push({step:'late-failed-period-ignored',commands:await calls()});
  // A failure of the current view remains visible and can be retried from that view.
  await page.evaluate(()=>window.__reportControl.getJournal='reject');
  await section('journal');await page.waitForFunction(()=>typeof window.__reportRelease==='function');
  await page.evaluate(()=>{window.__reportRelease();delete window.__reportRelease;});
  await page.getByText('Lecture fictive interrompue.',{exact:false}).waitFor();
  await clear();await page.getByRole('button',{name:'Réessayer',exact:true}).click();
  await check('failed-journal-retry',['getJournal']);
  assert.equal(await page.locator('.error-panel').count(),0);
  await page.evaluate(()=>window.__reportControl.getIncomeStatement='stale');
  await section('income');await page.waitForFunction(()=>typeof window.__reportRelease==='function');
  await section('overview');await ready();
  await page.getByRole('combobox',{name:'Période de la vue d’ensemble',exact:true}).selectOption('month');await ready();
  await page.evaluate(()=>{window.__reportRelease();delete window.__reportRelease;});await ready();
  assert.deepEqual(await page.locator('.finance-overview__figures strong').allTextContents(),amounts);
  assert.equal(await page.getByRole('combobox',{name:'Période de la vue d’ensemble',exact:true}).inputValue(),'month');
  results.push({step:'late-success-cannot-replace-new-period',amounts:await page.locator('.finance-overview__figures strong').allTextContents()});
  await section('income');await ready();await clear();
  await page.getByRole('button',{name:'Toutes les dates',exact:true}).click();await check('open-period-keeps-both-statements',['getBalanceSheet','getIncomeStatement']);
  assert.deepEqual((await calls()).map(call=>call.args),[[{dateFrom:undefined,dateTo:undefined}],[{dateFrom:undefined,dateTo:undefined}]]);
  await section('overview');await ready();
  const scopeLabel=await page.evaluate(async()=>{const {formatDate}=await import('/src/utils.ts');return `${formatDate(window.__lastIncomeScope.dateFrom)} – ${formatDate(window.__lastIncomeScope.dateTo)}`;});
  assert.equal(await page.locator('.finance-overview__intro > div > p').innerText(),scopeLabel);
  results.push({step:'open-period-uses-returned-scope',scopeLabel});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:new URL(`overview-${engine}-${width}.png`,out).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')});
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('zentra-automation-navigate',{detail:'clients'})));
  await page.locator('.desktop-app[data-view="clients"]').waitFor();
  for(const fallback of [false,true]) {
   await page.evaluate(async fallback=>{
    const {desktopApi:api}=await import('/src/bridge.ts');
    const report=await api.getJournal({});window.__reportCalls=[];
    const entry={id:'journal-exact',number:'J-FICTIF-42',entryDate:'2026-03-14',description:'Écriture fictive exacte',sourceType:'manual',sourceId:null,sourceEvent:null,status:'posted',reversalOf:null,hasReversal:false};
    api.getJournal=async filter=>{window.__reportCalls.push({name:'getJournal',args:[structuredClone(filter)]});return {...report,entries:fallback&&filter.dateFrom?[]:[entry],lines:[]};};
    window.__focusFixture=await (await import('/tests/accounting-demand-focus.tsx')).mountFocusTest({entryId:entry.id,entryNumber:entry.number,entryDate:entry.entryDate,paymentId:'payment-fictif',accountingState:'active'});
   },fallback);
   await page.waitForFunction(()=>document.activeElement?.getAttribute('data-journal-entry-id')==='journal-exact');
   const commands=await calls();
   assert.deepEqual(commands.map(call=>call.args[0]),fallback?[{dateFrom:'2026-03-14',dateTo:'2026-03-14'},{}]:[{dateFrom:'2026-03-14',dateTo:'2026-03-14'}]);
   assert.ok(await page.evaluate(()=>window.__focusFixture.handled()>0));
   results.push({step:fallback?'exact-journal-fallback-without-reread':'exact-journal-without-reread',commands});
   if(fallback) {
    const panel=page.locator('#accounting-demand-focus');
    await panel.getByRole('combobox',{name:'Autres outils comptables',exact:true}).selectOption('accounts');
    await panel.locator('.accounting-account-plan summary').click();
    await panel.locator('.accounting-account-plan').getByRole('button',{name:'Nouveau compte',exact:true}).click();
    const form=panel.locator('.account-inline-form');
    await form.locator('[name="code"]').fill('1099');await form.locator('[name="name"]').fill('Compte fictif test');
    await form.locator('[name="accountType"]').selectOption('asset');await form.locator('[name="normalBalance"]').selectOption('debit');await form.locator('[name="reportSection"]').selectOption('current_assets');
    await page.evaluate(async()=>{const {desktopApi:api}=await import('/src/bridge.ts');window.__writeAttempts=0;api.upsertAccount=async()=>{window.__writeAttempts++;await new Promise((resolve,reject)=>{window.__writeRelease=()=>reject(new Error('Écriture fictive refusée.'));});};});
    await form.getByRole('button',{name:'Enregistrer',exact:true}).click();
    await page.waitForFunction(()=>typeof window.__writeRelease==='function');
    const picker=panel.getByRole('combobox',{name:'Section comptable',exact:true});
    if(await picker.isVisible())await picker.selectOption('overview');else await panel.getByRole('tab',{name:'Vue d’ensemble',exact:true}).click();
    await panel.locator('.finance-overview__figures').waitFor();
    assert.equal(await panel.locator('.finance-overview__figures').getAttribute('aria-busy'),'true');
    await page.evaluate(()=>window.__writeRelease());
    await panel.getByRole('alert').filter({hasText:'Écriture fictive refusée.'}).waitFor();
    await page.waitForFunction(()=>document.querySelector('#accounting-demand-focus .finance-overview__figures')?.getAttribute('aria-busy')==='false');
    assert.equal(await page.evaluate(()=>window.__writeAttempts),1);
    results.push({step:'tab-change-preserves-write-busy-and-failure',writeAttempts:1});
   }
   await page.evaluate(()=>window.__focusFixture.dispose());
  }
 }
 assert.deepEqual(errors,[]);
 await writeFile(new URL(baseline?'before.json':`after-${engine}-${width}.json`,out),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results));
} finally {await browser.close();}
