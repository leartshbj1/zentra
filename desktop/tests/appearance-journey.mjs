import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const engine=process.env.ZENTRA_QA_BROWSER||'chromium';
const playwright=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const browser=await playwright[engine].launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5272';
const out=`.qa/appearance165-${engine}`;await mkdir(out,{recursive:true});const report=[];let page;
const properties=['fill','stroke','color','backgroundColor','backgroundImage','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','outlineColor','boxShadow','filter','colorScheme','webkitTextFillColor'];
async function settle(){await page.evaluate(async()=>{document.activeElement?.blur?.();await new Promise(requestAnimationFrame);await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);});}
async function theme(value){await page.evaluate(async value=>(await import('/src/appearance.ts')).setAppearance(value),value);await page.waitForTimeout(220);await settle();}
async function snapshot(){return page.evaluate(properties=>[...document.querySelectorAll('html,body,body *')].flatMap((el,i)=>[null,'::before','::after'].map(pseudo=>{const s=getComputedStyle(el,pseudo);return {element:`${i}:${el.tagName}.${el.className}:${pseudo}`,style:properties.map(p=>s[p])}})),properties);}
async function contrast(){return page.evaluate(()=>{
 const rgba=s=>{const v=s.match(/[\d.]+/g)?.map(Number);return v&&v.length>=3?[v[0],v[1],v[2],v[3]??1]:[0,0,0,0]};
 const blend=(a,b)=>a.slice(0,3).map((v,i)=>v*a[3]+b[i]*(1-a[3]));
 const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const bg=el=>{const c=rgba(getComputedStyle(el).backgroundColor);return c[3]===1?c:blend(c,el.parentElement?bg(el.parentElement):[20,20,22])};
 const seen=new Set(),results=[];
 for(const el of document.querySelectorAll('body *')){
  if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())||el.closest('.print-root,.print-sheet,.print-page,.document-preview__paper,[data-document-colors],button:disabled,fieldset:disabled,[aria-hidden=true]'))continue;
  const rect=el.getBoundingClientRect(),s=getComputedStyle(el);if(!rect.width||!rect.height||s.visibility==='hidden'||!el.checkVisibility())continue;
  const back=bg(el),a=lum(back),b=lum(blend(rgba(s.color),back)),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  const key=el.className+'|'+s.color+'|'+back.join(',');if(seen.has(key))continue;seen.add(key);
  const large=parseFloat(s.fontSize)>=24||parseFloat(s.fontSize)>=18.66&&parseFloat(s.fontWeight)>=700;
  if(ratio<(large?3:4.5))results.push({cls:el.className,text:el.textContent.trim().slice(0,80),color:s.color,bg:back,ratio:Math.round(ratio*100)/100});
 }return results.sort((a,b)=>a.ratio-b.ratio);
 });}
