/** Actual DocumentEditor/draft/SDK under closed synthetic IPC; no native writes or user data. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
let root=process.env.ZENTRA_QA_REPO?resolve(process.env.ZENTRA_QA_REPO):dirname(fileURLToPath(import.meta.url));
while(!existsSync(join(root,'desktop/package.json'))){const parent=dirname(root);assert.notEqual(parent,root,'Set ZENTRA_QA_REPO to the repository');root=parent;}
const desktop=join(root,'desktop'),require=createRequire(join(desktop,'package.json'));
const vite=await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')),'dist/node/index.js')).href);
const imported=await import(pathToFileURL(process.env.ZENTRA_PLAYWRIGHT_MODULE||require.resolve('playwright')).href),pw=imported.default??imported;
const base=join(desktop,'tests'),mode=process.env.ZENTRA_QA_EXPECT_BASELINE==='true'?'baseline':'candidate';
const out=process.env.ZENTRA_QA_OUTPUT||join(tmpdir(),'zentra-time-invoice-customization');await mkdir(out,{recursive:true});
const fixture=await readFile(process.env.ZENTRA_QA_FIXTURE||join(base,'time-invoice-customization-fixture.tsx'),'utf8'),source=await readFile(join(desktop,'src/DocumentEditor.tsx'),'utf8');
const ts=require('typescript'),fixtureCode=ts.transpileModule(fixture,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const override=process.env.ZENTRA_QA_DOCUMENT_EDITOR_OVERRIDE,candidate=override?await readFile(override,'utf8'):source,sha=x=>createHash('sha256').update(x).digest('hex');
const translationOverride=process.env.ZENTRA_QA_DOCUMENT_COPY_OVERRIDE,translationCandidate=await readFile(translationOverride||join(desktop,'src/translationsDocumentEditor.ts'),'utf8'),copyOnly=process.env.ZENTRA_QA_COPY_ONLY==='true';
const translationAdditions={"Heures réservées":["Reservierte Stunden","Ore riservate","Reserved hours"],"Les heures facturées restent inchangées":["Die fakturierten Stunden bleiben unverändert","Le ore fatturate restano invariate","Billed hours stay unchanged"],"Cette saisie contient des changements de lignes ou de rattachement. Reprenez les valeurs enregistrées pour ces champs ; votre titre, vos notes, vos dates de facture et votre texte de bas de page seront conservés.":["Diese Eingabe enthält Änderungen an Positionen oder Verknüpfungen. Übernehmen Sie dafür die gespeicherten Werte; Titel, Notizen, Rechnungsdaten und Fusszeilentext bleiben erhalten.","Questa bozza contiene modifiche alle righe o ai collegamenti. Riprendi i valori registrati per questi campi; titolo, note, date della fattura e testo a piè di pagina saranno conservati.","This draft includes changes to items or links. Restore the saved values for those fields; your title, notes, invoice dates and footer text will be kept."],"Reprendre les heures réservées":["Reservierte Stunden übernehmen","Riprendi le ore riservate","Restore reserved hours"],"Les heures réservées ont été modifiées dans cette saisie. Votre texte est conservé. Utilisez « Reprendre les heures réservées » avant d’enregistrer.":["Die reservierten Stunden wurden in dieser Eingabe geändert. Ihr Text bleibt erhalten. Wählen Sie vor dem Speichern «Reservierte Stunden übernehmen».","Le ore riservate sono state modificate in questa bozza. Il testo è conservato. Usa «Riprendi le ore riservate» prima di salvare.","The reserved hours have been changed in this draft. Your text is kept. Use “Restore reserved hours” before saving."],"Les heures, les tarifs et la TVA restent liés aux temps facturés. Vous pouvez personnaliser le titre, les notes et les conditions de paiement.":["Stunden, Tarife und MWST bleiben mit den fakturierten Zeiten verknüpft. Titel, Notizen und Zahlungsbedingungen können Sie anpassen.","Ore, tariffe e IVA restano collegate ai tempi fatturati. Puoi personalizzare titolo, note e condizioni di pagamento.","Hours, rates and VAT stay linked to the billed time. You can customize the title, notes and payment terms."]};
const names=['DocumentEditor.tsx','bridge.ts','documentNumberEntry.ts','DocumentNumberInput.tsx','documentFormDraft.ts','formDrafts.ts','useFormDraft.tsx'];
const hashes=async()=>Object.fromEntries(await Promise.all(names.map(async name=>[name,sha(await readFile(desktop+'/src/'+name))])));
const report={mode,before:await hashes(),candidateSha256:override?sha(candidate):null,fixtureSha256:sha(fixture),cases:[],closed:false,scope:'Actual React DocumentEditor/number entry/form draft/SDK bridge; closed synthetic IPC receipts/refusals. No Rust LocalStore, native SQL, customer data or service.',limits:['The full-save IPC refusal is synthetic, independently corroborated by SCHEMA_SQL memory proof.','The host observes the child ActionRunner contract; this does not test whole App publication lifecycle.','No native compilation/execution; prepared LocalStore tests pending.']};
const loaded=await vite.loadConfigFromFile({command:'serve',mode:'development'},desktop+'/vite.config.ts');
const server=await vite.createServer({...loaded.config,root:desktop,configFile:false,cacheDir:join(tmpdir(),'zentra-time-editor-'+mode+'-'+Date.now()),
 plugins:[{name:'time-editor-proof',enforce:'pre',resolveId(id){if(id==='/__time_edit_fixture.js')return '\0time-edit-fixture.js';},load(id){if(id==='\0time-edit-fixture.js')return fixtureCode;id=id.replaceAll('\\','/').split('?')[0];if(override&&id===desktop.replaceAll('\\','/')+'/src/DocumentEditor.tsx')return candidate;if(translationOverride&&id===desktop.replaceAll('\\','/')+'/src/translationsDocumentEditor.ts')return translationCandidate;},configureServer(server){server.middlewares.use('/time-edit.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/time-edit.html','<html><body><div id="root"></div><script type="module" src="/__time_edit_fixture.js"></script></body></html>'));});if(copyOnly&&translationOverride)server.middlewares.use(async(req,res,next)=>{const language=/^\/__zentra-language\/(de|it|en)\.json/.exec(req.url||'')?.[1];if(!language)return next();const {translations}=await server.ssrLoadModule('/src/translations.ts');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(Object.fromEntries(Object.entries(translations).map(([key,values])=>[key,values[{de:0,it:1,en:2}[language]]]))));});}},...loaded.config.plugins],
 optimizeDeps:{entries:[],noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react','qrcode.react','@tauri-apps/api/core','@tauri-apps/api/event','@tauri-apps/plugin-dialog','@tauri-apps/plugin-fs']},resolve:{...loaded.config.resolve,dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false,watch:{ignored:['**/src-tauri/**']}},logLevel:'silent'});
const scenarios=(process.env.ZENTRA_QA_CASES||'fractional,fractional11,integer,old-financial,bad-dates,ordinary,readonly').split(',');assert(scenarios.every(x=>['fractional','fractional11','integer','old-financial','bad-dates','ordinary','readonly'].includes(x)));
try{
 await server.listen();const origin=server.resolvedUrls.local[0].replace(/\/$/,'');assert.notEqual(new URL(origin).port,'5363');
 for(const engine of (process.env.ZENTRA_QA_ENGINES||'chromium,webkit').split(',')){
  assert(['chromium','webkit'].includes(engine));
  const executable=engine==='chromium'?process.env.ZENTRA_EDGE_PATH:process.env.ZENTRA_WEBKIT_PATH;
  const browser=await pw[engine].launch({headless:true,...(executable?{executablePath:executable}:engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
  try{for(const scenario of scenarios){
   const row={engine,version:browser.version(),scenario,errors:[],external:[]};report.cases.push(row);
   const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(8000);
   page.on('pageerror',error=>row.errors.push(error.message));
   await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(row.external.push(route.request().url()),route.abort()));
   try{
    await page.goto(origin+'/time-edit.html?case='+scenario);const dialog=page.getByRole('dialog');await dialog.waitFor();
    if(scenario==='old-financial')await dialog.getByRole('button',{name:'Reprendre ma saisie',exact:true}).click();
    if(copyOnly){
     row.languages=[];
     for(const language of ['fr','de','it','en']){
      const selection=await page.evaluate(async language=>await window.__timeEditProof.chooseLanguage(language),language);assert.equal(selection,true);
      const copies=await page.evaluate(keys=>Object.fromEntries(keys.map(key=>[key,window.__timeEditProof.translate(key)])),Object.keys(translationAdditions));
      for(const [key,values]of Object.entries(translationAdditions))assert.equal(copies[key],language==='fr'?key:values[{de:0,it:1,en:2}[language]]);
      const label=copies['Reprendre les heures réservées'];await dialog.getByRole('button',{name:label,exact:true}).waitFor();
      row.languages.push({language,copies});await page.screenshot({path:out+'/'+engine+'-'+language+'.png'});
     }
     assert.equal(await page.evaluate(()=>window.__timeEditProof.proof.writes.length),0);row.green=true;
    }else if(scenario==='readonly'){
     assert.equal(await dialog.getByRole('button',{name:'Enregistrer le brouillon',exact:true}).isEnabled(),false);
     row.green=true;
    }else if(scenario==='old-financial'){
     await dialog.getByRole('button',{name:'Enregistrer le brouillon',exact:true}).click();
     if(mode==='candidate'){
      await dialog.locator('.error-guidance').waitFor();
      assert.equal(await page.evaluate(()=>window.__timeEditProof.proof.writes.length),0);
      assert.equal(await dialog.locator('[name=title]').inputValue(),'Preserved personal title');
      assert.equal(await dialog.locator('[name=notes]').inputValue(),'Preserved personal notes');
      assert.equal(await dialog.locator('[name=terms]').inputValue(),'Preserved personal footer');
      await dialog.getByRole('button',{name:'Reprendre les heures réservées',exact:true}).click();
      assert.equal(await dialog.locator('[name=title]').inputValue(),'Preserved personal title');
      await dialog.getByRole('button',{name:'Enregistrer le brouillon',exact:true}).click();await page.getByText('CONFIRMED SAVED',{exact:true}).waitFor();row.green=true;
     }else{await dialog.locator('.error-guidance').waitFor();row.desiredFailure='Full save submitted protected changed time line';row.green=false;}
    }else{
     await dialog.getByRole('button',{name:'1. Client',exact:true}).click();await dialog.locator('[name=title]').fill('Personal title');
     await dialog.getByRole('button',{name:'3. Conditions',exact:true}).click();
     if(['fractional','fractional11'].includes(scenario)&&mode==='baseline'){
      assert.equal(await page.evaluate(()=>window.__timeEditProof.proof.writes.length),0);
      assert.match((await page.evaluate(()=>window.__timeEditProof.number())).error,/4 décimales/);
      row.desiredFailure='Untouched fractional hour quantity blocked before IPC';row.green=false;
     }else{
      await dialog.locator('[name=notes]').fill('Personal notes');await dialog.locator('[name=terms]').fill('Personal footer');
      if(scenario==='bad-dates')await dialog.locator('[data-document-step="2"] input[type=date]').nth(1).fill('2026-09-01');
      await dialog.getByRole('button',{name:'4. Vérification',exact:true}).click();
      if(scenario==='bad-dates'){await dialog.locator('.error-guidance').waitFor();assert.equal(await page.evaluate(()=>window.__timeEditProof.proof.writes.length),0);assert.equal(await dialog.locator('[data-document-step="2"] input[type=date]').nth(1).inputValue(),'2026-09-01');row.green=true;}
      else{
       await dialog.getByRole('button',{name:'Enregistrer le brouillon',exact:true}).click();
       if(scenario==='integer'&&mode==='baseline'){await dialog.locator('.error-guidance').waitFor();row.desiredFailure='Unchanged lines reach immutable DELETE refusal';row.green=false;}
       else{await page.getByText('CONFIRMED SAVED',{exact:true}).waitFor();row.green=true;}
      }
     }
    }
    row.proof=await page.evaluate(()=>structuredClone(window.__timeEditProof.proof));row.number=await page.evaluate(()=>window.__timeEditProof.number());
    if(row.green&&!copyOnly&&['fractional','fractional11','integer','old-financial'].includes(scenario)){
     assert.equal(row.proof.writes.length,1);const write=row.proof.writes[0];assert.equal(write.command,'update_record');assert.equal(write.args.expectedWorkspaceScope,'fictive-scope-a');
     assert.deepEqual(Object.keys(write.args.data).sort(),['due_date','issue_date','notes','terms','title']);assert.equal(write.args.data.notes,scenario==='old-financial'?'Preserved personal notes':'Personal notes');
     if(scenario==='old-financial'){assert.equal(write.args.data.issue_date,'2026-09-05');assert.equal(write.args.data.due_date,'2026-11-05');}
    }
    if(scenario==='ordinary'){assert.equal(row.proof.writes.length,1);assert.equal(row.proof.writes[0].command,'save_document_with_items');}
    assert.deepEqual(row.errors,[]);assert.deepEqual(row.external,[]);await page.screenshot({path:out+'/'+engine+'-'+scenario+'.png'});
   }catch(error){row.failure=String(error.stack||error);row.green=false;await page.screenshot({path:out+'/'+engine+'-'+scenario+'-failure.png'});process.exitCode=1;}
   finally{await page.close();}
  }}finally{await browser.close();}
 }
}finally{await server.close();report.after=await hashes();assert.deepEqual(report.after,report.before);report.closed=true;await writeFile(out+'/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({mode,cases:report.cases.length,green:report.cases.filter(x=>x.green).length,desiredFailures:report.cases.filter(x=>x.desiredFailure).length,unexpectedFailures:report.cases.filter(x=>x.failure).map(x=>({engine:x.engine,scenario:x.scenario,failure:x.failure})),closed:true}));}
