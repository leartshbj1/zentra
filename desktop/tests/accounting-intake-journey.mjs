import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const output='.impeccable/review/accounting-intake';await mkdir(output,{recursive:true});const results=[];
for(const [engine,type] of [['edge',chromium],['webkit',webkit]]){
 const browser=await type.launch({headless:true,...(engine==='edge'?{channel:'msedge'}:{})});
 try{for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const theme=width===390?'dark':'light';await page.goto(`http://127.0.0.1:5331/tests/accounting-intake-preview.html?theme=${theme}`);
  await page.getByRole('button',{name:'Ajouter un bien',exact:true}).click();
  await page.getByLabel('Nom du bien',{exact:false}).fill('Ordinateur portable de l’atelier');
  await page.getByLabel('Référence d’achat',{exact:false}).fill('FOURNISSEUR-2026-01234');
  await page.getByLabel('Coût à immobiliser',{exact:false}).fill('2500');
  assert.equal(await page.getByRole('button',{name:'Enregistrer le bien'}).isDisabled(),true);
  await page.getByRole('checkbox').check();
  await page.screenshot({path:`${output}/asset-form-${engine}-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'Enregistrer le bien'}).click();
  assert.equal(await page.evaluate(()=>window.__accountingIntakeQa.registered),1);
  await page.getByRole('button',{name:'Amortissement 2026'}).click();
  assert.equal(await page.evaluate(()=>window.__accountingIntakeQa.depreciated),0);
  await page.getByRole('button',{name:'Confirmer l’écriture'}).click();
  assert.equal(await page.evaluate(()=>window.__accountingIntakeQa.depreciated),1);
  await page.screenshot({path:`${output}/asset-register-${engine}-${width}.png`,fullPage:true});
  await page.locator('.invoice-scan input[type=file]').setInputFiles(path.resolve('desktop/tests/fixtures/automation-test-invoice.pdf'));
  await page.getByRole('button',{name:'Utiliser ces informations'}).waitFor();
  assert.equal(await page.evaluate(()=>window.__accountingIntakeQa.scanApplied),0);
  await page.getByText('Voir le document original',{exact:true}).click();
  const original=page.locator('.invoice-scan__original canvas');await original.waitFor();
  await page.getByRole('button',{name:'Agrandir',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Ajuster à la largeur'}).innerText(),'150 %');
  const photo=await original.evaluate(canvas=>canvas.toDataURL('image/png').split(',')[1]);
  await page.getByText('Voir le document original',{exact:true}).click();
  await page.screenshot({path:`${output}/scan-review-${engine}-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'Utiliser ces informations'}).click();
  assert.equal(await page.evaluate(()=>window.__accountingIntakeQa.scanApplied),1);
  if(engine==='edge'&&width===1440){
    await page.locator('.invoice-scan input[type=file]').setInputFiles({name:'facture-test.png',mimeType:'image/png',buffer:Buffer.from(photo,'base64')});
    await page.getByRole('button',{name:'Utiliser ces informations'}).waitFor({timeout:60000});
    assert.equal(await page.evaluate(()=>window.__accountingIntakeQa.scans),2);
  }
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);assert.deepEqual(errors,[]);
  results.push({engine,width,theme,registerOnce:true,explicitDepreciation:true,pdfTextRead:true,originalRendered:true,zoomWorks:true,photoOcr:engine==='edge'&&width===1440,scanReviewed:true,overflow,errors});await page.close();
 }}finally{await browser.close();}
}
await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