async function check(name,screenshot=false){
 await page.waitForLoadState('networkidle');await theme('light');await page.waitForTimeout(600);await settle();const before=await snapshot();
 await theme('dark');const low=await contrast();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name}: horizontal overflow`);
 if(screenshot)await page.screenshot({path:`${out}/${page.viewportSize().width}-${name.replace(/[^a-zA-Z0-9]/g,'_')}.png`});
 await theme('light');const after=await snapshot();

 const differences=after.filter((row,i)=>JSON.stringify(row)!==JSON.stringify(before[i]));if(differences.length)await writeFile(out+'/last-snapshot.json',JSON.stringify({name,before,after}));
 assert.equal(differences.length,0,`${name}: ${JSON.stringify(differences.slice(0,3))}`);
 assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(245, 245, 247)');
 report.push({name,width:page.viewportSize().width,restoredElements:after.length/3,low});console.log(name,page.viewportSize().width,low.length);
}
try{
 for(const viewport of [{width:320,height:740},{width:390,height:844},{width:1440,height:1000}]){
  page=await browser.newPage({viewport,hasTouch:viewport.width<900,reducedMotion:'reduce',colorScheme:'light'});page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/tests/touch-team-harness.html?view=appearance');
  await page.getByRole('button',{name:'Sombre',exact:true}).click();await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-app-theme'),'dark');
  assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(20, 20, 22)');
  await page.getByRole('button',{name:'Clair',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.appTheme==='light');await settle();
  assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(245, 245, 247)');
  await page.getByRole('button',{name:'Automatique',exact:true}).click();
  for(const value of ['dark','light','dark','light']){await page.emulateMedia({colorScheme:value});await page.waitForFunction(v=>document.documentElement.dataset.appTheme===v,value);}
  await check('Appearance',true);
  await page.goto(origin+'/tests/mobile-harness.html?browsing=1&design=1&payroll=1');
  await page.getByRole('button',{name:'Fermer le guide automatique',exact:true}).click();
  const names=['Tableau de bord','Agenda','Projets','Clients','Produits & services','Devis','Factures','Relances','Temps','Équipe & salaires','Achats & fournisseurs','Banque','Rapports','Comptabilité','Paramètres'];
  for(const name of names){
   if(name!=='Tableau de bord'){
    await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
    await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill(name);
    await page.locator('.navigation-palette__results button').filter({has:page.getByText(name,{exact:true})}).click();
   }
   await page.waitForTimeout(250);await check(name,true);
   if(name==='Équipe & salaires'){
    await page.getByRole('button',{name:'Nouveau collaborateur',exact:true}).click();await check('Employee-form',true);assert.equal(await page.locator('.payroll-steps').evaluate(el=>getComputedStyle(el).listStyleType),'none');await page.getByRole('dialog').getByRole('button',{name:/^Fermer /}).click();
    for(const label of ['Fiches de salaire','Certificats annuels']){await page.locator('.team-navigation button').filter({hasText:label}).click();await check('Team-'+label,true);}
   }
   if(name==='Devis'||name==='Factures'){
    await page.getByRole('button',{name:name==='Devis'?'Nouveau devis':'Nouvelle facture',exact:true}).click();await check(name+'-form',true);assert.equal(await page.locator('.document-wizard-footer .button').first().evaluate(el=>{const node=[...el.childNodes].find(n=>n.nodeType===3&&n.textContent.trim());if(!node)return 1;const range=document.createRange();range.selectNodeContents(node);return range.getClientRects().length;}),1,'Cancel label fits on one line');await page.getByRole('dialog').getByRole('button',{name:/^Fermer /}).click();
   }
   if(name==='Comptabilité'){
    for(const label of ['Résultat','TVA','Dossier de clôture']){const compact=page.getByRole('combobox',{name:'Section comptable',exact:true});if(await compact.isVisible())await compact.selectOption({label});else await page.getByRole('tab',{name:label,exact:true}).click();await check('Accounting-'+label,true);}
    const picker=page.getByRole('combobox',{name:'Autres outils comptables'});
    const values=await picker.locator('option').evaluateAll(els=>els.map(e=>e.value).filter(Boolean));
    for(const value of values){await picker.selectOption(value);await check('Accounting-'+value);}
   }
   if(name==='Paramètres'){
    const ids=await page.locator('[data-settings-id]').evaluateAll(els=>els.map(el=>el.dataset.settingsId));
    for(const id of ids){const back=page.locator('.settings-browser__back');if(await back.isVisible())await back.click();await page.locator('[data-settings-link="'+id+'"]').click();await page.waitForTimeout(350);await check('Settings-'+id);}
   }
  }
  for(const view of ['account','join','document','image','pdf']){
   await page.goto(origin+'/tests/touch-team-harness.html?view='+view);await page.waitForTimeout(350);
   if(view==='pdf')await page.locator('.pdf-attachment-preview__page canvas').waitFor();
   await check(view,true);
   if(view==='document'){
    await theme('dark');assert.equal(await page.locator('.document-preview__paper').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
    assert.equal(await page.locator('.document-preview__header').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(35, 35, 38)');
    await page.emulateMedia({media:'print'});await settle();const darkPrint=await page.locator('.document-preview__paper').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
    await theme('light');assert.deepEqual(await page.locator('.document-preview__paper').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color})),darkPrint);
    await page.emulateMedia({media:'screen'});
   }
  }
  assert.deepEqual(errors,[]);await page.close();
 }
 assert.deepEqual(report.filter(row=>row.low.length),[],'Readable text contrast on every checked screen');
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:out+'/failure.png'});await writeFile(out+'/failure.json',JSON.stringify({error:String(error),text:await page.locator('body').innerText()}));}throw error;}
finally{await writeFile(out+'/report.json',JSON.stringify(report,null,2));await browser.close();}
