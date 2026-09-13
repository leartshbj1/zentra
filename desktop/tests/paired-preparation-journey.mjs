import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const out = `.qa/paired-preparation-${engine}`;
await mkdir(out, {recursive:true});
const browser = await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const report=[];
try {
  for(const [width,height] of [[320,568],[390,844],[844,390],[1440,1000]]) {
    const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',value=>errors.push(value.message));
    page.setDefaultTimeout(15000);
    const button=name=>page.getByRole('button',{name,exact:true});
    const field=name=>page.getByLabel(name,{exact:false});
    const snapshot=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-pair-snapshot')));
    const fieldFocused=async name=>assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('name')),name);
    const notesVisible=()=>page.waitForFunction(()=>{
      const input=document.querySelector('.paired-preparation textarea'),body=input.closest('.modal__body'),actions=document.querySelector('.paired-preparation__actions');
      const rect=input.getBoundingClientRect(),area=body.getBoundingClientRect(),bar=actions.getBoundingClientRect();
      const bottom=Math.min(area.bottom,innerHeight,bar.top>area.top?bar.top:Infinity);
      return rect.top>=area.top-1&&rect.bottom<=bottom+1;
    },null,{timeout:3000});
    const check=async stage=>{
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      const modal=page.getByRole('dialog');
      assert.ok(await modal.evaluate(node=>node.scrollWidth<=node.clientWidth+1&&node.querySelector('.modal__body').scrollWidth<=node.querySelector('.modal__body').clientWidth+1));
      await page.screenshot({path:`${out}/${width}-${stage}.png`});
    };
    try {
      await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271'}/tests/mobile-harness.html?quotePair=1`);
      await button('Fermer le guide automatique').click();
      await button('Aller à un écran').click();await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Devis');
      await page.locator('.navigation-palette__results button').filter({has:page.getByText('Devis',{exact:true})}).click();
      await button('Créer la facture').click();await page.getByRole('checkbox',{name:/Créer une facture d’acompte/}).check();
      await field('Pourcentage de l’acompte').fill('40');await button('Créer les deux factures').click();
      await button('Ouvrir l’acompte').waitFor();const before=await snapshot();
      await button('Ouvrir l’acompte').click();
      await button('Continuer vers le paiement').click();await fieldFocused('serviceDateFrom');
      assert.equal(await page.evaluate(()=>sessionStorage.getItem('qa-pair-update-attempts')),null);
      await field('Début de prestation').fill('2026-09-01');await field('Fin de prestation').fill('2026-08-31');
      await button('Continuer vers le paiement').click();await fieldFocused('serviceDateTo');await check('error');
      await field('Fin de prestation').fill('2026-09-30');await button('Continuer vers le paiement').click();
      await field('Date d’émission').fill('2026-09-10');assert.equal(await field('Échéance').inputValue(),'2026-10-10');
      await button('À 14 jours').click();assert.equal(await field('Échéance').inputValue(),'2026-09-24');
      await field('Date d’émission').fill('2026-09-12');assert.equal(await field('Échéance').inputValue(),'2026-09-24');
      await field('Échéance').fill('2026-09-11');await button('Vérifier la facture').click();await fieldFocused('dueDate');
      await field('Échéance').fill('2026-09-25');await page.getByRole('textbox',{name:'Notes',exact:true}).fill('Première ligne\nDeuxième ligne conservée.');
      await notesVisible();
      if(width<600){await page.setViewportSize({width,height:height-120});await notesVisible();await check('reduced-height');await page.setViewportSize({width,height});await notesVisible();}
      await check('payment');await button('Vérifier la facture').click();
      assert.match(await page.locator('.paired-preparation__notes').innerText(),/Première ligne\nDeuxième ligne/);
      assert.match(await page.locator('.paired-preparation__overview').innerText(),/432.40/);
      await button('Voir le dossier').click();await page.getByText('Garder vos modifications ?', {exact:true}).waitFor();
      await button('Rester sur la facture').click();await check('review');
      await page.evaluate(()=>window.__qaSetReadOnly(true));
      await page.waitForFunction(()=>document.querySelector('.paired-preparation button[type=submit]')?.disabled);
      assert.ok(await button('Enregistrer et voir le dossier').isDisabled());
      await page.evaluate(()=>window.__qaSetReadOnly(false));
      await page.evaluate(()=>sessionStorage.setItem('qa-pair-refuse-update','1'));
      await button('Enregistrer et voir le dossier').click();await page.getByRole('alert').filter({hasText:'Les dates n’ont pas pu être enregistrées.'}).waitFor();
      assert.match(await page.locator('.paired-preparation__notes').innerText(),/Deuxième ligne/);
      await page.evaluate(()=>{sessionStorage.removeItem('qa-pair-refuse-update');sessionStorage.setItem('qa-pair-hold-update','1');});
      const attempts=Number(await page.evaluate(()=>sessionStorage.getItem('qa-pair-update-attempts')));
      await page.locator('.paired-preparation').evaluate(node=>{node.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));node.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
      await page.waitForFunction(count=>Number(sessionStorage.getItem('qa-pair-update-attempts'))===count,attempts+1);
      assert.equal(await page.locator('.paired-preparation__steps button:disabled').count(),3);
      await page.keyboard.press('Escape');assert.equal(await page.getByText('Garder vos modifications ?', {exact:true}).count(),0);
      await page.evaluate(()=>{sessionStorage.removeItem('qa-pair-hold-update');window.dispatchEvent(new Event('qa-release-pair-update'));});
      await button('Ouvrir le solde').waitFor();
      const saved=await snapshot();const savedDeposit=saved.invoices.find(row=>row.id==='deposit-pair');
      assert.equal(savedDeposit.dueDate,'2026-09-25');assert.equal(savedDeposit.notes,'Première ligne\nDeuxième ligne conservée.');
      assert.deepEqual(savedDeposit.lines,before.invoices.find(row=>row.id==='deposit-pair').lines);
      assert.deepEqual(saved.invoices.find(row=>row.id==='balance-pair'),before.invoices.find(row=>row.id==='balance-pair'));
      assert.equal(savedDeposit.status,'draft');assert.equal(savedDeposit.number,'');
      await button('Ouvrir le solde').click();assert.equal(await field('Début de prestation').inputValue(),'');
      await button('Reprendre ces dates de prestation').click();assert.equal(await field('Début de prestation').inputValue(),'2026-09-01');
      assert.equal(await field('Fin de prestation').inputValue(),'2026-09-30');await check('copied');
      await button('Continuer vers le paiement').click();assert.equal(await field('Date d’émission').inputValue(),'2026-09-01');
      assert.equal(await field('Échéance').inputValue(),'2026-10-01');assert.equal(await page.getByRole('textbox',{name:'Notes',exact:true}).inputValue(),'');
      await button('Vérifier la facture').click();await button('Enregistrer et voir le dossier').click();await button('Ouvrir le solde').waitFor();
      await button('Ouvrir le solde').click();await field('Début de prestation').fill('2026-09-02');await button('Voir le dossier').click();await button('Quitter sans enregistrer').click();
      assert.equal((await snapshot()).invoices.find(row=>row.id==='balance-pair').serviceDateFrom,'2026-09-01');
      await button('Émettre l’acompte').click();await button('Confirmer et émettre l’acompte').click();await button('Ouvrir l’acompte').click();
      await page.getByText('Document verrouillé',{exact:true}).waitFor();
      assert.ok(await field('Début de la prestation').isDisabled());assert.ok(await field('Date d’émission').isDisabled());
      assert.equal(await button('Enregistrer et voir le dossier').count(),0);
      assert.deepEqual(errors,[]);
      report.push({width,height,fieldFocus:true,focusedNotesVisible:true,resizedViewport:width<600,paymentDates:true,copyServiceOnly:true,unsavedChanges:true,refusalRetry:true,singleWriteWhilePending:true,readOnly:true,issuedImmutable:true,noOverflow:true});
    } catch(error) { await page.screenshot({path:`${out}/${width}-failure.png`});await writeFile(`${out}/${width}-failure.txt`,await page.locator('body').innerText());throw error; }
    finally {await page.close();}
  }
  await writeFile(`${out}/report.json`,JSON.stringify({engine,scope:'Real application with a synthetic native bridge; no customer records or physical installation.',report},null,2));
  console.log(JSON.stringify({engine,report}));
} finally {await browser.close();}
