import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
const {chromium, webkit} = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5357';
const output = '.qa/empty-screens';
const shots = '.impeccable/review/empty-screens';
await mkdir(output, {recursive:true}); await mkdir(shots, {recursive:true});
const report=[];
const words={fr:['Actifs','Archivés','Nouvelle référence','Vos produits et prestations'],de:['Aktiv','Archiviert','Neuer Artikel','Ihre Produkte und Dienstleistungen'],it:['Attivi','Archiviati','Nuova voce','I tuoi prodotti e servizi'],en:['Active','Archived','New item','Your products and services']};
const client={id:'empty-client',name:'Camille Martin',company:'Atelier TEST',email:'client@example.invalid',phone:'',address:'Lausanne',notes:'',archivedAt:null};
const item={id:'empty-item',kind:'service',sku:'TEST',name:'Conseil de recette',description:'Données fictives',unit:'h',salesPriceCents:9500,purchaseCostCents:0,vatBp:810,trackStock:false,stockQuantityMilli:0,reorderLevelMilli:0,archivedAt:null,createdAt:'',updatedAt:''};
const translate=(page,text)=>page.evaluate(text=>window.__emptyScreensTranslate(text),text);
async function navigate(page,label,view){
 await page.locator('.navigation-launcher:visible,.sidebar__search:visible').first().click();
 const name=await translate(page,label);
 await page.locator('.navigation-palette__search input').fill(name);
 await page.locator('.navigation-palette__results button').filter({has:page.getByText(name,{exact:true})}).click();
 await page.locator(`.desktop-app[data-view="${view}"]`).waitFor();
}
async function check(page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'no horizontal overflow');}
async function shot(page,name){await check(page);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`${shots}/${name}.png`});}
for(const [engine,type] of [['edge',chromium],['webkit',webkit]]){
 const browser=await type.launch({headless:true,...(engine==='edge'?{channel:'msedge'}:{})});
 try{for(const [width,language] of [[320,'de'],[390,'fr'],[390,'it'],[1440,'en']]){
 const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(7000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
 await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
 try{
 await page.goto(`${origin}/tests/mobile-harness.html?emptyScreens=1&language=${language}&theme=${width===320?'dark':'light'}`);
 await navigate(page,'Produits & services','catalog');
 await page.locator('.catalog-screen').waitFor();
 assert.equal(await page.locator('.catalog-summary,.catalog-filters').count(),0);
 assert.equal(await page.locator('.global-search').count(),0);
 assert.equal(await page.getByRole('button',{name:words[language][2],exact:true}).count(),1);
 await page.getByRole('heading',{name:words[language][3],exact:true}).waitFor();
 assert.equal(await page.locator('.empty-state button').count(),0);
 if(engine==='webkit'&&width===320)await shot(page,'mobile-de-catalog');
 if(engine==='webkit'&&width===390&&language==='fr')await shot(page,'mobile-catalog');
 if(engine==='edge'&&width===1440)await shot(page,'desktop-catalog');
 await page.getByRole('button',{name:words[language][2],exact:true}).click();
 await page.locator('form.catalog-form [name=name]').focus();await page.keyboard.press('Escape');await page.locator('form.catalog-form').waitFor({state:'hidden'});
 await page.getByRole('button',{name:await translate(page,'Importer Excel'),exact:true}).click();
 await page.getByRole('dialog').focus();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.evaluate(item=>window.__emptyScreensPatch({catalogItems:[item]}),item);
 await page.locator('.catalog-filters').waitFor();await page.locator('.catalog-filter-search input').fill('aucune-reference');
 await page.evaluate(()=>window.__qaSetReadOnly(true));
 await page.waitForFunction(()=>document.querySelector('.catalog-heading-actions .button--primary')?.disabled===true);
 const reset=page.getByRole('button',{name:await translate(page,'Réinitialiser les filtres'),exact:true});assert.equal(await reset.isEnabled(),true);await reset.click();
 await page.locator('.catalog-item').waitFor();assert.equal(await page.getByRole('button',{name:words[language][2],exact:true}).isDisabled(),true);
 await page.evaluate(()=>window.__qaSetReadOnly(false));await page.waitForFunction(()=>document.querySelector('.catalog-heading-actions .button--primary')?.disabled===false);
 await check(page);
 await navigate(page,'Clients','clients');
 assert.equal(await page.locator('.empty-state button').count(),0);assert.equal(await page.locator('.global-search').count(),0);
 await page.evaluate(client=>window.__emptyScreensPatch({clients:[client]}),client);
 await page.locator('.client-directory-toolbar').waitFor();
 await page.getByRole('button',{name:new RegExp('^'+words[language][0]+' ')}).waitFor();
 const archived=page.getByRole('button',{name:new RegExp('^'+words[language][1]+' ')});await archived.click();assert.equal(await archived.getAttribute('aria-pressed'),'true');
 if(engine==='webkit'&&language==='it')await shot(page,'mobile-it-clients');
 await check(page);
 await navigate(page,'Temps','time');
 assert.equal(await page.locator('.time-hero,.summary-strip').count(),0);
 assert.equal(await page.locator('.creation-action__help p').count(),1);
 if(engine==='webkit'&&language==='fr')await shot(page,'mobile-time');
 await page.locator('.creation-action__help button').click();await page.locator('.desktop-app[data-view=projects]').waitFor();
 await navigate(page,'Temps','time');
 await page.evaluate(()=>window.__qaSetReadOnly(true));await page.locator('.creation-action__help').waitFor({state:'hidden'});assert.equal(await page.locator('.creation-action > button').isDisabled(),true);
 await page.evaluate(()=>window.__qaSetReadOnly(false));
 await navigate(page,'Agenda','agenda');
 await page.locator('.agenda-layout').waitFor();
 assert.equal(await page.locator('.agenda-create').count(),1);assert.equal(await page.locator('.empty-state button').count(),0);
 if(engine==='webkit'&&language==='fr')await shot(page,'mobile-agenda');
 if(engine==='edge'&&width===1440)await shot(page,'desktop-agenda');
 await page.locator('.agenda-create').click();await page.getByRole('dialog').focus();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.evaluate(()=>window.__qaSetReadOnly(true));await page.waitForFunction(()=>document.querySelector('.agenda-create')?.disabled===true);
 await check(page);assert.deepEqual(errors,[]);report.push({engine,width,language,emptyCreation:true,excelImport:true,filtersReadOnly:true,clientTabs:true,timeRecovery:true,agendaCreation:true,noOverflow:true,errors});
 }catch(error){await page.screenshot({path:`${output}/FAIL-${engine}-${width}-${language}.png`});throw error;}finally{await page.close();}
 }}finally{await browser.close();await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));}
}
console.log(JSON.stringify({passed:report.length,report:`${output}/report.json`}));
