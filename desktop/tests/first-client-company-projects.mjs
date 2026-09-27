import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const out='.qa/company-projects-clarity';await mkdir(out,{recursive:true});
const results=[];
for(const engine of ['chromium','webkit']) {
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
 try {
  for(const [index,language] of ['fr','de','it','en'].entries()) for(const width of [320,1440]) {
   const theme=index%2?'dark':'light';
   const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
   const tr=async (value,values)=>page.evaluate(async ({value,values})=>(await import('/src/language.ts')).t(value,values),{value,values});
   for(const scenario of ['old','local']) {
    await page.goto(`${origin}/tests/company-account-harness.html?scenario=${scenario}&language=${language}&theme=${theme}&long`);
    const button=scenario==='old'?'Ouvrir l’espace du compte':'Relier cette entreprise à mon compte';
    await page.getByRole('button',{name:await tr(button),exact:true}).waitFor();
    await page.getByText(await tr('Propriétaire'),{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    const controls=await page.locator('.company-account-opening button').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {height:r.height,left:r.left,right:r.right,label:e.textContent};}));
    assert.ok(controls.every(r=>r.height>=44&&r.left>=0&&r.right<=width),JSON.stringify(controls));
    const contrasts=await page.locator('.company-account-opening__identity span,.company-account-opening__identity small,.company-account-choices span,.company-account-choices small').evaluateAll(es=>{
     const luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{const c=v/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
     const background=getComputedStyle(document.querySelector('.company-account-opening')).backgroundColor;
     return es.map(e=>{const foreground=getComputedStyle(e).color,a=luminance(foreground),b=luminance(background);return {foreground,background,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
    });
    assert.ok(contrasts.length>0&&contrasts.every(c=>c.ratio>=4.5),JSON.stringify(contrasts));
    await page.screenshot({path:`${out}/${engine}-${language}-${width}-${scenario}.png`,fullPage:true});
    await page.getByRole('button',{name:await tr(button),exact:true}).click();
    await page.getByText('F-2026-0012',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__companyGateQa.loads),1);
    results.push({engine,language,width,theme,scenario,contrasts,passed:true});
   }
   await page.addInitScript(({language,theme})=>{localStorage.setItem('zentra.interface.language.v1',language);localStorage.setItem('zentra.appearance.v1',theme);},{language,theme});
   await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=activity`);
   await page.getByRole('button',{name:await tr('Aller à un écran'),exact:true}).waitFor();
   const later=page.getByRole('button',{name:await tr('Découvrir plus tard'),exact:true});if(await later.isVisible())await later.click();
   await page.getByRole('button',{name:await tr('Aller à un écran'),exact:true}).click();
   await page.getByRole('searchbox').fill(await tr('Projets'));
   await page.locator('.navigation-palette__results button').filter({has:page.getByText(await tr('Projets'),{exact:true})}).click();
   const select=page.locator('#project-status-filter');await select.waitFor();
   const expectedStatuses=['Planifiés','En cours','En pause','Terminés','Clôturés'];
   const options=await select.locator('option').allTextContents();
   assert.equal(options[0],await tr('Tous les projets ({count})',{count:2}));
   for(let i=0;i<expectedStatuses.length;i++)assert.ok(options[i+1].startsWith(await tr(expectedStatuses[i])),options[i+1]);
   await page.getByRole('button',{name:await tr('Ouvrir le dossier'),exact:true}).first().waitFor();
   await page.getByRole('button',{name:'Rénovation · Résidence Bellevue',exact:true}).waitFor();
   await select.selectOption('completed');
   await page.getByText(await tr('{count} projets affichés',{count:0}),{exact:true}).waitFor();
   await page.getByText(await tr('Modifiez votre recherche ou l’état sélectionné pour retrouver un projet.'),{exact:true}).waitFor();
   await page.getByRole('button',{name:await tr('Tous les états'),exact:true}).click();
   await page.getByText(await tr('{count} projets affichés',{count:2}),{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   if(language!=='fr') {
    const text=await page.locator('.project-collection').innerText();
    for(const untranslated of ['Vue d’ensemble','Tâches & jalons','État du projet','Ouvrir le dossier','Modifier','projets affichés'])assert.equal(text.includes(untranslated),false,untranslated);
   }
   await page.screenshot({path:`${out}/${engine}-${language}-${width}-projects.png`,fullPage:true});
   assert.deepEqual(errors,[]);results.push({engine,language,width,theme,scenario:'projects',passed:true});await page.close();
  }
  for(const lateFailure of [false,true]) {
   const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
   await page.goto(`${origin}/tests/company-account-harness.html?scenario=race`);
   await page.getByRole('button',{name:'Ouvrir l’espace du compte',exact:true}).click();
   await page.waitForFunction(()=>window.__companyGateQa.pending().includes('windows:open'));
   await page.evaluate(()=>window.__companyGateQa.switchAccount('mac'));
   await page.waitForFunction(()=>window.__companyGateQa.pending().includes('mac:auto'));
   assert.equal(await page.getByRole('button',{name:'Ouvrir l’espace du compte',exact:true}).count(),0);
   await page.evaluate(fail=>window.__companyGateQa.release('windows:open',fail),lateFailure);
   await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>window.__companyGateQa.loads),0);
   assert.equal(await page.getByText('Ancienne erreur',{exact:true}).count(),0);
   await page.evaluate(()=>window.__companyGateQa.release('mac:auto'));
   await page.getByRole('button',{name:'Relier cette entreprise à mon compte',exact:true}).waitFor();
   await page.getByText('Atelier Mac',{exact:true}).waitFor();
   await page.getByRole('button',{name:'Relier cette entreprise à mon compte',exact:true}).click();
   await page.getByText('F-2026-0012',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>window.__companyGateQa.loads),1);
   results.push({engine,scenario:lateFailure?'late-error':'late-response',passed:true});await page.close();
  }
  const page=await browser.newPage({viewport:{width:320,height:740}});
  await page.goto(`${origin}/tests/company-account-harness.html?scenario=old&role=read_only&language=de&theme=dark&long`);
  const readOnlyLabel=await page.evaluate(async()=>(await import('/src/language.ts')).t('Lecture seule'));
  await page.getByText(readOnlyLabel,{exact:true}).waitFor();
  const [openLabel,publishLabel]=await page.evaluate(async()=>{const {t}=await import('/src/language.ts');return [t('Ouvrir l’espace du compte'),t('Relier cette entreprise à mon compte')];});
  await page.getByRole('button',{name:openLabel,exact:true}).waitFor();
  await page.evaluate(async()=>(await import('/src/textSize.ts')).setTextSize(200));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  const actions=await page.locator('.company-account-opening button').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {height:r.height,left:r.left,right:r.right};}));
  assert.ok(actions.every(r=>r.height>=44&&r.left>=0&&r.right<=320),JSON.stringify(actions));
  await page.screenshot({path:`${out}/${engine}-read-only-200.png`,fullPage:true});
  assert.equal(await page.getByRole('button',{name:publishLabel,exact:true}).count(),0);
  await page.getByRole('button',{name:openLabel,exact:true}).click();
  await page.getByText('F-2026-0012',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__companyGateQa.loads),1);
  results.push({engine,scenario:'read-only-200',passed:true});await page.close();
 } finally {await browser.close();}
}
await writeFile(`${out}/proof.json`,JSON.stringify(results,null,2));console.log(JSON.stringify({passed:results.length}));
