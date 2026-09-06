import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const {chromium,webkit}=await import(pathToFileURL(process.env.ZENTRA_PLAYWRIGHT_MODULE+'/index.mjs').href);
const engine=process.env.ZENTRA_QA_BROWSER||'edge';
const out=new URL(`../../.qa/customer-credit-settlement-${engine}/`,import.meta.url);
await mkdir(out,{recursive:true});
const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='edge'?{channel:'msedge'}:{})});
const report=[];
try {
  for(const width of [320,390,768,1440]) {
    const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<800});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&customerSettlements=1&lostReply=1`,{waitUntil:'domcontentloaded',timeout:60000});
    if(width>860) await page.getByRole('button',{name:'Ne plus afficher automatiquement',exact:true}).click();
    await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
    await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Factures');
    await page.locator('.navigation-palette__results button').filter({has:page.getByText('Factures',{exact:true})}).click();
    await page.locator('.sales-documents tbody tr').filter({hasText:'Avoir et remboursements'}).getByRole('button',{name:'Consulter',exact:true}).click();
    const panel=page.getByRole('region',{name:'Avoirs et règlements liés'});
    await panel.getByRole('button',{name:'Enregistrer un remboursement',exact:true}).click();
    const form=panel.locator('form');
    await form.getByLabel('Montant (CHF)').fill('27.03');
    await form.getByLabel('Date effective').fill('2026-04-01');
    await form.getByLabel('Référence bancaire').fill('BANK-CUSTOMER-REFUND');
    await form.getByLabel(/^Motif/).fill('Remboursement partiel versé au client');
    await form.getByRole('button',{name:'Enregistrer le règlement',exact:true}).click();
    await form.getByRole('button',{name:'Vérifier la même demande',exact:true}).waitFor();
    assert.equal(await form.getByLabel('Montant (CHF)').isDisabled(),true);
    // Closing and reopening the dossier must resume the same pending command.
    await page.keyboard.press('Escape');
    await page.locator('.sales-documents tbody tr').filter({hasText:'Avoir et remboursements'}).getByRole('button',{name:'Consulter',exact:true}).click();
    await form.getByRole('button',{name:'Vérifier la même demande',exact:true}).waitFor();
    await form.getByRole('button',{name:'Vérifier la même demande',exact:true}).click();
    await form.waitFor({state:'detached'});
    const requests=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('customer-settlement-requests')));
    assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('customer-settlement-count')),'1');
    assert.equal(await page.evaluate(()=>localStorage.getItem('zentra.customer-credit-request.v1.customer-settlement-credit')),null);
    await panel.locator('summary').click();
    await panel.getByRole('button',{name:'Corriger',exact:true}).click();
    await panel.getByLabel('Date de correction').fill('2026-04-02');
    await panel.getByLabel(/^Motif/).fill('Virement retourné par la banque');
    await panel.getByRole('button',{name:'Enregistrer la correction',exact:true}).click();
    await panel.locator('form').waitFor({state:'detached'});
    assert.equal(await panel.getByText('Remboursement annulé',{exact:true}).count(),1);
    await panel.getByRole('button',{name:'Déduire d’une facture',exact:true}).click();
    await panel.getByLabel('Facture à régler').selectOption('customer-target');
    await panel.getByLabel('Montant (CHF)').fill('27.03');
    await panel.getByLabel('Date effective').fill('2026-04-03');
    await panel.getByLabel('Référence de la déduction').fill('COMPENSATION-CLIENT');
    await panel.getByLabel(/^Motif/).fill('Déduction sur la prochaine prestation');
    await page.screenshot({path:new URL(`form-${width}.png`,out).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await panel.getByRole('button',{name:'Enregistrer le règlement',exact:true}).click();
    await panel.locator('form').waitFor({state:'detached'});
    assert.equal(await panel.getByText('Déduit d’une facture',{exact:true}).count(),1);
    await page.waitForFunction(()=>document.activeElement?.classList.contains('customer-credit-card__heading'));
    await page.waitForFunction(()=>{
      const rect=document.activeElement.getBoundingClientRect();
      return rect.top>=document.querySelector('.modal__header').getBoundingClientRect().bottom && rect.bottom<=innerHeight;
    });
    await page.screenshot({path:new URL(`history-${width}.png`,out).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
    assert.deepEqual(errors,[]);report.push({width,refund:true,sameRequestRetry:true,reversal:true,application:true,noOverflow:true,pageErrors:errors});await page.close();
  }
  for(const width of [320,1440]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&customerSettlements=1&readOnly=1`,{waitUntil:'domcontentloaded',timeout:60000});
    if(width>860)await page.getByRole('button',{name:'Ne plus afficher automatiquement',exact:true}).click();
    await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Factures');
    await page.locator('.navigation-palette__results button').filter({has:page.getByText('Factures',{exact:true})}).click();
    await page.locator('.sales-documents tbody tr').filter({hasText:'Avoir et remboursements'}).getByRole('button',{name:'Consulter',exact:true}).click();
    const panel=page.getByRole('region',{name:'Avoirs et règlements liés'});
    assert.equal(await panel.getByRole('button',{name:'Enregistrer un remboursement',exact:true}).isDisabled(),true);
    assert.equal(await panel.getByRole('button',{name:'Déduire d’une facture',exact:true}).isDisabled(),true);
    report.push({width,readOnly:true});await page.close();
  }
} finally {await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));await browser.close();}
