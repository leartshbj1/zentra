import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { pathToFileURL,fileURLToPath } from 'node:url';
const {chromium,webkit}=await import(pathToFileURL(process.env.ZENTRA_PLAYWRIGHT_MODULE+'/index.mjs').href);
const engine=process.env.ZENTRA_QA_BROWSER||'edge';
const out=fileURLToPath(new URL(`../../.qa/customer-credit-continuity-${engine}/`,import.meta.url));
await mkdir(out,{recursive:true});
const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='edge'?{channel:'msedge'}:{})});
const report=[];
try {
  for(const width of [320,390,768,1440]) {
    const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<800});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&customerContinuity=1`,{waitUntil:'domcontentloaded',timeout:60000});
    if(width>860)await page.getByRole('button',{name:'Ne plus afficher automatiquement',exact:true}).click();
    await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
    await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Comptabilité');
    await page.locator('.navigation-palette__results button').filter({has:page.getByText('Comptabilité',{exact:true})}).click();
    if(width<=800)await page.getByRole('combobox',{name:'Section comptable',exact:true}).selectOption('accounts');
    else await page.getByRole('tab',{name:'Plan & liaisons',exact:true}).click();
    const panel=page.locator('.customer-credit-checks');
    assert.equal(await page.getByLabel('Date de début de la période',{exact:true}).count(),0);
    await panel.locator('summary').click();
    assert.equal(await panel.locator('li').count(),8);
    await panel.getByRole('button',{name:'Afficher les 2 suivants',exact:true}).click();
    assert.equal(await panel.locator('li').count(),10);
    assert.equal(await panel.getByText('Reprise historique à valider',{exact:true}).count(),2);
    assert.equal(await panel.getByRole('button',{name:/Voir l’écriture/}).count(),1);
    await panel.locator('summary').scrollIntoViewIfNeeded();
    await page.screenshot({path:`${out}/checks-${width}.png`});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.emulateMedia({reducedMotion:'reduce'});
    await panel.locator('summary').click();await panel.locator('summary').click();
    assert.equal(await panel.locator('.customer-credit-checks__body').evaluate(node=>getComputedStyle(node).animationName),'none');
    await panel.getByRole('button',{name:'Voir l’écriture de J-2026-999',exact:true}).click();
    const entry=page.locator('[data-journal-entry-id="entry-9"]');
    await page.getByLabel('Date de début de la période',{exact:true}).waitFor();
    await page.locator('.accounting-filters').getByText('Du',{exact:true}).waitFor();
    await page.locator('.accounting-filters').getByText('Au',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.activeElement?.getAttribute('data-journal-entry-id')==='entry-9');
    assert.equal(await entry.getByRole('button',{name:'Extourner',exact:true}).count(),0);
    await entry.getByText('Correction depuis l’avoir',{exact:true}).waitFor();
    await page.screenshot({path:`${out}/journal-${width}.png`});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);report.push({width,limitedInitialList:true,allIssuesAccessible:true,missingJournalNotOffered:true,linkedJournalFocused:true,genericReversalHidden:true,reducedMotion:true,pageErrors:errors});await page.close();
  }
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();}
