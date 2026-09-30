import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5355';
const output = new URL('../.impeccable/review/notes/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const results = [];
try {
  for (const [width, height, theme, language] of [[1440,1000,'light','fr'],[390,844,'light','fr'],[320,740,'dark','fr'],[390,844,'dark','de'],[390,844,'light','it'],[1440,1000,'dark','en']]) {
    const page = await browser.newPage({ viewport: {width,height}, hasTouch: width < 900 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { localStorage.setItem('elyko-guided-tour-v3','completed'); });
    await page.goto(`${base}/tests/mobile-harness.html?browsing=1&design=1&notes=1&theme=${theme}&language=${language}`, {timeout:60000});
    await page.getByRole('button',{name:language === 'de' ? 'Zu einem Bildschirm wechseln' : language === 'it' ? 'Vai a una schermata' : language === 'en' ? 'Go to a screen' : 'Aller à un écran',exact:true}).count().catch(()=>0);
    if (width < 900) await page.locator('.menu-button').click();
    await page.locator('.sidebar__nav button').filter({ has: page.getByText(/^(Notes|Notizen|Note)$/, {exact:true}) }).first().click();
    await page.locator('.notes-list__entry').first().waitFor();
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth+1),false,`${width}/${language} list overflow`);
    await page.screenshot({path:new URL(`${width}-${theme}-${language}-list.png`,output).pathname.replace(/^\/(.:)/,'$1'),fullPage:true});
    await page.locator('.notes-list__entry').first().click();
    await page.locator('.notes-editor__body').waitFor({state:'visible'});
    await page.locator('.notes-checklist summary').click();
    await page.locator('.notes-checklist input').first().check();
    assert.ok((await page.locator('.notes-editor__body').inputValue()).includes('☑ Confirmer'));
    await page.locator('.notes-editor__body').fill('Mesure finale : 3,42 m\n\nÀ confirmer avec le client vendredi.\n☐ Commander les fournitures');
    await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('notes-fixture-saved')||'null')?.body.includes('Mesure finale'));
    const saved = await page.evaluate(()=>JSON.parse(sessionStorage.getItem('notes-fixture-saved')));
    assert.ok(saved.projectId);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth+1),false,`${width}/${language} editor overflow`);
    const fields = await page.locator('.notes-editor__body').evaluate(el => { const s=getComputedStyle(el); return { background:s.backgroundColor,color:s.color,font:s.fontSize }; });
    await page.screenshot({path:new URL(`${width}-${theme}-${language}-editor.png`,output).pathname.replace(/^\/(.:)/,'$1'),fullPage:true});
    if (language === 'fr') {
      await page.locator('.notes-back').click();
      await page.locator('.notes-index__heading button').click();
      await page.locator('.notes-editor__title').fill('Observation terrain');
      await page.locator('.notes-editor__body').fill('La réservation doit être revue.');
      await page.locator('.notes-back').click();
      await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('notes-fixture-saved')||'null')?.title==='Observation terrain');
      await page.locator('.notes-list__entry').filter({hasText:'Observation terrain'}).click();
      await page.locator('.notes-editor__actions button').last().click();
      await page.locator('.notes-delete-confirm .button--danger').click();
      await page.locator('.notes-index').waitFor({state:'visible'});
      assert.equal(await page.locator('.notes-list__entry').filter({hasText:'Observation terrain'}).count(),0);
      await page.context().setOffline(true);
      await page.locator('.notes-list__entry').first().click();
      await page.locator('.notes-editor__body').fill('Modification enregistrée sans réseau.');
      await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('notes-fixture-saved')||'null')?.body==='Modification enregistrée sans réseau.');
    }
    assert.deepEqual(errors,[]);
    results.push({width,theme,language,fields,passed:true});
    await page.close();
  }
  await writeFile(new URL('journey.json',output), JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally { await browser.close(); }
