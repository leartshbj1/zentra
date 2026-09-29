import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium,webkit}=require(process.env.ZENTRA_PLAYWRIGHT_MODULE||'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base=process.env.ZENTRA_QA_URL||'http://127.0.0.1:5207';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw Error('Local fixture only');
const mode=process.argv.includes('--before')?'before':'after';
const output=new URL('../../.impeccable/review/modal-assistant-accessibility/',import.meta.url);
await mkdir(output,{recursive:true});
const report=[];
for(const [engine,type] of [['edge',chromium],['webkit',webkit]]){
 const browser=await type.launch({headless:true,...(engine==='edge'?{channel:'msedge'}:{})});
 try{for(const [width,height] of [[1440,900],[320,740]]){
  const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}),errors=[],blocked=[];
  page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(['localhost','127.0.0.1'].includes(url.hostname))return route.continue();blocked.push(url.origin);return route.abort();});
  const result={engine,width,height,mode};
  try{
   await page.goto(base+'/tests/mobile-harness.html?payroll=1&payrollPensionSetup=1&assistantFixture=1');
   await page.getByRole('button',{name:'Fermer le guide automatique',exact:true}).click();
   await page.evaluate(()=>{const node=document.createElement('div');node.id='original-modal-isolation';node.inert=true;node.setAttribute('aria-hidden','true');document.body.append(node);});
   await page.getByRole('button',{name:'Demander à l’assistant Zentra',exact:true}).click();
   await page.getByRole('button',{name:'Installer Qwen · 429 Mo',exact:true}).click();
   await page.getByRole('button',{name:'Fermer « Assistant Zentra »',exact:true}).click();
   await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
   await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Équipe & salaires');
   await page.locator('.navigation-palette__results button').filter({has:page.getByText('Équipe & salaires',{exact:true})}).click();
   await page.locator('.team-navigation').getByRole('button',{name:/Fiches de salaire/}).click();
   const payrollOpener=page.getByRole('button',{name:'Nouvelle fiche',exact:true});
   await payrollOpener.focus();await page.keyboard.press('Enter');
   const payroll=page.locator('.payroll-dialog');
   await payroll.getByRole('combobox',{name:/^Collaborateur/}).selectOption('elodie');
   await payroll.locator('input[name=period]').fill('2026-09');
   await payroll.getByRole('button',{name:'Continuer',exact:true}).click();
   const salary=payroll.getByRole('spinbutton',{name:'Salaire brut du mois (CHF)',exact:true});
   await salary.fill('5123.45');
   await salary.evaluate(node=>{window.__modalSalary=node;});
   const launcher=payroll.getByRole('button',{name:'Demander à l’assistant Zentra',exact:true});
   await launcher.focus();await launcher.evaluate(node=>{window.__modalLauncher=node;});await page.keyboard.press('Enter');
   const assistant=page.locator('.zentra-assistant-dialog');
   await assistant.waitFor();
   await page.getByLabel('Votre question',{exact:true}).fill('Comment vérifier le contrat de la caisse de pension avant de terminer cette fiche ?');
   await page.getByRole('button',{name:'Envoyer la question',exact:true}).click();
   await page.getByText('Guide vérifié Zentra',{exact:true}).waitFor();
   result.exposedDialogs=await page.getByRole('dialog').count();
   result.backgroundIsolated=await payroll.evaluate(node=>!!node.closest('[inert]'));
   result.assistantLabel=await assistant.getAttribute('aria-labelledby');
   assert.ok(result.assistantLabel);
   await writeFile(new URL(`${mode}-${engine}-${width}-aria.yml`,output),await page.locator('body').ariaSnapshot());
   result.tabEscapes=0;
   await assistant.evaluate(node=>node.focus());
   for(const key of [...Array(20).fill('Tab'),...Array(20).fill('Shift+Tab')]){
    await page.keyboard.press(key);
    if(!await assistant.evaluate(node=>node.contains(document.activeElement)))result.tabEscapes++;
   }
   result.backgroundFocusBlocked=await page.evaluate(()=>{window.__modalSalary.focus();return document.activeElement!==window.__modalSalary;});
   await assistant.evaluate(node=>node.focus());
   result.overflow=await assistant.evaluate(node=>node.scrollWidth>node.clientWidth+1);
   await page.screenshot({path:new URL(`${mode}-${engine}-${width}.png`,output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
   await page.keyboard.press('Escape');
   await assistant.waitFor({state:'detached'});
   result.returnedToLauncher=await page.evaluate(()=>document.activeElement===window.__modalLauncher);
   result.salary=await page.evaluate(()=>window.__modalSalary.value);
   result.payrollAccessibleAgain=await page.getByRole('dialog').count()===1&&!await payroll.evaluate(node=>!!node.closest('[inert]'));
   await page.keyboard.press('Escape');await payroll.waitFor({state:'detached'});
   result.returnedToPayrollOpener=await payrollOpener.evaluate(node=>document.activeElement===node);
   result.noInertLeak=await page.locator('#root').evaluate(node=>!node.closest('[inert], [aria-hidden="true"]'));
   result.preExistingIsolationPreserved=await page.locator('#original-modal-isolation').evaluate(node=>node.inert&&node.getAttribute('aria-hidden')==='true');
   result.errors=errors;result.blockedExternalOrigins=[...new Set(blocked)];
   assert.equal(result.tabEscapes,0);assert.equal(result.overflow,false);assert.equal(result.salary,'5123.45');
   assert.equal(result.returnedToLauncher,true);assert.equal(result.returnedToPayrollOpener,true);assert.equal(result.payrollAccessibleAgain,true);assert.equal(result.noInertLeak,true);assert.equal(result.preExistingIsolationPreserved,true);assert.deepEqual(errors,[]);
   if(mode==='before'){
    assert.equal(result.exposedDialogs,2);assert.equal(result.backgroundIsolated,false);assert.equal(result.backgroundFocusBlocked,false);
   }else{
    assert.equal(result.exposedDialogs,1);assert.equal(result.backgroundIsolated,true);assert.equal(result.backgroundFocusBlocked,true);
   }
  }catch(error){result.failure=error.stack;throw error;}
  finally{report.push(result);await writeFile(new URL(`${mode}.json`,output),JSON.stringify(report,null,2));await page.close();}
 }}finally{await browser.close();}
}
console.log(JSON.stringify(report,null,2));
