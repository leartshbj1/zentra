import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const output='.qa/first-client-clarity';await mkdir(output,{recursive:true});const proof=[];
for(const engine of ['chromium','webkit']){
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
 try{for(const width of [320,390,1440]) for(const language of ['fr','de','it','en']){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
  await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&language=${language}&theme=${width===390?'light':'dark'}`);
  await page.locator(width<=860?'.mobile-home__balance':'.workspace-finances').waitFor();
  const scope=await page.evaluate(async()=>{const {t}=await import('/src/language.ts');return t('Encore dû · toutes années confondues');});
  await page.getByText(scope,{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  if(width>860){assert.equal(await page.locator('.workspace-finances .metric-card').count(),4);await page.locator('.dashboard-finance-guide summary').click();await page.locator('.dashboard-finance-guide button').waitFor();}
  else {await page.locator('.mobile-home__balance summary').click();await page.locator('.mobile-home__balance button').waitFor();}
  await page.screenshot({path:`${output}/home-${engine}-${width}-${language}.png`});
  if(language==='fr'){
   await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
   await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Paramètres');
   await page.locator('.navigation-palette__results button').filter({has:page.getByText('Paramètres',{exact:true})}).click();
   await page.locator('[data-settings-link="company"]').click();
   const identity=page.locator('input[name="legalName"]');await identity.waitFor();
   const headings=await page.locator('[data-settings-id="company"] h2').allTextContents();
   assert.ok(headings.indexOf('Entreprise et facturation')<headings.indexOf('Secteur d’activité et noms des projets'),JSON.stringify(headings));
   const legalTop=await identity.evaluate(n=>n.getBoundingClientRect().top);assert.ok(legalTop<850,`Identity too far down: ${legalTop}`);
   await page.screenshot({path:`${output}/company-${engine}-${width}.png`});
   await page.getByRole('heading',{name:'Secteur d’activité et noms des projets',exact:true}).scrollIntoViewIfNeeded();
   await page.getByRole('button',{name:'Enregistrer le profil d’activité',exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  }
  assert.deepEqual(errors,[]);proof.push({engine,width,language,periodExplicit:true,currenciesSeparate:true,identityFirst:language==='fr',overflow:false});await page.close();
 }}finally{await browser.close();}
}
await writeFile(`${output}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
