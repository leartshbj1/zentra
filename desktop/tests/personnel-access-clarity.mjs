import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const output='.qa/personnel-access-clarity';await mkdir(output,{recursive:true});const proof=[];
for(const engine of ['chromium','webkit']){
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
 try{for(const width of [320,390,1440])for(const language of ['fr','de','it','en']){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
  await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&language=${language}&theme=${width===320?'dark':'light'}`);
  await page.locator('.desktop-app').waitFor();
  const copy=await page.evaluate(async()=>{const {t}=await import('/src/language.ts');return Object.fromEntries(['Aller à un écran','Rechercher un écran','Équipe & salaires','Nouvelle fiche de personnel','Enregistrez les informations pour les contrats et la paie. Cette fiche ne crée pas de compte de connexion.'].map(key=>[key,t(key)]));});
  await page.getByRole('button',{name:copy['Aller à un écran'],exact:true}).click();
  await page.getByRole('searchbox',{name:copy['Rechercher un écran']}).fill(copy['Équipe & salaires']);
  await page.locator('.navigation-palette__results button').filter({has:page.getByText(copy['Équipe & salaires'],{exact:true})}).click();
  await page.locator('.team-access-guide').waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:`${output}/${engine}-${width}-${language}.png`});
  await page.locator('.team-directory').getByRole('button',{name:copy['Nouvelle fiche de personnel'],exact:true}).click();
  await page.getByRole('heading',{name:copy['Nouvelle fiche de personnel'],exact:true}).waitFor();
  await page.getByText(copy['Enregistrez les informations pour les contrats et la paie. Cette fiche ne crée pas de compte de connexion.'],{exact:true}).waitFor({state:'attached'});
  await page.locator('.employee-dialog input[name="name"]').fill('Alex Exemple');
  await page.keyboard.press('Escape');await page.locator('.employee-dialog').waitFor({state:'detached'});
  await page.locator('.team-access-guide button').click();
  await page.waitForFunction(()=>document.activeElement?.id==='automation-account-target');
  assert.equal(await page.locator('#automation-account-target').evaluate(n=>n.closest('[data-settings-id]')?.hasAttribute('hidden')),false);
  assert.equal(await page.locator('.desktop-app').getAttribute('data-view'),'settings');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);proof.push({engine,width,language,recordDistinctFromAccess:true,recordFormAvailable:true,accountDestination:true,noOverflow:true});await page.close();
 }}finally{await browser.close();}
}
await writeFile(output+'/proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:proof.length,output}));
