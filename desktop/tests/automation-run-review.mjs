import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)('C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin='http://127.0.0.1:5359', out='.qa/automation-run-review';
await mkdir(out,{recursive:true});const checks=[];
const labels={fr:['Date non disponible','Confirmer les actions','Annuler la suite'],de:['Datum nicht verfügbar','Aktionen bestätigen','Weitere Schritte abbrechen'],it:['Data non disponibile','Conferma azioni','Annulla i passaggi successivi'],en:['Date unavailable','Confirm actions','Cancel remaining steps']};
for(const engine of ['chromium','webkit']){
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
 try{for(const language of ['fr','de','it','en'])for(const theme of ['light','dark']){
  const width=engine==='chromium'?1440:['fr','de'].includes(language)?320:390;
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
  const url=`${origin}/tests/automation-run-review.html?language=${language}&theme=${theme}`;
  await page.goto(url);await page.locator('.ac-run>summary').click();await page.locator('.ac-source>summary').click();
  await page.getByText(labels[language][0],{exact:true}).waitFor();
  const confirm=page.getByRole('button',{name:labels[language][1],exact:true});assert.ok(await confirm.isDisabled());
  await page.locator('input[type="radio"][value="yes"]').check();await confirm.click();
  assert.deepEqual(await page.evaluate(()=>window.__runActions),[{action:'workflow_confirm',id:'fixture-run',revision:7,choice:'yes'}]);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
  const targets=await page.locator('.ac-actions button, .ac-run__choice label').evaluateAll(nodes=>nodes.map(el=>({text:el.textContent.trim(),height:el.getBoundingClientRect().height})));
  assert.equal(overflow,false,'Horizontal overflow');assert.ok(targets.every(t=>t.height>=(engine==='webkit'?44:40)),JSON.stringify(targets));
  if(language==='de'&&engine==='webkit'){
   await page.locator('.ac-run, .ac-run *').evaluateAll(nodes=>{const sizes=nodes.map(el=>parseFloat(getComputedStyle(el).fontSize));nodes.forEach((el,index)=>{el.style.fontSize=`${sizes[index]*2}px`;});});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Large text overflow');
  }
  await page.screenshot({path:`${out}/${engine}-${width}-${language}-${theme}.png`,fullPage:true});
  await page.getByRole('button',{name:labels[language][2],exact:true}).click();
  assert.deepEqual((await page.evaluate(()=>window.__runActions)).at(-1),{action:'workflow_cancel',id:'fixture-run',revision:7});
  await page.goto(url+'&role=reader');await page.locator('.ac-run>summary').click();
  assert.equal(await page.locator('.ac-actions').count(),0);
  await page.goto(url+'&busy=1');await page.locator('.ac-run>summary').click();
  assert.ok(await page.getByRole('button',{name:labels[language][1],exact:true}).isDisabled());
  assert.ok(await page.getByRole('button',{name:labels[language][2],exact:true}).isDisabled());
  assert.deepEqual(errors,[]);checks.push({engine,width,language,theme,noOverflow:true,permissionPreserved:true,revisionAndDecisionPreserved:true,targets});await page.close();
 }}finally{await browser.close();}
}
await writeFile(`${out}/proof.json`,JSON.stringify(checks,null,2));console.log(JSON.stringify({scenarios:checks.length,output:out}));
