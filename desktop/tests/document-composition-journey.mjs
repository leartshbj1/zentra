import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({ headless:true, ...(engine === 'chromium' && process.platform === 'win32' ? {channel:'msedge'} : {}) });
const folder = `.qa/document-composition-${engine}`; await mkdir(folder,{recursive:true});
const report=[];
try {
 for (const width of [1440,390,320]) {
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}); const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.route('**/native-design-fixture/*.pdf',async route=>{
   const file=new URL(route.request().url()).pathname.split('/').at(-1);
   assert.match(file,/^(quotes|invoices|accounts|payslips)-(signature|minimal|helvetica|times|courier)\.pdf$/);
   await route.fulfill({contentType:'application/pdf',body:await readFile(`.qa/composition-pdfs/${file}`)});
  });
  await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271'}/tests/document-design-harness.html`);
  const ready=()=>page.locator('.design-studio__preview[aria-busy=false] .design-studio__pages img').first().waitFor({timeout:30000});
  const request=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('design-request')));
  await ready();
  await page.getByRole('button',{name:'Classique',exact:true}).click();await ready();
  assert.equal((await request()).style.composition.fontFamily,'times');
  await page.getByLabel('Taille du texte',{exact:true}).selectOption('11');
  await page.getByRole('button',{name:'Mise en page',exact:true}).click();
  await page.getByLabel('Position du logo',{exact:true}).selectOption('right');
  await page.getByLabel('Marges',{exact:true}).selectOption('25');
  await page.getByLabel('Position des totaux',{exact:true}).selectOption('afterNotes');await ready();
  const design=(await request()).style.composition;assert.equal(design.logoPosition,'right');assert.equal(design.bodySize,11);assert.equal(design.marginMm,25);assert.equal(design.totalsPosition,'afterNotes');
  await page.getByRole('button',{name:'Textes',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'Conditions et message de fin',exact:true});
  await editor.fill('Paiement sous 30 jours.');
  await editor.press('End');await editor.press('Enter');await editor.pressSequentially('Merci de votre confiance.');
  await ready();
  let rich=(await request()).style.composition.closing;
  assert.equal(rich.map(p=>p.runs.map(r=>r.text).join('')).join('\n'),'Paiement sous 30 jours.\nMerci de votre confiance.');
  await editor.evaluate(el=>{
   const node=el.querySelector('.rich-editor__paragraph')?.firstChild?.firstChild || el.firstChild;
   const range=document.createRange();range.setStart(node,0);range.setEnd(node,8);const s=getSelection();s.removeAllRanges();s.addRange(range);el.focus();
  });
  await page.getByRole('group',{name:'Mise en forme : Conditions et message de fin',exact:true}).getByRole('button',{name:'Gras',exact:true}).click();await ready();
  rich=(await request()).style.composition.closing;
  assert.ok(rich[0].runs.some(r=>r.bold && r.text==='Paiement'));
  await page.getByRole('group',{name:'Mise en forme : Conditions et message de fin',exact:true}).getByRole('button',{name:'Souligner',exact:true}).click();await ready();
  rich=(await request()).style.composition.closing;assert.ok(rich[0].runs.some(r=>r.bold && r.underline && r.text==='Paiement'));
  await page.getByRole('group',{name:'Mise en forme : Conditions et message de fin',exact:true}).getByRole('button',{name:'Centrer',exact:true}).click();await ready();
  assert.equal((await request()).style.composition.closing[0].align,'center');
  await page.getByRole('group',{name:'Mise en forme : Conditions et message de fin',exact:true}).getByRole('button',{name:'Annuler la modification du texte',exact:true}).click();await ready();
  assert.equal((await request()).style.composition.closing[0].align,'left');
  // Paste is text only, even if the clipboard contains executable HTML.
  await editor.press('Control+End');
  await editor.evaluate(el=>{const data=new DataTransfer();data.setData('text/plain',' <script>texte</script>');data.setData('text/html','<img src=x onerror=alert(1)>');el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});await ready();
  assert.equal(await editor.locator('img,script').count(),0);
  assert.ok((await request()).style.composition.closing.flatMap(p=>p.runs).map(r=>r.text).join('').includes('<script>texte</script>'));
  await page.getByRole('button',{name:'Enregistrer les présentations',exact:true}).click();
  await page.reload();await ready();assert.equal((await request()).style.composition.logoPosition,'right');
  await page.getByText('Réutiliser cette présentation',{exact:true}).click();await page.getByLabel('Copier vers',{exact:true}).selectOption('quotes');
  await page.getByRole('button',{name:'Copier la présentation',exact:true}).click();
  await page.getByRole('button',{name:'Devis',exact:true}).click();await ready();assert.equal((await request()).style.composition.fontFamily,'times');
  await page.getByRole('button',{name:'Exporter cet exemple',exact:true}).click();assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('design-export'))),await request());
  await page.getByRole('button',{name:'Réinitialiser devis',exact:true}).click();await ready();assert.equal((await request()).style.composition,undefined);
  await page.getByRole('button',{name:'Factures',exact:true}).click();await ready();assert.equal((await request()).style.composition.fontFamily,'times');
  await page.getByRole('button',{name:'Textes',exact:true}).click();await page.getByText('Pied de page simple',{exact:true}).click();
  await page.getByLabel('Une phrase en pied de page',{exact:true}).fill('Erreur de recette');await page.getByRole('alert').waitFor();assert.ok(await page.getByRole('button',{name:'Exporter cet exemple',exact:true}).isDisabled());
  await page.getByLabel('Une phrase en pied de page',{exact:true}).fill('Merci.');await ready();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:`${folder}/${width}.png`,fullPage:true});
  for (const kind of ['quotes','invoices','payslips']) {
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271'}/tests/document-design-harness.html?preview=${kind}`);
    await page.getByRole('alert').waitFor(); await page.getByRole('button',{name:'Réessayer',exact:true}).click();
    await page.locator('.pdf-attachment-preview__viewport[aria-busy=false] canvas').waitFor();
    const read = await page.evaluate(()=>JSON.parse(sessionStorage.getItem('document-preview-request')));
    assert.deepEqual(read,{kind,id:'fixture-document',attempts:2});
    await page.getByRole('button',{name:'Agrandir',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    const next=page.getByRole('button',{name:'Page suivante',exact:true});
    if (await next.isEnabled()) {await next.click();await page.locator('.pdf-attachment-preview__viewport[aria-busy=false] canvas').waitFor();}
    await page.getByRole('button',{name:'Exporter le PDF',exact:true}).click();
    const exported=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('document-preview-export')));assert.equal(exported.kind,kind);assert.equal(exported.id,'fixture-document');
    await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.getByText('Aperçu fermé.',{exact:true}).waitFor();
  }
  assert.deepEqual(errors,[]);report.push({width,richSelection:true,undo:true,paste:true,saveReload:true,copy:true,reset:true,noOverflow:true});await page.close();
 }
 await writeFile(`${folder}/report.json`,JSON.stringify({engine,report},null,2));console.log(JSON.stringify({engine,report}));
} finally {await browser.close();}
