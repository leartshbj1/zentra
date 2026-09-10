import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const output=new URL('../../.qa/clarity/',import.meta.url);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'msedge'});
const results=[];
try {
 for(const width of [1440,390,320]) {
  const page=await browser.newPage({viewport:{width,height:width>1000?1000:844}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&design=1&clarity=1`);
  await page.getByRole('button',{name:'Découvrir plus tard',exact:true}).click();
  const navigate=async name=>{
   await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
   await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill(name);
   await page.locator('.navigation-palette__results button').filter({has:page.getByText(name,{exact:true})}).click();
  };
  for(const name of ['Tableau de bord','Comptabilité','Devis','Factures','Achats & fournisseurs','Banque','Équipe & salaires','Paramètres','Projets','Clients','Produits & services','Agenda','Temps','Relances','Rapports']) {
   await navigate(name);
   await page.waitForTimeout(400);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${name} overflow`);
   await page.screenshot({path:fileURLToPath(new URL(`${width}-${name.replaceAll(/[^a-zA-Z]/g,'')}.png`,output))});
   await page.getByRole('button',{name:'Comprendre cet écran',exact:true}).click();
   await page.getByRole('heading',{name:'Comment faire',exact:true}).waitFor();
   assert.equal(await page.locator('.screen-help__steps li').count(),3);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${name} help overflow`);
   await page.getByRole('button',{name:'Revenir à mon écran',exact:true}).click();
   results.push({width,screen:name,layout:true,help:true});
  }
  await navigate('Comptabilité');
  await page.getByRole('heading',{name:'Vos finances, en clair.',exact:true}).waitFor();
  await page.getByRole('button',{name:'Configurer simplement',exact:true}).click();
  await page.getByRole('radio').nth(0).check();
  await page.getByRole('button',{name:'Vérifier mes choix',exact:true}).click();
  await page.screenshot({path:fileURLToPath(new URL(`${width}-configuration.png`,output))});
  await page.getByRole('button',{name:'Appliquer ces réglages',exact:true}).click();
  await page.getByRole('heading',{name:'Votre configuration est enregistrée',exact:true}).waitFor({timeout:5000});
  await page.getByRole('button',{name:'Terminer',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__clarityQA.settingsWrites.length),1);
  assert.equal(await page.evaluate(()=>window.__clarityQA.settingsWrites[0].billing.paymentTermsDays),14);
  await page.getByLabel('Période de la vue d’ensemble',{exact:true}).selectOption('quarter');
  await page.getByLabel('Période de la vue d’ensemble',{exact:true}).selectOption('all');
  await page.getByRole('button',{name:'Consulter les opérations',exact:true}).click();
  assert.equal(await page.getByLabel('Date de début de la période',{exact:true}).inputValue(),'');
  assert.equal(await page.getByLabel('Date de fin de la période',{exact:true}).inputValue(),'');
  await page.getByLabel('Autres outils comptables',{exact:true}).selectOption('journal');
  assert.equal(await page.getByRole('heading',{name:'Vos finances, en clair.',exact:true}).count(),0);
  assert.deepEqual(errors,[]);
  await page.close();
 }
}finally{await browser.close();await writeFile(new URL('results.json',output),JSON.stringify(results,null,2));}
console.log(JSON.stringify({passed:results.length,results}));
