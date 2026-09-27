import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5357',out='.qa/financial-detail';await mkdir(out,{recursive:true});const proof=[];
for(const engine of ['chromium','webkit']) {
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
 try {for(const language of ['fr','de','it','en'])for(const width of [320,1440]) {
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
  await page.addInitScript(({language})=>{localStorage.setItem('elyko-guided-tour-v3','completed');localStorage.setItem('zentra.interface.language.v1',language);localStorage.setItem('zentra.appearance.v1',language==='de'?'dark':'light');},{language});
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&financialTest=1`);
  await page.locator(width===320?'.mobile-home':'.workspace-finances').waitFor();
  const tr=value=>page.evaluate(async value=>(await import('/src/language.ts')).t(value),value);
  const year=new Date().getFullYear();
  for(const metric of ['openCents','invoicedCents','paidCents','netCents']) {
   if(width===320) {
    if(metric==='openCents')await page.locator('.mobile-home__balance>.mobile-home__calculation-action').click();
    else if(metric==='netCents')await page.locator('.mobile-home__time').click();
    else {
     const summary=page.locator('.mobile-home__balance summary');if(!await page.locator('.mobile-home__balance details').getAttribute('open').then(v=>v!==null))await summary.click();
     await page.locator('.mobile-home__balance details').getByRole('button',{name:await tr(metric==='paidCents'?'Paiements reçus':'Factures émises · TTC'),exact:true}).click();
    }
   } else {
    const label=(await tr({invoicedCents:'Factures émises · TTC',paidCents:'Paiements reçus',openCents:'Reste à recevoir',netCents:'Chiffre d’affaires · {year}'}[metric])).replace('{year}',String(year));
    const metricButton=page.locator('button.metric-card').filter({has:page.getByText(label,{exact:true})});
    const accessible=await metricButton.getAttribute('aria-label');
    for(const amount of await metricButton.locator('strong b').allTextContents())assert.ok(accessible.includes(amount));
    assert.ok(accessible.includes(await metricButton.locator('small').innerText()));
    await metricButton.click();
   }
   const detail=page.getByRole('region',{name:await tr('Détail du calcul'),exact:true});await detail.waitFor();
   assert.equal(await detail.locator('h3').evaluate(el=>el===document.activeElement),true);
   const text=await detail.innerText();assert.ok(!text.includes('DRAFT'));assert.ok(!text.includes('CANCELLED'));
   const expected=metric==='openCents'?(width===320?['CURRENT']:['EUR','CURRENT']):metric==='paidCents'?['CURRENT','OLD']:metric==='netCents'?['EUR','CURRENT','CREDIT']:(width===320?['CURRENT','CREDIT','OLD']:['EUR','CURRENT','CREDIT','OLD']);
   const ids=await detail.locator('li .financial-detail__document>strong').allTextContents();assert.deepEqual(ids.map(value=>value.split(' · ')[0]),expected);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   if(metric==='openCents'||metric==='netCents') {
    if(width===320)await detail.evaluate(el=>{el.scrollIntoView({block:'start'});window.scrollBy(0,-80);});
    await page.screenshot({path:`${out}/${engine}-${language}-${width}-${metric}.png`,fullPage:false});
   }
   if(language==='de'&&width===320&&metric==='openCents') {
    await page.evaluate(async()=>(await import('/src/textSize.ts')).setTextSize(200));
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await detail.locator('h3').evaluate(el=>{el.scrollIntoView({block:'start'});window.scrollBy(0,-80);});
    await page.screenshot({path:`${out}/${engine}-de-320-200.png`,fullPage:false});
    await page.evaluate(async()=>(await import('/src/textSize.ts')).setTextSize(100));
   }
   await detail.getByRole('button',{name:await tr('Fermer le détail'),exact:true}).click();
   await detail.waitFor({state:'detached'});proof.push({engine,language,width,metric,passed:true});
  }
  if(width===1440) {
   const first=page.locator('button.metric-card').nth(0),second=page.locator('button.metric-card').nth(1);
   await first.focus();await page.keyboard.press('Enter');await page.locator('.financial-detail h3').waitFor();
   await second.focus();await page.keyboard.press('Enter');
   const detail=page.getByRole('region',{name:await tr('Détail du calcul'),exact:true});
   assert.equal(await second.getAttribute('aria-expanded'),'true');
   await detail.getByRole('button',{name:await tr('Fermer le détail'),exact:true}).focus();await page.keyboard.press('Enter');
   await detail.waitFor({state:'detached'});assert.equal(await second.evaluate(el=>el===document.activeElement),true);
   proof.push({engine,language,width,scenario:'switch-metric-keyboard-focus',passed:true});
  }
  // Invoice detail is opened without submitting any business mutation.
  await page.locator(width===320?'.mobile-home__balance>.mobile-home__calculation-action':'button.metric-card').first().click();
  await page.locator('.financial-detail li button').first().click();await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');assert.deepEqual(errors,[]);
  proof.push({engine,language,width,scenario:'open-invoice',passed:true});await page.close();
 }}finally{await browser.close();}
}
await writeFile(`${out}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:proof.length}));
