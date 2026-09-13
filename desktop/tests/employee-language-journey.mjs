// Complete create/edit UI journeys with synthetic employee writes. No customer database is used.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine=process.env.ZENTRA_QA_ENGINE||'chromium';
const {[engine]:driver}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const browser=await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const output=`.qa/employee-language-${engine}`,reports=[];await mkdir(output,{recursive:true});
const copy={fr:{team:'Équipe & salaires',create:'Nouveau collaborateur',heading:'Qui rejoint votre équipe ?',next:'Continuer',annual:'L’année choisie est',missing:'Il manque le montant',dateEnd:'date de fin',save:'Ajouter le collaborateur',edit:'Modifier le collaborateur'},de:{team:'Team & Löhne',create:'Person hinzufügen',heading:'Wer verstärkt Ihr Team?',next:'Continue',annual:'Das gewählte Jahr ist',missing:'Der Betrag für',dateEnd:'Enddatum',save:'Person hinzufügen',edit:'Mitarbeiterprofil bearbeiten'},it:{team:'Team e stipendi',create:'Nuovo collaboratore',heading:'Chi entra nel team?',next:'Continua',annual:'L’anno scelto è',missing:'Manca l’importo',dateEnd:'data di fine',save:'Aggiungi il collaboratore',edit:'Modifica il collaboratore'},en:{team:'Team & payroll',create:'Add employee',heading:'Who is joining your team?',next:'Continue',annual:'The selected year is',missing:'The amount for',dateEnd:'end date',save:'Add employee',edit:'Edit employee'}};
async function changeLanguage(page,value){
 await page.evaluate(value=>{localStorage.setItem('zentra.interface.language.v1',value);dispatchEvent(new StorageEvent('storage',{key:'zentra.interface.language.v1',newValue:value}));},value);
 await page.waitForFunction(value=>document.documentElement.lang===`${value}-CH`,value);
}
async function geometry(page){
 const issues=await page.evaluate(()=>{
  const issues=[];if(document.documentElement.scrollWidth>innerWidth+1)issues.push('page');
  for(const node of document.querySelectorAll('.employee-wizard,.modal__body,.modal__header h2,.payroll-step-intro,.employee-annual-error,.employee-review,.employee-card,.team-navigation,.team-navigation button,.payroll-steps li,.field__label,.employee-selection-hint,.employee-document-import,.button')){
   if(!node.getBoundingClientRect().width)continue;
   if(node.clientWidth&&node.scrollWidth>node.clientWidth+2)issues.push(`${node.className}: ${node.textContent.trim().slice(0,80)}`);
  }return issues;
 });assert.deepEqual(issues,[]);
}
async function focused(page,name){await page.waitForFunction(name=>document.activeElement?.getAttribute('name')===name,name);}
try{
 for(const [width,height]of [[320,568],[390,844],[844,390],[1440,1000]])for(const language of ['fr','de','it','en']){
  const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  try{
   await page.addInitScript(language=>{localStorage.setItem('elyko-guided-tour-v3','completed');localStorage.setItem('zentra.interface.language.v1',language);},language);
   await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271'}/tests/mobile-harness.html?browsing=1&design=1`);
   await page.locator(width>1100?'.sidebar__search':'.topbar .navigation-launcher').waitFor();
   await page.evaluate(async()=>{
    const url=performance.getEntriesByType('resource').map(entry=>entry.name).findLast(url=>new URL(url).pathname==='/src/bridge.ts')??'/src/bridge.ts';
    const {desktopApi}=await import(url);const current=await desktopApi.loadWorkspace();
    window.employeeWrites=[];window.failEmployeeSave=true;
    const convert=(data,id)=>({...data,id,active:data.status==='actif',salaryMode:data.monthlySalaryCents>0?'monthly':'hourly',grossSalaryCents:data.monthlySalaryCents,hourlyCostCents:data.hourlyRateCents,avsNumber:data.socialSecurityNumber,employmentStart:data.employmentStartDate,employmentEnd:data.employmentEndDate});
    desktopApi.createEntity=async(entity,data)=>{
     if(entity!=='employees')throw Error('Unexpected entity');
     if(window.failEmployeeSave){window.failEmployeeSave=false;throw Error('SQLITE_BUSY: employee test save interrupted');}
     window.employeeWrites.push({kind:'create',data:structuredClone(data)});current.employees=[...current.employees,convert(data,'employee-language-qa')];return structuredClone(current);
    };
    desktopApi.updateEntity=async(entity,id,data)=>{if(entity!=='employees')throw Error('Unexpected entity');window.employeeWrites.push({kind:'update',id,data:structuredClone(data)});current.employees=current.employees.map(item=>item.id===id?convert(data,id):item);return structuredClone(current);};
   });
   await page.locator(width>1100?'.sidebar__search':'.topbar .navigation-launcher').click();await page.locator('.navigation-palette__search input').fill(copy[language].team);
   await page.locator('.navigation-palette__results button').filter({has:page.getByText(copy[language].team,{exact:true})}).click();
   await page.getByRole('button',{name:copy[language].create,exact:true}).click();
   const modal=page.getByRole('dialog'),form=modal.locator('.employee-wizard'),submit=form.locator('button[type=submit]');
   assert.equal(await form.locator('.payroll-step-intro h3').innerText(),copy[language].heading);
   await submit.click();await focused(page,'name');assert.equal(await form.locator('[name=name]').getAttribute('aria-invalid'),'true');
   await form.locator('[data-employee-step="0"] details').evaluateAll(nodes=>nodes.forEach(node=>node.open=true));
   await form.locator('.employee-document-import input').setInputFiles({name:'unsupported.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic document')});
   await form.locator('.employee-document-import__error').waitFor();assert.ok((await form.locator('.employee-document-import__error').innerText()).includes('PDF'));
   await form.locator('[name=name]').fill('Camille Exemple {year}');await form.locator('[name=role]').fill('Responsable de projet');await form.locator('[name=email]').fill('collaborateur@example.invalid');await form.locator('[name=addressLine1]').fill('Rue de la Paix 12');
   await geometry(page);await submit.click();
   await form.locator('[name=employmentRate]').fill('80');await form.locator('[name=contractualWeeklyHours]').fill('32');await form.locator('[name=employmentStart]').fill('2026-09-01');await form.locator('[name=employmentContractKind]').selectOption('fixed');await form.locator('[name=salaryMode]').selectOption('monthly');await form.locator('[name=grossSalary]').fill('4200');
   await submit.click();await focused(page,'employmentEnd');assert.ok((await form.locator('section.payroll-field-guide').innerText()).includes(copy[language].dateEnd));
   const alternate=language==='en'?'de':'en';await changeLanguage(page,alternate);assert.equal(await form.locator('[name=grossSalary]').inputValue(),'4200');assert.ok((await form.locator('section.payroll-field-guide').innerText()).includes(copy[alternate].dateEnd));await changeLanguage(page,language);
   await form.locator('[name=employmentEnd]').fill('2026-11-30');await form.locator('[name=hourlyCost]').fill('38');await geometry(page);await submit.click();
   await form.locator('[name=notes]').fill('Contrat {year}\nDeuxième ligne à conserver.');await form.locator('[data-employee-step="2"] details').evaluateAll(nodes=>nodes.forEach(node=>node.open=true));
   await form.locator('[name=lppAssessmentYear]').fill('2026');await submit.click();await focused(page,'lppAnnualSalary');
   assert.ok((await form.locator('section.payroll-field-guide').innerText()).includes(copy[language].missing));assert.ok((await form.locator('section.payroll-field-guide').innerText()).includes('2026'));
   await changeLanguage(page,alternate);assert.ok((await form.locator('section.payroll-field-guide').innerText()).includes(copy[alternate].missing));await changeLanguage(page,language);await form.locator('[name=lppAnnualSalary]').fill('50400');
   await form.locator('[name=lppExceptionCode]').selectOption('short_fixed_contract');await form.locator('[name=lppExceptionEvidenceReference]').fill('Contrat signé de septembre 2026');await form.locator('.employee-selection-hint').waitFor();
   await form.locator('[name=smallSalaryAssessmentYear]').fill('2026');await form.locator('[name=smallSalarySector]').selectOption('ordinary');await form.locator('[name=smallSalaryEmployeeRequestedContributions]').selectOption('no');await form.locator('[name=smallSalaryDecisionDate]').fill('2025-12-31');await form.locator('[name=smallSalaryOpeningGross]').fill('0');await form.locator('[name=smallSalaryOpeningContributedBasis]').fill('0');await form.locator('[name=smallSalaryEvidenceReference]').fill('Déclaration annuelle {year}');
   await submit.click();await focused(page,'smallSalaryDecisionDate');const annual=form.locator('#employee-annual-error');assert.ok((await annual.innerText()).includes(copy[language].annual));assert.ok((await annual.innerText()).includes('31.12.2025'));
   await changeLanguage(page,alternate);assert.ok((await annual.innerText()).includes(copy[alternate].annual));assert.equal(await form.locator('[name=notes]').inputValue(),'Contrat {year}\nDeuxième ligne à conserver.');await changeLanguage(page,language);
   assert.equal(await page.evaluate(()=>window.employeeWrites.length),0);await geometry(page);
   await annual.scrollIntoViewIfNeeded();if(width===320)await page.screenshot({path:`${output}/${language}-annual.png`});
   await form.locator('[name=smallSalaryDecisionDate]').fill('2026-01-12');await submit.click();await form.locator('.employee-save-details').waitFor();assert.ok(!(await form.locator('.error-panel').innerText()).includes('SQLITE'));assert.equal(await form.locator('[name=notes]').inputValue(),'Contrat {year}\nDeuxième ligne à conserver.');
   await form.locator('.employee-save-details summary').click();assert.ok((await form.locator('.employee-save-details').innerText()).includes('SQLITE_BUSY'));await geometry(page);
   await submit.click();await modal.waitFor({state:'hidden'});
   const created=await page.evaluate(()=>window.employeeWrites[0]);assert.equal(created.kind,'create');assert.equal(created.data.name,'Camille Exemple {year}');assert.equal(created.data.monthlySalaryCents,420000);assert.equal(created.data.contractualWeeklyMinutes,1920);assert.equal(created.data.lppAnnualSalaryCents,5040000);assert.equal(created.data.smallSalaryDecisionDate,'2026-01-12');assert.equal(created.data.smallSalaryEvidenceReference,'Déclaration annuelle {year}');
   const card=page.locator('.employee-card').filter({has:page.getByText('Camille Exemple {year}',{exact:true})});await card.locator('footer button').first().click();await modal.waitFor();assert.equal(await modal.locator('h2').innerText(),copy[language].edit);
   assert.equal(await form.locator('[name=name]').inputValue(),'Camille Exemple {year}');await submit.click();assert.equal(await form.locator('[name=grossSalary]').inputValue(),'4200');await form.locator('[name=grossSalary]').fill('4300');await submit.click();await form.locator('[name=notes]').fill('Note modifiée\nToujours conservée.');await submit.click();await modal.waitFor({state:'hidden'});
   const writes=await page.evaluate(()=>window.employeeWrites);assert.equal(writes.length,2);assert.equal(writes[1].kind,'update');assert.equal(writes[1].data.monthlySalaryCents,430000);assert.equal(writes[1].data.smallSalaryEvidenceReference,'Déclaration annuelle {year}');assert.equal(writes[1].data.notes,'Note modifiée\nToujours conservée.');
   await geometry(page);if(width===320)await page.screenshot({path:`${output}/${language}-team.png`});assert.deepEqual(errors,[]);
   reports.push({language,width,height,createAndEdit:true,localizedErrors:true,languageKeepsDraft:true,correctFieldFocused:true,rawValuesPreserved:true,failedSaveRetry:true,documentInputValidation:true,noClipping:true});console.log(`${engine} ${language} ${width}: passed`);
  }catch(error){await page.screenshot({path:`${output}/${language}-${width}-failure.png`});throw error;}finally{await page.close();}
 }
}finally{await writeFile(`${output}/report.json`,JSON.stringify(reports,null,2));await browser.close();}
