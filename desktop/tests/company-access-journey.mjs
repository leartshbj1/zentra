import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium,webkit }=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const engine=process.env.ZENTRA_BROWSER==='webkit'?webkit:chromium;
// Tauri uses persistent website data. Safari private contexts cannot open OPFS,
// so exercise the actual storage cleanup in an isolated persistent profile.
const profile=await mkdtemp(join(tmpdir(),'zentra-company-access-'));
const browser=await engine.launchPersistentContext(profile,{headless:true,...(process.platform==='win32'&&engine===chromium?{channel:'msedge'}:{})});
const results=[];
let currentPage;
async function failureGuide(page, raw, kind='unknown') {
  const guide=page.locator('.error-guidance');
  const alert=guide.getByRole('alert');
  const expected=kind==='busy'
    ? ['Transfert en cours','Un transfert utilise encore cet espace.','Attendez la fin du transfert, puis reprenez cette action.']
    : ['Action à vérifier','Le résultat de cette action n’a pas pu être confirmé.','Vérifiez le résultat. Si le problème persiste, communiquez le code d’incident au support. Avant un nouvel enregistrement, vérifiez si l’action apparaît déjà dans Zentra.'];
  for(const text of expected)await alert.getByText(text,{exact:true}).waitFor();
  const details=guide.locator('.error-guidance__details');
  assert.equal(await details.evaluate(node=>node.open),false,'technical details remain closed');
  assert.equal(await details.locator('pre').textContent(),raw,'the original refusal remains available in technical details');
  assert.equal(await details.locator('pre').isVisible(),false,'raw retry text is not the main user instruction');
}
await mkdir('.qa/company-access',{recursive:true});
try {
  for(const theme of ['light','dark'])for(const width of [320,390,1280]){
    const page=await browser.newPage();await page.setViewportSize({width,height:844});
    currentPage=page;
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const url=`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5296'}/tests/company-access-harness.html?theme=${theme}`;
    await page.goto(url);
    await page.getByRole('button',{name:'Réinitialiser cette application',exact:true}).click();
    const dialog=page.getByRole('dialog');
    const erase=dialog.getByRole('button',{name:'Effacer cet espace et recommencer',exact:true});
    assert.equal(await erase.isDisabled(),true);
    await dialog.getByRole('textbox').fill('REINITIALISER');
    assert.equal(await erase.isEnabled(),true);
    await page.screenshot({path:`.qa/company-access/${theme}-${width}-reset.png`,fullPage:true});
    assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    await dialog.getByRole('button',{name:'Annuler',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.companyFixture.resets),0);
    await page.goto(url+'&failure=1');
    await page.getByRole('button',{name:'Réinitialiser cette application',exact:true}).click();
    await page.getByRole('dialog').getByRole('textbox').fill('REINITIALISER');
    await page.getByRole('button',{name:'Effacer cet espace et recommencer',exact:true}).click();
    await failureGuide(page,'Un transfert est encore en cours. Réessayez dans un instant.','busy');
    assert.equal(await page.evaluate(()=>window.companyFixture.resets),1,'the refused explicit reset was invoked once');
    assert.equal(await page.getByRole('heading',{name:'Créer, importer ou rejoindre une entreprise',exact:true}).count(),0,'a busy refusal does not publish reset success');
    assert.equal(await page.getByRole('button',{name:'Effacer cet espace et recommencer',exact:true}).isEnabled(),true);
    await page.goto(url+'&join=1&missing=1');
    await page.getByText('Demandez au titulaire d’activer le partage dans Compte et équipe.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.companyFixture.joined),0);
    await page.goto(url+'&join=1&failure=1');
    await failureGuide(page,'Connexion interrompue. Réessayez pour récupérer l’entreprise.');
    await page.getByRole('button',{name:'Recevoir et ouvrir l’entreprise',exact:true}).click();
    await page.getByRole('heading',{name:'Entreprise ouverte',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.companyFixture.joined),2);
    await page.goto(url+'&join=1');
    await page.getByRole('heading',{name:'Entreprise ouverte',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.companyFixture.joined),1);
    await page.goto(url);
    await page.getByRole('button',{name:'Réinitialiser cette application',exact:true}).click();
    await page.getByRole('dialog').getByRole('textbox').fill('REINITIALISER');
    await page.getByRole('button',{name:'Effacer cet espace et recommencer',exact:true}).click();
    await page.getByRole('heading',{name:'Créer, importer ou rejoindre une entreprise',exact:true}).waitFor();
    await page.goto(url+'&recovery=1');
    await page.getByRole('button',{name:'Retrouver mon entreprise précédente',exact:true}).click();
    await page.getByRole('heading',{name:'Entreprise récupérée',exact:true}).waitFor();
    await page.goto(url+'&cacheFailure=1');
    await page.getByRole('button',{name:'Réinitialiser cette application',exact:true}).click();
    await page.getByRole('dialog').getByRole('textbox').fill('REINITIALISER');
    await page.getByRole('button',{name:'Effacer cet espace et recommencer',exact:true}).click();
    await failureGuide(page,'Le cache est occupé. Réessayez.');
    assert.equal(await page.evaluate(()=>window.companyFixture.resets),1);
    await page.getByRole('button',{name:'Effacer cet espace et recommencer',exact:true}).click();
    await page.getByRole('heading',{name:'Créer, importer ou rejoindre une entreprise',exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('resetCalls'),'1');
    await page.goto(url+'&team=1&missing=1');
    await page.getByRole('heading',{name:'Équipe et invitations',exact:true}).waitFor();
    await page.getByRole('button',{name:'Inviter une personne',exact:true}).click();
    const invite=page.getByRole('button',{name:'Créer le lien d’invitation',exact:true});
    assert.equal(await invite.isEnabled(),true);
    assert.equal(await page.getByRole('checkbox').count(),0);
    await page.getByRole('textbox',{name:'Adresse e-mail',exact:true}).fill('personne@example.test');
    await page.getByRole('combobox',{name:'Rôle',exact:true}).selectOption('read_only');
    await invite.click();
    await page.getByText('Invitation créée. Transmettez le lien à cette personne.',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>({shared:window.companyFixture.shared,invited:window.companyFixture.invited})),{shared:1,invited:1});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.screenshot({path:`.qa/company-access/${theme}-${width}-team.png`,fullPage:true});
    await page.goto(url+'&team=1&missing=1&shareFailure=1');
    await page.getByRole('button',{name:'Inviter une personne',exact:true}).click();
    await page.getByRole('textbox',{name:'Adresse e-mail',exact:true}).fill('personne@example.test');
    await page.getByRole('button',{name:'Créer le lien d’invitation',exact:true}).click();
    await failureGuide(page,'Connexion interrompue. Réessayez le partage.');
    assert.equal(await page.evaluate(()=>window.companyFixture.invited),0);
    await page.getByRole('button',{name:'Créer le lien d’invitation',exact:true}).click();
    await page.getByText('Invitation créée. Transmettez le lien à cette personne.',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>({shared:window.companyFixture.shared,invited:window.companyFixture.invited})),{shared:2,invited:1});
    assert.deepEqual(errors,[]);results.push({theme,width,status:'passed'});await page.close();
  }
} catch(error) {
  if(currentPage&&!currentPage.isClosed()){
    const failure={error:String(error),url:currentPage.url(),text:await currentPage.locator('body').innerText()};
    console.error(JSON.stringify(failure));
    await writeFile('.qa/company-access/failure.json',JSON.stringify(failure,null,2));
    await currentPage.screenshot({path:'.qa/company-access/failure.png',fullPage:true});
  }
  throw error;
} finally {await browser.close();await rm(profile,{recursive:true,force:true});await writeFile(`.qa/company-access/results-${process.env.ZENTRA_BROWSER||'chromium'}.json`,JSON.stringify(results,null,2));}
console.log(JSON.stringify(results));
