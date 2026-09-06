import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium }=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const directory=fileURLToPath(new URL('../../.qa/supplier-credit-refund',import.meta.url));
await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
const report=[];
try {
  for(const width of [320,390,768,1440]) for(const readOnly of [false,true]) {
    const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<500});
    page.setDefaultTimeout(12000); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5187'}/tests/mobile-harness.html?purchasing=1&creditDates=1${readOnly?'&readOnly=1':''}`);
    const tour=page.getByRole('button',{name:'Ne plus afficher automatiquement',exact:true}); if(await tour.isVisible())await tour.click();
    await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
    await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Achats');
    await page.locator('.navigation-palette__results button').filter({has:page.getByText('Achats & fournisseurs',{exact:true})}).click();
    if(width<=860)await page.getByRole('combobox',{name:'Section des achats',exact:true}).selectOption('documents');else await page.locator('#purchase-tab-documents').click();
    const card=page.locator('.purchase-document-card--credit').filter({has:page.getByRole('heading',{name:'AV-AVAILABLE',exact:true})});
    const dialog=page.getByRole('dialog');
    const capture=async(stage)=>{
      const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,clipped:[...document.querySelectorAll('[role="dialog"] input,[role="dialog"] textarea')].filter(node=>{const r=node.getBoundingClientRect();return r.width&&(r.left< -1||r.right>innerWidth+1);}).map(node=>node.outerHTML.slice(0,100))}));
      assert.ok(geometry.scroll<=width+1,`page overflow ${stage} ${width}`);assert.deepEqual(geometry.clipped,[]);
      await page.screenshot({path:`${directory}/${width}-${readOnly?'readonly':'write'}-${stage}.png`});
    };
    const open=card.getByRole('button',{name:'Remboursement reçu',exact:true});
    if(readOnly){assert.equal(await open.isDisabled(),true);await capture('list');}
    else {
      await open.click();
      const amount=dialog.getByLabel('Montant reçu (CHF)',{exact:false});
      await amount.fill('100');assert.equal(await dialog.getByRole('button',{name:'Enregistrer le remboursement',exact:true}).isDisabled(),true);
      await amount.fill('10,00');await dialog.getByLabel('Référence bancaire',{exact:false}).fill('AV-VIREMENT-001');await dialog.getByLabel('Motif',{exact:false}).fill('Retour de marchandises remboursé');
      await capture('form');
      await page.evaluate(()=>sessionStorage.setItem('qa-refund-refresh-fail','1'));
      await dialog.getByRole('button',{name:'Enregistrer le remboursement',exact:true}).click();
      await dialog.waitFor({state:'detached'});
      assert.match(await card.innerText(),/disponible\s+44[.,]05/);
      assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-credit-date-refund')).length),1,'refresh retry must not issue a second write');
      await card.getByRole('button',{name:'Imputer sur une facture',exact:true}).click();
      assert.equal(await dialog.getByLabel('Montant imputé',{exact:false}).inputValue(),'44.05');
      await dialog.getByLabel('Montant imputé',{exact:false}).fill('4.05');
      await dialog.getByRole('button',{name:'Confirmer l’imputation',exact:true}).click();await dialog.waitFor({state:'detached'});
      assert.match(await card.innerText(),/disponible\s+40[.,]00/);
      await card.locator('summary').filter({hasText:'Remboursements et corrections'}).click();
      await capture('history');
      await card.getByRole('button',{name:'Corriger ce remboursement',exact:true}).click();
      assert.equal(await dialog.getByLabel('Montant reçu (CHF)',{exact:false}).getAttribute('readonly'),'');
      await dialog.getByLabel('Motif',{exact:false}).fill('Virement retourné au fournisseur');await capture('correction');
      await dialog.getByRole('button',{name:'Confirmer la correction',exact:true}).click();await dialog.waitFor({state:'detached'});
      assert.match(await card.innerText(),/disponible\s+50[.,]00/);
      assert.equal(await card.getByRole('button',{name:'Corriger ce remboursement',exact:true}).count(),0);
      await capture('corrected');
    }
    assert.deepEqual(errors,[]);report.push({width,readOnly,passed:true});await page.close();
  }
} finally {await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify(report));
