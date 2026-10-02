import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5393';
const report = [], errors = [];
const folder = `.qa/import-scope-${engine}`;
await mkdir(folder,{recursive:true});
try {
  for(const kind of ['bank','catalog','bexio','email','attachment','scan']) {
    const page = await browser.newPage({viewport:{width:1280,height:960}});
    page.on('pageerror', error=>errors.push(`${kind}: ${error.message}`));
    await page.goto(`${origin}/tests/import-scope-harness.html?kind=${kind}`);
    await page.waitForFunction(()=>Boolean(window.__qaImport));
    if(kind==='bank') await page.getByRole('button',{name:'Choisir le relevé XML'}).click();
    if(kind==='email') await page.getByRole('button',{name:'Importer un e-mail'}).click();
    if(kind==='attachment') await page.getByRole('button',{name:'Ajouter un justificatif'}).click();
    if(kind==='scan') {
      await page.getByRole('button',{name:'Scanner une facture',exact:true}).waitFor();
      await page.locator('.invoice-scan input[type=file]').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:await readFile('tests/fixtures/automation-test-invoice.pdf')});
      await page.waitForFunction(()=>window.__qaImport.pendingRead());
    } else if(kind==='catalog'||kind==='bexio') {
      const csv = kind==='catalog'?'Référence;Désignation;Prix de vente;TVA;Unité\nSYNTHETIC;Article synthétique;2.00;0;pièce':'Nom;E-mail\nClient synthétique;synthetic@example.invalid';
      await page.locator('input[type=file]').setInputFiles({name:'synthetic.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
      await page.waitForFunction(()=>window.__qaImport.pendingRead());
    } else await page.waitForFunction(()=>window.__qaImport.pendingSelection());
    // Real production component remains mounted: change workspace and callback
    // while its first asynchronous file read/selector has not resolved.
    await page.evaluate(()=>window.__qaImport.change());
    await page.locator('main[data-version="1"]').waitFor();
    await page.evaluate(kind=>['catalog','bexio','scan'].includes(kind)?window.__qaImport.releaseRead():window.__qaImport.release(),kind);
    if(kind==='bank') await page.getByRole('button',{name:'Importer ce relevé',exact:true}).click();
    if(kind==='catalog') await page.getByRole('button',{name:'Importer (1)',exact:true}).click();
    if(kind==='bexio') await page.getByRole('button',{name:'Ajouter 1 clients',exact:true}).click();
    if(kind==='email') { await page.locator('.supplier-email-final-check input').check(); await page.getByRole('button',{name:'Créer le brouillon',exact:true}).click(); }
    if(kind==='scan') {
      await page.getByRole('button',{name:'Utiliser ces informations',exact:true}).click();
      await page.getByRole('button',{name:'Continuer vers les achats',exact:true}).click();
      await page.getByRole('button',{name:'Vérifier la facture',exact:true}).click();
      await page.getByRole('button',{name:'Enregistrer le brouillon',exact:true}).click();
    }
    const command = {bank:'bank',catalog:'catalog',bexio:'import_bexio_contacts',email:'email-save',attachment:'attachment',scan:'generic-draft-save'}[kind];
    await page.waitForFunction(command=>window.__qaImport.calls.some(call=>call.command===command),command);
    const calls = await page.evaluate(()=>window.__qaImport.calls);
    assert.equal(calls.find(call=>call.command===command).args.expectedWorkspaceScope,'scope-A',`${kind} kept original scope before await`);
    if(kind==='email') assert.equal(calls.find(call=>call.command==='inspect').args.expectedWorkspaceScope,'scope-A');
    if(kind==='bank'||kind==='catalog') assert.equal(calls.find(call=>call.command===command).callbackVersion,1,`${kind} uses current callback rather than frozen callback`);
    if(kind==='email'||kind==='attachment') assert.equal(calls.find(call=>call.command==='current-action').callbackVersion,1,`${kind} uses current action callback`);
    if(kind==='bexio') assert.equal(calls.find(call=>call.command==='bexio-publication').callbackVersion,1);
    if(kind==='scan') {
      await page.locator('[role=alert]').first().waitFor();
      assert.equal(await page.getByText('Champ invalide : L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.',{exact:true}).count(),1);
      assert.equal(calls.some(call=>call.command==='scan-attachment'),false,'refused draft never proceeds to successful scanned attachment');
    }
    report.push({kind,originalScope:'scope-A',currentScope:'scope-B',currentCallbacks:true,...(kind==='scan'?{refusedOldDraftBeforeAttachment:true,transportScopeGuard:'synthetic, native handler proof is separate CI test'}:{}),calls});
    await page.screenshot({path:`${folder}/${kind}.png`,fullPage:true});
    await page.close();
  }
  // Permission revocation during attachment selection must prevent any write.
  const page = await browser.newPage();
  page.on('pageerror',error=>errors.push(`revocation: ${error.message}`));
  await page.goto(`${origin}/tests/import-scope-harness.html?kind=attachment`);
  await page.getByRole('button',{name:'Ajouter un justificatif'}).click();
  await page.waitForFunction(()=>window.__qaImport.pendingSelection());
  await page.evaluate(()=>window.__qaImport.change('scope-A',true));
  await page.locator('main[data-version="1"]').waitFor();
  await page.evaluate(()=>window.__qaImport.release());
  await page.locator('.supplier-attachments[aria-busy=false]').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.__qaImport.calls),[]);
  report.push({kind:'attachment-permission-revoked',noMutation:true});
  assert.deepEqual(errors,[]);
  await writeFile(`${folder}/report.json`,JSON.stringify({engine,report,errors},null,2));
  process.stdout.write(JSON.stringify({engine,journeys:report.length,errors:errors.length})+'\n');
} finally {await browser.close();}
