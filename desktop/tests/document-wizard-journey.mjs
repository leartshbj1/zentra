import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const isWebKit=process.env.ZENTRA_QA_BROWSER==='webkit';
const browser=await (isWebKit?webkit:chromium).launch({headless:true,...(!isWebKit&&process.platform==='win32'?{channel:'msedge'}:{})});
const out=`.qa/document-wizard-${isWebKit?'webkit':'edge'}`;
await mkdir(out,{recursive:true});
const report=[];
let page;
try {
for(const viewport of [{width:320,height:568},{width:390,height:844},{width:844,height:390},{width:1440,height:900}]) {
 page=await browser.newPage({viewport,hasTouch:viewport.width<900});
 page.setDefaultTimeout(12000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&design=1&wizard=1`);
 const tour=page.getByRole('button',{name:'Découvrir plus tard',exact:true});
 await tour.click();
 const nav=async(name)=>{
  await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
  await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill(name);
  await page.locator('.navigation-palette__results button').filter({has:page.getByText(name,{exact:true})}).click();
 };
 const shot=async(name)=>{
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name}: viewport overflow`);
  await page.screenshot({path:`${out}/${viewport.width}-${name}.png`,animations:'disabled'});
 };
 const dialog=page.getByRole('dialog');
 const next=()=>dialog.getByRole('button',{name:'Continuer',exact:true}).click();
 const step=async(index)=>{
  await dialog.locator(`[data-document-step="${index}"]:not([hidden])`).waitFor();
  assert.equal(await dialog.locator('.document-step:not([hidden])').count(),1);
  await dialog.evaluate(el => Promise.all(el.getAnimations({subtree:true}).filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
  const footer=await dialog.locator('.document-wizard-footer').boundingBox();
  assert.ok(footer.y>=0&&footer.y+footer.height<=viewport.height+1,'footer remains visible');
  assert.ok(await dialog.locator('.document-form').evaluate(el=>el.clientHeight>=100),'usable reading area');
 };
 const calls=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('wizard-documents')||'[]'));
 const line=async()=>{
  await dialog.getByRole('textbox',{name:'Description',exact:true}).fill('Préparation et finition des murs');
  await dialog.getByRole('spinbutton',{name:'Quantité',exact:true}).fill('2');
  await dialog.getByRole('textbox',{name:'Unité',exact:true}).fill('h');
  await dialog.getByRole('spinbutton',{name:'Prix unitaire',exact:true}).fill('125');
  await dialog.getByRole('combobox',{name:'Taux TVA',exact:true}).selectOption('810');
 };
 await shot('dashboard');
 await nav('Devis');
 assert.equal(await page.locator('.page-content').evaluate(el=>getComputedStyle(el).animationName),'workspace-arrive');
 assert.equal(await page.locator('.page-content').evaluate(el=>getComputedStyle(el).animationDuration),'0.32s');
 await shot('quotes');
 await page.getByRole('button',{name:'Nouveau devis',exact:true}).click();
 await step(0);await shot('client');
 await next();await step(0);assert.equal(await calls().then(a=>a.length),0);
 assert.equal(await dialog.locator('[name=title]').evaluate(el=>el===document.activeElement),true);
 await dialog.locator('[name=title]').fill('Aménagement du séjour');
 await dialog.locator('[name=clientId]').selectOption('client-qa');
 await dialog.locator('[name=projectId]').selectOption('project-qa');
 // Jumping ahead validates each intermediate step and focuses the missing field.
 await dialog.locator('.document-stepper button').nth(3).click();await step(1);
 assert.equal(await dialog.getByRole('textbox',{name:'Description',exact:true}).evaluate(el=>el===document.activeElement),true);
 await line();await shot('services');await next();await step(2);
 await dialog.locator('[name=notes]').fill('Merci pour votre confiance.\nNous préparons votre projet avec soin.');
 await shot('conditions');
 await dialog.getByRole('button',{name:'Retour',exact:true}).click();await step(1);
 assert.equal(await dialog.getByRole('textbox',{name:'Description',exact:true}).inputValue(),'Préparation et finition des murs');
 await next();await next();await step(3);
 assert.match(await dialog.locator('.document-review').innerText(),/270.25/);
 assert.match(await dialog.locator('.document-review').innerText(),/Merci pour votre confiance/);
 assert.equal((await calls()).length,0);await shot('review');
 await page.evaluate(()=>window.__qaSetReadOnly(true));
 await page.waitForFunction(()=>document.querySelector('.document-wizard-footer button[type=submit]')?.disabled);
 assert.ok(await dialog.getByRole('button',{name:'Enregistrer le brouillon',exact:true}).isDisabled());
 await dialog.locator('form').evaluate(form=>form.requestSubmit());assert.equal((await calls()).length,0);
 await page.evaluate(()=>window.__qaSetReadOnly(false));
 await page.waitForFunction(()=>document.querySelector('.document-wizard-footer button[type=submit]')?.disabled===false);
 await dialog.getByRole('button',{name:'Enregistrer le brouillon',exact:true}).click();
 await dialog.waitFor({state:'detached'});
 let saved=(await calls())[0];
 assert.equal(saved[0],'quotes');assert.equal(saved[1].totalCents,27025);assert.equal(saved[1].projectId,'project-qa');assert.match(saved[1].notes,/Merci/);
 // New deposit, including validation of the period and the exact base/deduction payload.
 await nav('Factures');await shot('invoices');
 await page.getByRole('button',{name:'Nouvelle facture',exact:true}).click();
 await dialog.locator('[name=title]').fill('Acompte pour le séjour');
 await dialog.locator('[name=clientId]').selectOption('client-qa');
 await dialog.locator('[name=projectId]').selectOption('project-qa');
 await dialog.getByLabel('Type de document').selectOption('deposit');
 await next();await line();await next();await step(2);
 await next();await step(2);assert.equal((await calls()).length,1);
 await dialog.getByLabel('Début de la prestation').fill('2026-09-08');
 await dialog.getByLabel('Fin de la prestation').fill('2026-09-12');
 await dialog.getByRole('spinbutton',{name:'Pourcentage de l’acompte',exact:true}).fill('30');
 await next();await step(3);await shot('deposit-review');
 await dialog.getByRole('button',{name:'Enregistrer le brouillon',exact:true}).click();await dialog.waitFor({state:'detached'});
 saved=(await calls())[1];assert.equal(saved[1].depositPercentageBp,3000);assert.equal(saved[1].depositBasisLines[0].unitPriceCents,12500);assert.equal(saved[1].totalCents,8108);assert.equal(saved[2].length,1);
 // Quick client creation keeps the in-progress title and selects the saved client.
 await page.getByRole('button',{name:'Nouvelle facture',exact:true}).click();
 await dialog.locator('[name=title]').fill('Titre conservé pendant l’ajout du contact');
 await dialog.getByRole('button',{name:'Nouveau contact',exact:true}).click();
 const card=dialog.getByRole('region',{name:'Ajouter un nouveau client'});
 for(const [label,value] of [['Entreprise','Studio du Lac'],['Rue / case postale','Rue du Lac'],['NPA','1000'],['Localité','Lausanne']])await card.getByLabel(label).fill(value);
 await card.getByRole('button',{name:'Ajouter et sélectionner',exact:true}).click();
 await card.waitFor({state:'detached'});
 assert.equal(await dialog.locator('[name=title]').inputValue(),'Titre conservé pendant l’ajout du contact');
 assert.equal(await dialog.locator('[name=clientId] option:checked').innerText(),'Studio du Lac');
 await dialog.getByRole('button',{name:'Annuler',exact:true}).click();
 // A linked credit note keeps the original currency and blocks an earlier issue date.
 await page.getByRole('button',{name:'Nouvelle facture',exact:true}).click();
 await dialog.locator('[name=title]').fill('Correction partielle');
 await dialog.getByLabel('Type de document').selectOption('credit_note');
 await dialog.getByLabel('Facture originale').selectOption('invoice-2');
 assert.equal(await dialog.locator('[name=clientId]').inputValue(),'client-other');
 assert.ok(await dialog.locator('[name=clientId]').isDisabled());
 assert.equal(await dialog.getByRole('textbox',{name:'Devise',exact:true}).inputValue(),'EUR');
 await next();await line();
 assert.equal(await dialog.locator('.money-input > span').innerText(),'EUR');
 await next();await step(2);
 await dialog.getByLabel('Date d’émission').fill('2026-01-01');
 await dialog.getByLabel('Début de la prestation').fill('2026-06-05');
 await dialog.getByLabel('Fin de la prestation').fill('2026-06-05');
 await next();await step(2);assert.equal((await calls()).length,2);
 await dialog.getByLabel('Date d’émission').fill('2026-09-06');
 await next();await step(3);await shot('credit-review');
 assert.match(await dialog.locator('.document-review').innerText(),/Avoir lié à F-2026-003/);
 await dialog.getByRole('button',{name:'Enregistrer le brouillon',exact:true}).click();await dialog.waitFor({state:'detached'});
 saved=(await calls())[2];assert.equal(saved[1].type,'credit_note');assert.equal(saved[1].originalInvoiceId,'invoice-2');assert.equal(saved[1].currency,'EUR');assert.equal(saved[1].dueDate,'');
 // Reduced motion removes all page and step animations.
 await page.emulateMedia({reducedMotion:'reduce'});await nav('Devis');
 assert.equal(await page.locator('.page-content').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.getByRole('button',{name:'Nouveau devis',exact:true}).click();
 assert.equal(await dialog.locator('[data-document-step="0"]').evaluate(el=>getComputedStyle(el).animationName),'none');
 await dialog.getByRole('button',{name:'Annuler',exact:true}).click();
 assert.deepEqual(errors,[]);
 report.push({viewport,status:'passed',quoteTotal:27025,depositTotal:8108,retainedDraft:true,quickClient:true,linkedCreditEur:true,readOnly:true,motion:true,reducedMotion:true,errors});
 await page.close();
}
} catch(error) {if(page){await page.screenshot({path:`${out}/failure.png`,animations:'disabled'});await writeFile(`${out}/failure.json`,JSON.stringify({error:String(error),text:await page.locator('body').innerText()},null,2));}throw error;}
finally {await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();}
