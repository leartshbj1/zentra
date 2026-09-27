import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const output='.qa/language-loading'; await mkdir(output+'/screens',{recursive:true});
const proof=[];
for(const engine of ['chromium','webkit']) {
  const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
  try { for(const [width,theme] of [[320,'light'],[390,'dark'],[1440,'light']]) {
    const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
    const page=await context.newPage(),errors=[],assets=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
    await page.addInitScript(theme=>{localStorage.setItem('zentra.appearance.v1',theme);localStorage.setItem('zentra.interface.language.v1','fr');},theme);
    page.on('request',request=>{if(request.url().includes('/__zentra-language/'))assets.push(request.url());});
    await page.goto(origin+'/tests/language-loading.html');
    await page.getByRole('heading',{name:'Paramètres',exact:true}).waitFor();
    await page.evaluate(async theme=>(await import('/src/appearance.ts')).setAppearance(theme),theme);
    assert.equal(assets.length,0,'French should not fetch any translated pack');
    await page.getByRole('textbox',{name:'Saisie de recette'}).fill('Entreprise fictive · Ne pas perdre {client}');
    let fail=true;
    await page.route('**/__zentra-language/it.json',route=>fail?route.fulfill({status:503,body:'unavailable'}):route.continue());
    await page.getByRole('button',{name:'Italiano',exact:true}).click();
    await page.getByRole('button',{name:'Riprova',exact:true}).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'),'fr-CH');
    await page.screenshot({path:`${output}/screens/${engine}-${width}-error.png`});
    fail=false; await page.getByRole('button',{name:'Riprova',exact:true}).click();
    await page.waitForFunction(()=>document.documentElement.lang==='it-CH');
    assert.equal(await page.getByRole('textbox',{name:'Saisie de recette'}).inputValue(),'Entreprise fictive · Ne pas perdre {client}');
    await page.getByRole('button',{name:'Français',exact:true}).click(); await page.waitForFunction(()=>document.documentElement.lang==='fr-CH');
    await page.getByRole('button',{name:'Italiano',exact:true}).click(); await page.waitForFunction(()=>document.documentElement.lang==='it-CH');
    assert.equal(assets.length,2,'Retry once, then reuse the local successful pack');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:`${output}/screens/${engine}-${width}-ready.png`});
    proof.push({engine,width,theme,case:'failure-retry-draft-cache',requests:assets.length,errors}); assert.deepEqual(errors,[]);
    await context.close();
  }
  // Cold boot exercises the production gate, including StrictMode and delayed local reads.
  for(const initial of ['de','en']) {
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),page=await context.newPage();
    await page.addInitScript(initial=>localStorage.setItem('zentra.interface.language.v1',initial),initial);
    let release; const waiting=new Promise(resolve=>{release=resolve;});
    await page.route(`**/__zentra-language/${initial}.json`,async route=>{await waiting;await route.continue();});
    await page.goto(origin+'/tests/language-loading.html',{waitUntil:'domcontentloaded'});
    await page.locator('.language-boot .language-feedback').waitFor();
    assert.equal(await page.getByRole('textbox',{name:'Saisie de recette'}).count(),0);
    assert.equal(await page.locator('html').getAttribute('lang'),initial+'-CH');
    await page.screenshot({path:`${output}/screens/${engine}-boot-${initial}.png`});
    release(); await page.getByRole('textbox',{name:'Saisie de recette'}).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'),initial+'-CH');
    assert.equal(await page.getByRole('heading',{level:1}).innerText(),initial==='de'?'Einstellungen':'Settings');
    proof.push({engine,case:'stored-language-first-render',initial}); await context.close();
  }
  // Real onboarding fields survive both a failed language switch and successful retry.
  const context=await browser.newContext({viewport:{width:engine==='webkit'?390:1440,height:900},reducedMotion:'reduce'}),page=await context.newPage();
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.goto(origin+'/tests/onboarding-preview.html?language=fr');
  const settings=await page.evaluate(async()=>(await import('/src/onboardingDraft.ts')).initialOnboardingSettings);
  await page.addInitScript(settings=>{
    localStorage.setItem('zentra.onboarding.draft.v2',JSON.stringify({version:2,step:2,highestStep:2,settings,categoriesText:'',vatText:'',privacyConfirmed:false}));
  },settings); await page.reload();
  const field=page.locator('[data-field="organization.legalName"]'); await field.fill('Atelier de recette à conserver');
  let fail=true; await page.route('**/__zentra-language/en.json',route=>fail?route.fulfill({status:503,body:'unavailable'}):route.continue());
  await page.locator('.first-run__preferences select').first().selectOption('en');
  await page.getByRole('button',{name:'Try again',exact:true}).waitFor();
  await page.screenshot({path:`${output}/screens/${engine}-onboarding-error.png`});
  fail=false;await page.getByRole('button',{name:'Try again',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.lang==='en-CH');
  assert.equal(await field.inputValue(),'Atelier de recette à conserver');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:`${output}/screens/${engine}-onboarding-ready.png`});
  proof.push({engine,case:'actual-onboarding-draft-preserved'});await context.close();
  } finally {await browser.close();}
}
const files=(await readdir('dist/assets')).filter(file=>/^language-(de|it|en)-.*\.json$/.test(file));
assert.equal(files.length,3);
const packs=[];
for(const file of files) {const buffer=await readFile('dist/assets/'+file),data=JSON.parse(buffer);packs.push({file,bytes:buffer.length,keys:Object.keys(data).length});assert.ok(Object.keys(data).length>1000);}
assert.equal(new Set(packs.map(pack=>pack.keys)).size,1);
await writeFile(output+'/browser-proof.json',JSON.stringify({scope:'Local Chromium/Edge and WebKit fixtures; no physical device or backend proof',proof,packagedAssets:packs},null,2));
console.log(JSON.stringify({cases:proof.length,packagedAssets:packs}));
