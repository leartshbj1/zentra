import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const type = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await type.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const output = `.qa/project-sync-recovery-${engine}`;
await mkdir(output, { recursive: true });
const report = [];
try {
  for (const [width, height] of [[320,568], [390,844], [844,390], [1440,1000]]) {
    const context = await browser.newContext({ viewport: {width,height}, reducedMotion: 'reduce', acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(12000); const errors=[]; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`${base}/tests/project-files-harness.html?syncRecovery=1`);
      const issues=page.locator('.project-sync-issues');
      await issues.getByText('Copie locale à réparer', {exact:true}).waitFor();
      await page.waitForFunction(() => window.projectSyncRecovery.calls >= 1);
      const broken=page.locator('.project-document-list__open').filter({hasText:'Plan-original-du-projet-à-conserver.txt'});
      assert.match(await broken.innerText(),/Copie locale à réparer/);
      assert.doesNotMatch(await broken.innerText(),/Disponible hors ligne/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await issues.screenshot({path:`${output}/${width}-repair.png`});
      // Already readable files still export the original bytes while offline.
      await context.setOffline(true);
      await page.locator('.project-sync').getByText(/Hors ligne/).waitFor();
      await page.locator('.project-document-list__open').filter({hasText:'Conditions.txt'}).click();
      const modal=page.getByRole('dialog'); await modal.waitFor();
      const downloaded=page.waitForEvent('download');
      await modal.getByRole('link',{name:'Enregistrer',exact:true}).click();
      assert.equal((await readFile(await (await downloaded).path())).toString(),'Conditions conservées');
      await modal.getByRole('button',{name:/^Fermer «/}).click();
      await context.setOffline(false);
      await page.getByRole('button',{name:'Synchroniser',exact:true}).waitFor();
      await page.waitForFunction(() => !document.querySelector('.project-sync button')?.disabled);
      // A network return during a pending request must survive its late error.
      const before=await page.evaluate(() => { const c=window.projectSyncRecovery; c.hold=true; c.networkError=true; return c.calls; });
      await page.getByRole('button',{name:'Synchroniser',exact:true}).click();
      await page.waitForFunction(n => window.projectSyncRecovery.calls===n+1,before);
      await context.setOffline(true); await context.setOffline(false);
      assert.equal(await page.evaluate(() => window.projectSyncRecovery.calls),before+1);
      await page.evaluate(() => { const c=window.projectSyncRecovery; c.hold=false;c.networkError=false;c.release(); });
      await page.waitForFunction(n => window.projectSyncRecovery.calls===n+2,before,{timeout:5000});
      // The guided action reuses the existing picker and requires Save.
      const chooser=page.waitForEvent('filechooser');
      await issues.getByRole('button',{name:'Ajouter le fichier original',exact:true}).click();
      await (await chooser).setFiles({name:'Plan-original-du-projet-à-conserver.txt',mimeType:'text/plain',buffer:Buffer.from('Plan original de recette')});
      assert.equal(await page.evaluate(() => window.projectSyncRecovery.repairs),0);
      await page.getByRole('button',{name:'Enregistrer 1 fichier',exact:true}).click();
      await issues.waitFor({state:'detached'});
      assert.equal(await page.locator('.project-document-list__open').count(),2);
      assert.equal(await page.evaluate(() => window.projectSyncRecovery.repairs),1);
      await broken.getByText('Synchronisé · Disponible hors ligne',{exact:true}).waitFor();
      await broken.click(); await modal.waitFor();
      const repaired=page.waitForEvent('download');
      await modal.getByRole('link',{name:'Enregistrer',exact:true}).click();
      assert.equal((await readFile(await (await repaired).path())).toString(),'Plan original de recette');
      await modal.getByRole('button',{name:/^Fermer «/}).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors,[]);
      await page.screenshot({path:`${output}/${width}-repaired.png`,fullPage:true});
      report.push({width,height,offlineBytes:true,lateNetworkRetry:true,repairGuide:true,noDuplicate:true,overflow:false});
    } catch(error) { await page.screenshot({path:`${output}/${width}-failure.png`,fullPage:true}); throw error; }
    finally { await context.close(); }
  }
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(`${base}/tests/project-files-harness.html?syncRecovery=1&readonly=1`);
  await page.locator('.project-sync-issues').getByText(/personne autorisée/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Ajouter le fichier original',exact:true}).count(),0);
  assert.equal(await page.locator('.project-file-picker').count(),0);
  report.push({readOnly:true});await page.close();
} finally {await browser.close();}
await writeFile(`${output}/report.json`,JSON.stringify({engine,report},null,2));
console.log(JSON.stringify({engine,passed:report.length}));
