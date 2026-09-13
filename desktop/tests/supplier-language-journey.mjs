import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const engine=process.env.ZENTRA_QA_ENGINE||'chromium', base=process.env.ZENTRA_QA_URL||'http://127.0.0.1:5271';
const driver=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright')[engine];
const browser=await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const out=`.qa/supplier-language-${engine}`,report=[];await mkdir(out,{recursive:true});
const tr=(page,source,values)=>page.evaluate(async({source,values})=>{const url=performance.getEntriesByType('resource').map(r=>r.name).findLast(url=>new URL(url).pathname==='/src/language.ts');return(await import(url)).t(source,values);},{source,values});
const change=async(page,language)=>{await page.evaluate(language=>{const key='zentra.interface.language.v1';localStorage.setItem(key,language);window.dispatchEvent(new StorageEvent('storage',{key,newValue:language}));},language);await page.waitForFunction(language=>document.documentElement.lang===`${language}-CH`,language);};
async function geometry(page,label){const problems=await page.locator('.supplier-preparation').evaluate(root=>{
  const result=[];if(document.documentElement.scrollWidth>innerWidth+1)result.push('document');
  for(const node of [root,...root.querySelectorAll('.modal__body,button,summary,.field__label,.field__hint,.field__error,h2,h3,p,strong,small,dd')]){
    const hidden=node.closest('details:not([open])');if(hidden&&!hidden.querySelector('summary')?.contains(node))continue;
    if(node.getClientRects().length&&node.clientWidth&&node.scrollWidth>node.clientWidth+2)result.push(`${node.tagName}.${node.className}: ${node.textContent.slice(0,90)}`);
  }const amount=root.querySelector('.supplier-preparation__overview > div:last-child strong');if(amount&&/^\D*\d/.test(amount.textContent)&&amount.getBoundingClientRect().height>parseFloat(getComputedStyle(amount).lineHeight)+2)result.push('amount wraps onto multiple lines');return result;});assert.deepEqual(problems,[],label);}
