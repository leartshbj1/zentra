import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await webkit.launch({headless:true});
const results = [];
await mkdir('desktop/artifacts/macos', {recursive:true});
try {
  for (const theme of ['light','dark']) for (const width of [320,390,1280]) {
    const page = await browser.newPage({viewport:{width,height:844}});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    for (const scenario of ['empty','created','old','local','failure','waiting','create']) {
      await page.goto(`${process.env.ZENTRA_QA_ORIGIN}/tests/company-account-harness.html?theme=${theme}&scenario=${scenario}`);
      if (scenario === 'old') {
        await page.getByRole('heading',{name:'Quel espace souhaitez-vous ouvrir ?',exact:true}).waitFor();
        await page.getByText('Sur cet appareil',{exact:true}).waitFor();
        await page.getByText('Dans votre compte',{exact:true}).waitFor();
        await page.getByRole('button',{name:'Ouvrir l’espace du compte',exact:true}).click();
      }
      if (scenario === 'local') await page.getByRole('button',{name:'Relier cette entreprise à mon compte',exact:true}).click();
      if (scenario === 'failure') await page.getByRole('button',{name:'Réessayer',exact:true}).click();
      if (scenario === 'waiting') await page.getByRole('heading',{name:'Votre entreprise attend son premier envoi',exact:true}).waitFor();
      else if (scenario === 'create') await page.getByRole('heading',{name:'Créer votre entreprise',exact:true}).waitFor();
      else {
        await page.getByRole('heading',{name:'Atelier Windows retrouvé',exact:true}).waitFor();
        assert.equal(await page.getByText('F-2026-0012',{exact:true}).count(),1);
        assert.equal(await page.getByText('Client Windows',{exact:true}).count(),1);
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      results.push({theme,width,scenario,passed:true});
    }
    assert.deepEqual(errors,[]);
    await page.close();
  }
  await writeFile('desktop/artifacts/macos/company-account-webkit-report.json',JSON.stringify(results,null,2));
} finally { await browser.close(); }
