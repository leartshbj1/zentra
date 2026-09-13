import { createRequire } from 'node:module';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine=process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser=await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const origin=process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271';
const folder=`.qa/document-save-${engine}`; await mkdir(folder,{recursive:true});
const report=[];
async function setup(width,height) {
 const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}); page.setDefaultTimeout(20000);
 const errors=[]; page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/native-design-fixture/*.pdf',async route=>{
  const name=new URL(route.request().url()).pathname.split('/').at(-1);
  assert.match(name,/^(quotes|invoices|accounts|payslips)-(signature|minimal|helvetica|times|courier)\.pdf$/);
  await route.fulfill({contentType:'application/pdf',body:await readFile(`.qa/composition-pdfs/${name}`)});
 });
 return {page,errors};
}
const ready=page=>page.locator('.design-studio__preview[aria-busy=false] img').first().waitFor();
const save=page=>page.getByRole('group',{name:'Historique de la présentation'}).getByRole('button',{name:'Enregistrer',exact:true});
const count=(page,key)=>page.evaluate(key=>Number(sessionStorage.getItem(key)||0),key);
const draft=page=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('design-draft')||'{}'));
try {
 for(const [width,height] of [[320,568],[390,844],[844,390],[1440,1000]]) {
  const {page,errors}=await setup(width,height);
  await page.goto(`${origin}/tests/document-design-harness.html?tools=1&validation=1`); await ready(page);
  await page.evaluate(async()=>{
   const {normalizeComposition}=await import('/src/documentComposition.ts');
   window.dispatchEvent(new CustomEvent('design-fixture-update',{detail:{settings:{documentComposition:{
    quotes:normalizeComposition({closing:[{runs:[{text:'Conditions ',bold:true}]},{runs:[{text:'📎 document'}]}]}),
    accounts:normalizeComposition({footerText:Array.from({length:6},(_,i)=>({runs:[{text:`Ligne ${i}`}]}))})
   }}}}));
  });
  await save(page).click();
  const problems=page.locator('.design-studio__problems'); await problems.waitFor();
  await problems.getByText('Devis · Conditions et message de fin',{exact:true}).waitFor();
  assert.equal(await count(page,'design-save-count'),0);
  await problems.getByRole('button',{name:'Corriger ce passage',exact:true}).click();
  await page.waitForFunction(()=>getSelection()?.toString()==='📎');
  await page.screenshot({path:`${folder}/${width}-selected-problem.png`});
  await page.keyboard.insertText('Pièce jointe');
  assert.equal((await draft(page)).documentComposition.quotes.closing.flatMap(p=>p.runs.map(r=>r.text)).join(''),'Conditions Pièce jointe document');
  await page.evaluate(()=>sessionStorage.setItem('design-invalid-kind','accounts'));
  await ready(page); await save(page).click();
  await problems.getByText('Bilan · Pied de page',{exact:true}).waitFor();
  assert.equal(await count(page,'design-save-count'),0);
  await problems.getByRole('button',{name:'Corriger ce passage',exact:true}).click();
  const footer=page.getByRole('textbox',{name:'Pied de page mis en forme',exact:true});
  await footer.waitFor(); await footer.fill('Contact : Atelier du Léman');
  await page.evaluate(()=>sessionStorage.removeItem('design-invalid-kind'));
  if (await page.getByRole('button',{name:'Réessayer l’aperçu',exact:true}).isVisible()) await page.getByRole('button',{name:'Réessayer l’aperçu',exact:true}).click();
  await ready(page);
  await page.evaluate(()=>sessionStorage.setItem('design-save-fail','1'));
  await save(page).click(); await problems.getByText('Enregistrement momentanément indisponible.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('design-settings')),null);
  assert.equal(await footer.innerText(),'Contact : Atelier du Léman');
  await page.evaluate(()=>{sessionStorage.removeItem('design-save-fail');sessionStorage.setItem('design-check-hold','1');sessionStorage.setItem('design-checks','[]');});
  await save(page).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('design-checks')).length>=4);
  await page.evaluate(()=>{
   const settings=JSON.parse(sessionStorage.getItem('design-draft'));
   window.dispatchEvent(new CustomEvent('design-fixture-update',{detail:{settings:{organization:{...settings.organization,legalName:'Nom actualisé ailleurs'}}}}));
  });
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('design-draft')).organization.legalName==='Nom actualisé ailleurs');
  await page.evaluate(()=>{sessionStorage.removeItem('design-check-hold');window.dispatchEvent(new Event('design-check-release'));});
  await page.getByText(/Les réglages ont changé pendant la vérification/).waitFor();
  assert.equal(await count(page,'design-save-count'),1,'no write with stale settings');
  await ready(page);
  await page.evaluate(()=>{sessionStorage.setItem('design-check-hold','1');sessionStorage.setItem('design-checks','[]');});
  await save(page).click(); await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('design-checks')).length>=4);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('design-fixture-update',{detail:{busy:true}})));
  await page.waitForFunction(()=>document.querySelector('.rich-editor__surface').getAttribute('aria-disabled')==='true');
  await page.evaluate(()=>{sessionStorage.removeItem('design-check-hold');window.dispatchEvent(new Event('design-check-release'));});
  await page.getByText(/Les réglages ont changé pendant la vérification/).waitFor();
  assert.equal(await count(page,'design-save-count'),1,'no write after an external lock');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('design-fixture-update',{detail:{busy:false}})));
  await save(page).click(); await page.getByText('Les présentations sont enregistrées.',{exact:true}).waitFor();
  assert.equal(await count(page,'design-save-count'),2);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('design-settings')));
  assert.equal(saved.organization.legalName,'Nom actualisé ailleurs');
  assert.equal(saved.documentComposition.quotes.closing[0].runs[0].bold,true);
  await page.reload(); await ready(page);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('design-settings')).documentComposition.accounts.footerText[0].runs[0].text),'Contact : Atelier du Léman');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.deepEqual(errors,[]); await page.close();

  const full=await setup(width,height); const app=full.page;
  await app.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&settingsRecovery=1`);
  await app.getByRole('button',{name:'Découvrir plus tard',exact:true}).click();
  const openDocuments=async()=>{
   await app.getByRole('button',{name:'Aller à un écran',exact:true}).click();
   await app.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Paramètres');
   await app.locator('.navigation-palette__results button').filter({has:app.getByText('Paramètres',{exact:true})}).click();
   await app.locator('[data-settings-link="documents"]').click(); await ready(app);
  };
  await openDocuments();
  await app.getByLabel('Police du document',{exact:true}).selectOption('times'); await ready(app);
  await app.evaluate(()=>sessionStorage.setItem('settings-recovery-mode','refresh'));
  await save(app).click();
  const recovery=app.getByRole('dialog',{name:'Enregistrement effectué',exact:true}); await recovery.waitFor();
  assert.equal(await count(app,'settings-recovery-writes'),1);
  await recovery.getByRole('button',{name:'Actualiser les données',exact:true}).click();
  await recovery.getByText('Actualisation impossible',{exact:true}).waitFor();
  assert.equal(await count(app,'settings-recovery-attempts'),1);
  await app.evaluate(()=>sessionStorage.setItem('settings-recovery-empty','1'));
  await recovery.getByRole('button',{name:'Actualiser les données',exact:true}).click();
  await recovery.getByText('Les réglages enregistrés de votre entreprise doivent être accessibles pour continuer.',{exact:true}).waitFor();
  await app.screenshot({path:`${folder}/${width}-settings-recovery.png`});
  await app.evaluate(()=>{sessionStorage.removeItem('settings-recovery-empty');window.__qaSetReadOnly(true);});
  await recovery.getByRole('button',{name:'Actualiser les données',exact:true}).click(); await recovery.waitFor({state:'hidden'});
  await app.getByText('Les présentations sont enregistrées.',{exact:true}).waitFor();
  assert.equal(await count(app,'settings-recovery-writes'),1); assert.equal(await save(app).isDisabled(),true);
  if(width<=1100) await app.getByRole('button',{name:'Tous les paramètres',exact:true}).click();
  await app.locator('[data-settings-link="storage"]').click();
  assert.equal(await app.getByRole('button',{name:'Restaurer',exact:true}).isDisabled(),true);
  assert.equal(await app.getByRole('button',{name:'Créer une sauvegarde',exact:true}).isDisabled(),false);
  await app.getByRole('button',{name:'Exporter en JSON',exact:true}).click();
  await app.waitForFunction(()=>Number(sessionStorage.getItem('settings-recovery-exports'))===1);
  assert.equal(await count(app,'settings-recovery-writes'),1);
  if(width<=1100) await app.getByRole('button',{name:'Tous les paramètres',exact:true}).click();
  await app.locator('[data-settings-link="documents"]').click();
  await app.evaluate(()=>{window.__qaSetReadOnly(false);sessionStorage.setItem('settings-recovery-mode','refuse');});
  await app.getByLabel('Police du document',{exact:true}).selectOption('courier'); await ready(app);
  await save(app).click();
  await app.locator('.design-studio__problems').getByText('Vérifiez les coordonnées de l’entreprise avant d’enregistrer.',{exact:true}).waitFor();
  assert.equal(await app.getByLabel('Police du document',{exact:true}).inputValue(),'courier');
  assert.equal(await app.evaluate(()=>window.__qaSettingsRecovery.stored().settings.documentComposition.invoices.fontFamily),'times');
  await app.evaluate(()=>sessionStorage.setItem('settings-recovery-logo','1'));
  await save(app).click();
  const companyProblem=app.locator('.design-studio__problems article').filter({has:app.getByText('Factures · Entreprise et logo',{exact:true})});
  await companyProblem.getByRole('button',{name:'Ouvrir Entreprise et facturation',exact:true}).click();
  await app.waitForFunction(()=>document.activeElement.matches('.company-logo-setting button'));
  assert.equal(await app.locator('[data-settings-id="company"]').evaluate(el=>el.open),true);
  assert.equal(await count(app,'settings-recovery-attempts'),2);
  await app.evaluate(()=>sessionStorage.removeItem('settings-recovery-logo'));
  if(width<=1100) await app.getByRole('button',{name:'Tous les paramètres',exact:true}).click();
  await app.locator('[data-settings-link="documents"]').click();
  assert.equal(await app.getByLabel('Police du document',{exact:true}).inputValue(),'courier');
  await app.evaluate(()=>sessionStorage.setItem('settings-recovery-mode','hold'));
  await save(app).click(); await app.waitForFunction(()=>Number(sessionStorage.getItem('settings-recovery-attempts'))===3);
  await save(app).dispatchEvent('click');
  assert.equal(await count(app,'settings-recovery-attempts'),3);
  await app.evaluate(()=>window.dispatchEvent(new Event('settings-recovery-release')));
  await app.getByText('Les présentations sont enregistrées.',{exact:true}).waitFor();
  assert.equal(await count(app,'settings-recovery-writes'),2);
  await app.reload(); await openDocuments();
  assert.equal(await app.getByLabel('Police du document',{exact:true}).inputValue(),'courier');
  assert.equal(await app.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.deepEqual(full.errors,[]); await app.close();
  report.push({engine,width,height,guidedCorrections:true,allCategoriesChecked:true,staleInputHeld:true,acknowledgedRecovery:true,persisted:true,passed:true});
 }
}catch(error){report.push({error:String(error.stack||error)});process.exitCode=1;}
finally{await writeFile(`${folder}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();}
