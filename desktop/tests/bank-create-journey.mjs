import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
const report=[];
await mkdir('.qa/bank-create',{recursive:true});
try {
  for (const width of [320,390,768,1024,1440]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    page.on('pageerror',error=>report.push({width,error:error.message}));
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?finance=1&bank=1&bankCreate=1',{waitUntil:'domcontentloaded'});
    const tour=page.getByRole('button',{name:'Ne plus afficher automatiquement',exact:true});if(await tour.isVisible())await tour.click();
    await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
    await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill('Banque');
    await page.locator('.navigation-palette__results button').filter({has:page.getByText('Banque',{exact:true})}).click();
    const picker=page.locator('.bank-expense-picker');await picker.locator('summary').click();
    await picker.getByRole('button',{name:'Créer une dépense avec justificatif'}).click();
    const dialog=page.getByRole('dialog',{name:'Créer une dépense',exact:true});
    const capture=async(name)=>{
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`page overflow ${width}`);
      assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),`dialog overflow ${width}`);
      await page.screenshot({path:`.qa/bank-create/${width}-${name}.png`});
    };
    await dialog.locator('input[type=file]').setInputFiles({name:'Ticket-marchandises-pour-projet-renovation.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nUI fixture; real bytes validated by native tests')});
    await dialog.locator('input[name=reference]').fill('TICKET-2026-81');
    await dialog.locator('input[name=date]').fill('2026-08-20');
    await dialog.locator('input[name=category]').fill('Marchandises');
    await dialog.locator('input[inputmode=decimal]').fill('8,10');
    await dialog.locator('select[name=treatment]').selectOption('input_materials');
    assert.match(await dialog.locator('.bank-expense-form__total').innerText(),/100.00/);
    await capture('form');
    const save=dialog.getByRole('button',{name:'Créer et rapprocher',exact:true});
    await page.evaluate(()=>sessionStorage.setItem('qa-create-reject','1'));await save.click();
    await dialog.getByRole('alert').waitFor();
    await page.waitForFunction(() => { const alert=document.querySelector('.bank-expense-form [role="alert"]'); if(!alert)return false;const box=alert.getBoundingClientRect();return box.top>=0 && box.bottom<=innerHeight; });
    assert.equal(await dialog.locator('input[name=reference]').inputValue(),'TICKET-2026-81');
    assert.match(await dialog.locator('.bank-expense-form__file').innerText(),/Ticket-marchandises/);
    await capture('refusal');
    await page.evaluate(()=>{sessionStorage.removeItem('qa-create-reject');sessionStorage.setItem('qa-create-lost-response','1');});
    await save.click();await dialog.getByRole('alert').filter({hasText:'Réponse interrompue'}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('qa-create-postings')),'1');
    await capture('lost-response');
    await page.evaluate(()=>{sessionStorage.removeItem('qa-create-lost-response');sessionStorage.setItem('qa-create-refresh-fail','1');});
    await save.click();await dialog.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('qa-create-attempts')),'3');
    assert.equal(new Set(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-create-ids')))).size,1);
    await page.evaluate(()=>sessionStorage.removeItem('qa-bank-refresh-fail'));
    await page.getByRole('button',{name:'Actualiser les données',exact:true}).click();
    await page.getByRole('tab',{name:/^Rapprochés/}).click();
    await page.locator('.bank-match-confirmed').waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('qa-create-attempts')),'3');
    await page.screenshot({path:`.qa/bank-create/${width}-confirmed.png`});
    report.push({width,result:'PASS receipt retained, explicit VAT, refusal, lost response retry with stable ID, committed refresh failure, read-only recovery, no overflow',captures:4});
    await page.close();
  }
  assert.deepEqual(report.filter(row=>row.error),[]);
} catch(error){report.push({fatal:error.stack});process.exitCode=1;const page=browser.contexts().flatMap(c=>c.pages()).at(-1);if(page){await page.screenshot({path:'.qa/bank-create/failure.png'});await writeFile('.qa/bank-create/failure.html',await page.content());}}
finally{await writeFile('.qa/bank-create/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
