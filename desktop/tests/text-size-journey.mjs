import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const engine=process.env.ZENTRA_QA_BROWSER||'chromium';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const browser=await pw[engine].launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const out=`.qa/text-size-${engine}`;await mkdir(out,{recursive:true});const report=[];let page;
const formsOnly=process.env.ZENTRA_QA_FORMS_ONLY==='1';
const accountingOnly=process.env.ZENTRA_QA_ACCOUNTING_ONLY==='1';
const sizes=[{width:320,height:740,lang:'de',theme:'dark'},{width:390,height:844,lang:'fr',theme:'light'},{width:844,height:390,lang:'it',theme:'dark'},{width:1440,height:1000,lang:'en',theme:'light'}];
const errors=[];
async function translate(value){return page.evaluate(async value=>(await import('/src/language.ts')).t(value),value);}
async function setSize(value){await page.evaluate(async value=>(await import('/src/textSize.ts')).setTextSize(value),value);await settle();}
async function settle(){await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);});}
async function inspect(name,screenshot=false){
 await page.waitForLoadState('networkidle');
 await page.locator('.page-content > .settings-cloud-status').waitFor({state:'hidden',timeout:15000});
 await settle();
 if(name==='screen-13'&&page.viewportSize().width<=860){
  const bounds=await page.locator('.section-navigation__current').evaluate(el=>{
   const control=el.getBoundingClientRect(),text=el.querySelector(':scope > span:not(.section-navigation__icon)'),arrow=el.querySelector(':scope > svg');
   const range=document.createRange();range.selectNodeContents(text);const r=range.getBoundingClientRect(),a=arrow.getBoundingClientRect();
   return {left:r.left>=control.left,right:r.right<=a.left+1,bottom:r.bottom<=control.bottom,arrow:a.right<=control.right};
  });
  assert.ok(Object.values(bounds).every(Boolean),`Accounting control contains its text and arrow: ${JSON.stringify(bounds)}`);
 }
 const issues=await page.evaluate(()=>{
  const issues=[];if(document.documentElement.scrollWidth>innerWidth+1)issues.push({type:'page-overflow'});
  for(const el of document.querySelectorAll('body *')){
   if(el.closest('[data-qa-fixture-toolbar],[aria-hidden=true],.sr-only,.print-root,.print-sheet,.print-page,.document-preview__paper,[data-document-colors],.mobile-navigation__selection')||!el.checkVisibility())continue;
   if(el.closest('table[data-mobile-cards] > thead')&&getComputedStyle(el.closest('thead')).clipPath==='inset(50%)')continue;
   if(document.querySelector('[role=dialog]')&&!el.closest('[role=dialog]'))continue;
   const r=el.getBoundingClientRect();if(!r.width||!r.height||r.bottom<0||r.top>innerHeight)continue;
   const s=getComputedStyle(el),label=(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,80);
   const scroller=el.closest('.table-panel,.document-stepper ol,.mobile-navigation__shortcuts');
   const scrollable=scroller&&['auto','scroll'].includes(getComputedStyle(scroller).overflowX);
   if((r.left < -2 || r.right>innerWidth+2)&&!scrollable&&!el.closest('.sidebar,.table-scroll,.document-preview__viewport,.section-navigation__tabs'))issues.push({type:'outside',cls:String(el.className),label,left:Math.round(r.left),right:Math.round(r.right)});
   if(!['hidden','clip'].includes(s.overflowY)&&!['hidden','clip'].includes(s.overflowX))continue;
   if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))continue;
   if(s.textOverflow==='ellipsis'||s.webkitLineClamp!=='none')continue;
   if(el.scrollHeight>el.clientHeight+3||el.scrollWidth>el.clientWidth+3)issues.push({type:'clipped',cls:String(el.className),label});
  }
  return issues;
 });
 if(screenshot)await page.screenshot({path:`${out}/${page.viewportSize().width}-${name}.png`});
 report.push({name,...page.viewportSize(),issues});console.log(name,page.viewportSize().width,issues.length);
}
async function navigate(name){
 await page.getByRole('button',{name:await translate('Aller à un écran'),exact:true}).click();
 await page.getByRole('searchbox',{name:await translate('Rechercher un écran'),exact:true}).fill(await translate(name));
 await page.locator('.navigation-palette__results button').filter({has:page.getByText(await translate(name),{exact:true})}).click();
 await settle();
}
try{
 for(const config of sizes){
  page=await browser.newPage({viewport:{width:config.width,height:config.height},hasTouch:config.width<900,reducedMotion:'reduce'});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/tests/touch-team-harness.html?view=appearance&lang='+config.lang);
  const slider=page.getByRole('slider',{name:await translate('Taille du texte')});
  const heading=page.locator('.appearance-setting h2');const normal=await heading.evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
  await slider.focus();await slider.press('End');await settle();
  assert.equal(await slider.inputValue(),'200');assert.equal(await heading.evaluate(el=>parseFloat(getComputedStyle(el).fontSize)),normal*2);
  await page.reload();assert.equal(await slider.inputValue(),'200');
  await page.evaluate(async theme=>(await import('/src/appearance.ts')).setAppearance(theme),config.theme);
  await inspect('appearance',true);
  await page.getByRole('button',{name:await translate('Revenir à 100 %')}).click();
  assert.equal(await heading.evaluate(el=>parseFloat(getComputedStyle(el).fontSize)),normal);
  await setSize(200);
  await page.goto(origin+'/tests/mobile-harness.html?browsing=1&design=1&payroll=1&automation=active&lang='+config.lang);
  await page.getByRole('button',{name:await translate('Fermer le guide automatique'),exact:true}).click();
  await page.evaluate(async lang=>(await import('/src/language.ts')).setAppLanguage(lang),config.lang);
  for(const [i,name] of ['Tableau de bord','Agenda','Projets','Clients','Produits & services','Devis','Factures','Relances','Temps','Équipe & salaires','Achats & fournisseurs','Banque','Rapports','Comptabilité','Paramètres'].entries()){
   if(formsOnly&&!['Devis','Équipe & salaires'].includes(name))continue;
   if(accountingOnly&&name!=='Comptabilité')continue;
   if(i)await navigate(name);
   await inspect(`screen-${i}`,['Paramètres','Tableau de bord','Comptabilité'].includes(name));
   if(name==='Devis'||name==='Équipe & salaires'){
    await page.getByRole('button',{name:await translate(name==='Devis'?'Nouveau devis':'Nouvelle fiche de personnel'),exact:true}).click();
    await page.getByRole('dialog').locator('input:not([hidden]):not([type=hidden])').first().waitFor({state:'visible'});
    if(name==='Devis')await page.locator('.document-editor-dialog input[name="title"]').waitFor({state:'visible'});
    await inspect(name==='Devis'?'quote-form':'employee-form',true);
    await page.getByRole('dialog').locator('.modal__header-actions > button').last().click();
   }
   if(name==='Paramètres'){
    await page.locator('[data-settings-link="appearance"]').click();await inspect('settings-appearance',true);
    const control=page.getByRole('slider');await control.focus();await control.press('Home');assert.equal(await control.inputValue(),'100');
   }
  }
  if(formsOnly||accountingOnly){await page.close();continue;}
  await setSize(200);
  if(config.width<=860){
   const shortcuts=page.locator('.mobile-navigation__shortcuts button');
   await shortcuts.last().click();await settle();assert.ok(await shortcuts.last().getAttribute('aria-current'));
   const menu=page.locator('.mobile-navigation > button');assert.ok(await menu.isVisible());
   await menu.click();await page.getByRole('button',{name:await translate('Fermer la navigation'),exact:true}).click();
   assert.ok(await menu.isVisible());
  }
  await page.evaluate(async()=>(await import('/src/automationExperience.ts')).openAutomationHub());
  await page.locator('.automation-hub').waitFor();await inspect('automation',true);
  // Document type and dimensions are invariant under the device preference.
  await page.goto(origin+'/tests/touch-team-harness.html?view=document');await settle();
  const documentStyle=()=>page.locator('.document-preview__paper').evaluate(el=>[el,...el.querySelectorAll('h1,h2,td')].map(node=>({size:getComputedStyle(node).fontSize,width:node.offsetWidth,height:node.offsetHeight})));
  await setSize(100);const before=await documentStyle();await setSize(200);assert.deepEqual(await documentStyle(),before);
  await page.emulateMedia({media:'print'});const print=await documentStyle();await setSize(100);assert.deepEqual(await documentStyle(),print);await page.emulateMedia({media:'screen'});
  report.push({name:'document-invariant',...page.viewportSize(),issues:[]});
  await page.close();
 }
 assert.deepEqual(errors,[],'No runtime errors');
 if(process.env.ZENTRA_QA_COLLECT_ONLY!=='1')assert.deepEqual(report.filter(row=>row.issues.length),[],'Text stays readable at 200%');
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:out+'/failure.png'});await writeFile(out+'/failure.json',JSON.stringify({error:String(error),text:await page.locator('body').innerText()}));}throw error;}
finally{await writeFile(out+(formsOnly?'/report-forms.json':accountingOnly?'/report-accounting.json':'/report.json'),JSON.stringify({engine,report,errors},null,2));await browser.close();}
