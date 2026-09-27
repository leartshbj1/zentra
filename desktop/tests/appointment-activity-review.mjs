import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5359',out=process.env.ZENTRA_APPOINTMENT_OUTPUT||'.qa/appointment-activity-review';
await mkdir(out,{recursive:true});const proof=[];
const names={fr:['Rendez-vous','Date non disponible'],de:['Termine','Datum nicht verfügbar'],it:['Appuntamenti','Data non disponibile'],en:['Appointments','Date unavailable']};
const imported=page=>page.locator('.automation-journal__appointment').filter({hasText:'Visite technique'});
async function bounds(page){
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Horizontal overflow');
 const heights=await page.locator('.automation-journal__filters button,.automation-journal__appointment button').evaluateAll(nodes=>nodes.filter(el=>el.getBoundingClientRect().height).map(el=>({text:el.textContent.trim(),height:el.getBoundingClientRect().height})));
 assert.ok(heights.every(target=>target.height>=44),JSON.stringify(heights));return heights;
}
async function focusProof(page,id){
 await page.locator(`[data-event-id="${id}"]`).waitFor();
 await page.waitForFunction(id=>document.activeElement?.getAttribute('data-event-id')===id,id);
 assert.equal(await page.locator('.agenda-main-grid').getAttribute('data-display'),'day');
 assert.equal(await page.locator('[role="dialog"]').count(),0);
}
for(const engine of ['chromium','webkit']){
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
 try{for(const language of ['fr','de','it','en'])for(const theme of ['light','dark']){
  const width=engine==='chromium'?1440:['fr','de'].includes(language)?320:390;
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[],row={engine,width,language,theme};
  page.setDefaultTimeout(6500);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
  const url=`${origin}/tests/appointment-activity-review.html?language=${language}&theme=${theme}&size=${width<600?'small':'large'}`;
  try{
   await page.goto(url);await page.locator('.automation-journal__filters').getByRole('button',{name:names[language][0],exact:true}).click();
   assert.equal(await page.locator('.automation-journal__appointment').count(),3);
   const search=page.locator('.automation-journal__search input');await search.fill('Rue du Lac');assert.equal(await page.locator('.automation-journal__appointment').count(),2);await search.fill('');
   await imported(page).locator('summary').click();
   assert.match(await imported(page).innerText(),/2031.*09:30.*10:30/);
   row.targets=await bounds(page);
   if(engine==='webkit'&&language==='de'){
    await page.locator('.automation-journal,.automation-journal *').evaluateAll(nodes=>{const sizes=nodes.map(el=>parseFloat(getComputedStyle(el).fontSize));nodes.forEach((el,i)=>el.style.fontSize=`${sizes[i]*2}px`);});
    await bounds(page);row.text200=true;
   }
   await page.screenshot({path:`${out}/${engine}-${width}-${language}-${theme}-journal.png`,fullPage:true});
   await imported(page).locator('button').click();await focusProof(page,'appointment-imported');
   assert.equal(await page.locator('[data-event-id="appointment-cancelled"]').count(),0);
   await bounds(page);await page.screenshot({path:`${out}/${engine}-${width}-${language}-${theme}-agenda.png`,fullPage:true});
   await page.getByTestId('back').focus();await page.evaluate(()=>window.__appointmentQa.refresh());
   await page.waitForFunction(()=>window.__appointmentQa.revision===1);
   assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-testid')),'back','Background refresh must not steal focus');
   await page.getByTestId('back').click();const cancelled=page.locator('.automation-journal__appointment').filter({hasText:'Visite annulée'});
   await cancelled.locator('summary').click();await cancelled.locator('button').click();await focusProof(page,'appointment-cancelled');
   assert.equal(await page.locator('[data-event-id="appointment-cancelled"].is-closed').count(),1);
   await page.getByTestId('back').click();const pending=page.locator('.automation-journal__appointment').filter({hasText:'Visite à préciser'});
   await pending.locator('summary').click();assert.ok((await pending.innerText()).includes(names[language][1]));await pending.locator('button').click();await page.locator('.automation-appointments').waitFor();
   assert.ok((await page.locator('.automation-appointments').innerText()).includes(names[language][1]));await bounds(page);
   await page.getByTestId('back').click();await page.evaluate(()=>window.__appointmentQa.setOrg('company-b'));
   await page.waitForFunction(()=>document.querySelectorAll('.automation-journal__appointment').length===0);
   await page.goto(url+'&role=reader');await imported(page).locator('summary').click();await imported(page).locator('button').click();await focusProof(page,'appointment-imported');
   assert.equal(await page.locator('.agenda-row button:enabled').count(),0,'Read-only appointment must not become editable');
   const before=await page.locator('.agenda-row').evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
   await page.evaluate(theme=>window.__appointmentQa.setAppearance(theme==='light'?'dark':'light'),theme);
   await page.evaluate(theme=>window.__appointmentQa.setAppearance(theme),theme);
   assert.deepEqual(await page.locator('.agenda-row').evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color})),before,'Theme round trip');
   assert.deepEqual(errors,[]);row.passed=true;
  }catch(error){row.error=error.stack;await page.screenshot({path:`${out}/${engine}-${width}-${language}-${theme}-failure.png`,fullPage:true}).catch(()=>{});}
  proof.push(row);await page.close();
 }
 // The real WorkspaceApp supplies the organization and chooses the exact agenda target.
 for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),row={engine,width,integration:true},errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
  await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
  const url=`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=active&automationDesign=1&appointmentActivityAudit=1&theme=${width===390?'dark':'light'}`;
  try{
   await page.goto(url);await imported(page).locator('summary').click();await imported(page).locator('button').click();await focusProof(page,'appointment-imported');
   await bounds(page);await page.screenshot({path:`${out}/${engine}-${width}-integration-agenda.png`,fullPage:true});
   await page.goto(url);await imported(page).locator('summary').click();await page.evaluate(()=>window.__qaRemoveAppointment('appointment-imported'));await imported(page).locator('button').click();
   await page.getByText('Ce rendez-vous n’est pas disponible sur cet appareil.',{exact:false}).waitFor();
   assert.equal(await page.locator('.agenda-layout').count(),0,'Missing target must not open a different agenda');
   await page.evaluate(()=>window.__qaSetProjectAccount('company-b'));await page.waitForFunction(()=>document.querySelectorAll('.automation-journal__appointment').length===0);
   assert.deepEqual(errors,[]);row.passed=true;
  }catch(error){row.error=error.stack;await page.screenshot({path:`${out}/${engine}-${width}-integration-failure.png`,fullPage:true}).catch(()=>{});}
  proof.push(row);await page.close();
 }
 }finally{await browser.close();}
}
await writeFile(`${out}/proof.json`,JSON.stringify(proof,null,2));
console.log(JSON.stringify({scenarios:proof.length,passed:proof.filter(row=>row.passed).length,failures:proof.filter(row=>!row.passed),output:out}));
if(proof.some(row=>!row.passed))process.exitCode=1;
