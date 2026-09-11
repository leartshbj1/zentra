import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium,webkit}=require('C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out='.qa/assistant-interface';await mkdir(out,{recursive:true});const report=[];
for (const [engine,type] of [['edge',chromium],['webkit',webkit]]) {
 const browser=await type.launch({headless:true,...(engine==='edge'?{channel:'msedge'}:{})});
 try {for (const [width,height] of [[320,568],[390,844],[844,390],[1440,900]]) {
  const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
   await page.goto('http://127.0.0.1:5193/tests/mobile-harness.html?payroll=1&payrollPensionSetup=1&assistantFixture=1');
   await page.getByRole('button',{name:'Fermer le guide automatique',exact:true}).click();

   await page.getByRole('button',{name:'Demander à l’assistant Zentra',exact:true}).click();
   await page.getByRole('button',{name:'Installer Qwen · 429 Mo',exact:true}).click();
   await page.getByLabel('Votre question',{exact:true}).fill('Comment commencer ?');
   await page.getByRole('button',{name:'Envoyer la question',exact:true}).click();
   await page.getByText('Guide vérifié Zentra',{exact:true}).waitFor();
   await page.getByRole('button',{name:'Fermer « Assistant Zentra »',exact:true}).click();
   await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
   await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Équipe & salaires');
   await page.locator('.navigation-palette__results button').filter({has:page.getByText('Équipe & salaires',{exact:true})}).click();
   await page.locator('.team-navigation').getByRole('button',{name:/Fiches de salaire/}).click();
   await page.getByRole('button',{name:'Nouvelle fiche',exact:true}).click();
   const payroll=page.locator('.payroll-dialog');
   await payroll.getByRole('combobox',{name:/^Collaborateur/}).selectOption('elodie');
   await payroll.locator('input[name=period]').fill('2026-09');
   await payroll.getByRole('button',{name:'Continuer',exact:true}).click();
   await payroll.getByRole('spinbutton',{name:'Salaire brut du mois (CHF)',exact:true}).fill('5123.45');
   await payroll.getByRole('button',{name:'Demander à l’assistant Zentra',exact:true}).click();
   await page.getByText('Contexte utilisé',{exact:true}).click();
   await page.getByLabel('Votre question',{exact:true}).fill('Aide pour ma caisse de pension');
   await page.getByRole('button',{name:'Envoyer la question',exact:true}).click();
   await page.getByText('Guide vérifié Zentra',{exact:true}).waitFor();
   const call=await page.evaluate(()=>window.assistantCalls.at(-1));
   assert.equal(call.screen,'Création de fiche de salaire');assert.equal(call.facts['Période'],'2026-09');assert.equal(call.facts['Salaire brut saisi (CHF)'],'5123.45');
   assert.equal(JSON.stringify(call.facts).includes('Élodie'),false);
   const overflow=await page.locator('.zentra-assistant-dialog').evaluate(el=>el.scrollWidth>el.clientWidth+1);assert.equal(overflow,false);
   await page.screenshot({path:`${out}/${engine}-${width}-payroll.png`});
   await page.locator('.assistant-guide summary').click();
   await page.getByRole('button',{name:'Vérifier le plan LPP',exact:true}).click();
   await payroll.locator('[data-pension-plan][open]').waitFor();
   await payroll.getByRole('button',{name:'← Revenir au salaire',exact:true}).click();
   assert.equal(await payroll.getByRole('spinbutton',{name:'Salaire brut du mois (CHF)',exact:true}).inputValue(),'5123.45');
   await page.goto('http://127.0.0.1:5193/tests/mobile-harness.html?assistantOnboarding=1');
   await page.getByRole('heading',{name:'Voulez-vous installer votre assistant local ?',exact:true}).waitFor();
   await page.getByRole('button',{name:'Plus tard',exact:true}).click();
   assert.equal(await page.evaluate(()=>localStorage.getItem('zentra.local-assistant.preference.v1')),'later');
   await page.getByRole('button',{name:/Créer mon entreprise/}).click();
   await page.getByText('Créer avec l’essentiel',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   assert.deepEqual(errors,[]);report.push({engine,width,height,passed:true});
  } catch(error) {report.push({engine,width,error:error.stack,errors});await page.screenshot({path:`${out}/${engine}-${width}-failure.png`});throw error;} finally {await page.close();}
 }} finally {await browser.close();await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));}
}
console.log(JSON.stringify(report,null,2));
