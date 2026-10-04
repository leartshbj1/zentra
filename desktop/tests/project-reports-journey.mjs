import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const out='.qa/project-reports-clarity';await mkdir(out,{recursive:true});const results=[];
for(const engine of ['chromium','webkit']) {
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
 try {
  for(const [index,language] of ['fr','de','it','en'].entries()) for(const width of [320,1440]) {
   const theme=index%2?'dark':'light';
   const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
   await page.addInitScript(({language,theme})=>{localStorage.setItem('elyko-guided-tour-v3','completed');localStorage.setItem('zentra.interface.language.v1',language);localStorage.setItem('zentra.appearance.v1',theme);},{language,theme});
   const tr=async(value)=>page.evaluate(async value=>(await import('/src/language.ts')).t(value),value);
   async function open(scenario) {
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&reportTest=${scenario}`);
    await page.getByRole('button',{name:await tr('Aller à un écran'),exact:true}).waitFor();
    const later=page.getByRole('button',{name:await tr('Découvrir plus tard'),exact:true});if(await later.isVisible())await later.click();
    await page.getByRole('button',{name:await tr('Aller à un écran'),exact:true}).click();
    await page.getByRole('searchbox').fill(await tr('Rapports'));
    await page.locator('.navigation-palette__results button').filter({has:page.getByText(await tr('Rapports'),{exact:true})}).click();
   }
   await open('single');
   await page.locator('.project-reports__title h2').waitFor();
   assert.match(await page.locator('.project-reports__title h2').innerText(),/Rénovation Bellevue/);
   const selector=page.getByLabel(await tr('Type de rapport'),{exact:true});
   assert.equal(await selector.inputValue(),'summary');
   for(const preset of ['summary','client','internal']) {
    await selector.selectOption(preset);
    const button=page.getByRole('button',{name:await tr('Exporter le PDF'),exact:true});
    await button.click();
    await page.waitForFunction(()=>window.__projectReportsQa.reports.length>0);
    const report=await page.evaluate(()=>window.__projectReportsQa.reports.at(-1));
    const serialized=JSON.stringify(report);
    if(preset==='client'){assert.ok(!serialized.includes('SECRET-DRAFT'));assert.ok(!serialized.includes('NOTE INTERNE CONFIDENTIELLE'));assert.ok(!serialized.includes(await tr('Marge sur coûts enregistrés')));assert.ok(!serialized.includes(await tr('Marge estimée')));}
    if(preset==='internal'){assert.ok(serialized.includes('NOTE INTERNE CONFIDENTIELLE'));assert.ok(serialized.includes('SECRET-DRAFT'));}
    if(preset==='summary')assert.equal(report.sections.length,3);
    const contextTitle=await tr('Repères du rapport');
    assert.ok(report.sections.some(section=>section.title===contextTitle));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    if(preset!=='internal')await page.screenshot({path:`${out}/${engine}-${language}-${width}-${preset}.png`,fullPage:true});
    results.push({engine,language,width,theme,scenario:preset,passed:true});
    if(engine==='chromium'&&language==='fr'&&width===1440)await writeFile(`${out}/${preset}.json`,JSON.stringify(report,null,2));
   }
   await selector.selectOption('summary');
   await page.locator('.project-reports__customize summary').click();
   await page.locator('.project-reports__sections input').first().uncheck();
   assert.equal(await page.getByRole('button',{name:await tr('Exporter le PDF'),exact:true}).isDisabled(),true);
   await page.locator('.project-reports__sections input').first().check();
   await page.getByLabel(await tr('Préparé par (facultatif)'),{exact:true}).fill('Camille Martin');
   await page.evaluate(()=>{window.__projectReportsQa.fail=true;});
   await page.getByRole('button',{name:await tr('Exporter le PDF'),exact:true}).click();
   await page.getByRole('alert').waitFor();
   assert.equal(await page.getByLabel(await tr('Préparé par (facultatif)'),{exact:true}).inputValue(),'Camille Martin');
   await page.getByRole('button',{name:await tr('Exporter le PDF'),exact:true}).click();
   await page.waitForFunction(()=>window.__projectReportsQa.reports.at(-1).subtitle.includes('Camille Martin'));
   assert.equal(await page.getByRole('alert').count(),0);
   const before=await page.evaluate(()=>{window.__projectReportsQa.pending=true;return window.__projectReportsQa.reports.length;});
   await page.getByRole('button',{name:await tr('Exporter le PDF'),exact:true}).evaluate(button=>{button.click();button.click();});
   await page.waitForFunction(expected=>window.__projectReportsQa.reports.length===expected,before+1);
   assert.equal(await selector.isDisabled(),true);
   await page.evaluate(()=>{window.__projectReportsQa.release();window.__projectReportsQa.pending=false;});
   await page.getByRole('button',{name:await tr('Exporter le PDF'),exact:true}).waitFor();
   assert.equal(await selector.isDisabled(),false);
   assert.deepEqual(errors,[]);results.push({engine,language,width,scenario:'validation-retry-single-flight',passed:true});
   if(width===320&&language==='de') {
    await page.evaluate(async()=>(await import('/src/textSize.ts')).setTextSize(200));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.screenshot({path:`${out}/${engine}-de-320-200.png`,fullPage:true});
    results.push({engine,scenario:'200-percent',passed:true});
   }
   await page.close();
  }
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&reportTest=many`);
  const later=page.getByRole('button',{name:'Découvrir plus tard',exact:true});if(await later.isVisible())await later.click();
  await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();await page.getByRole('searchbox').fill('Rapports');
  await page.locator('.navigation-palette__results button').filter({has:page.getByText('Rapports',{exact:true})}).click();
  const projects=page.locator('.project-reports__project-list button[aria-pressed]');await projects.first().waitFor();
  assert.equal(await projects.count(),20);assert.ok((await projects.first().innerText()).startsWith('Projet 25'));
  await page.getByRole('button',{name:'Afficher plus de projets',exact:true}).click();assert.equal(await projects.count(),25);
  await page.getByRole('searchbox',{name:'Rechercher un projet',exact:true}).fill('introuvable');
  await page.getByText('Aucun projet trouvé. Modifiez votre recherche.',{exact:true}).waitFor();
  await page.getByRole('searchbox',{name:'Rechercher un projet',exact:true}).fill('Projet 01');await projects.first().click();
  await page.getByRole('heading',{name:'Projet 01',exact:true}).waitFor();
  results.push({engine,scenario:'recent-projects-search-pagination',passed:true});await page.close();
 } finally {await browser.close();}
}
await writeFile(`${out}/proof.json`,JSON.stringify(results,null,2));console.log(JSON.stringify({passed:results.length}));
