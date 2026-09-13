import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine=process.env.ZENTRA_QA_ENGINE||'chromium';
const driver=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright')[engine];
const browser=await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const folder=`.qa/receipt-guided-${engine}`;await mkdir(folder,{recursive:true});const report=[];
try{
  for(const [width,height] of (process.env.ZENTRA_QA_WIDTHS?process.env.ZENTRA_QA_WIDTHS.split(',').map(Number).map(width=>[width,width===320?568:width===844?390:900]):[[320,568],[390,844],[844,390],[1440,1000]])){
    const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const state=()=>page.evaluate(()=>window.receiptFixture.state);
    const mode=value=>page.evaluate(value=>window.receiptFixture.state.mode=value,value);
    const refresh=()=>page.evaluate(()=>window.__qaReceiptRefresh());
    const screenshot=async name=>{
      if(['comparison','stale-review','reverse-stock-help'].includes(name))await page.waitForFunction(()=>{
        const dialog=document.querySelector('.supplier-receipt-modal'), heading=dialog?.querySelector('.receipt-alert > strong'), body=dialog?.querySelector('.modal__body'), footer=dialog?.querySelector('.form-actions');
        if(!heading||!body||!footer)return false;
        const rect=heading.getBoundingClientRect();return rect.top>=Math.max(body.getBoundingClientRect().top,dialog.querySelector('.modal__header').getBoundingClientRect().bottom)-1&&rect.bottom<=Math.min(innerHeight,footer.getBoundingClientRect().top)+1;
      });
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));for(const modal of await page.getByRole('dialog').all())assert.ok(await modal.evaluate(el=>el.scrollWidth<=el.clientWidth+1&&el.querySelector('.modal__body').scrollWidth<=el.querySelector('.modal__body').clientWidth+1));await page.screenshot({path:`${folder}/${width}-${name}.png`});};
    await page.goto(`${process.env.ZENTRA_QA_URL||'http://127.0.0.1:5271'}/tests/mobile-harness.html?receiptGuided=1`);
    await page.getByRole('button',{name:'Fermer le guide automatique',exact:true}).click();
    await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Achats');await page.locator('.navigation-palette__results button').filter({has:page.getByText('Achats & fournisseurs',{exact:true})}).click();
    if(width<=860)await page.getByRole('combobox',{name:'Section des achats',exact:true}).selectOption('orders');else await page.locator('#purchase-tab-orders').click();
    await page.getByRole('button',{name:'Saisir la réception',exact:true}).click();
    let form=page.locator('form.receipt-form');const submit=()=>form.getByRole('button',{name:'Continuer vers la validation',exact:true}).click();
    const quantity=()=>form.locator('[name=quantity-paint-line]');
    await form.evaluate(el=>el.addEventListener('submit',()=>{el.dataset.submissions=String(Number(el.dataset.submissions||0)+1);}));
    await form.getByRole('button',{name:'Tout est arrivé',exact:true}).click();assert.equal(await quantity().inputValue(),'10.000');assert.equal(await form.getAttribute('data-submissions'),null);assert.equal((await state()).attempts.length,0);
    await quantity().fill('0');await form.locator('[name=quantity-sample-line]').fill('0');
    assert.equal(await quantity().inputValue(),'0');await submit();await page.waitForFunction(()=>document.activeElement?.getAttribute('name')==='quantity-paint-line');assert.equal((await state()).attempts.length,0);
    await quantity().fill('');assert.equal(await quantity().inputValue(),'');await submit();assert.equal((await state()).attempts.length,0);
    await quantity().fill('2.1256');await submit();await screenshot('quantity-error');
    await quantity().fill('2,125');await form.locator('[name=quantity-sample-line]').fill('1');await form.locator('[name=date]').fill('2026-09-02');
    await form.locator('summary').click();await form.locator('[name=reference]').fill('BL-2026-012');await form.locator('[name=notes]').fill('Premier colis\nLivraison partielle');
    await page.evaluate(()=>window.__qaSetReadOnly(true));await page.waitForFunction(()=>document.querySelector('[name=quantity-paint-line]')?.matches(':disabled'));assert.ok(await form.getByRole('button',{name:'Continuer vers la validation',exact:true}).isDisabled());await page.evaluate(()=>window.__qaSetReadOnly(false));await page.waitForFunction(()=>!document.querySelector('[name=quantity-paint-line]')?.matches(':disabled'));
    await mode('lost-unreadable');await submit();let recovery=page.getByRole('dialog',{name:'Vérifier l’enregistrement',exact:true});await recovery.waitFor();assert.equal((await state()).writes,1);assert.equal((await state()).stored.catalog_items[0].stock_quantity_milli,5000);
    await page.evaluate(()=>{window.receiptFixture.state.blockRead=false;window.receiptFixture.state.empty=true;});await recovery.getByRole('button',{name:'Vérifier maintenant',exact:true}).click();await recovery.getByText('Vérification encore indisponible',{exact:true}).waitFor();assert.equal((await state()).attempts.length,1);
    await page.evaluate(()=>window.receiptFixture.state.empty=false);await recovery.getByRole('button',{name:'Vérifier maintenant',exact:true}).click();await recovery.waitFor({state:'detached'});
    let review=page.getByRole('dialog',{name:'Vérifier et valider la réception',exact:true});await review.waitFor();assert.equal((await state()).writes,1);await screenshot('review');
    await review.getByRole('button',{name:'Corriger les quantités',exact:true}).click();await form.waitFor();await quantity().fill('3,5');const id=(await state()).stored.supplier_receipts[0].id;
    await page.evaluate(id=>window.receiptFixture.change(id,2750),id);await refresh();await form.getByText('Cette réception a changé ailleurs',{exact:true}).waitFor();assert.equal(await quantity().inputValue(),'3,5');await screenshot('comparison');
    await form.evaluate(el=>el.addEventListener('submit',()=>{el.dataset.submissions=String(Number(el.dataset.submissions||0)+1);}));
    await form.getByRole('button',{name:'Conserver ma saisie',exact:true}).click();assert.equal(await form.getAttribute('data-submissions'),null);assert.equal((await state()).attempts.length,1);await submit();await review.waitFor();assert.equal((await state()).stored.supplier_receipt_lines.find(row=>row.supplier_order_line_id==='paint-line').quantity_milli,3500);
    await review.getByRole('button',{name:'Valider la réception',exact:true}).click();await review.getByText(/^Cochez la confirmation/).waitFor();assert.equal((await state()).writes,2);
    await review.locator('input[type=checkbox]').check();await page.evaluate(()=>window.receiptFixture.state.hold=true);await review.getByRole('button',{name:'Valider la réception',exact:true}).click();await page.waitForFunction(()=>window.receiptFixture.state.attempts.length===3);
    await page.keyboard.press('Escape');assert.ok(await review.isVisible());assert.ok(await review.getByRole('button',{name:'Corriger les quantités',exact:true}).isDisabled());
    await page.evaluate(id=>{window.receiptFixture.change(id,4125);window.receiptFixture.state.hold=false;window.receiptFixture.state.release();},id);
    await review.getByText('La réception ou la commande a changé. Actualisez les données avant de reprendre.',{exact:true}).waitFor();assert.equal((await state()).writes,2);assert.equal(await review.locator('input[type=checkbox]').isChecked(),false);await screenshot('stale-review');
    await review.locator('input[type=checkbox]').check();await mode('ack-unreadable');await review.getByRole('button',{name:'Valider la réception',exact:true}).click();recovery=page.getByRole('dialog',{name:'Enregistrement effectué',exact:true});await recovery.waitFor();assert.equal((await state()).writes,3);
    await page.evaluate(()=>{window.receiptFixture.state.blockRead=false;window.receiptFixture.state.omitReceipt=true;});await recovery.getByRole('button',{name:'Actualiser les données',exact:true}).click();await recovery.getByText('Actualisation impossible',{exact:true}).waitFor();assert.equal((await state()).attempts.length,4);
    await page.evaluate(()=>window.receiptFixture.state.omitReceipt=false);await recovery.getByRole('button',{name:'Actualiser les données',exact:true}).click();await review.waitFor({state:'detached'});assert.equal((await state()).stored.catalog_items[0].stock_quantity_milli,9125);
    await page.getByRole('button',{name:'Annuler la réception',exact:true}).click();const reverse=page.getByRole('dialog',{name:'Annuler cette réception',exact:true});await reverse.getByRole('button',{name:'Confirmer l’annulation',exact:true}).click();await page.waitForFunction(()=>document.activeElement?.tagName==='TEXTAREA');assert.equal((await state()).attempts.length,4);
    await reverse.getByRole('textbox',{name:/Motif de la correction/}).fill('Retour');await page.evaluate(()=>window.receiptFixture.state.stored.catalog_items[0].stock_quantity_milli=1000);await reverse.getByRole('button',{name:'Actualiser les réceptions',exact:true}).click();await reverse.getByText(/Il ne reste pas assez/).waitFor();await reverse.getByRole('button',{name:'Confirmer l’annulation',exact:true}).click();assert.equal((await state()).attempts.length,4);assert.equal(await reverse.getByRole('textbox',{name:/Motif de la correction/}).inputValue(),'Retour');await screenshot('reverse-stock-help');
    await page.evaluate(()=>window.receiptFixture.state.stored.catalog_items[0].stock_quantity_milli=9125);await reverse.getByRole('button',{name:'Actualiser les réceptions',exact:true}).click();await mode('lost');await reverse.getByRole('button',{name:'Confirmer l’annulation',exact:true}).click();await reverse.waitFor({state:'detached'});
    assert.equal((await state()).stored.catalog_items[0].stock_quantity_milli,5000);assert.equal((await state()).stored.supplier_receipts[0].status,'reversed');assert.equal((await state()).stored.stock_movements.length,3);assert.equal((await state()).writes,4);
    await page.reload();await page.getByRole('button',{name:'Aller à un écran',exact:true}).waitFor();assert.equal((await state()).stored.supplier_receipts.length,1);assert.equal((await state()).stored.catalog_items[0].stock_quantity_milli,5000);assert.deepEqual(errors,[]);
    const openPurchases=async()=>{await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Achats');await page.locator('.navigation-palette__results button').filter({has:page.getByText('Achats & fournisseurs',{exact:true})}).click();};
    const section=async value=>{if(width<=860)await page.getByRole('combobox',{name:'Section des achats',exact:true}).selectOption(value);else await page.locator(`#purchase-tab-${value}`).click();};
    await openPurchases();await section('orders');await page.getByRole('button',{name:'Saisir la réception',exact:true}).click();
    await quantity().fill('1');await submit();await review.waitFor();const resumedId=(await state()).stored.supplier_receipts.find(row=>row.status==='draft').id;
    await review.locator('input[type=checkbox]').check();await mode('refuse');await review.getByRole('button',{name:'Valider la réception',exact:true}).click();
    await review.getByRole('button',{name:'Ouvrir les exercices',exact:true}).click();await page.getByRole('heading',{name:'Exercices comptables',exact:true}).waitFor();
    await openPurchases();await section('receipts');await page.getByRole('button',{name:'Vérifier et valider',exact:true}).click();await review.waitFor();
    assert.equal((await state()).stored.supplier_receipts.find(row=>row.id===resumedId).status,'draft');assert.equal((await state()).stored.catalog_items[0].stock_quantity_milli,5000);
    assert.match(await review.locator('.receipt-review-lines').innerText(),/1,000/);assert.deepEqual(errors,[]);
    report.push({width,height,exactQuantities:true,partialDelivery:true,noStockBeforeReview:true,currentVersion:true,stableIds:true,lostResponses:true,ackRecovery:true,reversal:true,readOnly:true,periodGuidanceAndResume:true,noOverflow:true});await page.close();
  }
}catch(error){report.push({error:error.stack});process.exitCode=1;const page=browser.contexts().flatMap(context=>context.pages()).at(-1);if(page){await page.screenshot({path:`${folder}/failure.png`,fullPage:true});await writeFile(`${folder}/failure.html`,await page.content());}}
finally{await writeFile(`${folder}/report.json`,JSON.stringify({engine,report},null,2));console.log(JSON.stringify({engine,report}));await browser.close();}
