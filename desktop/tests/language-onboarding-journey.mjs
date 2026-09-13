import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine=process.env.ZENTRA_QA_ENGINE||'chromium';
const {[engine]:driver}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const browser=await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const out=`.qa/language-onboarding-${engine}`;await mkdir(out,{recursive:true});const report=[];
const names={fr:'Français',de:'Deutsch',it:'Italiano',en:'English'};
const copy={fr:{company:'Créer mon entreprise',create:'Créer avec l’essentiel',error:'La raison sociale est obligatoire.'},de:{company:'Mein Unternehmen anlegen',create:'Mit den Grundangaben starten',error:'Firmenname: Dieses Feld ist erforderlich.'},it:{company:'Crea la mia azienda',create:'Crea con l’essenziale',error:'Ragione sociale: questo campo è obbligatorio.'},en:{company:'Create my company',create:'Create with the essentials',error:'Legal company name: this field is required.'}};
try {
  for(const [width,height] of [[320,568],[390,844],[844,390],[1440,1000]]) for(const language of ['fr','de','it','en']) {
    const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(language=>localStorage.setItem('zentra.interface.language.v1',language),language);
    try {
      await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271'}/tests/mobile-harness.html?assistantOnboarding=1`);
      await page.getByRole('button',{name:new RegExp('^'+copy[language].company)}).click();
      await page.getByRole('button',{name:copy[language].create,exact:true}).click();
      await page.getByText(copy[language].error,{exact:true}).first().waitFor();
      await page.waitForFunction(()=>document.activeElement?.getAttribute('data-field')==='organization.legalName');
      assert.equal(await page.locator('[data-field="organization.legalName"]').evaluate(el=>document.activeElement===el),true);
      await page.locator('[data-field="organization.legalName"]').fill('Entreprise');
      await page.locator('[data-field="business.activityDescription"]').fill('Notes personnelles : travaux à Lausanne.');
      await page.locator('[data-field="business.nogaSection"]').selectOption('M');
      await page.locator('[data-field="business.nogaDivision"]').selectOption('68');
      for(const next of ['en','it','de','fr',language]) {
        await page.getByRole('button',{name:names[next],exact:true}).click();
        assert.equal(await page.locator('html').getAttribute('lang'),`${next}-CH`);
        assert.equal(await page.locator('[data-field="organization.legalName"]').inputValue(),'Entreprise');
        assert.equal(await page.locator('[data-field="business.activityDescription"]').inputValue(),'Notes personnelles : travaux à Lausanne.');
        assert.equal(await page.locator('[data-field="business.nogaSection"]').inputValue(),'M');
        const noga={fr:'Activités immobilières',de:'Grundstücks- und Wohnungswesen',it:'Attività immobiliari',en:'Real estate activities'};
        assert.equal(await page.locator('[data-field="business.nogaDivision"] option:checked').innerText(),`68 · ${noga[next]}`);
        await page.locator('.field__hint').getByText(noga[next],{exact:true}).first().waitFor();
      }
      await page.waitForFunction(()=>JSON.parse(localStorage.getItem('elyko.onboarding.draft.v1')||'null')?.settings?.organization?.legalName==='Entreprise');
      await page.reload();
      assert.equal(await page.locator('[data-field="organization.legalName"]').inputValue(),'Entreprise');
      assert.equal(await page.locator('html').getAttribute('lang'),`${language}-CH`);
      // Visit all stages with a draft-only fixture; no native company or financial records are written.
      // Seed before React mounts, so an in-flight autosave cannot overwrite the requested test stage.
      await page.addInitScript(()=>{const raw=localStorage.getItem('qa-language-stage'),draft=JSON.parse(localStorage.getItem('elyko.onboarding.draft.v1')||'null');if(raw!==null&&draft){draft.step=Number(raw);draft.highestStep=6;localStorage.setItem('elyko.onboarding.draft.v1',JSON.stringify(draft));}});
      for(const step of [0,1,2,3,4,5,6]) {
        await page.evaluate(step=>localStorage.setItem('qa-language-stage',String(step)),step);
        await page.reload();await page.locator('.setup-stage').waitFor();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${language} ${width} step ${step}`);
        const clipped=await page.locator('.onboarding__main .field__label,.onboarding__main .button,.setup-steps em,.language-setting__choices button').evaluateAll(elements=>elements.filter(el=>el.getClientRects().length&&el.scrollWidth>el.clientWidth+2).map(el=>el.textContent));
        assert.deepEqual(clipped,[],`Clipped labels in ${language} step ${step}`);
        if(step===0||step===1){await page.locator(step===0?'.language-setting':'[data-field="organization.legalName"]').scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/${language}-${width}-step${step}.png`});}
      }
      assert.deepEqual(errors,[]);report.push({language,width,height,selectionAndReload:true,draftPreserved:true,localizedRequiredError:true,sevenStepsNoOverflow:true});
    } catch(error){await page.screenshot({path:`${out}/${language}-${width}-failure.png`});throw error;}
    finally{await page.close();}
  }
}catch(error){report.push({error:String(error.stack||error)});process.exitCode=1;}
finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify({engine,report}));
