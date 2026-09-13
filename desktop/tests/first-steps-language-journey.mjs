import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine=process.env.ZENTRA_QA_ENGINE||'chromium';
const {[engine]:driver}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const browser=await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const output=`.qa/first-steps-language-${engine}${process.env.ZENTRA_QA_LANGUAGES ? "-" + process.env.ZENTRA_QA_LANGUAGES.replaceAll(",", "-") : ""}`,reports=[];await mkdir(output,{recursive:true});
const languages=(process.env.ZENTRA_QA_LANGUAGES||'fr,de,it,en').split(',');
assert.ok(languages.length&&languages.every(value=>['fr','de','it','en'].includes(value)));
const names={fr:'Français',de:'Deutsch',it:'Italiano',en:'English'};
const labels={fr:'Ajouter mon premier client',de:'Meinen ersten Kunden hinzufügen',it:'Aggiungi il primo cliente',en:'Add my first customer'};
const expected=['create_client','create_project','create_quote','configure_billing','review_quotes','review_quotes','convert_quote','review_invoice','configure_accounting','record_payment','review_accounting','create_backup',null];
async function geometry(page,label) {
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${label} page`);
  const clipped=await page.locator('.getting-started,.setup-strip').evaluateAll(roots=>roots.flatMap(root=>[root,...root.querySelectorAll('button,strong,small,p,em,span')]).filter(el=>el.getClientRects().length&&(el.scrollWidth>el.clientWidth+2)).map(el=>el.textContent));
  assert.deepEqual(clipped,[],label);
}
try {
  for(const [width,height] of [[320,568],[390,844],[844,390],[1440,1000]])for(const language of languages) {
    const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    try {
      await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271'}/tests/first-steps-language.html`);
      await page.locator('.language-setting').getByRole('button',{name:names[language],exact:true}).click();
      await page.locator('[data-getting-started-action=create_client]').getByText(labels[language],{exact:true}).waitFor();
      for(let i=0;i<expected.length;i++) {
        await page.getByRole('combobox',{name:'QA scenario',exact:true}).selectOption(String(i));
        const checklist=page.locator('.getting-started');await checklist.waitFor();await checklist.locator('.checklist-toggle').click();
        assert.equal(await checklist.locator('li').count(),6);await geometry(page,`${language} ${width} ${i}`);
        const alternate=language==='de'?'en':'de';await page.locator('.language-setting').getByRole('button',{name:names[alternate],exact:true}).click();
        assert.equal(await checklist.locator('.checklist-toggle').getAttribute('aria-expanded'),'true');
        await page.locator('.language-setting').getByRole('button',{name:names[language],exact:true}).click();
        if(i===12) { assert.equal(await checklist.locator('[role=progressbar]').getAttribute('aria-valuenow'),'6');await checklist.locator('[role=status]').waitFor();continue; }
        const action=checklist.locator('[data-getting-started-action]');assert.equal(await action.getAttribute('data-getting-started-action'),expected[i]);await action.click();
        const payload=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-first-step-action')));assert.equal(payload.kind,expected[i]);
        if(i===4||i===5)assert.equal(payload.entityId,'quote-qa');if(i===7||i===9)assert.equal(payload.entityId,'invoice-qa');
        await page.locator('[data-read-only]').check();await geometry(page,'read-only');await action.click();assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-first-step-action'))),payload);
        await page.locator('[data-read-only]').uncheck();
      }
      await page.getByRole('combobox',{name:'QA scenario',exact:true}).selectOption('0');await page.locator('[data-compact]').check();
      const strip=page.locator('.setup-strip');await strip.waitFor();await geometry(page,'compact');await strip.getByText(labels[language],{exact:true}).waitFor();
      await strip.locator('button').first().click();assert.equal(await page.locator('.checklist-toggle').getAttribute('aria-expanded'),'true');
      await page.locator('.getting-started').scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/${language}-${width}.png`});assert.deepEqual(errors,[]);
      reports.push({language,width,height,scenarios:13,readOnly:true,expandedStateRetained:true,stableActionIds:true,noClipping:true});console.log(`${engine} ${language} ${width}: passed`);
    } catch(error) { await page.screenshot({path:`${output}/failure-${language}-${width}.png`});throw error; }finally{await page.close();}
  }
}finally{await writeFile(`${output}/report.json`,JSON.stringify(reports,null,2));await browser.close();}
