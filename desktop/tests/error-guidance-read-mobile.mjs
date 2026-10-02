import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5414';
const output=process.env.ZENTRA_QA_OUTPUT||join(tmpdir(),'zentra-read-guidance-mobile-20261002');
const copy={
  fr:{timeout:'Cette vérification prend trop de temps. Vos données sont conservées.',retry:'Réessayer la vérification',action:'Réessayez le chargement. Si le problème persiste, communiquez le code d’incident au support.'},
  de:{timeout:'Diese Prüfung dauert zu lange. Ihre Daten bleiben erhalten.',retry:'Prüfung erneut versuchen',action:'Laden Sie die Informationen erneut. Falls das Problem bleibt, geben Sie dem Support den Vorfallcode.'},
  it:{timeout:'Questa verifica richiede troppo tempo. I tuoi dati sono conservati.',retry:'Riprova la verifica',action:'Riprova a caricare le informazioni. Se il problema persiste, comunica il codice incidente all’assistenza.'},
  en:{timeout:'This check is taking too long. Your data is preserved.',retry:'Retry account check',action:'Try loading the information again. If the problem continues, give the incident code to support.'},
};
await mkdir(output,{recursive:true});

async function targets(page,language){
  return page.evaluate(language=>{
    const retry=document.querySelector('.draft-identity-splash > button'),assistant=document.querySelector('.assistant-launcher');
    if(!retry||!assistant)throw Error('Expected identity retry and assistant');
    const bounds=retry.getBoundingClientRect(),help=assistant.getBoundingClientRect();
    const visibility=assistant.style.visibility;assistant.style.visibility='hidden';
    const controls=[];
    try{for(const control of document.querySelectorAll('.draft-identity-splash button, .draft-identity-splash summary')){
      const rect=control.getBoundingClientRect(),pixels=[];
      for(let y=Math.ceil(rect.top);y<rect.bottom;y++)for(let x=Math.ceil(rect.left);x<rect.right;x++){
        const node=document.elementFromPoint(x+.5,y+.5);if(node&&control.contains(node))pixels.push([x+.5,y+.5]);
      }
      controls.push({control,pixels});
    }}finally{assistant.style.visibility=visibility;}
    const checked=controls.map(({control,pixels})=>({label:control.textContent,testedPixels:pixels.length,occludedPixels:pixels.filter(([x,y])=>{const node=document.elementFromPoint(x,y);return !node||!control.contains(node);}).length}));
    const checkedRetry=checked.find(control=>control.label===retry.textContent);
    const color=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
    const luminance=rgb=>rgb.map(c=>c/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((total,c,i)=>total+c*[.2126,.7152,.0722][i],0);
    const contrast=node=>{const style=getComputedStyle(node),a=luminance(color(style.color)),b=luminance(color(style.backgroundColor));return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
    const paragraph=document.querySelector('.error-guidance__recovery'),panel=document.querySelector('.error-guidance');
    const ink=luminance(color(getComputedStyle(paragraph).color)),surface=luminance(color(getComputedStyle(panel).backgroundColor));
    return{language,viewport:innerWidth,viewportHeight:innerHeight,document:document.documentElement.scrollWidth,body:document.body.scrollWidth,retry:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},assistant:{x:help.x,y:help.y,width:help.width,height:help.height},testedPixels:checkedRetry.testedPixels,occludedPixels:checkedRetry.occludedPixels,controls:checked,retryContrast:contrast(retry),textContrast:(Math.max(ink,surface)+.05)/(Math.min(ink,surface)+.05),mobileNavigation:!!document.querySelector('.mobile-navigation'),dockedAssistant:!!document.querySelector('.assistant-launcher--docked')};
  },language);
}
async function run(engine){
  const browser=await pw[engine].launch({headless:true,...engine==='chromium'&&process.platform==='win32'?{executablePath:process.env.ZENTRA_EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{}});
  const result={engine,cases:[],errors:[],blocked:[],prompts:[]};let page;
  try{
    for(const viewport of[{width:320,height:844},{width:390,height:844},{width:320,height:667},{width:320,height:667,safeTop:20,safeBottom:34}])for(const language of Object.keys(copy)){
      const {width,height,safeTop=0,safeBottom=0}=viewport,name=`${engine}-${width}x${height}-${language}-safe${safeTop}-${safeBottom}`;page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});page.setDefaultTimeout(10000);
      page.on('pageerror',e=>result.errors.push(e.message));page.on('dialog',async d=>{result.prompts.push(d.message());await d.dismiss();});
      await page.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin!==origin||u.pathname.startsWith('/api/')){result.blocked.push(u.origin+u.pathname);return r.abort();}return r.continue();});
      await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));await page.clock.install();
      await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1&language=${language}`,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>window.__qaAppDraftIdentity?.proof.identityReads.some(read=>read.pending));
      if(safeTop||safeBottom)await page.evaluate(({safeTop,safeBottom})=>{document.documentElement.style.setProperty('--safe-top',`${safeTop}px`);document.documentElement.style.setProperty('--safe-bottom',`${safeBottom}px`);},{safeTop,safeBottom});
      await page.clock.fastForward(15020);await page.getByRole('alert').getByText(copy[language].timeout,{exact:true}).waitFor();
      assert.equal(await page.locator('.error-guidance__recovery').textContent(),copy[language].action);
      const failure=await page.evaluate(()=>window.__qaAppDraftIdentity.diagnostics().filter(event=>event.phase==='failure').at(-1));
      const incident=await page.locator('.error-guidance__incident code').textContent();assert.equal(incident,`ZT-${failure.id}`);
      const otherLanguage=language==='fr'?'de':'fr';
      await page.evaluate(async language=>{const module=await import('/src/language.ts');await module.setAppLanguage(language);},otherLanguage);
      await page.locator('.error-guidance__recovery').getByText(copy[otherLanguage].action,{exact:true}).waitFor();assert.equal(await page.locator('.error-guidance__incident code').textContent(),incident,'Language rerender preserves the failed read reference');
      await page.evaluate(async language=>{const module=await import('/src/language.ts');await module.setAppLanguage(language);},language);
      await page.getByRole('button',{name:copy[language].retry,exact:true}).waitFor();
      // Use the browser's existing scroll when the small viewport has a fold;
      // no production height, visibility or scrolling behavior is changed.
      await page.getByRole('button',{name:copy[language].retry,exact:true}).scrollIntoViewIfNeeded();
      await page.evaluate(()=>{const rect=document.querySelector('.draft-identity-splash > button').getBoundingClientRect();if(rect.bottom>innerHeight)window.scrollBy(0,Math.ceil(rect.bottom-innerHeight));});
      const geometry=await targets(page,language);result.pendingCase={width,height,safeTop,safeBottom,geometry};assert.equal(geometry.mobileNavigation,false);assert.equal(geometry.dockedAssistant,false);
      assert.equal(geometry.occludedPixels,0);for(const control of geometry.controls){assert.ok(control.testedPixels>0);assert.equal(control.occludedPixels,0);}assert.ok(geometry.testedPixels>0);assert.ok(geometry.document<=width+1&&geometry.body<=width+1);assert.ok(geometry.retry.x>=0&&geometry.retry.x+geometry.retry.width<=width+1);assert.ok(geometry.retry.y>=0&&geometry.retry.y+geometry.retry.height<=height+1);
      assert.ok(geometry.retry.height>=44);assert.ok(geometry.assistant.width>=44&&geometry.assistant.height>=44);assert.ok(geometry.retryContrast>=4.5&&geometry.textContrast>=4.5);
      await page.screenshot({path:join(output,`${name}-timeout.png`)});
      // DE 320 uses the exact previously intercepted physical point.
      if(width===320&&height===844&&language==='de')await page.mouse.click(engine==='chromium'?257.5:258.5,728.5);
      else await page.getByRole('button',{name:copy[language].retry,exact:true}).click();
      await page.waitForFunction(()=>window.__qaAppDraftIdentity.proof.identityReads.length===2);assert.equal(await page.locator('.zentra-assistant-dialog').count(),0);
      await page.clock.fastForward(15020);await page.getByRole('alert').getByText(copy[language].timeout,{exact:true}).waitFor();
      const secondFailure=await page.evaluate(()=>window.__qaAppDraftIdentity.diagnostics().filter(event=>event.phase==='failure').at(-1));
      const secondIncident=await page.locator('.error-guidance__incident code').textContent();assert.equal(secondIncident,`ZT-${secondFailure.id}`);assert.notEqual(secondIncident,incident,'A fresh retry identifies its own failed read');
      const help=await page.locator('.assistant-launcher').boundingBox();await page.mouse.click(help.x+help.width/2,help.y+help.height/2);await page.locator('.zentra-assistant-dialog').waitFor();
      result.cases.push({width,height,safeTop,safeBottom,language,...geometry,incidentCodeMatched:true,incidentStableAcrossLanguage:true,retryReads:2,assistantAccessible:true});delete result.pendingCase;await page.close();
    }
    // The normal navigation still keeps its existing 88 px dock clearance.
    page=await browser.newPage({viewport:{width:320,height:844},reducedMotion:'reduce'});
    await page.route('**/*',r=>{const u=new URL(r.request().url());return u.origin===origin&&!u.pathname.startsWith('/api/')?r.continue():r.abort();});
    await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup`,{waitUntil:'domcontentloaded'});await page.locator('.desktop-app').waitFor();
    const normal=await page.evaluate(()=>{const assistant=document.querySelector('.assistant-launcher'),floating=assistant.cloneNode(true);floating.classList.remove('assistant-launcher--docked');document.body.append(floating);const floatingBottom=getComputedStyle(floating).bottom;floating.remove();return{identitySplash:!!document.querySelector('.draft-identity-splash'),bottom:getComputedStyle(assistant).bottom,docked:assistant.classList.contains('assistant-launcher--docked'),position:getComputedStyle(assistant).position,floatingBottom,mobileNavigation:!!document.querySelector('.mobile-navigation')};});
    assert.equal(normal.identitySplash,false);assert.equal(normal.floatingBottom,'88px');assert.equal(normal.mobileNavigation,true);if(normal.docked){assert.equal(normal.bottom,'auto');assert.equal(normal.position,'static');}result.normalNavigation=normal;
    assert.deepEqual(result.errors,[]);assert.deepEqual(result.blocked,[]);assert.deepEqual(result.prompts,[]);result.passed=true;
  }catch(e){result.passed=false;result.failure=e.stack;if(page&&!page.isClosed())await page.screenshot({path:join(output,`${engine}-failure.png`)});}finally{await browser.close();}return result;
}
const results=await Promise.all(['chromium','webkit'].map(run));
await writeFile(join(output,'report.json'),JSON.stringify({origin,transport:'strictly synthetic',component:'real App/ErrorGuidance, StrictMode',results},null,2));
console.log(JSON.stringify({output,results:results.map(({engine,cases,passed,failure,errors,blocked,prompts,normalNavigation})=>({engine,cases:cases.length,passed,failure,errors,blocked,prompts,normalNavigation}))},null,2));if(results.some(result=>!result.passed))process.exitCode=1;
