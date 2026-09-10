import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,channel:'msedge'});
const out=new URL('../../.qa/clarity-compact/',import.meta.url);await mkdir(out,{recursive:true});
try{for(const width of [1440,1024,390,320]){
 const page=await browser.newPage({viewport:{width,height:900}});
 await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&design=1&clarity=1`);
 await page.getByRole('button',{name:'Découvrir plus tard',exact:true}).click();
 await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Comptabilité');
 await page.locator('.navigation-palette__results button').filter({has:page.getByText('Comptabilité',{exact:true})}).click();
 await page.getByRole('button',{name:'Configurer simplement',exact:true}).waitFor();
 for(const size of [16,20]){
  await page.addStyleTag({content:`html{font-size:${size}px!important}`});await page.waitForTimeout(350);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const current=page.locator('.accounting-screen--overview .section-navigation__current > span:not(.section-navigation__icon)');
  if(await current.isVisible()){
   const measure=await current.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,line:parseFloat(getComputedStyle(el).lineHeight)}));
   assert.ok(measure.width>=68,JSON.stringify({width,size,measure}));
   assert.ok(measure.height<=measure.line*3+1,JSON.stringify({width,size,measure}));
  }
  await page.screenshot({path:fileURLToPath(new URL(`${width}-${size}.png`,out))});
 }
 await page.close();console.log(JSON.stringify({width,normalAndEnlargedText:true,compactOverview:true}));
}}finally{await browser.close();}
