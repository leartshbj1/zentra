import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const pw = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5357';
const output = '.qa/settings-discovery';
await mkdir(output, { recursive: true });
const proof = [];
const realtimeOnly = process.argv.includes('--realtime-only');
const ids = ['readiness','company','account','payroll','documents','accounting','time','migration','automation','mail','appearance','personalization','language','assistant','storage'];
for (const engine of ['chromium','webkit']) {
  const browser = await pw[engine].launch({ headless:true, ...(engine === 'chromium' ? { channel:'msedge' } : {}) });
  try {
    for (const language of (realtimeOnly ? [] : ['fr','de','it','en'])) for (const width of [320,1440]) {
      const page = await browser.newPage({ viewport:{width,height:900}, reducedMotion:'reduce' });
      page.setDefaultTimeout(15000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      await page.addInitScript(language => {
        localStorage.setItem('elyko-guided-tour-v3','completed');
        localStorage.setItem('zentra.interface.language.v1', language);
        localStorage.setItem('zentra.appearance.v1',language === 'de' ? 'dark' : 'light');
      },language);
      await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=active`);
      await page.waitForFunction(()=>Boolean(window.__TAURI_INTERNALS__));
      await page.evaluate(()=>{
        const previous=window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke=(command,args)=>command==='outgoing_mail_state'
          ? Promise.resolve({scope:'synthetic',connection:{connected:true,fromName:'Atelier du Léman',fromEmail:'contact@example.invalid',host:'mail.infomaniak.com',port:465,security:'tls',username:'contact@example.invalid'},templates:{quotes:{subject:'Devis {numero}',body:'Bonjour {client}'},invoices:{subject:'Facture {numero}',body:'Bonjour {client}'}},signature:{includeCompanyLogo:false},canConfigure:true})
          : previous(command,args);
      });
      const tr = value => page.evaluate(async value => (await import('/src/language.ts')).t(value),value);
      const navigate = async name => {
        await page.getByRole('button',{ name:await tr('Aller à un écran'),exact:true }).click();
        await page.getByRole('searchbox',{ name:await tr('Rechercher un écran'),exact:true }).fill(await tr(name));
        await page.locator('.navigation-palette__results button').filter({has:page.getByText(await tr(name),{exact:true})}).click();
      };
      const back = page.locator('.settings-browser__back');
      const index = async () => { if(width <= 1100 && await back.isVisible()) await back.click(); };
      const open = async id => { await index(); await page.locator(`[data-settings-link="${id}"]`).click(); await page.locator(`[data-settings-id="${id}"][open]`).waitFor(); };
      const capture = async name => {
        await page.evaluate(()=>window.scrollTo(0,0));
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
        await page.screenshot({path:`${output}/${name}.png`,fullPage:false});
      };
      await navigate('Paramètres');
      assert.deepEqual(await page.locator('[data-settings-link]').evaluateAll(nodes=>nodes.map(node=>node.dataset.settingsLink)),ids);
      assert.equal(await page.locator('.settings-browser__group').count(),4);
      if(language==='fr')await capture(`${engine}-${language}-${width}-overview`);
      const search = page.getByRole('searchbox',{name:await tr('Rechercher un réglage'),exact:true});
      await index();
      await search.fill({fr:'assurance',de:'Versicherung',it:'assicurazioni',en:'insurance'}[language]);
      assert.deepEqual(await page.locator('[data-settings-link]').evaluateAll(nodes=>nodes.map(node=>node.dataset.settingsLink)),['payroll']);
      assert.notEqual(await page.locator('.company-settings-sync').getAttribute('data-company-draft'),'true');
      const searched = await search.inputValue();
      const oldSearch = await search.elementHandle();
      await page.evaluate(()=>window.dispatchEvent(new Event('zentra-company-workspace-received')));
      await page.waitForFunction(node=>!node.isConnected,oldSearch);
      assert.equal(await search.inputValue(),searched);
      assert.equal(await search.evaluate(node=>node===document.activeElement),true,'Receiving data preserves search focus');
      await search.press('Enter'); await page.locator('[data-settings-id="payroll"][open]').waitFor();
      await index();
      await search.fill('logo');
      assert.deepEqual(await page.locator('[data-settings-link]').evaluateAll(nodes=>nodes.map(node=>node.dataset.settingsLink)),['company','documents','mail']);
      if(language==='fr'&&width===1440) { await page.locator('[data-settings-link="company"]').click(); await capture(`${engine}-fr-1440-search`); }
      await search.fill('zzzz_inexistant');
      await page.getByText(await tr('Aucun réglage trouvé'),{exact:true}).waitFor();
      await search.press('Escape');assert.equal(await search.inputValue(),'');
      assert.equal(await page.locator('[data-settings-link]').count(),15);
      proof.push({engine,language,width,scenario:'discover-search-and-receive',passed:true});
      // Drafts are still mounted when filtering or opening another category.
      await open('company');
      const name = page.locator('input[name="legalName"]');await name.fill('Brouillon de recette');
      await index();await search.fill('SMTP');await page.locator('[data-settings-link="mail"]').click();
      await page.locator('[data-settings-id="mail"][open]').waitFor();
      await index();await search.fill('logo');await page.locator('[data-settings-link="company"]').click();
      assert.equal(await name.inputValue(),'Brouillon de recette');
      assert.equal(await page.locator('.company-settings-sync').getAttribute('data-company-draft'),'true');
      await index();await search.fill('');
      await open('appearance');
      assert.equal(await page.locator('[data-settings-id="appearance"] h2').count(),0,'No repeated section title');
      await navigate('Clients'); await navigate('Paramètres');
      await page.locator('[data-settings-id="appearance"][open]').waitFor();
      if(width===320) { await back.click(); assert.equal(await page.locator('[data-settings-link="appearance"]').evaluate(node=>node===document.activeElement),true); }
      if(width===320) {
        await search.fill('SMTP');
        await page.evaluate(async()=>{const {revealSettingsTarget}=await import('/src/SettingsCategory.tsx');revealSettingsTarget(document.querySelector('.appearance-setting'));});
        await page.locator('[data-settings-id="appearance"][open]').waitFor();await back.click();
        await page.waitForFunction(()=>document.activeElement?.getAttribute('data-settings-link')==='appearance');
        assert.equal(await search.inputValue(),'','Returning from a direct shortcut clears an incompatible search');
      }
      proof.push({engine,language,width,scenario:'drafts-and-return',passed:true});
      await index(); await search.fill('');
      // Every category remains reachable; opening never submits a business action.
      for(const id of ids) { await open(id); assert.equal(await page.locator('.settings-category[open]').count(),1); }
      proof.push({engine,language,width,scenario:'all-fifteen-categories',passed:true});
      // Reopen the visual email panel after navigating away.
      await navigate('Clients');await navigate('Paramètres');await open('mail');
      await page.locator('.mail-fields').waitFor();
      assert.equal(await page.locator('.mail-settings>header').count(),0);
      if(language==='it'&&width===320)await capture(`${engine}-it-320-mail`);
      await open('automation');assert.equal(await page.locator('.automation-settings>header').count(),0);
      if(language==='de'&&width===1440)await capture(`${engine}-de-1440-automation`);
      if(language==='de'&&width===320) {
        await index();await page.evaluate(async()=>(await import('/src/textSize.ts')).setTextSize(200));
        await capture(`${engine}-de-320-200`);
        await search.fill('Textgrösse');await search.press('Enter');
        await page.locator('[data-settings-id="appearance"][open]').waitFor();
        await capture(`${engine}-de-320-200-appearance`);
      }
      assert.deepEqual(errors,[]);
      proof.push({engine,language,width,scenario:'embedded-headings-and-reflow',passed:true});
      await page.close();
    }
    for(const width of [390,1440]) {
      const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
      await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
      await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
      await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&companyRealtime=1`);
      await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
      await page.getByRole('searchbox',{name:'Rechercher un écran',exact:true}).fill('Paramètres');
      await page.locator('.navigation-palette__results button').filter({has:page.getByText('Paramètres',{exact:true})}).click();
      const search=page.getByRole('searchbox',{name:'Rechercher un réglage',exact:true});await search.fill('logo');
      await search.evaluate(node=>node.setSelectionRange(1,3));
      await page.evaluate(()=>window.companyRealtimeFixture.renameCompany('Entreprise reçue pendant la recherche'));
      await page.waitForFunction(()=>document.querySelector('input[name="legalName"]')?.value==='Entreprise reçue pendant la recherche',null,{timeout:8000});
      await page.waitForFunction(()=>!document.getElementById('root').inert);
      assert.equal(await search.inputValue(),'logo');
      assert.equal(await search.evaluate(node=>node===document.activeElement&&node.selectionStart===1&&node.selectionEnd===3),true);
      assert.notEqual(await page.locator('.company-settings-sync').getAttribute('data-company-draft'),'true');
      proof.push({engine,width,scenario:'automatic-reception-keeps-search-and-cursor',passed:true});await page.close();
    }
  } finally { await browser.close(); await writeFile(`${output}/${realtimeOnly?'realtime-proof':'proof'}.json`,JSON.stringify(proof,null,2)); }
}
console.log(JSON.stringify({passed:proof.length}));
