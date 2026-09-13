import { createRequire } from 'node:module';
import { mkdir,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine=process.env.ZENTRA_QA_ENGINE||'chromium';
const driver=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright')[engine];
const browser=await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271',folder=`.qa/stock-guided-${engine}`;
await mkdir(folder,{recursive:true});const report=[];let activePage;
const state=page=>page.evaluate(()=>({attempts:window.stockFixture.state.attempts,writes:window.stockFixture.state.writes,stock:window.stockFixture.state.stored.catalog_items[0].stock_quantity_milli,rows:window.stockFixture.state.stored.stock_movements}));
const set=async(page,value)=>page.evaluate(value=>Object.assign(window.stockFixture.state,value),value);
async function navigate(page){await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Produits');await page.locator('.navigation-palette__results button').filter({has:page.getByText('Produits & services',{exact:true})}).click();await page.locator('.catalog-screen').waitFor();}
async function screenshot(page,name){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1||[...document.querySelectorAll('.modal,.modal__body')].some(el=>el.scrollWidth>el.clientWidth+1)),false,'no horizontal overflow');await page.screenshot({path:`${folder}/${name}.png`});}
try{
  for(const [width,height] of [[320,568],[390,844],[844,390],[1440,1000]]){
    const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});activePage=page;page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&stockGuided=1`);
    await page.getByRole('button',{name:'Découvrir plus tard',exact:true}).click();await navigate(page);
    const open=async kind=>{await page.locator('.catalog-item').getByRole('button',{name:kind,exact:true}).click();return page.getByRole('dialog').filter({has:page.locator('form.stock-workflow')});};
    const review=async form=>form.getByRole('button',{name:'Vérifier le mouvement',exact:true}).click();
    const fill=async(form,qty,reason)=>{await form.locator('[name=quantity]').fill(qty);await form.locator('[name=reason]').fill(reason);};
    let form=await open('Inventaire');
    await review(form);await page.waitForFunction(()=>document.activeElement?.getAttribute('name')==='quantity');assert.equal((await state(page)).attempts,0);
    await fill(form,'1','Inventaire du dépôt');await review(form);await form.getByText(/Stock insuffisant/).waitFor();assert.equal((await state(page)).attempts,0);await screenshot(page,`${width}-quantity-help`);
    await fill(form,'8,125','Inventaire du dépôt\nComptage vérifié');await form.locator('[name=date]').fill('');await review(form);await page.waitForFunction(()=>document.activeElement?.getAttribute('name')==='date');
    await form.locator('[name=date]').fill('2026-09-13');await review(form);
    assert.equal((await state(page)).attempts,0,'review does not write');await form.getByRole('region',{name:'Vérification du mouvement'}).waitFor();await screenshot(page,`${width}-review`);
    await page.evaluate(()=>window.stockFixture.adjust(1000));
    await form.getByRole('button',{name:'Enregistrer la correction',exact:true}).click();
    await form.getByText('Les quantités ont changé',{exact:true}).waitFor();assert.equal(await form.locator('[name=quantity]').inputValue(),'8,125');assert.equal((await state(page)).writes,0);await screenshot(page,`${width}-stale-count`);
    await form.getByRole('button',{name:'Utiliser le stock actuel',exact:true}).click();assert.equal((await state(page)).writes,0);
    await review(form);await form.getByRole('button',{name:'Enregistrer la correction',exact:true}).click();await form.waitFor({state:'hidden'});
    assert.equal((await state(page)).stock,8125);assert.equal((await state(page)).writes,1);
    // A lost acknowledgement is found through the production receipt matcher.
    form=await open('Entrée');await fill(form,'2','Livraison reçue');await set(page,{mode:'lost'});await review(form);await form.getByRole('button',{name:'Enregistrer l’entrée',exact:true}).click();await form.waitFor({state:'hidden'});assert.equal((await state(page)).stock,10125);assert.equal((await state(page)).writes,2);
    // A real refusal returns to the actual field with all other values intact.
    form=await open('Sortie');await fill(form,'1','Motif à conserver');await set(page,{mode:'refuse'});await review(form);await form.getByRole('button',{name:'Enregistrer la sortie',exact:true}).click();await page.waitForFunction(()=>document.activeElement?.getAttribute('name')==='reason');assert.equal(await form.locator('[name=quantity]').inputValue(),'1');assert.equal((await state(page)).writes,2);
    await form.locator('[name=reason]').fill('Matériel utilisé');await review(form);await form.getByRole('button',{name:'Enregistrer la sortie',exact:true}).click();await form.waitFor({state:'hidden'});assert.equal((await state(page)).stock,9125);
    // Confirmation without a readable receipt holds all writes; retries only read.
    form=await open('Entrée');await fill(form,'1','Livraison en attente de lecture');await set(page,{mode:'ack-unreadable',hold:true});await review(form);
    const attempts=(await state(page)).attempts;await form.getByRole('button',{name:'Enregistrer l’entrée',exact:true}).click();await page.waitForFunction(n=>window.stockFixture.state.attempts===n,attempts+1);
    await form.locator('form').dispatchEvent('submit');await page.keyboard.press('Escape');assert.equal(await form.locator('[name=quantity]').isDisabled(),true);assert.equal((await state(page)).attempts,attempts+1);
    await page.evaluate(()=>{window.stockFixture.state.hold=false;window.stockFixture.state.release();});
    const saved=page.getByRole('dialog',{name:'Enregistrement effectué',exact:true});await saved.waitFor();await screenshot(page,`${width}-recorded-recovery`);
    await set(page,{blockRead:false,omitReceipt:true});await saved.getByRole('button',{name:'Actualiser les données',exact:true}).click();await saved.getByText('Actualisation impossible',{exact:true}).waitFor();assert.equal((await state(page)).writes,4);
    await set(page,{empty:true});await saved.getByRole('button',{name:'Actualiser les données',exact:true}).click();await saved.getByText('Actualisation impossible',{exact:true}).waitFor();
    await page.evaluate(()=>window.__qaSetReadOnly(true));await set(page,{empty:false,omitReceipt:false});await saved.getByRole('button',{name:'Actualiser les données',exact:true}).click();await saved.waitFor({state:'hidden'});await form.waitFor({state:'hidden'});assert.equal((await state(page)).attempts,attempts+1);
    assert.equal(await page.locator('.catalog-item').getByRole('button',{name:'Entrée',exact:true}).isDisabled(),true);await page.evaluate(()=>window.__qaSetReadOnly(false));
    // Unknown result, unreadable then recovered once.
    form=await open('Sortie');await fill(form,'1','Sortie vérifiée');await set(page,{mode:'lost-unreadable'});await review(form);await form.getByRole('button',{name:'Enregistrer la sortie',exact:true}).click();
    const unknown=page.getByRole('dialog',{name:'Vérifier l’enregistrement',exact:true});await unknown.waitFor();await unknown.getByRole('button',{name:'Vérifier maintenant',exact:true}).click();await unknown.getByText('Vérification encore indisponible',{exact:true}).waitFor();
    const writes=(await state(page)).writes;await set(page,{blockRead:false});await unknown.getByRole('button',{name:'Vérifier maintenant',exact:true}).click();await form.waitFor({state:'hidden'});assert.equal((await state(page)).writes,writes);
    // Modes retain separate inputs; refreshing an archived item offers a way out.
    form=await open('Inventaire');await fill(form,'8','Autre inventaire');await form.getByRole('button',{name:'Écart (+ ou −)',exact:true}).click();assert.equal(await form.locator('[name=quantity]').inputValue(),'');await form.locator('[name=quantity]').fill('-1');await form.getByRole('button',{name:'Quantité comptée',exact:true}).click();assert.equal(await form.locator('[name=quantity]').inputValue(),'8');
    await page.evaluate(()=>{window.stockFixture.state.stored.catalog_items[0].archived_at='2026-09-13';});await form.getByRole('button',{name:'Actualiser les quantités',exact:true}).click();await form.getByRole('button',{name:'Revenir au catalogue',exact:true}).click();await form.waitFor({state:'hidden'});
    await page.evaluate(async()=>{window.stockFixture.state.stored.catalog_items[0].archived_at=null;window.stockFixture.persist();await window.__qaStockRefresh();});
    const beforeReload=await state(page);await page.reload();await navigate(page);
    assert.equal((await state(page)).stock,beforeReload.stock);assert.equal((await state(page)).rows.length,beforeReload.rows.length);
    await page.getByRole('button',{name:`Historique (${beforeReload.rows.length})`,exact:true}).click();await page.getByRole('region',{name:'Historique de stock de Peinture de recette'}).waitFor();await screenshot(page,`${width}-history`);
    assert.deepEqual(errors,[]);report.push({engine,width,height,passed:true,writes:beforeReload.writes,receiptAndRecovery:true});await page.close();
  }
}catch(error){if(activePage&&!activePage.isClosed()){await activePage.screenshot({path:`${folder}/failure.png`});await writeFile(`${folder}/failure.html`,await activePage.content());}report.push({error:String(error.stack||error)});process.exitCode=1;}
finally{await writeFile(`${folder}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();}
