import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const stage=process.env.ZENTRA_QA_STAGE||'before';
const output=`.qa/large-directories/${stage}`;await mkdir(output,{recursive:true});
const proof=[];
async function text(page,message){return page.evaluate(async message=>(await import('/src/language.ts')).t(message),message);}
async function navigate(page,title){
 title=await text(page,title);
 await page.getByRole('button',{name:await text(page,'Aller à un écran'),exact:true}).click();
 await page.getByRole('searchbox',{name:await text(page,'Rechercher un écran')}).fill(title);
 await page.evaluate(()=>{window.__runtimeCommits.length=0;document.addEventListener('click',()=>window.__directoryStart=performance.now(),{once:true,capture:true});});
 await page.locator('.navigation-palette__results button').filter({has:page.getByText(title,{exact:true})}).click();
}
const cases=[['chromium',1440,'fr'],['chromium',390,'fr'],['webkit',390,'fr']];
if(stage==='after')cases.push(['webkit',320,'de'],['webkit',390,'it'],['chromium',768,'en']);
for(const [engine,width,language] of cases){
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
 try{
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(60000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
  await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&emptyScreens=1&runtimePerformance=1&language=${language}&theme=${width===390?'dark':'light'}`);
  await page.waitForFunction(()=>!!window.__emptyScreensPatch);
  await page.evaluate(async()=>{
   const base=await window.__qaDesktopApi.loadWorkspace();
   const clients=Array.from({length:2200},(_,i)=>({id:'large-c-'+i,name:'Personne '+String(i+1).padStart(4,'0'),company:'Entreprise '+String(i+1).padStart(4,'0'),email:`client-${i}@example.invalid`,phone:'021 000 00 00',address:'Rue de recette 12, 1000 Lausanne',notes:'',archivedAt:i>=2000?'2026-01-01':null}));
   const projects=Array.from({length:2000},(_,i)=>({...base.projects[0],id:'large-p-'+i,clientId:clients[i].id,name:'Projet '+String(i+1).padStart(4,'0'),address:'Rue de recette 12, Lausanne',status:i%2?'planned':'in_progress'}));
   const invoices=Array.from({length:4000},(_,i)=>({...base.invoices[0],id:'large-i-'+i,clientId:clients[i%2000].id,projectId:projects[i%2000].id,status:'issued',number:'F-RECETTE-'+i}));
   window.__largeFixture={clients,projects,invoices};
   window.__emptyScreensPatch({...base,clients,projects,invoices,activeTimer:null,payments:[],timeEntries:[],expenses:[],supplierInvoices:[],supplierCreditNotes:[],projectTasks:[]});
  });
  for(const [screen,selector] of [['Clients','.table-panel tbody tr'],['Projets','.project-card']]){
   await navigate(page,screen);await page.locator(selector).first().waitFor();
   const metrics=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({paintMs:performance.now()-window.__directoryStart,renderMs:window.__runtimeCommits.reduce((sum,c)=>sum+c.duration,0),nodes:document.querySelectorAll('*').length,overflow:document.documentElement.scrollWidth>innerWidth+1})))));
   metrics.rows=await page.locator(selector).count();
   await page.screenshot({path:`${output}/${engine}-${width}-${language}-${screen}.png`});
   assert.equal(metrics.overflow,false);assert.deepEqual(errors,[]);
   if(stage==='after'){
    assert.equal(metrics.rows,screen==='Clients'?25:12);
    const pager=page.locator('.collection-pagination').first();
    const range=`1–${screen==='Clients'?25:12} ${{fr:'sur',de:'von',it:'di',en:'of'}[language]} 2000`;
    assert.equal(await pager.getByRole('status').innerText(),range);
    if(screen==='Clients')assert.equal(await page.locator('.table-panel th').nth(3).textContent(),await text(page,'Projets'));
    const next=pager.getByRole('button',{name:await text(page,'Page suivante'),exact:true});
    await next.focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.activeElement?.classList.contains('collection-page-start'));
    assert.ok((await page.locator(selector).first().innerText()).includes(screen==='Clients'?'0026':'0013'));
    const search=page.locator('input[type="search"]').filter({visible:true}).first();
    await search.fill(screen==='Clients'?'Entreprise 1999':'Projet 1999');
    await page.waitForFunction(selector=>document.querySelectorAll(selector).length===1,selector);
    assert.ok((await page.locator(selector).innerText()).includes('1999'));
    assert.equal(await page.locator('.collection-pagination').count(),0);
    if(screen==='Clients'){
     await page.getByRole('button',{name:await text(page,'Dossier'),exact:true}).click();
     await page.getByRole('dialog').waitFor();
     await page.waitForFunction(()=>document.querySelector('[role="dialog"]')?.contains(document.activeElement));
     await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
    }else{
     await page.getByRole('button',{name:'Projet 1999',exact:true}).click();
     await page.locator('.project-folder').waitFor();
     await page.locator('.project-folder').getByRole('button').first().click();
    }
    await search.fill('');
    await page.waitForFunction(selector=>document.querySelectorAll(selector).length>1,selector);
    assert.ok((await page.locator(selector).first().innerText()).includes('0001'));
    if(screen==='Clients'){
     await page.locator('.client-directory-toolbar button').nth(1).click();
     assert.ok((await page.locator(selector).first().innerText()).includes('2001'));
     assert.ok((await page.locator('.collection-pagination').first().innerText()).includes('200'));
     await page.locator('.client-directory-toolbar button').first().click();
    }else{
     await page.locator('#project-status-filter').selectOption('planned');
     assert.ok((await page.locator(selector).first().innerText()).includes('0002'));
     assert.ok((await page.locator('.collection-pagination').first().innerText()).includes('1000'));
     await page.locator('#project-status-filter').selectOption('all');
    }
    // A sync deletes the final page while it is selected; a later refresh must not resurrect it.
    await page.locator('.collection-pagination').first().getByRole('button',{name:await text(page,'Page suivante'),exact:true}).click();
    await page.evaluate(screen=>window.__emptyScreensPatch(screen==='Clients'?{clients:window.__largeFixture.clients.slice(0,2)}:{projects:window.__largeFixture.projects.slice(0,2)}),screen);
    await page.waitForFunction(selector=>document.querySelectorAll(selector).length===2,selector);
    await page.evaluate(screen=>window.__emptyScreensPatch(screen==='Clients'?{clients:window.__largeFixture.clients}:{projects:window.__largeFixture.projects}),screen);
    await page.waitForFunction(selector=>document.querySelectorAll(selector).length>2,selector);
    assert.ok((await page.locator(selector).first().innerText()).includes('0001'));
    if(language==='fr'&&width===390){
     await page.evaluate(()=>window.__qaSetReadOnly(true));
     await page.waitForFunction(selector=>document.querySelector(selector)?.querySelectorAll('button:disabled').length===2,selector);
     assert.equal(await page.locator(selector).first().locator('button:disabled').count(),2);
     assert.equal(await page.locator('.collection-pagination').first().getByRole('button',{name:'Page suivante',exact:true}).isEnabled(),true);
     await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
     await page.screenshot({path:`${output}/${engine}-${width}-${screen}-readonly.png`});
     await page.evaluate(()=>window.__qaSetReadOnly(false));
    }
    await search.fill('Aucun résultat fictif 0000');
    await page.waitForFunction(selector=>document.querySelectorAll(selector).length===0,selector);
    assert.equal(await page.locator('.collection-pagination').count(),0);
    await search.fill('');
    await page.waitForFunction(selector=>document.querySelectorAll(selector).length>1,selector);
    assert.deepEqual(errors,[]);
   }
   proof.push({engine,width,language,screen,...metrics,fullSearchAndPaging:stage==='after'});
   console.log(JSON.stringify({checked:screen,engine,width,language}));
  }
 }finally{await browser.close();}
}
await writeFile(`${output}/proof.json`,JSON.stringify({scope:'Synthetic workspace; local development build, no physical device or network timing',counts:{clients:2200,projects:2000,invoices:4000},proof},null,2));console.log(JSON.stringify(proof));
