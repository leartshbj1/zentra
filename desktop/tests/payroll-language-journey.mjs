import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine=process.env.ZENTRA_QA_ENGINE||'chromium';
const {[engine]:driver}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const browser=await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const out=`.qa/payroll-language-${engine}`,report=[];await mkdir(out,{recursive:true});
const names={fr:'Français',de:'Deutsch',it:'Italiano',en:'English'};
const copy={fr:{written:'confirmation écrite',required:'obligatoire',date:'Début de validité',missing:'Complétez ce champ',hour:'Calculer le salaire avec les heures travaillées',help:'Confirmez la date du choix de cotisation'},de:{written:'schriftlichen Bestätigung',required:'erforderlich',date:'Gültig ab',missing:'Füllen Sie dieses Feld',hour:'Lohn aus den Arbeitsstunden berechnen',help:'Bestätigen Sie das Datum der Beitragswahl'},it:{written:'conferma scritta',required:'obbligatorio',date:'Inizio validità',missing:'Compila questo campo',hour:'Calcola il salario dalle ore lavorate',help:'Conferma la data della scelta contributiva'},en:{written:'written confirmation',required:'required',date:'Valid from',missing:'Complete this field',hour:'Calculate pay from hours worked',help:'Confirm the date of the contribution choice'}};
async function geometry(page){
 const issues=await page.evaluate(()=>{
   const result=[];
   if(document.documentElement.scrollWidth>innerWidth+1)result.push('page');
   for(const node of document.querySelectorAll('.payroll-dialog,.modal__body,.payroll-preparation,.payroll-hourly,.payroll-pension-pair,.payroll-problem,.payroll-field-guide,.payroll-inline-error,h3,h4,summary,.button,.field__label')){
     if(!node.getBoundingClientRect().width)continue;
     if(node.clientWidth&&node.scrollWidth>node.clientWidth+2)result.push(`${node.className||node.tagName}: ${node.textContent.trim().slice(0,70)}`);
   }
   for(const marker of document.querySelectorAll('.field__label em')){
     if(!marker.getBoundingClientRect().width)continue;
     const range=document.createRange();range.selectNodeContents(marker);
     const lines=new Set([...range.getClientRects()].map(rect=>Math.round(rect.top)));
     if(lines.size>1)result.push(`Required marker wraps: ${marker.textContent}`);
   }
   return result;
 });assert.deepEqual(issues,[]);
}
async function language(page,value){await page.getByRole('button',{name:names[value],exact:true}).click();await page.waitForFunction(value=>document.documentElement.lang===`${value}-CH`,value);}
try{
 for(const [width,height] of [[320,568],[390,844],[844,390],[1440,1000]])for(const selected of ['fr','de','it','en']){
  const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
  try{
   await page.addInitScript(value=>localStorage.setItem('zentra.interface.language.v1',value),selected);
   await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271'}/tests/payroll-language.html`);
   await page.locator('[data-check]').click();
   await page.waitForFunction(()=>document.activeElement?.getAttribute('name')==='decisionDate');
   assert.equal(await page.locator('[data-date-details]').getAttribute('open'),'');
   const guide=page.locator('section.payroll-field-guide');
   assert.match(await guide.innerText(),new RegExp(copy[selected].written));
   assert.match(await guide.locator('strong').innerText(),new RegExp(copy[selected].date));
   assert.ok(!(await guide.locator('strong').innerText()).includes(copy[selected].required));
   const raw=await page.locator('[data-raw]').textContent();
   const alternate=selected==='en'?'de':'en';await language(page,alternate);
   assert.match(await guide.innerText(),new RegExp(copy[alternate].written));
   assert.match(await guide.locator('strong').innerText(),new RegExp(copy[alternate].date));
   assert.equal(await page.locator('[data-raw]').textContent(),raw);
   assert.equal(await page.locator('[name=decisionDate]').inputValue(),'2025-12-31');
   assert.equal(await page.locator('[name=notes]').inputValue(),'Note employeur {field}\nConditions conservées');
   await language(page,selected);await geometry(page);await guide.locator('button').click();
   if(width===320)await page.screenshot({path:`${out}/${selected}-date.png`});
   await page.locator('[name=decisionDate]').fill('2026-09-01');await guide.waitFor({state:'hidden'});
   assert.equal(await page.locator('[name=decisionDate]').getAttribute('aria-describedby'),'qa-date-hint');
   assert.equal(await page.locator('[name=decisionDate]').getAttribute('aria-invalid'),null);
   await page.locator('[name=email]').fill('incomplet');await page.locator('[data-check]').click();
   assert.ok((await guide.innerText()).includes(selected==='fr'?'facultatif':selected==='de'?'freiwillige':selected==='it'?'facoltativo':'optional'));
   await page.locator('[name=email]').fill('');await page.locator('[data-check]').click();await page.locator('[data-done]').waitFor();
   for(const scenario of ['problems','preparation']){
     await page.locator(`[data-scenario=${scenario}]`).click();
     const container=page.locator(scenario==='problems'?'.payroll-problems':'.payroll-preparation');
     assert.ok((await container.innerText()).includes(copy[selected].help));
     await container.locator('details').evaluateAll(nodes=>nodes.forEach(node=>node.open=true));
     await geometry(page);
     await language(page,alternate);
     assert.equal(await container.locator('details:not([open])').count(),0,'Language must not remount open guidance');
     await language(page,selected);
     await container.locator(scenario==='problems'?'.payroll-problem .button':'.payroll-preparation__next > .button').first().click();
     assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-destination'))),{target:'history',selector:'[name=decisionDate]'});
     await page.waitForFunction(()=>document.activeElement?.getAttribute('name')==='decisionDate');
   }
   await page.locator('[data-scenario=hourly]').click();const hourly=page.locator('.payroll-hourly');
   assert.ok((await hourly.innerText()).includes(copy[selected].hour));await hourly.locator('button').click();
   assert.equal(await hourly.getByRole('alert').count(),2);
   await hourly.locator('input').nth(0).fill('152,50');await hourly.locator('input').nth(1).fill('30,25');
   await language(page,alternate);assert.equal(await hourly.locator('input').nth(0).inputValue(),'152,50');await language(page,selected);
   await geometry(page);await hourly.locator('button').click();
   assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-hourly'))),{cents:461313,label:'Salaire horaire · 152,50 h × 30,25 CHF'});
   await page.locator('[data-scenario=basis]').click();const basis=page.locator('.payroll-basis-guide');
   await basis.locator('button[type=submit]').click();await basis.getByRole('alert').waitFor();
   await basis.locator('input').fill('5000,25');await language(page,alternate);assert.equal(await basis.locator('input').inputValue(),'5000,25');await language(page,selected);
   await basis.locator('details').evaluate(node=>node.open=true);assert.ok((await basis.innerText()).includes('Contrat assuré {name}'));
   await geometry(page);await basis.locator('button[type=submit]').click();
   assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-basis'))),{basisCents:500025});
   await page.locator('[data-scenario=pension]').click();const pension=page.locator('.payroll-pension-pair');
   await pension.locator('button[type=submit]').click();assert.ok((await pension.locator('section.payroll-field-guide').innerText()).includes(copy[selected].missing));
   await pension.locator('[name=employee]').fill('250.25');await pension.locator('[name=employer]').fill('280.50');await pension.locator('[name=component]').selectOption('combined');await pension.locator('input[type=checkbox]').check();
   await pension.locator('details').evaluate(node=>node.open=true);await geometry(page);
   if(width===320)await page.screenshot({path:`${out}/${selected}-pension.png`});
   await page.evaluate(()=>sessionStorage.setItem('qa-refuse-employer','1'));await pension.locator('button[type=submit]').click();await pension.locator('p[role=alert]').waitFor();
   const partial=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-pension-saved')));assert.equal(partial.length,1);
   await language(page,alternate);assert.equal(await pension.locator('[name=employee]').inputValue(),'250.25');await language(page,selected);
   await page.evaluate(()=>sessionStorage.removeItem('qa-refuse-employer'));await pension.locator('button[type=submit]').click();await pension.locator('p[role=alert]').waitFor({state:'hidden'});
   const saved=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-pension-saved')));assert.equal(saved.length,2);assert.equal(saved[0].id,partial[0].id);assert.deepEqual(saved.map(row=>row.fixedAmountCents),[25025,28050]);assert.ok(saved.every(row=>row.source==='Règlement de test {name} 2026'));
   assert.deepEqual(errors,[]);report.push({selected,width,height,fieldGuidance:true,languageKeepsDraft:true,rawRoutingPreserved:true,hourlyExact:true,basisExact:true,pensionRetryWithoutDuplicate:true,noClipping:true});console.log(`${engine} ${selected} ${width}: passed`);
  }catch(error){await page.screenshot({path:`${out}/${selected}-${width}-failure.png`});throw error;}finally{await page.close();}
 }
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();}
