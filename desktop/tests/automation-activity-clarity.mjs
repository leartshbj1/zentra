import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357',fix=process.env.ZENTRA_ACTIVITY_REVIEW_FIX==='1',output=fix?'.qa/automation-activity-review-fix':'.qa/automation-activity-clarity';
await mkdir(output,{recursive:true});const proof=[];
for(const engine of ['chromium','webkit']){
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
 try{for(const width of fix?[320]:[320,390,1440])for(const language of ['fr','de','it','en']){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
  await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=active&automationDesign=1&automationActivityAudit=1&language=${language}&theme=${width===320?'dark':'light'}`);
  await page.locator('.automation-journal').waitFor();
  if(fix){
   const settings=page.locator('.automation-hub__navigation button').last();
   assert.equal(await settings.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return range.getClientRects().length;}),1,'Settings label is a single intact line');
  }
  const invoice=page.locator('.automation-journal__invoice').filter({hasText:'LEMAN-2026-091'});
  const invoiceAction=invoice.locator('xpath=..').locator('.automation-journal__direct button');
  assert.ok(await invoiceAction.isVisible(),'Imported invoice can be opened without expanding its details');
  await invoice.locator('summary').click();
  assert.ok(await invoice.locator('.automation-journal__facts').isVisible());
  assert.match(await invoice.innerText(),/270[.,]25/);
  assert.match(await invoice.innerText(),/facturation@papeterie.example.test/);
  const amountLabels={fr:'Montant lu sur la facture',de:'Ausgelesener Rechnungsbetrag',it:'Importo letto sulla fattura',en:'Amount read from the invoice'};
  assert.ok((await invoice.innerText()).includes(amountLabels[language]));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:`${output}/${engine}-${width}-${language}.png`});
  await invoiceAction.click();
  const modal=page.locator('[role="dialog"]').filter({hasText:'LEMAN-2026-091'});await modal.waitFor();
  assert.match(await modal.innerText(),/270[.,]25/);
  await modal.focus();await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
  if(fix){
   await page.evaluate(()=>{window.__automationActivityQa.state.activity.supplierInbox.recent[0].invoiceId='not-present-locally';window.__automationActivityQa.refresh();});
   await page.waitForTimeout(150);
   await invoiceAction.click();
   const unavailableInvoice={fr:'Cette facture n’est pas disponible dans les données chargées sur cet appareil.',de:'Diese Rechnung ist in den auf diesem Gerät geladenen Daten nicht verfügbar.',it:'Questa fattura non è disponibile nei dati caricati su questo dispositivo.',en:'This invoice is not available in the data loaded on this device.'};
   await page.getByText(unavailableInvoice[language],{exact:false}).waitFor();
   assert.equal(await page.locator('.supplier-file-modal').count(),0);
  }
  const search=page.locator('.automation-journal__search input');
  await search.fill('facturation@papeterie.example.test');assert.equal(await page.locator('.automation-journal__entry').count(),1);
  await search.fill('STUDIO-2026-067');assert.equal(await page.locator('.automation-journal__entry').count(),1);
  await search.fill('');
  const review=page.locator('.automation-journal__invoice').filter({hasText:'ELEC-2026-082'});
  assert.equal(await review.locator('[data-state="review"]').count(),1);
  await review.locator('summary').click();await review.locator('xpath=..').locator('.automation-journal__direct button').click();await page.locator('.supplier-inbox').waitFor();
  await page.locator('.automation-hub__navigation button').first().click();await page.locator('.automation-journal').waitFor();
  await page.evaluate(()=>{window.__automationActivityQa.state.activity=null;window.__automationActivityQa.refresh();});
  const unavailable={fr:'L’activité n’est pas disponible pour le moment.',de:'Die Aktivität ist zurzeit nicht verfügbar.',it:'Le attività non sono disponibili al momento.',en:'Activity is currently unavailable.'};
  await page.getByText(unavailable[language],{exact:true}).first().waitFor();
  await page.locator('.automation-hub__navigation button').nth(1).click();
  await page.locator('.automation-brief--attention').getByText(unavailable[language],{exact:true}).waitFor();
  assert.equal(await page.locator('.automation-brief--attention .automation-brief__empty svg').count(),0);
  assert.deepEqual(errors,[]);proof.push({engine,width,language,invoiceOpened:true,reviewDestination:true,searchMetadata:true,unknownHonest:true,noOverflow:true});await page.close();
 }}finally{await browser.close();}
}
await writeFile(`${output}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:proof.length,output}));
