import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium', origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271';
const { [engine]: driver } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const languages = (process.env.ZENTRA_QA_LANGUAGES || 'fr,de,it,en').split(','), output = `.qa/payroll-settings-language-${engine}`, report = [];
await mkdir(output, { recursive: true });
async function tr(page, source, values) { return page.evaluate(async ({ source, values }) => { const url = performance.getEntriesByType('resource').map(entry => entry.name).findLast(url => new URL(url).pathname === '/src/language.ts') || '/src/language.ts'; return (await import(url)).t(source, values); }, { source, values }); }
async function change(page, language) { await page.evaluate(language => { const key = 'zentra.interface.language.v1'; localStorage.setItem(key, language); window.dispatchEvent(new StorageEvent('storage', { key, newValue: language })); }, language); await page.waitForFunction(language => document.documentElement.lang === `${language}-CH`, language); }
const calls = (page, name) => page.evaluate(name => JSON.parse(sessionStorage.getItem(`qa-payroll-${name}`) || '[]'), name);
async function geometry(page, label) {
  const errors = await page.locator('[data-settings-id=payroll]').evaluate(root => {
    const issues = []; if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('document');
    for (const el of root.querySelectorAll('.payroll-settings,.form-grid,.swiss-rules,.swiss-rule,.swiss-family-reference__table-wrap,.swiss-family-reference td,.swiss-rule dd,.swiss-rule em,button,summary,.field__label,.field__hint')) {
      const closed=el.closest('details:not([open])'); if(closed&&!closed.querySelector(':scope > summary')?.contains(el))continue;
      if (el.getClientRects().length && el.clientWidth && el.scrollWidth > el.clientWidth + 2) issues.push(`${el.className}: ${el.textContent.slice(0,80)}`);
    }
    return issues;
  }); assert.deepEqual(errors, [], label);
}
try { for (const [width,height] of [[320,568],[390,844],[844,390],[1440,1000]]) for (const language of languages) {
  const page = await browser.newPage({ viewport:{width,height}, reducedMotion:'reduce' }), errors=[]; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(language => { localStorage.setItem('zentra.interface.language.v1', language); localStorage.setItem('elyko-guided-tour-v3','completed'); }, language);
  try {
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&payroll=1&payrollNoFederal=1`);
    const openSettings = async () => { await page.locator(width>1100?'.sidebar__search':'.topbar .navigation-launcher').click(); const search=page.locator('.navigation-palette__search input'); await search.fill(await tr(page,'Paramètres')); await search.press('Enter'); await page.locator('[data-settings-link=payroll]').click(); };
    await openSettings();
    const section=page.locator('[data-settings-id=payroll]'), form=section.locator('.payroll-settings'), rules=section.locator('.swiss-rules'), contracts=form.locator('.payroll-settings__contracts');
    const button=async (name,scope=form)=>scope.getByRole('button',{name:await tr(page,name),exact:true});
    await rules.locator('.swiss-rule').first().waitFor(); assert.equal(await rules.locator('.swiss-rule').count(),10);
    await form.locator('[name=avsFund]').fill('Caisse {v0} de recette');
    await form.locator('[name=lppPlanContractNumber]').fill('Contrat-{v0}-'+'RéférenceLongue'.repeat(6));
    await form.locator('[name=lppPlanEffectiveTo]').fill('2025-12-31'); await contracts.locator(':scope > summary').click();
    await (await button('Enregistrer la paie')).click(); await form.locator('[name=lppPlanEffectiveTo][aria-invalid=true]').waitFor(); assert.equal(await contracts.getAttribute('open') !== null,true);
    const alternate=language==='de'?'it':'de'; await change(page,alternate); assert.equal(await form.locator('[name=avsFund]').inputValue(),'Caisse {v0} de recette'); await change(page,language); await geometry(page,'guided pension correction');
    await form.locator('[name=lppPlanEffectiveTo]').fill('2026-12-31');
    await form.locator('[name=aanpEmployerCoverageEnabled]').check(); await (await button('Enregistrer la paie')).click(); await form.locator('[name=aanpEmployerCoverageReference][aria-invalid=true]').waitFor();
    await form.locator('[name=aanpEmployerCoverageReference]').fill('Convention {name} de recette'); await form.locator('[name=aanpEmployerCoverageEffectiveFrom]').fill('2026-01-01'); await form.locator('[name=aanpEmployerCoverageEffectiveTo]').fill('2025-12-31');
    await (await button('Enregistrer la paie')).click(); await form.locator('[name=aanpEmployerCoverageEffectiveTo][aria-invalid=true]').waitFor(); await form.locator('[name=aanpEmployerCoverageEffectiveTo]').fill('2026-12-31');
    await form.locator('[name=laaSmallSalaryExceptionEnabled]').check(); await form.locator('[name=laaSmallSalaryAssessmentYear]').fill('2026'); await form.locator('[name=laaSmallSalaryEvidenceReference]').fill('Preuve annuelle {v0}');
    await (await button('Enregistrer la paie')).click(); await form.locator('[name=laaSmallSalaryAllEmployeesConfirmed][aria-invalid=true]').waitFor(); await form.locator('[name=laaSmallSalaryAllEmployeesConfirmed]').check();
    await form.locator('[name=payrollCanton]').selectOption('AR'); await geometry(page,'complete canton name'); await form.locator('[name=payrollCanton]').selectOption('VS');
    assert.equal((await calls(page,'settings')).length,0);
    await page.evaluate(()=>sessionStorage.setItem('qa-payroll-refuse-settings','1')); await (await button('Enregistrer la paie')).click(); await form.locator('.payroll-settings__error').waitFor();
    assert.ok((await form.locator('.error-panel').innerText()).includes(await tr(page,'Les réglages n’ont pas pu être enregistrés. Votre saisie est conservée. Réessayez.')));
    assert.equal(await form.locator('[name=avsFund]').inputValue(),'Caisse {v0} de recette'); await change(page,alternate); await change(page,language); await geometry(page,'save failure');
    await page.evaluate(()=>sessionStorage.removeItem('qa-payroll-refuse-settings')); await (await button('Enregistrer la paie')).click(); await form.locator('.payroll-settings__error').waitFor({state:'hidden'});
    const saves=await calls(page,'settings'); assert.equal(saves.length,2); const saved=saves.at(-1).payroll;
    assert.equal(saved.avsFund,'Caisse {v0} de recette'); assert.equal(saved.payrollCanton,'VS'); assert.equal(saved.aanpEmployerCoverage.reference,'Convention {name} de recette'); assert.equal(saved.laaSmallSalaryException.assessmentYear,2026); assert.equal(saved.lppPlanEvidence.effectiveTo,'2026-12-31');
    const avs=rules.locator('.swiss-rule').filter({has:page.getByText(await tr(page,'AVS / AI / APG'),{exact:true})});
    assert.ok((await avs.innerText()).includes(await tr(page,'Configuration requise')));
    await (await button('Installer le profil officiel',section)).click(); await avs.getByText(await tr(page,'Configuration présente'),{exact:true}).waitFor();
    await section.locator('.payroll-definitions .contribution-list > article').nth(12).waitFor(); assert.equal((await calls(page,'definition')).length,8);
    await rules.locator('.swiss-family-reference > summary').click(); assert.equal(await rules.locator('tbody tr').count(),26); await geometry(page,'all cantons');
    await rules.locator('tbody tr').filter({has:page.getByText('VD',{exact:true})}).scrollIntoViewIfNeeded(); await page.screenshot({path:`${output}/${language}-${width}-cantons.png`});
    const certificate=rules.locator('.swiss-rule--local'); assert.ok((await certificate.innerText()).includes(await tr(page,'Formulaire officiel 11 · export PDF local'))); assert.equal(await certificate.locator('a').getAttribute('href'),'https://www.estv.admin.ch/fr/certificat-de-salaire-et-attestation-de-rentes');
    // Simulate another writer in the local fixture. A stale form must not overwrite it.
    await form.locator('[name=avsFund]').fill('Saisie non enregistrée');
    await page.evaluate(async()=>{const url=performance.getEntriesByType('resource').map(entry=>entry.name).findLast(url=>new URL(url).pathname==='/src/bridge.ts');const{desktopApi}=await import(url);const current=await desktopApi.loadWorkspace();await desktopApi.saveSettings({...current.settings,payroll:{...current.settings.payroll,accidentInsurer:'Assureur mis à jour ailleurs'}});});
    const countBefore=(await calls(page,'settings')).length;
    await (await button('Enregistrer la paie')).click(); await form.locator('.payroll-settings__error').waitFor(); assert.equal((await calls(page,'settings')).length,countBefore);
    await form.locator('.payroll-settings__error summary').click(); assert.ok((await form.locator('.payroll-settings__error').innerText()).includes(await tr(page,'Les réglages de paie ont changé. Rechargez les paramètres avant d’enregistrer pour retrouver les dernières informations.')));
    await (await button('Charger les derniers réglages enregistrés')).click(); await form.locator('.payroll-settings__error').waitFor({state:'hidden'}); assert.equal(await form.locator('[name=accidentInsurer]').inputValue(),'Assureur mis à jour ailleurs'); assert.equal(await form.locator('[name=avsFund]').inputValue(),'Caisse {v0} de recette'); await geometry(page,'reload saved settings');
    await form.scrollIntoViewIfNeeded(); await page.screenshot({path:`${output}/${language}-${width}-settings.png`});
    // A failed reference read must not show configuration badges; retry stays in this section.
    await page.evaluate(()=>sessionStorage.setItem('qa-payroll-fail-rates','1')); await page.reload(); await openSettings(); await rules.locator('.error-panel').waitFor(); assert.equal(await rules.locator('.swiss-rule').count(),0);
    await page.evaluate(()=>sessionStorage.removeItem('qa-payroll-fail-rates')); await (await button('Réessayer',rules)).click(); await rules.locator('.swiss-rule').first().waitFor(); assert.equal(await rules.locator('.swiss-rule').count(),10); await geometry(page,'reference retry');
    assert.deepEqual(errors,[]); report.push({language,width,height,pensionAndAccidentDateGuidance:true,annualEvidenceGuidance:true,saveRetry:true,externalChangeProtected:true,reloadSavedSettings:true,profileRefresh:true,cantons:26,referenceReadRetry:true,noHorizontalOverflow:true}); console.log(`${engine} ${language} ${width}: passed`);
  } catch(error) {await page.screenshot({path:`${output}/failure-${language}-${width}.png`});await writeFile(`${output}/failure.txt`,`${error.stack}\n${await page.locator('body').innerText()}`);throw error;}
  finally{await page.close();}
}}finally{await writeFile(`${output}/report${languages.length===4?'':'-'+languages.join('-')}.json`,JSON.stringify(report,null,2));await browser.close();}
