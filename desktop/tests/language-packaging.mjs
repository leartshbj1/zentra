import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,readdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357',proof=[];
const de=(await readdir('dist/assets')).find(file=>/^language-de-.*\.json$/.test(file));
const body=await readFile('dist/assets/'+de,'utf8');
for(const engine of ['chromium','webkit']) {
  const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
  try {
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),page=await context.newPage();
    await page.goto(origin+'/tests/language-loading.html');
    await page.getByRole('heading',{name:'Paramètres',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'Saisie de recette'}).fill('Brouillon hors ligne à conserver');
    // The browser preview uses HTTP, unlike a packaged Tauri asset. Offline HTTP must
    // show recovery without losing the draft; retry reads the exact built JSON bytes.
    await page.route('**/__zentra-language/de.json',route=>route.fulfill({contentType:'application/json',body}));
    await context.setOffline(true);
    await page.getByRole('button',{name:'Deutsch',exact:true}).click();
    await page.waitForFunction(()=>document.documentElement.lang==='de-CH'||[...document.querySelectorAll('button')].some(button=>button.textContent==='Erneut versuchen'));
    assert.equal(await page.evaluate(()=>navigator.onLine),false);
    assert.equal(await page.getByRole('textbox',{name:'Saisie de recette'}).inputValue(),'Brouillon hors ligne à conserver');
    const neededRetry=await page.getByRole('button',{name:'Erneut versuchen',exact:true}).isVisible();
    await context.setOffline(false);
    if(neededRetry) await page.getByRole('button',{name:'Erneut versuchen',exact:true}).click();
    await page.getByRole('heading',{name:'Einstellungen',exact:true}).waitFor();
    proof.push({engine,case:'web-preview-offline-with-packaged-json',neededRetry,file:de,nativeOfflineVerified:false});await context.close();
    const startup=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),start=await startup.newPage();
    await start.addInitScript(()=>{localStorage.setItem('zentra.interface.language.v1','de');localStorage.setItem('zentra.appearance.v1','dark');});
    let failed=true;await start.route('**/__zentra-language/de.json',route=>failed?route.fulfill({status:503,body:'unavailable'}):route.continue());
    await start.goto(origin+'/tests/language-loading.html');
    await start.getByRole('button',{name:'Erneut versuchen',exact:true}).waitFor();
    assert.equal(await start.getByRole('textbox').count(),0);
    await start.evaluate(()=>{
      const root=document.documentElement;
      for(const [side,value] of Object.entries({top:'80px',right:'44px',bottom:'60px',left:'44px'})) root.style.setProperty('--safe-'+side,value);
    });
    await start.waitForFunction(()=>getComputedStyle(document.querySelector('.language-boot')).paddingTop==='80px');
    const padding=await start.evaluate(()=>{
      const style=getComputedStyle(document.querySelector('.language-boot'));
      return [style.paddingTop,style.paddingRight,style.paddingBottom,style.paddingLeft];
    });
    assert.deepEqual(padding,['80px','44px','60px','44px']);
    assert.equal(await start.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await start.screenshot({path:`.qa/language-loading/screens/${engine}-boot-error-dark.png`});
    failed=false;await start.getByRole('button',{name:'Erneut versuchen',exact:true}).click();
    await start.getByRole('heading',{name:'Einstellungen',exact:true}).waitFor();
    proof.push({engine,case:'cold-boot-error-retry',simulatedNativeInsets:padding});await startup.close();
  } finally {await browser.close();}
}
await writeFile('.qa/language-loading/packaging-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
