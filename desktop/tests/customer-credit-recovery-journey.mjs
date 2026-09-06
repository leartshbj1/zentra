import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
const {chromium,webkit}=await import(pathToFileURL(process.env.ZENTRA_PLAYWRIGHT_MODULE+'/index.mjs').href);
const engine=process.env.ZENTRA_QA_BROWSER||'edge';
const out=fileURLToPath(new URL(`../../.qa/customer-credit-recovery-${engine}/`,import.meta.url));await mkdir(out,{recursive:true});
const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='edge'?{channel:'msedge'}:{})});const report=[];let activePage;
try {
  for(const mode of ['write','readonly','blocked'])for(const width of mode==='write'?[320,390,768,1440]:[320,1440]) {
    const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<800,reducedMotion:mode==='write'?'no-preference':'reduce'});activePage=page;page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&customerRecovery=1&${mode==='write'?'lostReply=1':mode==='readonly'?'readOnly=1':'recoveryBlocked=1'}`,{waitUntil:'domcontentloaded',timeout:60000});
    if(width>860)await page.getByRole('button',{name:'Ne plus afficher automatiquement',exact:true}).click();
    await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Factures');
    await page.locator('.navigation-palette__results button').filter({has:page.getByText('Factures',{exact:true})}).click();
    const open=()=>page.locator('.sales-documents tbody tr').filter({hasText:'Dossier des avoirs historiques'}).getByRole('button',{name:'Consulter',exact:true}).click();await open();
    const card=page.getByRole('article',{name:'Reprise des avoirs historiques'});
    assert.equal(await card.count(),1,'one recovery for the entire invoice folder');await card.getByRole('button',{name:'Documenter les règlements'}).click();
    if(mode==='blocked') {
      await card.getByText('Rapprochement nécessaire',{exact:true}).waitFor();assert.equal(await card.getByRole('button',{name:'Vérifier la reprise',exact:true}).count(),0);
    } else {
      await card.getByLabel('Traitement de AVO-2026-201').waitFor();
      assert.equal(await card.getByLabel('Traitement de AVO-2026-201').inputValue(),'');
      if(mode==='readonly')assert.equal(await card.getByLabel('Traitement de AVO-2026-201').isDisabled(),true);
      else {
        await card.getByLabel('Traitement de AVO-2026-201').selectOption('applied');
        assert.equal(await card.getByLabel('Date de déduction · AVO-2026-201').inputValue(),'');
        await card.getByLabel('Montant déduit · AVO-2026-201 (CHF)').fill('99');
        await card.getByRole('alert').filter({hasText:'au maximum'}).waitFor();
        assert.equal(await card.getByLabel('Montant déduit · AVO-2026-201 (CHF)').getAttribute('aria-invalid'),'true');
        await card.getByLabel('Date de déduction · AVO-2026-201').fill('2026-02-28');
        await card.getByRole('alert').filter({hasText:'Conservez la date réelle'}).waitFor();
        await card.getByLabel('Montant déduit · AVO-2026-201 (CHF)').fill('27.03');await card.getByLabel('Date de déduction · AVO-2026-201').fill('2026-03-15');
        await card.getByLabel('Traitement de AVO-2026-202').selectOption('available');
        await card.getByLabel('Référence du rapprochement').fill('Courriel client du 15 mars');await card.getByLabel('Motif de la reprise').fill('Déduction confirmée avec le client et solde conservé disponible');
        assert.equal(await card.getByRole('button',{name:'Vérifier la reprise',exact:true}).isDisabled(),true);
        await card.getByRole('checkbox').check();await page.screenshot({path:`${out}/${width}-document.png`,fullPage:false});
        await card.getByRole('button',{name:'Vérifier la reprise',exact:true}).click();await card.getByRole('heading',{name:'Vérifier les soldes après reprise'}).waitFor();
        assert.equal(await page.evaluate(()=>sessionStorage.getItem('recovery-count')),null,'preview cannot commit');
        assert.match(await card.locator('.credit-recovery__balance').innerText(),/81[.,]07/);
        await page.waitForFunction(()=>{const box=document.querySelector('.credit-recovery__balance')?.getBoundingClientRect();return box&&box.top>=0&&box.bottom<=innerHeight;});
        await page.screenshot({path:`${out}/${width}-review.png`,fullPage:false});
        await card.getByRole('button',{name:'Confirmer la reprise',exact:true}).click();await card.getByRole('button',{name:'Vérifier la même reprise',exact:true}).waitFor();
        await page.keyboard.press('Escape');await open();await card.getByRole('button',{name:'Vérifier la même reprise',exact:true}).click();
        await card.waitFor({state:'detached'});
        await page.waitForFunction(()=>{const box=document.querySelector('.customer-credit-card__heading')?.getBoundingClientRect();return box&&box.top>=0&&box.bottom<=innerHeight;});
        const requests=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('recovery-requests')));assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.equal(await page.evaluate(()=>sessionStorage.getItem('recovery-count')),'1');
        await page.getByText(/^Reprise documentée le/).first().click();await page.getByText('Courriel client du 15 mars',{exact:true}).first().waitFor();
        await page.screenshot({path:`${out}/${width}-done.png`,fullPage:false});
      }
    }
    const overflow=await page.evaluate(()=>({window:document.documentElement.scrollWidth>innerWidth+1,panels:[...document.querySelectorAll('.modal,.credit-recovery,.credit-recovery__document')].some(e=>e.scrollWidth>e.clientWidth+2)}));assert.deepEqual(overflow,{window:false,panels:false});
    if(mode!=='write'){assert.equal(await card.locator('.credit-recovery__body').evaluate(el=>getComputedStyle(el).animationName),'none');await page.screenshot({path:`${out}/${width}-${mode}.png`,fullPage:false});}
    assert.deepEqual(errors,[]);report.push({width,mode,noOverflow:true,errors,retryDeduplicated:mode==='write'});await page.close();
  }
}catch(error){if(activePage&&!activePage.isClosed()){await activePage.screenshot({path:`${out}/failure.png`,fullPage:false});await writeFile(`${out}/failure.txt`,await activePage.locator('body').innerText());}throw error;}
finally{await browser.close();await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
