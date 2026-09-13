import { createRequire } from 'node:module';
import { mkdir,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine=process.env.ZENTRA_QA_ENGINE||'chromium',origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271';
const {[engine]:driver}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const browser=await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const languages=(process.env.ZENTRA_QA_LANGUAGES||'fr,de,it,en').split(','),output=`.qa/payroll-setup-language-${engine}`,report=[];await mkdir(output,{recursive:true});
async function tr(page,source,values){return page.evaluate(async({source,values})=>{const url=performance.getEntriesByType('resource').map(entry=>entry.name).findLast(url=>new URL(url).pathname==='/src/language.ts')||'/src/language.ts';return(await import(url)).t(source,values);},{source,values});}
async function change(page,language){await page.evaluate(language=>{const key='zentra.interface.language.v1';localStorage.setItem(key,language);window.dispatchEvent(new StorageEvent('storage',{key,newValue:language}));},language);await page.waitForFunction(language=>document.documentElement.lang===`${language}-CH`,language);}
const calls=(page,name)=>page.evaluate(name=>JSON.parse(sessionStorage.getItem(`qa-payroll-${name}`)||'[]'),name);
async function geometry(page,label){
 const issues=await page.locator('.payroll-dialog').evaluate(root=>{
  const errors=[];if(document.documentElement.scrollWidth>innerWidth+1)errors.push('document');
  for(const el of root.querySelectorAll('.modal__body,.payroll-setup,.payroll-contracts,.payroll-pension-pair,.payroll-select,.payroll-select__caption,.payroll-question-progress,.contribution-form,button,summary,h3,.field__label'))if(el.getClientRects().length&&el.clientWidth&&el.scrollWidth>el.clientWidth+2)errors.push(`${el.className}: ${el.textContent.slice(0,70)}`);
  for(const select of root.querySelectorAll('.payroll-select select')){
   if(!select.getClientRects().length||!select.clientWidth)continue;
   const bounds=select.getBoundingClientRect(),host=select.parentElement.getBoundingClientRect();if(bounds.left<host.left-1||bounds.right>host.right+1)errors.push('native selection outside field');
   const style=getComputedStyle(select),text=select.selectedOptions[0]?.textContent||'',ctx=document.createElement('canvas').getContext('2d');ctx.font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
   if(ctx.measureText(text).width>select.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)){if(select.parentElement.querySelector('.payroll-select__caption')?.textContent!==text)errors.push(`truncated selection: ${text}`);}
  }return errors;
 });assert.deepEqual(issues,[],label);
}
try {for(const [width,height] of [[320,568],[390,844],[844,390],[1440,1000]])for(const language of languages){
 const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(language=>{localStorage.setItem('zentra.interface.language.v1',language);localStorage.setItem('elyko-guided-tour-v3','completed');},language);
 const alternate=language==='de'?'it':'de';
 try{
  await page.goto(`${origin}/tests/mobile-harness.html?payroll=1&browsing=1&payrollSetup=1&payrollPensionSetup=1&payrollNoFederal=1`);
  await page.locator(width>1100?'.sidebar__search':'.topbar .navigation-launcher').click();await page.locator('.navigation-palette__search input').fill({fr:'Équipe & salaires',de:'Team & Löhne',it:'Team e stipendi',en:'Team & payroll'}[language]);await page.locator('.navigation-palette__search input').press('Enter');
  await page.locator('.team-navigation button').nth(1).click();await page.getByRole('button',{name:await tr(page,'Nouvelle fiche'),exact:true}).click();
  const modal=page.locator('.payroll-dialog'),setup=modal.locator('.payroll-setup'),guide=modal.locator('.payroll-preparation');
  const button=async(name,scope=setup)=>scope.getByRole('button',{name:await tr(page,name),exact:true});
  await modal.locator('select[name=employeeId]').selectOption('elodie');await modal.locator('[name=period]').fill('2026-09');await modal.locator('[name=paymentDate]').fill('2026-09-30');await(await button('Continuer',modal)).click();
  const salary=modal.locator('[data-payroll-salary-entry] .payroll-salary input');await salary.fill('5123.45');await(await button('Vérifier le salaire',modal)).click();await guide.waitFor();
  let person=false,history=false,pension=false,federal=false,pair=false;
  for(let turn=0;turn<12;turn++){
   const calculate=await button('Calculer le net',guide);
   const next=guide.locator('.payroll-preparation__next > button').or(calculate).first();await next.waitFor();
   if((await next.innerText()).trim()===await tr(page,'Calculer le net'))break;
   await next.click();
   if(await setup.locator('[name=birthDate]:visible').count()){
    person=true;await setup.locator('[name=birthDate]').fill('1990-01-01');await(await button('Continuer')).click();await setup.locator('[name=weeklyHours]').fill('40');await change(page,alternate);assert.equal(await setup.locator('[name=weeklyHours]').inputValue(),'40');await change(page,language);await geometry(page,'employment contract');await(await button('Continuer')).click();await setup.locator('[name=lppAnnualSalary]').fill('60000');await(await button('Enregistrer et continuer')).click();
   }else if(await setup.locator('[name=contractNumber]:visible').count()){
    pension=true;await setup.locator('[name=pensionFund]').fill('Fondation {name} de recette');await setup.locator('[name=contractNumber]').fill('QA-LPP-2026');await setup.locator('[name=regulationReference]').fill('Règlement de prévoyance QA {year} 2026');await setup.locator('[name=lppFrom]').fill('2026-01-01');await setup.locator('[name=lppTo]').fill('2025-12-31');await setup.locator('[name=lppParity]').check();await(await button('Enregistrer et continuer')).click();await setup.locator('[name=lppTo][aria-invalid=true]').waitFor();
    await change(page,alternate);assert.ok((await setup.locator('.payroll-field-guide').innerText()).includes('31.12.2025'));await change(page,language);assert.equal(await setup.locator('[name=regulationReference]').inputValue(),'Règlement de prévoyance QA {year} 2026');
    await setup.locator('[name=lppTo]').fill('2026-08-31');await(await button('Enregistrer et continuer')).click();await setup.locator('[name=lppTo][aria-invalid=true]').waitFor();assert.ok((await setup.locator('.payroll-field-guide').innerText()).includes('30.09.2026'));await geometry(page,'pension date correction');await page.screenshot({path:`${output}/${language}-${width}-pension-date.png`});
    await setup.locator('[name=lppTo]').fill('2026-12-31');await(await button('Enregistrer et continuer')).click();const settings=(await calls(page,'settings')).at(-1).payroll;assert.equal(settings.payrollCanton,'VD');assert.equal(settings.avsFund,'Caisse de recette');assert.equal(settings.pensionFund,'Fondation {name} de recette');
   }else if(await setup.locator('[data-payroll-history]:visible').count()){
    history=true;await setup.locator('[data-payroll-history] select').first().selectOption('previous');for(const name of ['openingGross','openingAvs','openingAc','openingLaa'])await setup.locator(`[name=${name}]`).fill('2000');await change(page,alternate);assert.equal(await setup.locator('[name=openingGross]').inputValue(),'2000');await change(page,language);await geometry(page,'opening balances');await(await button('Continuer')).click();await setup.locator('[name=sector]').selectOption('ordinary');await setup.locator('[name=requested]').selectOption('no');await(await button('Continuer')).click();
    await setup.locator('[name=decisionDate]').fill('2025-12-31');await setup.locator('[name=evidence]').fill('Déclaration {year} de recette');await(await button('Enregistrer et continuer')).click();await setup.locator('[name=decisionDate][aria-invalid=true]').waitFor();await change(page,alternate);assert.equal(await setup.locator('[name=evidence]').inputValue(),'Déclaration {year} de recette');await change(page,language);await setup.locator('[name=decisionDate]').fill('2026-01-01');await(await button('Enregistrer et continuer')).click();
   }else if(await(await button('Préparer les cotisations suisses 2026')).isVisible()){
    federal=true;await(await button('Préparer les cotisations suisses 2026')).click();
   }else if(await setup.locator('.payroll-pension-pair').isVisible()){
    pair=true;const fields=setup.locator('.payroll-pension-pair');await fields.locator('[name=employee]').fill('245.50');await fields.locator('[name=employer]').fill('260');await fields.locator('[name=component]').selectOption('combined');await fields.locator('input[type=checkbox]').check();await page.evaluate(()=>sessionStorage.setItem('qa-payroll-refuse-pension-employer-once','1'));await(await button('Enregistrer les deux montants')).click();await setup.locator('.payroll-problem').waitFor();await change(page,alternate);assert.equal(await fields.locator('[name=employee]').inputValue(),'245.50');await change(page,language);await geometry(page,'pension retry');await(await button('Enregistrer les deux montants')).click();
   }else throw Error('Unrecognized preparation step: '+await setup.innerText());
   await guide.waitFor();
  }
  assert.deepEqual([person,history,pension,federal,pair],[true,true,true,true,true]);await(await button('Calculer le net',guide)).click();await modal.locator('.payroll-net').waitFor();assert.equal(await salary.inputValue(),'5123.45');await modal.locator('[name=notes]').fill('Note {name}\nTexte conservé');await(await button('Enregistrer la fiche',modal)).click();await modal.waitFor({state:'hidden'});
  const saved=(await calls(page,'save')).at(-1);assert.equal(saved.lines[0].amountCents,512345);assert.equal(saved.data.notes,'Note {name}\nTexte conservé');assert.equal(saved.selections.length,13);const pensions=(await calls(page,'definition')).filter(item=>item.category==='lpp');assert.deepEqual(pensions.map(item=>item.fixedAmountCents),[24550,26000]);
  // The remaining setup categories and advanced definitions use the same production components.
  await page.goto(`${origin}/tests/payroll-setup-language.html`);await setup.waitFor();
  for(const scenario of ['insurance','history','person','accounts','contributions']){await page.locator(`[data-scenario="${scenario}"]`).click();if(scenario==='contributions')await setup.getByText(await tr(page,'Comptes pour la comptabilité'),{exact:true}).click();await geometry(page,scenario);if(scenario==='insurance'){const canton=setup.locator('[data-payroll-question=insurance-0] select').first();for(const code of ['AI','AR','BL','VD']){await canton.selectOption(code);await geometry(page,'canton selection');}}}
  await page.locator('[data-scenario=advanced-contributions]').click();await setup.locator('.contribution-list article').first().waitFor();await(await button('Nouvelle cotisation')).click();const form=setup.locator('.contribution-form');
  for(const code of ['avs_ai_apg','aanp','family_allowance','lpp']){await form.locator('[name=category]').selectOption(code);await geometry(page,'advanced category');}
  await form.locator('[name=code]').fill('QA-EXTRA');await form.locator('[name=label]').fill('Police {name} personnalisée');await form.locator('[name=side]').selectOption('employee');await form.locator('[name=fixedAmount]').fill('0');await form.locator('[name=lppEmployeeId]').selectOption('elodie');await form.locator('[name=lppComponent]').selectOption('combined');await form.locator('[name=basisKind]').selectOption('coordinated');await form.locator('[name=effectiveFrom]').fill('2026-01-01');await form.locator('[name=effectiveTo]').fill('2026-12-31');await form.locator('[name=source]').fill('Règlement LPP de recette 2026, article 12');await form.locator('[name=active]').selectOption('yes');
  await(await button('Enregistrer la définition')).click();await form.locator('[name=fixedAmount][aria-invalid=true]').waitFor();await change(page,alternate);assert.equal(await form.locator('[name=label]').inputValue(),'Police {name} personnalisée');await change(page,language);await form.locator('[name=fixedAmount]').fill('123.45');await geometry(page,'advanced correction');await(await button('Enregistrer la définition')).click();await form.waitFor({state:'hidden'});const definition=(await calls(page,'definition')).at(-1);assert.equal(definition.label,'Police {name} personnalisée');assert.equal(definition.fixedAmountCents,12345);assert.equal(definition.lppEmployeeId,'elodie');
  // Switching records must load that record, while switching language must retain its draft.
  const cards=setup.locator('.contribution-list article');await cards.first().getByRole('button',{name:await tr(page,'Modifier'),exact:true}).click();const firstCode=await form.locator('[name=code]').inputValue();await cards.nth(1).getByRole('button',{name:await tr(page,'Modifier'),exact:true}).click();assert.notEqual(await form.locator('[name=code]').inputValue(),firstCode);await change(page,alternate);const editedCode=await form.locator('[name=code]').inputValue();await change(page,language);assert.equal(await form.locator('[name=code]').inputValue(),editedCode);await geometry(page,'switching records');
  assert.deepEqual(errors,[]);report.push({language,width,height,firstPayslip:true,pensionDateCorrections:true,annualDateCorrection:true,pensionRetry:true,advancedContribution:true,recordSwitch:true,selectedLabelsVisible:true,noHorizontalOverflow:true});console.log(`${engine} ${language} ${width}: passed`);
 }catch(error){await page.screenshot({path:`${output}/failure-${language}-${width}.png`});await writeFile(`${output}/failure.txt`,`${error.stack}\n${await page.locator('body').innerText()}`);throw error;}finally{await page.close();}
}}finally{await writeFile(`${output}/report${languages.length===4?'':'-'+languages.join('-')}.json`,JSON.stringify(report,null,2));await browser.close();}