try{for(const[width,height]of [[320,568],[390,844],[844,390],[1440,1000]])for(const language of (process.env.ZENTRA_QA_LANGUAGES||'fr,de,it,en').split(',')){
  const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}),errors=[],confirmations=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{confirmations.push(d.message());await d.accept();});
  const modal=page.locator('.supplier-preparation'), button=async name=>modal.getByRole('button',{name:await tr(page,name),exact:true});
  const attempts=operation=>page.evaluate(operation=>JSON.parse(sessionStorage.getItem(`qa-purchase-${operation}-attempts`)||'[]'),operation);
  const mode=(operation,value)=>page.evaluate(([operation,value])=>sessionStorage.setItem(`qa-purchase-${operation}-failure`,value),[operation,value]);
  try{
    await page.goto(`${base}/tests/mobile-harness.html?purchasing=1&supplierPreparation=1`);
    await page.getByRole('button',{name:'Fermer le guide automatique',exact:true}).click();
    await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Achats');
    await page.locator('.navigation-palette__results button').filter({has:page.getByText('Achats & fournisseurs',{exact:true})}).click();
    await change(page,language);await page.getByRole('button',{name:await tr(page,'Facture fournisseur'),exact:true}).click();
    await modal.getByRole('heading',{name:await tr(page,'Quelle facture avez-vous reçue ?'),exact:true}).waitFor();
    await modal.locator('[name=supplierId]').selectOption('supplier-second-qa');
    const reference='Référence {number} '+ 'Longue'.repeat(18), note='TVA {message}\nDeuxième ligne personnelle.', description='Description {name}';
    await modal.locator('[name=reference]').fill(reference);await modal.locator('[name=date]').fill('2026-09-05');await modal.locator('[name=dueDate]').fill('2026-10-15');await modal.locator('[name=note]').fill(note);
    await geometry(page,'invoice details');await(await button('Continuer vers les achats')).click();
    await(await button('Vérifier la facture')).click();
    const issueSource='décrivez ce que vous avez acheté, en 1 000 caractères maximum.';
    await modal.getByText(await tr(page,'Ligne {number} : {message}',{number:1,message:await tr(page,issueSource)}),{exact:true}).waitFor();
    const alternate=language==='de'?'it':'de';await change(page,alternate);
    await modal.getByText(await tr(page,'Ligne {number} : {message}',{number:1,message:await tr(page,issueSource)}),{exact:true}).waitFor();await change(page,language);
    await modal.locator('[name$="-description"]').fill(description);await modal.locator('[name$="-quantity"]').fill('2,5');await modal.locator('[name$="-price"]').fill('100,10');
    const defaultUnit=await modal.locator('[name$="-unit"]').inputValue();assert.equal(defaultUnit,await tr(page,'unité'));
    await modal.locator('[name$="-unit"]').fill('Unité {name}');await modal.locator('.supplier-preparation__options > summary').click();
    await modal.locator('[name$="-discount"]').fill('101');await modal.locator('.supplier-preparation__options > summary').click();await(await button('Vérifier la facture')).click();
    await page.waitForFunction(()=>document.activeElement?.getAttribute('name')?.endsWith('-discount'));assert.notEqual(await modal.locator('.supplier-preparation__options').getAttribute('open'),null);
    await change(page,alternate);assert.equal(await modal.locator('[name$="-discount"]').inputValue(),'101');await geometry(page,'translated discount error');await change(page,language);
    await modal.locator('[name$="-discount"]').fill('10');await modal.locator('[name=vatTreatment]').selectOption('input_materials');
    assert.equal((await attempts('invoice-draft')).length,0);await(await button('Vérifier la facture')).click();
    await modal.locator('.supplier-preparation__review').waitFor();assert.ok((await modal.locator('.supplier-preparation__overview').innerText()).includes(reference));assert.ok((await modal.locator('.supplier-preparation__review').innerText()).includes(description));assert.ok((await modal.locator('.supplier-preparation__note').innerText()).includes(note));await geometry(page,'review');
    await modal.locator('.supplier-preparation__overview').scrollIntoViewIfNeeded();
    if(width<600)assert.ok(await modal.locator('.supplier-preparation__overview > div:last-child strong').evaluate(node=>node.getBoundingClientRect().bottom<=document.querySelector('.supplier-preparation__actions').getBoundingClientRect().top));
    await page.screenshot({path:`${out}/${language}-${width}-review.png`});
    await mode('invoice-draft','reject');await(await button('Enregistrer le brouillon')).click();await modal.locator('.error-panel').waitFor();
    const errorSource='La date de cette facture appartient à une période comptable fermée. Vérifiez la date ou consultez Comptabilité → Exercices avant de réessayer.';
    if(language!=='fr')assert.ok((await modal.locator('.error-panel').innerText()).includes(await tr(page,errorSource)));
    await change(page,alternate);assert.ok((await modal.locator('.error-panel').innerText()).includes(await tr(page,errorSource)));await geometry(page,'native refusal');await change(page,language);
    await(await button('Enregistrer le brouillon')).click();await(await button('Terminer')).waitFor();
    const saved=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-purchase-saved-invoice')));assert.equal(saved.reference,reference);assert.equal(saved.note,note);assert.equal(saved.documentDate,'2026-09-05');assert.equal(saved.dueDate,'2026-10-15');assert.equal(saved.totalCents,24346);assert.equal(saved.lines[0].unit,'Unité {name}');assert.equal(saved.lines[0].description,description);assert.equal((await attempts('invoice-draft')).length,2);
    await(await button('Ajouter un justificatif')).click();await modal.getByText('facture-originale.pdf',{exact:true}).waitFor();
    await page.evaluate(async()=>{const data=await window.__qaReloadPurchases();const invoice=data.supplierInvoices.find(row=>row.reference.startsWith('Référence'));invoice.attachments[0].originalName='Facture {name}.pdf';sessionStorage.setItem('qa-purchase-workspace-patch',JSON.stringify({supplierInvoices:data.supplierInvoices}));await window.__qaReloadPurchases();const url=performance.getEntriesByType('resource').map(r=>r.name).findLast(url=>new URL(url).pathname==='/src/bridge.ts');(await import(url)).desktopApi.openAttachment=async()=>{throw new Error('Unknown file error {name}');};});
    await(await button('Ouvrir')).click();await modal.locator('.supplier-attachments .error-panel').waitFor();
    if(language!=='fr')assert.ok((await modal.locator('.supplier-attachments .error-panel').innerText()).includes(await tr(page,'Le justificatif local n’a pas pu être ouvert.')));
    await change(page,alternate);assert.ok((await modal.locator('.supplier-attachments .error-panel').innerText()).includes(await tr(page,'Le justificatif local n’a pas pu être ouvert.')));await change(page,language);await geometry(page,'receipt error');
    await page.screenshot({path:`${out}/${language}-${width}-receipt.png`});
    if(language==='en'&&width===320){
      await page.evaluate(async()=>{const url=performance.getEntriesByType('resource').map(r=>r.name).findLast(url=>new URL(url).pathname==='/src/bridge.ts');const api=(await import(url)).desktopApi;api.openAttachment=()=>new Promise((_,reject)=>{window.__qaRejectReceiptOpen=()=>reject(new Error('Delayed open failure'));});api.chooseSupplierInvoiceAttachment=async()=>{throw new Error('New file failure');};});
      await(await button('Ouvrir')).click();await(await button('Ajouter un justificatif')).click();
      await modal.getByText(await tr(page,'Le justificatif n’a pas pu être ajouté.'),{exact:true}).waitFor();
      await page.evaluate(()=>window.__qaRejectReceiptOpen());
      await modal.getByText(await tr(page,'Le justificatif local n’a pas pu être ouvert.'),{exact:true}).waitFor();
    }
    await modal.getByRole('button',{name:await tr(page,'Supprimer {name}',{name:'Facture {name}.pdf'}),exact:true}).click();
    assert.equal(confirmations.at(-1),await tr(page,'Supprimer le justificatif « {name} » ?',{name:'Facture {name}.pdf'}));
    await modal.getByText(await tr(page,'Aucun justificatif joint.'),{exact:false}).waitFor();assert.equal((await attempts('delete-attachment')).length,1);
    await(await button('Terminer')).click();await modal.waitFor({state:'hidden'});assert.deepEqual(errors,[]);
    report.push({engine,language,width,height,result:'PASS translated steps/errors, live language switch, verbatim user text, stable dates/amounts, native refusal, receipt open/delete and no overflow'});
  }catch(error){await page.screenshot({path:`${out}/${language}-${width}-failure.png`});await writeFile(`${out}/${language}-${width}-failure.html`,await page.content());throw error;}finally{await page.close();}
}}catch(error){report.push({fatal:error.stack});process.exitCode=1;}finally{await browser.close();}
await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
