import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const fixtures=process.env.ZENTRA_DESIGN_PDF_FIXTURES||'.qa/composition-pdfs';
const largeText=process.env.ZENTRA_QA_LARGE_TEXT==='1';
const output=largeText?'.qa/document-settings-large-text':'.qa/document-settings-mobile';await mkdir(output,{recursive:true});const proof=[];
for(const engine of ['chromium','webkit']){
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
 try{for(const width of (largeText?[320]:[320,390,1440])) for(const language of (largeText?['de','en']:['fr','de','it','en'])){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(20000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async r=>{
   const url=r.request().url();
   if(url.startsWith(`${origin}/native-design-fixture/`)){const file=url.split('/').at(-1);assert.match(file,/^(quotes|invoices|accounts|payslips)-(signature|minimal|helvetica|times|courier)\.pdf$/);return r.fulfill({contentType:'application/pdf',body:await readFile(`${fixtures}/${file}`)});}
   return url.startsWith(origin)||url.startsWith('data:')?r.continue():r.abort();
  });
  try{
   await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
   await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&language=${language}&theme=${width===390?'light':'dark'}`);
   await page.locator(width<=860?'.mobile-home__balance':'.workspace-finances').waitFor();
   if(largeText)await page.evaluate(async()=>{(await import('/src/textSize.ts')).setTextSize(200);});
   const copy=await page.evaluate(async()=>{const {t}=await import('/src/language.ts');return Object.fromEntries(['Aller à un écran','Rechercher un écran','Paramètres','Mon document','Mes réglages','Fournisseurs','Réessayer la vérification','Ajouter {count} fournisseurs'].map(s=>[s,t(s,{count:1})]));});
   await page.evaluate(async()=>{
    const {desktopApi}=await import('/src/bridge.ts');
    desktopApi.documentDesignExample=async input=>[...new Uint8Array(await (await fetch(`/native-design-fixture/${input.kind}-${input.style.composition?.fontFamily||input.style.layout}.pdf`)).arrayBuffer())];
    window.__TAURI_INTERNALS__ ||= {invoke:async()=>{throw new Error('Unavailable in isolated fixture');}};
    const old=window.__TAURI_INTERNALS__.invoke;window.__settingsQa={fail:true,scopeCalls:0,imports:[]};
    window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
     if(command==='bexio_import_scope'){window.__settingsQa.scopeCalls++;if(window.__settingsQa.fail)throw new Error('Synthetic scope failure');return 'qa-only-company';}
     if(command==='import_bexio_contacts'){window.__settingsQa.imports.push(args);return {created:args.input.rows.length,skipped:0,rows:[]};}
     return old(command,args);
    };
   });
   await page.getByRole('button',{name:copy['Aller à un écran'],exact:true}).click();
   await page.getByRole('searchbox',{name:copy['Rechercher un écran']}).fill(copy.Paramètres);
   await page.locator('.navigation-palette__results button').filter({has:page.getByText(copy.Paramètres,{exact:true})}).click();
   await page.locator('[data-settings-link="documents"]').click();
   await page.locator('.design-studio__preview[aria-busy=false] img').first().waitFor();
   const shot=async name=>{
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${engine}/${width}/${language}/${name} overflows`);
    const broken=await page.evaluate(()=>{
     const failures=[];
     for(const el of document.querySelectorAll('.design-studio__mobile-switch button,.bexio-import-choices button,.bexio-import-retry button')){
      if(!el.getClientRects().length)continue;const box=el.getBoundingClientRect();const walk=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
      while(walk.nextNode())for(const word of walk.currentNode.textContent.matchAll(/\S+/gu)){
       const range=document.createRange();range.setStart(walk.currentNode,word.index);range.setEnd(walk.currentNode,word.index+word[0].length);const rects=[...range.getClientRects()];
       if(rects.length>1||rects.some(r=>r.left<box.left-1||r.right>box.right+1||r.top<box.top-1||r.bottom>box.bottom+1))failures.push(word[0]);
      }
     }return failures;
    });
    assert.deepEqual(broken,[],`${engine}/${width}/${language}/${name} clipped or broken words`);
    if(name==='import-retry'){
     const gap=await page.evaluate(()=>document.querySelector('.bexio-import-choices').getBoundingClientRect().top-document.querySelector('.bexio-import-retry button').getBoundingClientRect().bottom);
     assert.ok(gap>=12,`Retry / choices overlap: ${gap}`);
    }
    if(language==='fr'||language==='de'||largeText)await page.screenshot({path:`${output}/${engine}-${width}-${language}-${name}.png`});
   };
   let previewTop=null;
   if(width<=900){
    assert.equal(await page.locator('.design-studio').getAttribute('data-mobile-view'),'preview');
    previewTop=await page.locator('.design-studio__pages img').first().evaluate(n=>n.getBoundingClientRect().top);
    if(!largeText)assert.ok(previewTop<740,`Preview too low: ${previewTop}`);
    assert.equal(await page.locator('.design-studio__tools').isVisible(),false);
    await page.locator('.design-studio__mobile-kind select').selectOption('quotes');
    await page.locator('.design-studio__preview[aria-busy=false] img').first().waitFor();
   }
   await shot('document');
   if(largeText){await page.locator('.design-studio__mobile-switch').evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await shot('document-switch');}
   if(width<=900)await page.getByRole('button',{name:copy['Mes réglages'],exact:true}).click();
   await page.locator('.design-studio__tools').waitFor();
   await page.getByLabel('Police du document',{exact:true}).selectOption('times');
   if(width<=900)await page.getByRole('button',{name:copy['Mon document'],exact:true}).click();
   await page.locator('.design-studio__preview[aria-busy=false] img').first().waitFor();
   if(width<=900)await page.getByRole('button',{name:copy['Mes réglages'],exact:true}).click();
   assert.equal(await page.getByLabel('Police du document',{exact:true}).inputValue(),'times');
   if(await page.locator('.settings-browser__back').isVisible())await page.locator('.settings-browser__back').click();
   await page.locator('[data-settings-link="migration"]').click();
   const supplier=page.locator('.bexio-import-choices button').nth(1);assert.equal(await supplier.innerText(),{fr:'Fournisseurs',de:'Lieferanten',it:'Fornitori',en:'Suppliers'}[language]);
   await supplier.click();
   // Changing category must not erase an unresolved scope error or enable import.
   await page.locator('.bexio-import-retry').waitFor();assert.equal(await page.locator('.bexio-import-file input').isDisabled(),true);
   await shot('import-retry');
   await page.evaluate(()=>window.__settingsQa.fail=false);
   await page.getByRole('button',{name:copy['Réessayer la vérification'],exact:true}).click();
   await page.waitForFunction(()=>!document.querySelector('.bexio-import-file input').disabled);
   const labelFits=await supplier.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return range.getClientRects().length===1;});assert.ok(labelFits,`Supplier word broken: ${language}/${width}`);
   await shot('import');
   await page.locator('.bexio-import-file input').setInputFiles({name:'suppliers.csv',mimeType:'text/csv',buffer:Buffer.from('Entreprise;E-mail;Rue;Code postal;Ville\nFournisseur Démo;factures@example.invalid;Rue du Lac;1000;Lausanne')});
   await page.getByRole('button',{name:copy['Ajouter {count} fournisseurs'],exact:true}).click();
   await page.locator('.bexio-import-receipt').waitFor();
   const sent=await page.evaluate(()=>window.__settingsQa.imports);
   assert.equal(sent.length,1);assert.equal(sent[0].input.entity,'suppliers');assert.equal(sent[0].input.scope,'qa-only-company');assert.equal(sent[0].input.rows[0].data.name,'Fournisseur Démo');
   assert.deepEqual(errors,[]);proof.push({engine,width,language,previewTop,draftPreserved:true,scopeRetry:true,supplierLabelFits:true,controlsWholeWords:true,retrySeparated:true,scopedImport:true,overflow:false});
  }catch(error){await page.screenshot({path:`${output}/FAILED-${engine}-${width}-${language}.png`});throw error;}finally{await page.close();}
 }}finally{await browser.close();}
}
await writeFile(`${output}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
