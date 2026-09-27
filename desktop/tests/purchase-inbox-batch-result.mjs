import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const output='.qa/purchase-inbox-batch-result';await mkdir(output,{recursive:true});const proof=[];
for(const [engine,width] of [['chromium',1440],['webkit',390]]){
  const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
  try{for(const lang of ['fr','de','it','en'])for(const scenario of ['complete','mixed']){
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
    await page.goto(`${origin}/tests/supplier-mailbox-batch.html?lang=${lang}&scenario=${scenario}&theme=${scenario==='mixed'?'dark':'light'}`);
    const tr=(source,values)=>page.evaluate(async({source,values})=>(await import('/src/language.ts')).t(source,values),{source,values});
    await page.getByRole('button',{name:await tr('Vérifier toutes les factures'),exact:true}).click();
    await page.getByText(await tr('Vérification terminée'),{exact:true}).waitFor();
    const summary=page.locator('.supplier-inbox__batch-summary');
    assert.ok((await summary.innerText()).includes(await tr('{count} brouillons à valider',{count:scenario==='mixed'?10:12})));
    assert.equal((await summary.innerText()).includes(await tr('{count} comptabilisées',{count:12})),false);
    if(scenario==='complete') {
      assert.equal(await page.getByText(await tr('Tout est à jour.'),{exact:true}).count(),0);
      await page.getByText(await tr('Aucune facture reçue en attente.'),{exact:true}).waitFor();
    }
    if(scenario==='mixed'){
      const detail=page.locator('.supplier-inbox__batch-attention');
      assert.ok((await detail.locator('summary').innerText()).includes(await tr('{count} à compléter',{count:2})));
      await detail.locator('summary').click();assert.equal(await detail.locator('li').count(),2);
      assert.equal(await detail.getByText(await tr('Fournisseur déjà renseigné'),{exact:true}).count(),1);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:`${output}/${engine}-${lang}-${scenario}.png`});
    assert.deepEqual(errors,[]);proof.push({engine,width,lang,scenario,drafts:scenario==='mixed'?10:12,exceptions:scenario==='mixed'?2:0,posted:0});await page.close();
  }}finally{await browser.close();}
}
await writeFile(`${output}/proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:proof.length}));
