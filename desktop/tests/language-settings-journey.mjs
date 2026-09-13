import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine=process.env.ZENTRA_QA_ENGINE||'chromium';
const {[engine]:driver}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const browser=await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const out=`.qa/language-settings-${engine}`;await mkdir(out,{recursive:true});const report=[];
const names={fr:'Français',de:'Deutsch',it:'Italiano',en:'English'};
const copy={fr:{settings:'Paramètres',search:'banque',destination:'Banque',noga:'Activités immobilières'},de:{settings:'Einstellungen',search:'bank',destination:'Bank',noga:'Grundstücks- und Wohnungswesen'},it:{settings:'Impostazioni',search:'banca',destination:'Banca',noga:'Attività immobiliari'},en:{settings:'Settings',search:'banking',destination:'Banking',noga:'Real estate activities'}};
try {
  for(const [width,height] of [[320,568],[390,844],[844,390],[1440,1000]]) for(const language of ['fr','de','it','en']) {
    const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
    try {
      await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271'}/tests/mobile-harness.html?browsing=1&design=1`);
      const openPalette=async()=>{await page.locator(width>1100?'.sidebar__search':'.topbar .navigation-launcher').click();return page.locator('.navigation-palette__search input');};
      let search=await openPalette();await search.fill('Paramètres');await search.press('Enter');
      await page.locator('[data-settings-link=language]').click();
      await page.locator('[data-settings-id=language]').getByRole('button',{name:names[language],exact:true}).click();
      assert.equal(await page.locator('html').getAttribute('lang'),`${language}-CH`);
      await page.locator('.page-header h1').getByText(copy[language].settings,{exact:true}).waitFor();
      const layout=async(label)=>{
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${label}: page overflow`);
        const clipped=await page.locator('.language-setting button,.language-setting h2,.language-setting p,.settings-browser__navigation button,.settings-browser__back,.sidebar__nav button span,.navigation-palette button,.settings-cloud-steps strong,.settings-cloud-steps small,.settings-cloud-intro .button').evaluateAll(els=>els.filter(el=>el.getClientRects().length&&(el.scrollWidth>el.clientWidth+2||el.scrollHeight>el.clientHeight+2)).map(el=>el.textContent));
        assert.deepEqual(clipped,[],`${label}: clipped text`);
      };
      await layout('language');
      await page.locator('.language-setting').scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/${language}-${width}-settings.png`});
      const openCategory=async(id)=>{const back=page.locator('.settings-browser__back');if(await back.isVisible())await back.click();await page.locator(`[data-settings-link=${id}]`).click();};
      await openCategory('company');
      const company=page.locator('input[name=legalName]');await company.fill('Entreprise');
      const fullLabel=page.locator('[data-settings-id=company] .field__hint').getByText(copy[language].noga,{exact:true});await fullLabel.first().waitFor();
      await openCategory('language');
      const languagePanel=page.locator('[data-settings-id=language]');
      for(const next of ['de','it','en','fr',language]) await languagePanel.getByRole('button',{name:names[next],exact:true}).click();
      await openCategory('company');assert.equal(await company.inputValue(),'Entreprise');
      await openCategory('account');await layout('account');
      const accountText=await page.locator('[data-settings-id=account]').innerText();
      if(language!=='fr')assert.equal(accountText.includes('Votre connexion Zentra'),false);
      const accountSummary=page.locator('[data-settings-id=account] summary');await accountSummary.scrollIntoViewIfNeeded();
      await page.screenshot({path:`${out}/${language}-${width}-account.png`});
      await page.locator('.screen-help-launcher').click();
      const help=page.locator('.screen-help');await help.waitFor();
      const vat={fr:'TVA',de:'MWST',it:'IVA',en:'VAT'};
      await help.locator('input[type=search]').fill(vat[language]);
      const definition=help.locator('.screen-help__words details').filter({hasNot:help.locator('.screen-help__sources')}).first();
      await definition.locator('summary').click();
      if(language!=='fr')assert.equal((await help.innerText()).includes('La taxe à déclarer sur les opérations concernées.'),false);
      assert.equal(await help.evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'Help dialog overflow');
      assert.ok(await help.locator('.screen-help__words details[open] p').first().isVisible());
      await page.screenshot({path:`${out}/${language}-${width}-help.png`});
      await help.locator('.form-actions button').click();
      if(width<1100){const labels=await page.locator('.mobile-navigation button span').allTextContents();assert.equal(labels[0],language==='de'?'Start':language==='fr'?'Accueil':'Home');}
      search=await openPalette();await search.fill(copy[language].search);
      const result=page.locator('.navigation-palette__results button').filter({has:page.getByText(copy[language].destination,{exact:true})});await result.waitFor();
      await layout('navigation search');await result.click();
      await page.locator('.desktop-app[data-view=bank]').waitFor();
      await page.reload();await page.locator('.desktop-app').waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'),`${language}-CH`);
      assert.equal(await page.evaluate(()=>localStorage.getItem('zentra.interface.language.v1')),language);
      assert.deepEqual(errors,[]);report.push({language,width,height,settingsChoice:true,draftPreserved:true,nogaHintTranslated:true,connectionAndSearchTranslated:true,financialHelp:true,mobileNavigationTranslated:true,reload:true,noClipping:true});
    }catch(error){await page.screenshot({path:`${out}/${language}-${width}-failure.png`});throw error;}
    finally{await page.close();}
  }
}catch(error){report.push({error:String(error.stack||error)});process.exitCode=1;}
finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify({engine,report}));
