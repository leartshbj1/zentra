import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine=process.env.ZENTRA_QA_ENGINE||'chromium', driver=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright')[engine];
const browser=await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const folder=process.env.ZENTRA_QA_DIR||`.qa/credit-allocation-${engine}`;await mkdir(folder,{recursive:true});const report=[];
try {
  for(const [width,height] of [[320,568],[390,844],[844,390],[1440,1000]].filter(([width])=>!process.env.ZENTRA_QA_WIDTHS||process.env.ZENTRA_QA_WIDTHS.split(',').includes(String(width)))) {
    const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const state=()=>page.evaluate(()=>window.creditAllocationFixture.state);
    const mode=value=>page.evaluate(value=>window.creditAllocationFixture.state.mode=value,value);
    const screenshot=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));for(const modal of await page.getByRole('dialog').all())assert.ok(await modal.evaluate(el=>el.scrollWidth<=el.clientWidth+1&&el.querySelector('.modal__body').scrollWidth<=el.querySelector('.modal__body').clientWidth+1));await page.screenshot({path:`${folder}/${width}-${name}.png`});};
    await page.goto(`${process.env.ZENTRA_QA_URL||'http://127.0.0.1:5271'}/tests/mobile-harness.html?creditAllocation=1`);
    await page.getByRole('button',{name:'Fermer le guide automatique',exact:true}).click();
    await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Achats');await page.locator('.navigation-palette__results button').filter({has:page.getByText('Achats & fournisseurs',{exact:true})}).click();
    if(width<=860)await page.getByRole('combobox',{name:'Section des achats',exact:true}).selectOption('documents');else await page.locator('#purchase-tab-documents').click();
    const card=page.locator('.purchase-document-card--credit').filter({has:page.getByRole('heading',{name:'AV-2026-003',exact:true})});
    await card.getByRole('button',{name:'Utiliser sur une facture',exact:true}).click();
    const dialog=page.locator('.credit-allocation-modal'),amount=dialog.locator('[name=amount]'),date=dialog.locator('[name=date]');
    const verify=()=>dialog.getByRole('button',{name:'Vérifier les soldes',exact:true}).click();
    const confirm=()=>dialog.getByRole('button',{name:'Confirmer l’utilisation',exact:true}).click();
    assert.equal(await amount.inputValue(),'49.05');await dialog.locator('form').evaluate(el=>el.addEventListener('submit',()=>el.dataset.submissions=String(Number(el.dataset.submissions||0)+1)));
    await dialog.getByRole('button',{name:/Utiliser le maximum/}).click();assert.equal(await dialog.locator('form').getAttribute('data-submissions'),null);assert.equal((await state()).attempts.length,0);
    for(const text of ['','20.001','100']) {await amount.fill(text);await verify();await page.waitForFunction(()=>document.activeElement?.getAttribute('name')==='amount');assert.equal(await amount.inputValue(),text);assert.equal((await state()).writes,0);}
    await screenshot('amount-error');await amount.fill('10,25');await date.fill('2026-05-01');await verify();await page.waitForFunction(()=>document.activeElement?.getAttribute('name')==='date');
    await date.fill('2026-05-03');await page.evaluate(()=>window.__qaSetReadOnly(true));await page.waitForFunction(()=>document.querySelector('[name=amount]')?.matches(':disabled'));await page.evaluate(()=>window.__qaSetReadOnly(false));await page.waitForFunction(()=>!document.querySelector('[name=amount]')?.matches(':disabled'));
    await verify();assert.equal((await state()).attempts.length,0);await screenshot('review');
    await page.evaluate(()=>window.creditAllocationFixture.state.stored.supplier_invoices[0].paid_cents=1000);await page.evaluate(()=>window.__qaCreditAllocationRefresh());
    await dialog.getByRole('button',{name:'Reprendre la vérification',exact:true}).click();assert.equal((await state()).attempts.length,0);
    await page.evaluate(()=>window.creditAllocationFixture.state.hold=true);await confirm();await page.waitForFunction(()=>window.creditAllocationFixture.state.attempts.length===1);
    await page.keyboard.press('Escape');assert.ok(await dialog.isVisible());assert.ok(await dialog.getByRole('button',{name:'Modifier',exact:true}).isDisabled());
    await page.evaluate(()=>{const s=window.creditAllocationFixture.state;s.stored.supplier_invoices[0].paid_cents=2000;s.hold=false;s.release();});
    await dialog.getByText('Les soldes ont changé depuis votre vérification. Actualisez-les, puis relisez les montants avant de confirmer.',{exact:true}).waitFor();assert.equal((await state()).writes,0);
    await dialog.getByRole('button',{name:'Reprendre la vérification',exact:true}).click();await mode('lost-unreadable');await confirm();
    const recovery=page.getByRole('dialog',{name:'Vérifier l’enregistrement',exact:true});await recovery.waitFor();assert.equal((await state()).writes,1);
    await page.evaluate(()=>{const s=window.creditAllocationFixture.state;s.blockRead=false;s.empty=true;});await recovery.getByRole('button',{name:'Vérifier maintenant',exact:true}).click();await recovery.getByText('Vérification encore indisponible',{exact:true}).waitFor();
    await page.evaluate(()=>window.creditAllocationFixture.state.empty=false);await recovery.getByRole('button',{name:'Vérifier maintenant',exact:true}).click();await dialog.waitFor({state:'detached'});
    assert.equal((await state()).attempts.length,2);assert.equal((await state()).stored.supplier_credit_allocations[0].amount_cents,1025);
    await card.getByRole('button',{name:'Annuler cette utilisation',exact:true}).click();await verify();await page.waitForFunction(()=>document.activeElement?.getAttribute('name')==='reason');
    await dialog.locator('[name=reason]').fill('Erreur');await date.fill('2026-05-04');await verify();await screenshot('reverse-review');await mode('ack-unreadable');await dialog.getByRole('button',{name:'Confirmer l’annulation',exact:true}).click();
    const acknowledged=page.getByRole('dialog',{name:'Enregistrement effectué',exact:true});await acknowledged.waitFor();assert.equal((await state()).writes,2);
    await page.evaluate(()=>{const s=window.creditAllocationFixture.state;s.blockRead=false;s.omitHistory=true;});await acknowledged.getByRole('button',{name:'Actualiser les données',exact:true}).click();await acknowledged.getByText('Actualisation impossible',{exact:true}).waitFor();
    await page.evaluate(()=>window.creditAllocationFixture.state.omitHistory=false);await acknowledged.getByRole('button',{name:'Actualiser les données',exact:true}).click();await dialog.waitFor({state:'detached'});
    assert.equal((await state()).attempts.length,3);assert.equal((await state()).stored.supplier_invoices[0].credited_cents,0);assert.equal((await state()).stored.supplier_credit_allocations.length,2);
    await card.getByRole('button',{name:'Utiliser sur une facture',exact:true}).click();await amount.fill('2,50');await verify();await mode('refuse');await confirm();await dialog.getByRole('button',{name:'Ouvrir les exercices',exact:true}).waitFor();await screenshot('period-help');
    await dialog.getByRole('button',{name:'Modifier',exact:true}).click();assert.equal(await amount.inputValue(),'2,50');await dialog.getByRole('button',{name:'Retour',exact:true}).click();
    await page.reload();assert.equal((await state()).stored.supplier_credit_allocations.length,2);assert.deepEqual(errors,[]);
    report.push({width,height,exactCents:true,currentBalances:true,nativeStaleRefusal:true,briefReason:true,lostResponse:true,acknowledgedRecovery:true,singleWrites:true,readOnly:true,persistence:true,noOverflow:true});await page.close();
  }
}catch(error){report.push({error:error.stack});process.exitCode=1;const page=browser.contexts().flatMap(context=>context.pages()).at(-1);if(page){await page.screenshot({path:`${folder}/failure.png`,fullPage:true});await writeFile(`${folder}/failure.html`,await page.content());}}
finally{await writeFile(`${folder}/report.json`,JSON.stringify({engine,report},null,2));console.log(JSON.stringify({engine,report}));await browser.close();}
