import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium,webkit}=require(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const out='.qa/personal-activation';await mkdir(out,{recursive:true});
const reports=[];
for(const engine of ['chromium','webkit']){
 const browser=await ({chromium,webkit}[engine]).launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
 try{for(const width of [320,390,1440]){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<500});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
   window.__ZENTRA_NATIVE_READY__=true;window.qaLicenseReads=0;
   window.__TAURI_INTERNALS__={invoke:async command=>{
    if(command==='get_app_state')return {onboarding_completed:false,schema_version:59};
    if(command==='get_cloud_account_state')return {status:'disconnected'};
    if(command==='get_noga_catalog')return {sections:[]};
    if(command==='get_license_state'){
     const count=++window.qaLicenseReads;
     return {status:count<3?'missing':'valid',enforcement_configured:true,read_only:count<3,can_refresh:false,personal_activation_pending:count<3,installation_id:'67977efd-492e-4e01-b719-5fe42b7c3d2d',reason:count===1?'Cette licence appartient à une autre installation. Copiez l’identifiant.':count===2?'Le service de licence est momentanément inaccessible.':'',access_role:'owner',valid_until:'2036-12-31'};
    }
    throw new Error('Unexpected command: '+command);
   }};
  });
  await page.goto(process.env.ZENTRA_TEST_URL||'http://127.0.0.1:5293/',{waitUntil:'networkidle'});
  await page.getByText('Activation de votre iPhone',{exact:true}).waitFor();
  assert.equal(await page.getByText('Espace indisponible',{exact:true}).count(),0);
  await page.getByText('Restaurer une sauvegarde',{exact:true}).waitFor();
  await page.getByText('67977efd-492e-4e01-b719-5fe42b7c3d2d',{exact:true}).waitFor();
  const button=page.getByRole('button',{name:'Activer ma licence personnelle',exact:true});
  assert.ok((await button.boundingBox()).height>=44);
  assert.equal(await page.locator('.license-banner textarea').isVisible(),false);
  await page.getByText('Installer une licence fournie par l’assistance',{exact:true}).click();
  assert.equal(await page.locator('.license-banner textarea').isVisible(),true);
  await page.getByText('Installer une licence fournie par l’assistance',{exact:true}).click();
  await button.click();
  await page.getByRole('alert').filter({hasText:'momentanément inaccessible'}).waitFor();
  assert.equal(await page.evaluate(()=>window.qaLicenseReads),2);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`${out}/${engine}-${width}.png`,fullPage:true});
  await button.click();
  await page.getByText('Activation de votre iPhone',{exact:true}).waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.qaLicenseReads),3);
  assert.deepEqual(errors,[]);
  reports.push({engine,width,setupAccessible:true,identityVisible:true,retryUpdatesCause:true,activationRecovered:true,noOverflow:true});await page.close();
 }}finally{await browser.close();}
}
await writeFile(`${out}/report.json`,JSON.stringify(reports,null,2));console.log(JSON.stringify(reports));
