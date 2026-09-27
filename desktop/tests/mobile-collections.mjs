import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const out=process.env.ZENTRA_QA_OUTPUT||'.impeccable/review/mobile-collections';
await mkdir(out,{recursive:true});
const results=[];
for(const config of [
  {engine:'webkit',width:320,lang:'de',theme:'light'},
  {engine:'webkit',width:390,lang:'fr',theme:'dark'},
  {engine:'edge',width:768,lang:'it',theme:'light'},
  {engine:'edge',width:1440,lang:'en',theme:'dark'},
  {engine:'webkit',width:320,lang:'de',theme:'dark',textSize:200,long:true},
]){
  const browser=await(config.engine==='edge'?chromium:webkit).launch(config.engine==='edge'?{channel:'msedge'}:{});
  const page=await browser.newPage({viewport:{width:config.width,height:844},hasTouch:true,reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const result={...config,views:[],errors};results.push(result);
  const tr=source=>page.evaluate(async source=>(await import('/src/language.ts')).t(source),source);
  try{
    await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
    await page.addInitScript(size=>{localStorage.setItem('elyko-guided-tour-v3','completed');localStorage.setItem('zentra.text-size.v1',String(size));},config.textSize||100);
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=active&collectionTest=1${config.long?'&collectionLong=1':''}&language=${config.lang}&theme=${config.theme}`);
    await page.locator('.desktop-app').waitFor();
    const later=page.getByRole('button',{name:await tr('Découvrir plus tard'),exact:true});if(await later.isVisible())await later.click();
    for(const view of ['invoices','quotes','clients','projects']){
      await page.evaluate(view=>window.dispatchEvent(new CustomEvent('zentra-automation-navigate',{detail:view})),view);
      await page.locator(`.desktop-app[data-view=${view}]`).waitFor();
      await page.evaluate(()=>window.scrollTo(0,0));
      const list=view==='clients'?(config.width<=860?'.client-mobile-list > li':'.client-directory table tbody tr'):view==='projects'?'.project-card-grid > article':'.sales-documents table tbody tr';
      await page.locator(list).first().waitFor();
      if(config.width<=860&&(view==='invoices'||view==='quotes'))await page.locator('.sales-documents table[data-mobile-cards] td[data-label]').first().waitFor();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const metrics=await page.evaluate(({list,view})=>{
        const rows=[...document.querySelectorAll(list)].map(e=>{const r=e.getBoundingClientRect();return {top:r.top,height:r.height,bottom:r.bottom};});
        const bounds=[...document.querySelectorAll('.page-header button,.page-header summary')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {label:e.textContent.trim()||e.getAttribute('aria-label'),x:r.x,y:r.y,width:r.width,height:r.height};});
        const overflow=[...document.querySelectorAll('.page-content button,.page-content summary,.page-content input,.page-content select')].filter(e=>!e.closest('details:not([open]) .mobile-details__content') && e.getClientRects().length && getComputedStyle(e).visibility!=='hidden' && (e.getBoundingClientRect().right>innerWidth+1||e.getBoundingClientRect().left< -1)).map(e=>e.textContent.slice(0,120));
        return {view,rows,bounds,overflow,documentOverflow:document.documentElement.scrollWidth>innerWidth+1};
      },{list,view});
      result.views.push(metrics);
      await page.screenshot({path:`${out}/${config.engine}-${config.width}-${config.theme}-${config.lang}-${view}.png`});
      assert.equal(metrics.documentOverflow,false,`${view}: document overflow`);
      assert.deepEqual(metrics.overflow,[],`${view}: control overflow`);
      if(config.width<=860){
        for(const b of metrics.bounds)assert.ok(b.width>=43.9&&b.height>=43.9,`${view}: touch target ${JSON.stringify(b)}`);
        const help=metrics.bounds.find(b=>b.label?.includes('guide')||b.label?.includes('Hilfe'));
        if(help)for(const b of metrics.bounds.filter(b=>b!==help))assert.ok(!(help.x<b.x+b.width&&help.x+help.width>b.x&&help.y<b.y+b.height&&help.y+help.height>b.y),`${view}: overlapping help`);
      }
      if(view==='invoices'||view==='quotes'){
        const toggle=page.locator('.document-list-tools__compact button');
        if(config.width<=860)await toggle.click();
        const field=page.locator('.document-list-search input');
        if(config.width<=860){
          await field.fill('Aménagement');assert.equal(await page.locator(list).count(),1);
          await field.fill('no-matching-document-qa');assert.equal(await page.locator(list).count(),0);
          await field.fill('');await page.keyboard.press('Escape');assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.ok(await toggle.evaluate(e=>e===document.activeElement));
          const actions=page.locator('.document-actions--compact .mobile-details').first();
          await actions.locator('summary').click();assert.ok(await actions.locator('.mobile-document-metadata').isVisible());
          await actions.locator('summary').click();
        }
        metrics.filterJourney=true;
      }else if(view==='clients'){
        if(config.width<=860){
          const details=page.locator('.client-mobile-list .mobile-details').first();await details.locator('summary').click();
          assert.match(await details.innerText(),config.long?/entreprise-de-demonstration.example.invalid/:/camille@example.invalid/);assert.match(await details.innerText(),/1009 Pully/);
          assert.equal(await details.locator('.row-actions button').count(),3);
          await page.evaluate(()=>window.__qaSetReadOnly(true));
          await page.waitForFunction(()=>document.querySelector('.client-mobile-list .row-actions button:nth-child(2)')?.disabled===true);
          assert.equal(await details.locator('.row-actions button').nth(2).isDisabled(),true);
          assert.equal(await details.locator('.row-actions button').first().isDisabled(),false);
          await page.evaluate(()=>window.__qaSetReadOnly(false));
          await details.locator('summary').click();
          await page.locator('.client-mobile-list__open').first().click();
        }else await page.locator('.client-directory .row-actions button').first().click();
        await page.locator('.modal').waitFor();assert.match(await page.locator('.modal').innerText(),config.long?/espaces professionnels du Léman/:/Résidence Bellevue/);
        await page.keyboard.press('Escape');await page.locator('.modal').waitFor({state:'hidden'});metrics.clientJourney=true;
        await page.locator('.client-directory-toolbar button').nth(1).click();
        assert.equal(await page.locator(list).count(),1);
        assert.match(await page.locator(list).innerText(),/Ancien client de recette/);
        if(config.width<=860){await page.locator('.client-mobile-list summary').click();assert.ok(await page.locator('.client-mobile-list .row-actions button').nth(1).isVisible());}
        metrics.archiveJourney=true;
      }else{
        if(config.width<=860){const details=page.locator('.project-card .mobile-details').first();await details.locator('summary').click();assert.equal(await details.locator('footer button').count(),3);await details.locator('summary').click();}
        await page.locator('.project-name-link').first().click();
        await page.locator('.project-folder').waitFor();metrics.projectJourney=true;
      }
    }
    assert.deepEqual(errors,[]);
  }catch(e){result.failure=String(e);await page.screenshot({path:`${out}/${config.width}-failure.png`});}
  finally{await browser.close();}
}
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
if(results.some(r=>r.failure))process.exitCode=1;
