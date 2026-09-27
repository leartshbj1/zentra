import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const out=fileURLToPath(new URL('../.qa/accounting-period-truth/',import.meta.url));await mkdir(out,{recursive:true});
const report=[];
for(const engine of [chromium,webkit]){
 const browser=await engine.launch({headless:true,...(engine===chromium&&process.platform==='win32'?{channel:'msedge'}:{})});
 try{for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5367'}/tests/mobile-harness.html?browsing=1&design=1`);
  await page.getByRole('button',{name:'Découvrir plus tard',exact:true}).click();
  const dates=await page.evaluate(async()=>{
   const {desktopApi}=await import('/src/bridge.ts');const {todayIso,formatDate}=await import('/src/utils.ts');
   const today=todayIso(),year=today.slice(0,4);window.__periodRequests=[];
   const income=desktopApi.getIncomeStatement,continuity=desktopApi.getAccountingContinuity;
   desktopApi.getAccountingContinuity=async()=>({...await continuity(),enabled:true,mappingReady:true,journalEntryCount:3});
   desktopApi.getIncomeStatement=async filter=>{
    window.__periodRequests.push({...filter});const result=await income(filter);
    return {...result,revenueCents:123456,profitCents:123456,scope:{...result.scope,dateFrom:filter.dateFrom||`${year}-01-01`,dateTo:filter.dateTo||today}};
   };
   return {year,today,currentYearLabel:`${formatDate(`${year}-01-01`)} – ${formatDate(`${year}-12-31`)}`,fallbackLabel:`${formatDate(`${year}-01-01`)} – ${formatDate(today)}`};
  });
  await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
  await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Comptabilité');
  await page.locator('.navigation-palette__results button').filter({has:page.getByText('Comptabilité',{exact:true})}).click();
  const period=page.getByRole('combobox',{name:'Période de la vue d’ensemble',exact:true});
  await page.waitForFunction(()=>document.querySelector('.finance-overview__figures')?.getAttribute('aria-busy')==='false');
  assert.equal(await period.inputValue(),'year');
  assert.equal(await period.locator('option[value=all]').count(),0);
  assert.deepEqual(await page.evaluate(()=>window.__periodRequests.at(-1)),{dateFrom:`${dates.year}-01-01`,dateTo:`${dates.year}-12-31`});
  assert.equal(await page.locator('.finance-overview__intro > div > p').innerText(),dates.currentYearLabel);
  await period.selectOption('month');
  await page.waitForFunction(()=>document.querySelector('.finance-overview__figures')?.getAttribute('aria-busy')==='false');
  assert.equal((await page.evaluate(()=>window.__periodRequests.at(-1))).dateFrom,`${dates.today.slice(0,7)}-01`);
  const section=async(value,name)=>{
   const picker=page.getByRole('combobox',{name:'Section comptable',exact:true});
   if(await picker.isVisible())await picker.selectOption(value);
   else await page.getByRole('tab',{name}).click();
  };
  await section('income','Résultat');
  await page.getByRole('button',{name:'Toutes les dates',exact:true}).click();
  await page.waitForFunction(()=>window.__periodRequests.at(-1)?.dateFrom===undefined);
  assert.equal(await page.locator('.accounting-period-toggle strong').innerText(),dates.fallbackLabel);
  await section('overview',/^Vue d.ensemble$/);
  assert.equal(await period.inputValue(),'custom');
  assert.equal(await page.locator('.finance-overview__intro > div > p').innerText(),dates.fallbackLabel);
  if(width===390)await page.evaluate(async()=>{const {setAppearance}=await import('/src/appearance.ts');setAppearance('dark');});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);
  const label=await page.locator('.finance-overview__intro > div > p').boundingBox();assert.ok(label&&label.x>=0&&label.x+label.width<=width+1);
  assert.deepEqual(errors,[]);await page.screenshot({path:`${out}/${engine.name()}-${width}.png`});
  report.push({engine:engine.name(),width,explicitYear:true,monthRequested:true,openFilterUsesReturnedStatementScope:true,overflow,errors});
  await page.close();
 }}finally{await browser.close();}
}
await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
