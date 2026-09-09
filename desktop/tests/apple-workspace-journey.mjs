import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const output = new URL('../../.qa/apple-workspace/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const results = [];
try {
  for (const viewport of [{width:1440,height:1000},{width:1024,height:800},{width:390,height:844},{width:320,height:568},{width:844,height:390}]) {
    const page = await browser.newPage({viewport, hasTouch: viewport.width < 900});
    page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&design=1`, {timeout:60000});
    const guide = page.getByRole('dialog', {name:'Bienvenue dans votre espace'});
    await guide.waitFor();
    await page.waitForTimeout(450);
    const footerBounds = await page.locator(".guided-tour__card footer").boundingBox();
    assert.ok(footerBounds && footerBounds.y >= 0 && footerBounds.y + footerBounds.height <= viewport.height, "Guide controls stay in view");
    assert.equal(await page.locator('.app-main').evaluate(el=>el.inert), true);
    await page.screenshot({path:new URL(`${viewport.width}-welcome.png`,output).pathname.replace(/^\/(.:)/,'$1')});
    await page.getByRole('button',{name:'Découvrir plus tard',exact:true}).click();
    assert.equal(await page.locator('.app-main').evaluate(el=>el.inert), false);
    const navigate = async name => {
      await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
      await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill(name);
      await page.locator('.navigation-palette__results button').filter({has:page.getByText(name,{exact:true})}).click();
    };
    const check = async stage => {
      await page.waitForTimeout(400);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 1), `${viewport.width} overflow at ${stage}`);
      await page.screenshot({path:new URL(`${viewport.width}-${stage}.png`,output).pathname.replace(/^\/(.:)/,'$1')});
    };
    await check('dashboard');
    for (const module of ['Projets','Devis','Factures','Équipe & salaires']) { await navigate(module); await check(module.replaceAll(/[^a-zA-Z]/g,'')); }
    await page.getByRole('button',{name:'Ouvrir le guide complet',exact:true}).click();
    const subject = page.getByRole('combobox',{name:'Choisir un sujet du guide'});
    const options = await subject.locator('option').count();
    assert.equal(options,16);
    for (let index=0;index<options;index++) {
      await subject.selectOption(String(index));
      assert.equal(await page.locator('.guided-tour__actions li').count(),3);
      assert.equal(await page.locator('.app-main').evaluate(el=>el.inert),true);
    }
    await subject.selectOption('4');
    await page.getByRole('button',{name:'Reprendre plus tard',exact:true}).click();
    await page.getByRole('button',{name:'Ouvrir le guide complet',exact:true}).click();
    assert.equal(await subject.inputValue(),'4');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.app-main').evaluate(el=>el.inert),false);
    await page.emulateMedia({reducedMotion:'reduce'});
    await navigate('Devis');
    assert.equal(await page.locator('.page-content').evaluate(el=>getComputedStyle(el).animationName),'none');
    await page.getByRole('button',{name:'Nouveau devis',exact:true}).click();
    await page.getByRole('dialog',{name:'Nouveau devis',exact:true}).waitFor();
    await check('editor');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors,[]);
    results.push({viewport,guideSubjects:options,resume:true,reducedMotion:true,passed:true});
    await page.close();
  }
} finally { await browser.close(); await writeFile(new URL('results.json',output),JSON.stringify(results,null,2)); }
console.log(results);
