import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,channel:'msedge'});
const page=await browser.newPage();const report=[];const errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.emulateMedia({reducedMotion:'reduce'});
await mkdir('.qa/updater-dialog',{recursive:true});
const withinDialog=()=>page.getByRole('dialog').evaluate(e=>e.contains(document.activeElement));
try {
 for(const width of [320,390,768,1024,1440]) {
  await page.setViewportSize({width,height:900});
  await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?updater=1');
  const launcher=page.getByRole('button',{name:'Mise à jour',exact:true});
  await launcher.click();
  const dialog=page.getByRole('dialog',{name:'Mise à jour de Zentra',exact:true});
  const close=dialog.getByRole('button',{name:'Fermer « Mise à jour de Zentra »',exact:true});
  await close.waitFor();
  await dialog.evaluate(async e=>{ await Promise.all(e.getAnimations().map(a=>a.finished.catch(()=>{}))); });
  await page.waitForFunction(()=>document.querySelector('[role="dialog"]')?.contains(document.activeElement));
  const box=await dialog.boundingBox(),button=await close.boundingBox();
  assert(button.x>=box.x && button.y>=box.y && button.x+button.width<=box.x+box.width+1,JSON.stringify({box,button}));
  assert(button.x>=0 && button.x+button.width<=width && button.height>=39.9,JSON.stringify({width,box,button}));
  const search=dialog.getByRole('button',{name:'Rechercher une mise à jour',exact:true});
  const searchBox=await search.boundingBox();assert(searchBox.y+searchBox.height<=900,'Main action should fit the initial viewport');
  const technical=dialog.locator('.app-updater__technical');
  assert.equal(await technical.getAttribute('open'),null);
  await technical.locator('summary').click();await dialog.getByText('Ed25519 obligatoire',{exact:true}).waitFor();
  await technical.locator('summary').click();
  await page.screenshot({path:`.qa/updater-dialog/${width}-open.png`});
  await close.focus();await page.keyboard.press('Shift+Tab');assert(await withinDialog());
  for(let i=0;i<8;i++){await page.keyboard.press('Tab');assert(await withinDialog());}
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert(await launcher.evaluate(e=>e===document.activeElement));
  await launcher.click();
  await dialog.getByRole('button',{name:'Rechercher une mise à jour',exact:true}).click();
  await dialog.getByRole('button',{name:'Préparer l’installation 1.30.0',exact:true}).click();
  await dialog.getByRole('button',{name:'Installer et redémarrer',exact:true}).click();
  await page.waitForFunction(()=>window.__updaterQA.installs===1);
  await dialog.getByRole('progressbar').waitFor();
  await dialog.getByText('Mise à jour en cours',{exact:true}).waitFor();
  assert(await withinDialog(),'Focus must remain in the dialog during installation');
  await page.keyboard.press('Escape');assert.equal(await dialog.count(),1);
  assert.equal(await close.count(),0);
  await page.keyboard.press('Tab');assert(await withinDialog());
  await page.locator('.modal-backdrop').click({position:{x:2,y:2},force:true});assert.equal(await dialog.count(),1);
  await page.screenshot({path:`.qa/updater-dialog/${width}-installing.png`});
  await page.evaluate(()=>window.__updaterQA.refuse());
  await dialog.getByText('Téléchargement de recette interrompu.',{exact:true}).waitFor();
  await close.waitFor();
  await page.screenshot({path:`.qa/updater-dialog/${width}-retry.png`});
  await close.click();await dialog.waitFor({state:'hidden'});
  assert(await launcher.evaluate(e=>e===document.activeElement));
  assert.equal(await page.evaluate(()=>window.__updaterQA.installs),1);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  report.push({width,closeFullyVisible:true,focusAndEscape:true,installationCannotBeHidden:true,errorReleasesDialog:true,installCalls:1});
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'PASS',views:report.length,report}));
}catch(error){report.push({fatal:error.stack});await page.screenshot({path:'.qa/updater-dialog/failure.png'});console.error(error);process.exitCode=1;}
finally{await writeFile('.qa/updater-dialog/report.json',JSON.stringify({report,errors},null,2));await browser.close();}
