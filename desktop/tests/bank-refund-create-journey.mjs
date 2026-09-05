import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium }=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
const report=[]; const folder='.qa/bank-refund-create'; await mkdir(folder,{recursive:true});
try {
  for(const width of [320,390,768,1024,1440]) {
    const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<1024});
    page.setDefaultTimeout(10000); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?finance=1&bank=1&bankRefundCreate=1');
    const tour=page.getByRole('button',{name:'Ne plus afficher automatiquement',exact:true}); if(await tour.isVisible())await tour.click();
    await page.getByRole('button',{name:'Aller à un écran',exact:true}).click(); await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Banque'); await page.locator('.navigation-palette__results button').filter({has:page.getByText('Banque',{exact:true})}).click();
    const capture=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`page overflow ${width} ${name}`); const dialog=page.getByRole('dialog');if(await dialog.isVisible())assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1),`dialog overflow ${width} ${name}`);await page.screenshot({path:`${folder}/${width}-${name}.png`});};
    const flag=async(name,value)=>page.evaluate(({name,value})=>value?sessionStorage.setItem(name,'1'):sessionStorage.removeItem(name),{name:'qa-bank-create-refund-'+name,value});
    await page.locator('.bank-refund-picker summary').click();
    assert.equal(await page.getByRole('button',{name:'Confirmer l’encaissement',exact:true}).count(),0,'No customer invoice action when no invoice is available');
    await page.getByRole('button',{name:'Créer le remboursement reçu',exact:true}).click();
    let chooser=page.getByRole('dialog',{name:'Choisir l’achat remboursé',exact:true});
    const search=chooser.getByRole('searchbox',{name:'Rechercher l’achat remboursé'});
    await search.fill('ANCIEN-PAIEMENT');assert.ok(await chooser.locator('.bank-refund-create__choice').isDisabled());await capture('blocked-purchase');
    await search.fill('inconnu-absent');await chooser.getByRole('status').waitFor();
    await search.fill('RECU-0');await chooser.locator('.bank-refund-create__choice').click();
    let dialog=page.getByRole('dialog',{name:'Créer le remboursement reçu',exact:true});
    await dialog.getByRole('textbox',{name:/Référence de l’avoir/}).waitFor();
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Créer le remboursement reçu',exact:true}).click();await chooser.getByRole('searchbox').fill('RECU-0');await chooser.locator('.bank-refund-create__choice').click();
    await dialog.getByRole('button',{name:'Choisir un autre achat',exact:true}).click();await chooser.getByRole('searchbox').fill('RECU-0');await chooser.locator('.bank-refund-create__choice').click();
    await dialog.getByLabel(/Date de l’avoir/).fill('2026-08-21');
    await dialog.getByRole('textbox',{name:/Référence de l’avoir/}).fill('AV-RETOUR-MARCHANDISES-POUR-LE-PROJET-2026');
    const tax=dialog.getByRole('textbox',{name:/Dont TVA selon l’avoir/});await tax.fill('9,00');
    await dialog.getByRole('textbox',{name:/Motif du remboursement/}).fill('Retour de marchandises inutilisées sur le projet.');
    const submit=dialog.getByRole('button',{name:'Créer et rapprocher',exact:true});
    await submit.click();await dialog.getByRole('alert').filter({hasText:'solde HT ou TVA'}).waitFor();assert.equal(await page.evaluate(()=>sessionStorage.getItem('qa-bank-create-refund-attempts')),null);
    await tax.fill('4,05');
    const file=dialog.locator('input[type="file"]');await file.setInputFiles({name:'avoir-remboursement-fournisseur-pour-le-projet.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nfixture')});
    await file.setInputFiles({name:'piece-invalide.exe',mimeType:'application/octet-stream',buffer:Buffer.from('invalid')});await dialog.getByRole('alert').waitFor();assert.equal(await dialog.getByText('avoir-remboursement-fournisseur-pour-le-projet.pdf',{exact:true}).count(),0);
    await file.setInputFiles({name:'avoir-remboursement-fournisseur-pour-le-projet.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nfixture')});
    await submit.scrollIntoViewIfNeeded();assert.ok(await submit.evaluate(node=>node.getBoundingClientRect().height>=44));await capture('ready');
    await flag('deny',true);await submit.click();await dialog.getByRole('alert').filter({hasText:'compte bancaire a changé'}).waitFor();assert.equal(await tax.inputValue(),'4,05');await capture('refusal');
    await flag('deny',false);await flag('lost',true);await submit.click();await dialog.getByRole('alert').filter({hasText:'Réponse interrompue'}).waitFor();await capture('lost-response');
    await flag('lost',false);await flag('fail-after-save',true);await submit.click();await dialog.waitFor({state:'hidden'});await page.getByRole('button',{name:'Actualiser les données',exact:true}).waitFor();await capture('refresh-recovery');
    const attempts=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-bank-create-refund-attempts')));assert.equal(attempts.length,3);assert.equal(new Set(attempts.map(x=>x.requestId)).size,1);assert.equal(attempts[0].netCents,5000);assert.equal(attempts[0].paymentDate,'2026-08-31');assert.equal(await page.evaluate(()=>sessionStorage.getItem('qa-bank-create-refund-commits')),'1');
    await flag('read',false);await flag('fail-after-save',false);await page.getByRole('button',{name:'Actualiser les données',exact:true}).click();await page.getByRole('tab',{name:/^Rapprochés/}).click();
    await page.getByText(/Remboursement rapproché · AV-RETOUR/).waitFor();await capture('matched');
    await page.getByRole('button',{name:'Voir la dépense d’origine',exact:true}).click();const detail=page.getByRole('dialog');await detail.getByText('RECU-0',{exact:true}).waitFor();await detail.getByRole('button',{name:/Ouvrir avoir-remboursement/}).click();assert.equal(await page.evaluate(()=>sessionStorage.getItem('qa-bank-create-refund-opened')),'bank-refund-receipt');await capture('source-receipt');
    assert.deepEqual(errors,[]);report.push({width,result:'PASS',atomicCommand:true,bankAmountAndDate:true,blockedPurchases:true,invalidReceiptCleared:true,refusalAndLostResponseRetained:true,oneCommit:true,readRecovery:true,sourceReceipt:true,overflow:false});await page.close();
  }
  const readOnly=await browser.newPage({viewport:{width:390,height:844}});
  await readOnly.goto('http://127.0.0.1:5175/tests/mobile-harness.html?finance=1&bank=1&bankRefundCreate=1&readOnly=1');
  const tour=readOnly.getByRole('button',{name:'Ne plus afficher automatiquement',exact:true});if(await tour.isVisible())await tour.click();
  await readOnly.getByRole('button',{name:'Aller à un écran',exact:true}).click();await readOnly.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Banque');await readOnly.locator('.navigation-palette__results button').filter({has:readOnly.getByText('Banque',{exact:true})}).click();
  await readOnly.locator('.bank-refund-picker summary').click();assert.ok(await readOnly.getByRole('button',{name:'Créer le remboursement reçu',exact:true}).isDisabled());assert.ok(await readOnly.getByRole('button',{name:'Importer un relevé XML',exact:true}).isDisabled());
  await readOnly.screenshot({path:folder+'/390-readonly.png'});report.push({width:390,readOnly:true,result:'PASS',creationDisabled:true,importDisabled:true});await readOnly.close();
} catch(error) {process.exitCode=1;report.push({fatal:error.stack});const page=browser.contexts().flatMap(context=>context.pages()).at(-1);if(page){await page.screenshot({path:folder+'/failure.png'});await writeFile(folder+'/failure.html',await page.content());}}
finally{await writeFile(folder+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
