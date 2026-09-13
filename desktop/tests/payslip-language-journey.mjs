// Main payslip creation/editing against the production UI and existing synthetic payroll RPCs.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine=process.env.ZENTRA_QA_ENGINE||'chromium';
const {[engine]:driver}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const browser=await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const output=`.qa/payslip-language-${engine}`,reports=[];await mkdir(output,{recursive:true});
const titles={fr:'Nouvelle fiche de salaire',de:'Neue Lohnabrechnung',it:'Nuova busta paga',en:'New payslip'};
const teams={fr:'Équipe & salaires',de:'Team & Löhne',it:'Team e stipendi',en:'Team & payroll'};
async function changeLanguage(page,language) {
  await page.evaluate(value=>{const key='zentra.interface.language.v1';localStorage.setItem(key,value);window.dispatchEvent(new StorageEvent('storage',{key,newValue:value}));},language);
  await page.waitForFunction(value=>document.documentElement.lang===`${value}-CH`,language);
}
async function translation(page,source) {
  return page.evaluate(async source=>{const url=performance.getEntriesByType('resource').map(entry=>entry.name).findLast(url=>new URL(url).pathname==='/src/language.ts')||'/src/language.ts';return(await import(url)).t(source);},source);
}
async function geometry(page,label) {
  const issues=await page.locator('.payroll-dialog').evaluate(root=>{
    const failures=[];if(document.documentElement.scrollWidth>innerWidth+1)failures.push('page overflow');
    for(const el of [root,...root.querySelectorAll('.modal__body,.payroll-step-intro,.payroll-steps li,.payroll-salary label,.payroll-month-overview,.payroll-save-later,.payroll-net,button,summary,.field__label,.payroll-selection-caption')]) {
      if(el.getClientRects().length&&el.scrollWidth>el.clientWidth+2)failures.push(`overflow: ${el.className} ${el.textContent.slice(0,90)}`);
    }
    return failures;
  });assert.deepEqual(issues,[],label);
}
const calls=(page,name)=>page.evaluate(name=>JSON.parse(sessionStorage.getItem(`qa-payroll-${name}`)||'[]'),name);
try {
  for(const [width,height] of [[320,568],[390,844],[844,390],[1440,1000]])for(const language of ['fr','de','it','en']) {
    const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(language=>{localStorage.setItem('zentra.interface.language.v1',language);localStorage.setItem('elyko-guided-tour-v3','completed');},language);
    try {
      await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271'}/tests/mobile-harness.html?payroll=1&browsing=1`);
      await page.locator(width>1100?'.sidebar__search':'.topbar .navigation-launcher').click();await page.locator('.navigation-palette__search input').fill(teams[language]);await page.locator('.navigation-palette__search input').press('Enter');
      await page.locator('.team-navigation button').nth(1).click();await page.getByRole('button',{name:await translation(page,'Nouvelle fiche'),exact:true}).click();
      const modal=page.locator('.payroll-dialog'),form=modal.locator('form.payroll-form');
      const button=async source=>modal.getByRole('button',{name:await translation(page,source),exact:true});
      await modal.locator('h2').getByText(titles[language],{exact:true}).waitFor();
      await form.locator('[name=employeeId]').selectOption('elodie');await form.locator('[name=period]').fill('2026-09');await form.locator('[name=paymentDate]').fill('2026-09-30');
      await geometry(page,'person');await (await button('Continuer')).click();
      const salary=form.locator('.payroll-salary input');assert.equal(await salary.inputValue(),'5000');await salary.fill('5100');
      const month={fr:'septembre 2026',de:'September 2026',it:'settembre 2026',en:'September 2026'};
      assert.ok((await form.locator('.payroll-current-person').innerText()).includes(month[language]));
      await form.locator('[data-payroll-salary-entry] details').first().locator('summary').click();
      const salaryLabel=form.locator('.pay-line-list > div').first().locator('input').first();await salaryLabel.fill('Contrat {name} — septembre');
      const alternate=language==='de'?'en':'de';await changeLanguage(page,alternate);assert.equal(await salary.inputValue(),'5100');assert.equal(await salaryLabel.inputValue(),'Contrat {name} — septembre');await changeLanguage(page,language);
      await (await button('Ajouter un élément')).click();const extraLine=form.locator('.pay-line-list > div').nth(1);
      const payTypes=await extraLine.locator('.payroll-line-kind option').evaluateAll(options=>options.filter(option=>!option.disabled).map(option=>option.value));
      for(const kind of payTypes) {
        await extraLine.locator('.payroll-line-kind select').selectOption(kind);
        assert.equal(await extraLine.locator('.payroll-selection-caption').innerText(),await extraLine.locator('option:checked').first().innerText());await geometry(page,'pay component');
      }
      await extraLine.getByRole('button',{name:await translation(page,'Supprimer la ligne {v0}').then(text=>text.replace('{v0}','2')),exact:true}).click();
      await form.locator('[data-payroll-salary-entry] details').first().locator('summary').click();
      const references=form.locator('[data-payroll-salary-entry] details').nth(1);await references.locator('summary').click();
      const canton=references.locator('select');assert.equal(await canton.locator('option').count(),27);await canton.selectOption('VD');assert.ok((await references.innerText()).includes('CHF 322 / 365'));
      for(const code of ['AI','AR','BL','GE','VS']) {await canton.selectOption(code);assert.equal(await references.locator('.payroll-selection-caption').innerText(),await canton.locator('option:checked').innerText());await geometry(page,'canton');}assert.ok((await references.innerText()).includes(language==='de'?'0,13':language==='en'?'0.13':'0,13'));await references.locator('summary').click();
      await (await button('Vérifier le salaire')).click();await modal.locator('.payroll-net').waitFor();assert.match(await modal.locator('.payroll-net > strong').innerText(),/4.?472[.,]60/);
      const calculationCalls=(await calls(page,'calculate')).length;await form.locator('[name=notes]').fill('Note {title}\nLigne conservée 2026');
      await changeLanguage(page,alternate);assert.equal((await calls(page,'calculate')).length,calculationCalls);assert.equal(await form.locator('[name=notes]').inputValue(),'Note {title}\nLigne conservée 2026');
      assert.equal(await (await button('Enregistrer la fiche')).isEnabled(),true);await changeLanguage(page,language);
      await (await button('Retour')).click();await salary.fill('5200');await (await button('Vérifier le salaire')).click();assert.match(await modal.locator('.payroll-net > strong').innerText(),/4.?565[.,]20/);
      await geometry(page,'review');await modal.locator('.modal__body').evaluate(el=>el.scrollTop=0);await page.screenshot({path:`${output}/${language}-${width}-review.png`});
      await modal.locator('.payroll-net').evaluate(el=>el.scrollIntoView({block:'start'}));
      await modal.evaluate(root=>{const body=root.querySelector('.modal__body'),amount=root.querySelector('.payroll-net > strong'),footer=root.querySelector('.payroll-actions');const top=body.getBoundingClientRect().top,bottom=footer.getBoundingClientRect().top;const rect=amount.getBoundingClientRect();body.scrollTop+=rect.top-(top+Math.max(4,(bottom-top-rect.height)/2));});
      const netVisible=await modal.evaluate(root=>{const rect=root.querySelector('.payroll-net > strong').getBoundingClientRect();return rect.top>=root.querySelector('.modal__body').getBoundingClientRect().top-1&&rect.bottom<=root.querySelector('.payroll-actions').getBoundingClientRect().top+1;});assert.ok(netVisible,'The net amount can be read above the fixed actions');
      await page.screenshot({path:`${output}/${language}-${width}-net.png`});
      await form.locator('[name=validated]').check();await page.evaluate(()=>sessionStorage.setItem('qa-payroll-refuse-save','1'));await (await button('Enregistrer la fiche')).click();
      await modal.locator('.payroll-problem').first().waitFor();assert.equal(await form.locator('[name=notes]').inputValue(),'Note {title}\nLigne conservée 2026');
      if(language!=='fr')assert.equal((await modal.locator('.payroll-problem > strong').first().innerText()).includes('Choisissez'),false);
      await changeLanguage(page,alternate);await geometry(page,'failed save');await changeLanguage(page,language);
      await page.evaluate(()=>sessionStorage.setItem('qa-payroll-refuse-save','0'));await (await button('Enregistrer la fiche')).click();await modal.waitFor({state:'hidden'});
      const saved=(await calls(page,'save')).at(-1);assert.equal(saved.data.status,'validated');assert.equal(saved.data.employeeId,'elodie');assert.equal(saved.data.period,'2026-09');assert.equal(saved.data.paymentDate,'2026-09-30');assert.equal(saved.lines[0].amountCents,520000);assert.equal(saved.lines[0].label,'Contrat {name} — septembre');assert.equal(saved.selections.length,13);assert.equal(saved.data.notes,'Note {title}\nLigne conservée 2026');
      await page.locator('.payslip-list article').first().getByRole('button',{name:await translation(page,'Modifier'),exact:true}).click();await modal.waitFor();await (await button('Continuer')).click();assert.equal(await salary.inputValue(),'5200');await salary.fill('5250');await (await button('Vérifier le salaire')).click();
      const basisGuide=modal.locator('.payroll-basis-guide');await basisGuide.waitFor();
      for(let index=0;index<3;index++) {
        await basisGuide.locator('input').fill('5250');
        if(index===0) {await changeLanguage(page,alternate);assert.equal(await basisGuide.locator('input').inputValue(),'5250');await changeLanguage(page,language);}
        await geometry(page,'insurance basis');await basisGuide.getByRole('button',{name:(await translation(page,'Confirmer ce montant ')).trim(),exact:true}).click();
      }
      // The fixture rounds each contribution separately: AVS 228.38 + AI 36.75 + APG 13.13 + AC 57.75 + AANP 52.50 + LPP 250.
      await basisGuide.getByRole('button',{name:await translation(page,'Continuer vers mon salaire'),exact:true}).click();await (await button('Vérifier le salaire')).click();await modal.locator('.payroll-net').waitFor();assert.match(await modal.locator('.payroll-net > strong').innerText(),/4.?611[.,]49/);
      assert.equal(await form.locator('[name=notes]').inputValue(),'Note {title}\nLigne conservée 2026');await changeLanguage(page,alternate);await changeLanguage(page,language);await (await button('Enregistrer la fiche')).click();await modal.waitFor({state:'hidden'});
      const edit=(await calls(page,'save')).at(-1);assert.ok(edit.existingId);assert.equal(edit.lines[0].amountCents,525000);assert.equal(edit.lines.length,1,'Generated deductions are restored as selections, never duplicated as manual lines');assert.equal(edit.selections.length,13);
      assert.deepEqual(errors,[]);reports.push({language,width,height,createAndEdit:true,netAndSavedAmounts:true,noRecalculationOnLanguageChange:true,userLabelsAndNotesPreserved:true,failedSaveRetry:true,basisConfirmation:true,fullSelectionCaptions:true,netAmountVisible:true,noHorizontalOverflow:true});console.log(`${engine} ${language} ${width}: passed`);
    } catch(error){await page.screenshot({path:`${output}/failure-${language}-${width}.png`});throw error;}finally{await page.close();}
  }
}finally{await writeFile(`${output}/report.json`,JSON.stringify(reports,null,2));await browser.close();}
