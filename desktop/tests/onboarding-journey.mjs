import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5331';
const out='.qa/onboarding-redesign';await mkdir(out,{recursive:true});const results=[];
const stageNames=['welcome','account','identity','address','activity','tax','bank','documents','work','payroll','insurance','contributions','backup','assistants','review'];
let seed;
async function field(page,name,value){await page.locator(`[data-field="${name}"]`).fill(value);}
async function forward(page){await page.locator('.first-run__actions .button--primary').click();}
async function stage(page,id){await page.locator(`.first-run__stage--${id}`).waitFor();}
async function noOverflow(page,label){
  const findings=await page.evaluate(()=>({page:document.documentElement.scrollWidth>innerWidth+1,labels:[...document.querySelectorAll('.first-run .field__label,.first-run .button,.first-run h1')].filter(el=>el.getClientRects().length&&el.scrollWidth>el.clientWidth+2).map(el=>el.textContent)}));
  assert.equal(findings.page,false,`${label}: page overflow`);assert.deepEqual(findings.labels,[],`${label}: clipped label`);
}
async function capture(page,file){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${out}/${file}.png`,fullPage:true});}
const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined});
try{
  const page=await browser.newPage({viewport:{width:1293,height:911},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${origin}/tests/onboarding-preview.html`);await stage(page,'welcome');await capture(page,'welcome-desktop');await forward(page);
  await stage(page,'account');await page.getByRole('button',{name:'Se connecter dans le navigateur',exact:true}).click();
  await page.getByText('TEST-1234',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.onboardingFixture.calls.slice(0,2)),['start-link','open-link']);await capture(page,'account-desktop');await forward(page);
  await stage(page,'identity');await forward(page);await page.waitForFunction(()=>document.activeElement?.getAttribute('data-field')==='organization.legalName');
  assert.equal(await page.locator('.first-run__stage--identity .field--error').count(),3);
  await field(page,'organization.legalName','Atelier du Léman · Démonstration');await field(page,'organization.contactName','Camille Exemple');await field(page,'organization.email','camille@example.invalid');
  await page.getByRole('button',{name:'Choisir le logo',exact:true}).click();await page.locator('.company-logo-setting__preview img').waitFor();await capture(page,'identity-desktop');
  // Persist across reload without changing customer-entered strings.
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('zentra.onboarding.draft.v2')||'null')?.settings.organization.legalName==='Atelier du Léman · Démonstration');
  await page.reload();await stage(page,'identity');assert.equal(await page.locator('[data-field="organization.contactName"]').inputValue(),'Camille Exemple');await forward(page);
  await stage(page,'address');for(const [k,v] of Object.entries({street:'Rue de démonstration',postalCode:'1000',city:'Lausanne',canton:'VD'})) await field(page,`organization.address.${k}`,v);await forward(page);
  await stage(page,'activity');await page.locator('[data-field="business.nogaSection"]').selectOption('M');await page.locator('[data-field="business.nogaDivision"]').selectOption('68');await field(page,'business.activityDescription','Conseil immobilier, données fictives.');await forward(page);
  await stage(page,'tax');await forward(page);await stage(page,'bank');await field(page,'billing.iban','CH93 0076 2011 6238 5295 7');await field(page,'billing.accountHolder','Atelier du Léman');await forward(page);
  await stage(page,'documents');await capture(page,'documents-desktop');await forward(page);
  await stage(page,'work');await field(page,'work.workWeekHours','40');await field(page,'work.dailyHours','8');await field(page,'work.costCategories','Marchandises, Déplacements');await forward(page);
  await stage(page,'payroll');await page.getByRole('button',{name:/Oui, je prépare des salaires/}).click();await forward(page);
  await stage(page,'insurance');await forward(page);await page.waitForFunction(()=>document.activeElement?.getAttribute('data-field')==='payroll.avsFund');
  await field(page,'payroll.avsFund','Caisse de recette');await field(page,'payroll.accidentInsurer','Assurance de recette');await field(page,'payroll.payrollCanton','VD');await forward(page);
  await stage(page,'contributions');await page.getByRole('button',{name:'Ajouter un taux',exact:true}).first().click();
  await page.locator('[data-field$=".label"]').fill('Cotisation de test');await page.locator('[data-field$=".rateBp"]').fill('1');await page.locator('[data-field$=".effectiveFrom"]').fill('2026-01-01');await capture(page,'contributions-desktop');await forward(page);
  await stage(page,'backup');await page.getByRole('button',{name:'Choisir',exact:true}).click();await page.locator('[data-field="backup.privacyConfirmed"]').check();await page.locator('[data-field="backup.recoveryConfirmed"]').check();await forward(page);
  await stage(page,'assistants');await forward(page);await stage(page,'review');await capture(page,'review-desktop');
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('zentra.onboarding.draft.v2')||'null')?.step===14);seed=await page.evaluate(()=>JSON.parse(localStorage.getItem('zentra.onboarding.draft.v2')));
  // Native preflight rejection routes back to the actual bank field. A retry creates exactly once.
  await page.evaluate(()=>window.onboardingFixture.preflightFailure=true);await forward(page);await stage(page,'bank');await page.waitForFunction(()=>document.activeElement?.getAttribute('data-field')==='billing.iban');await field(page,'billing.iban','CH9300762011623852957');
  await page.getByRole('button',{name:/À vous de jouer/}).click();await forward(page);await stage(page,'review');await forward(page);
  await page.getByRole('heading',{name:'Atelier du Léman · Démonstration',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.onboardingFixture.completed.length),1);
  assert.equal(await page.evaluate(()=>localStorage.getItem('zentra.onboarding.draft.v2')),null);
  assert.deepEqual(errors,[]);results.push({test:'Full creation, native rejection, retry, draft, payroll',passed:true});await page.close();
  const retry=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await retry.addInitScript(seed=>localStorage.setItem('zentra.onboarding.draft.v2',JSON.stringify(seed)),seed);
  await retry.goto(`${origin}/tests/onboarding-preview.html`);await stage(retry,'review');
  await retry.evaluate(()=>window.onboardingFixture.createFailure=true);await forward(retry);
  await retry.getByText('Enregistrement de test interrompu. Réessayez.',{exact:true}).waitFor();
  assert.equal(await retry.evaluate(()=>window.onboardingFixture.completed.length),0);
  assert.equal(await retry.evaluate(()=>JSON.parse(localStorage.getItem('zentra.onboarding.draft.v2')).settings.organization.legalName),seed.settings.organization.legalName);
  await retry.evaluate(()=>window.onboardingFixture.createFailure=false);await forward(retry);
  await retry.getByRole('heading',{name:seed.settings.organization.legalName,exact:true}).waitFor();
  assert.equal(await retry.evaluate(()=>window.onboardingFixture.completed.length),1);await retry.close();
  const cancel=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await cancel.goto(`${origin}/tests/onboarding-preview.html`);await forward(cancel);await stage(cancel,'account');
  await cancel.evaluate(()=>window.onboardingFixture.restoreCancelled=true);
  await cancel.getByText('Reprendre une sauvegarde',{exact:true}).click();await cancel.getByRole('button',{name:'Choisir un fichier .zentra',exact:true}).click();
  assert.equal(await cancel.evaluate(()=>window.onboardingFixture.calls.includes('restore')),false);
  assert.equal(await cancel.locator('.first-run__actions .button--primary').isEnabled(),true);
  assert.equal(await cancel.locator('.assistant-launcher').isVisible(),false);
  await cancel.getByRole('button',{name:'Demander à l’assistant Zentra',exact:true}).click();
  await cancel.getByRole('dialog').waitFor();await cancel.close();
  results.push({test:'Failed create keeps draft, retry succeeds once, cancelled restore leaves setup available, inline assistant works',passed:true});
  // Layout coverage on every page, all shipped languages, desktop and phone, both themes.
  for(const language of ['fr','de','it','en']) for(const width of [320,390,1293]) {
    const page=await browser.newPage({viewport:{width,height:width===1293?911:844},reducedMotion:'reduce'});
    await page.addInitScript(({seed})=>{window.__qaSeed=seed;localStorage.setItem('zentra.onboarding.draft.v2',JSON.stringify({...seed,step:Number(sessionStorage.getItem('qa-step')||0)}));},{seed});
    for(const theme of ['light','dark']) for(let index=0;index<stageNames.length;index++) {
      if(index===0)await page.goto(`${origin}/tests/onboarding-preview.html?language=${language}&theme=${theme}`);
      await page.evaluate(index=>sessionStorage.setItem('qa-step',String(index)),index);await page.reload();await stage(page,stageNames[index]);await noOverflow(page,`${language}/${width}/${theme}/${stageNames[index]}`);
      if(language==='fr'&&width===390&&theme==='light'&&[0,2,7,11].includes(index))await capture(page,`${stageNames[index]}-mobile`);
      if(language==='de'&&width===390&&theme==='dark'&&[0,2,10,12].includes(index))await capture(page,`${stageNames[index]}-mobile-dark-de`);
    }
    results.push({test:'Layout',language,width,pages:30,passed:true});await page.close();
  }
  const remote=await browser.newPage({viewport:{width:390,height:844}});await remote.goto(`${origin}/tests/onboarding-preview.html?remote=1`);await forward(remote);await remote.getByRole('button',{name:'Se connecter dans le navigateur',exact:true}).click();
  await remote.evaluate(()=>{window.onboardingFixture.account={status:'connected',organizationId:'fixture-company',organizationName:'Entreprise déjà partagée',role:'owner'};});
  await remote.getByRole('heading',{name:'Entreprise déjà partagée',exact:true}).waitFor();assert.equal(await remote.evaluate(()=>window.onboardingFixture.completed.length),0);results.push({test:'Existing account opens remote company without creating another',passed:true});await remote.close();
}catch(error){results.push({failed:String(error.stack||error)});process.exitCode=1;}
finally{await browser.close();}
if(!process.exitCode){
  const browser=await webkit.launch();const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  try{await page.goto(`${origin}/tests/onboarding-preview.html?language=de&theme=dark`);await stage(page,'welcome');await noOverflow(page,'WebKit welcome');await forward(page);await stage(page,'account');await forward(page);await stage(page,'identity');await page.getByRole('button',{name:/1 \/ 7/}).count();await noOverflow(page,'WebKit identity');await capture(page,'webkit-mobile-identity');results.push({test:'WebKit touch welcome/account/company',passed:true});}
  catch(error){results.push({failed:String(error.stack||error)});process.exitCode=1;}finally{await browser.close();}
}
await writeFile(`${out}/journey-results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
