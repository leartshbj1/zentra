import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({headless:true,...(engine==='chromium'&&process.platform==='win32'?{channel:'msedge'}:{})});
const folder = `.qa/document-fonts-${engine}`;
await mkdir(folder,{recursive:true});
const report=[];
try {
  for(const [width,height] of [[320,568],[390,844],[1440,1000]]) {
    const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});
    const errors=[],fontRequests=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.url().includes('.ttf'))fontRequests.push(request.url());});
    await page.route('**/native-design-fixture/*.pdf',async route=>{
      const name=new URL(route.request().url()).pathname.split('/').at(-1);
      const path= /-(inter|literata)\.pdf$/.test(name)?`.qa/font-pdfs/${name}`:`.qa/composition-pdfs/${name}`;
      await route.fulfill({contentType:'application/pdf',body:await readFile(path)});
    });
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271'}/tests/document-design-harness.html?tools=1`);
    const ready=()=>page.locator('.design-studio__preview[aria-busy=false] .design-studio__pages img').first().waitFor({state:'attached',timeout:30000});
    const state=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('design-draft')||localStorage.getItem('design-settings')||'{}'));
    const tools=async()=>{const button=page.getByRole('button',{name:'Mes réglages',exact:true});if(await button.isVisible())await button.click();};
    await ready();
    for(const [kind,label] of [['invoices','Factures'],['quotes','Devis'],['accounts','Bilan'],['payslips','Fiches de salaire']]){
      await tools();await page.getByRole('button',{name:label,exact:true}).click();
      await page.getByRole('button',{name:'Style',exact:true}).click();
      await page.getByLabel('Police du document',{exact:true}).selectOption(kind==='quotes'?'literata':'inter');
      await page.getByLabel('Police du titre',{exact:true}).selectOption('literata');
      await ready();
      assert.equal((await state()).documentComposition[kind].titleFontFamily,'literata');
      const exportButton=page.getByRole('button',{name:'Exporter cet exemple',exact:true});
      await exportButton.click();
      await page.waitForFunction(kind=>JSON.parse(sessionStorage.getItem('design-export')||'{}').kind===kind,kind);
      assert.equal((await page.evaluate(()=>JSON.parse(sessionStorage.getItem('design-export')))).style.composition.titleFontFamily,'literata');
    }
    await tools();await page.getByRole('button',{name:'Factures',exact:true}).click();
    await page.getByRole('button',{name:'Textes',exact:true}).click();
    const editor=page.getByRole('textbox',{name:'Conditions et message de fin',exact:true});
    await editor.fill('');
    await editor.evaluate(element=>{
      element.focus();const transfer=new DataTransfer();
      transfer.setData('text/html','<p><span style="font-family: Inter;">Avant </span><span style="font-family: Literata; font-weight:700; font-style:italic;">conditions</span><span style="font-family: Inter;"> après</span></p>');
      transfer.setData('text/plain','Avant conditions après');
      element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
    });
    let closing=(await state()).documentComposition.invoices.closing;
    assert.deepEqual(closing[0].runs.map(run=>[run.text,run.fontFamily]),[['Avant ','inter'],['conditions','literata'],[' après','inter']]);
    assert.equal(closing[0].runs[1].bold,true);assert.equal(closing[0].runs[1].italic,true);
    await page.getByRole('button',{name:'Annuler la modification du texte',exact:true}).click();
    assert.equal((await state()).documentComposition.invoices.closing.flatMap(p=>p.runs).map(r=>r.text).join(''),'');
    await page.getByRole('button',{name:'Rétablir la modification du texte',exact:true}).click();
    const loaded=await page.evaluate(async()=>{
      const result=[];
      for(const family of ['Zentra Document Inter','Zentra Document Literata']) for(const style of ['normal','italic']) for(const weight of [400,700]){
        const query=`${style} ${weight} 16px "${family}"`;
        const fonts=await document.fonts.load(query,'Aa été CHF');
        result.push({family,style,weight,loaded:fonts.length>0&&fonts.every(font=>font.status==='loaded')});
      }
      return result;
    });
    assert.equal(loaded.length,8);assert.ok(loaded.every(font=>font.loaded));
    assert.ok(fontRequests.every(url=>new URL(url).hostname==='127.0.0.1'));
    await ready();
    await page.getByRole('group',{name:'Historique de la présentation'}).getByRole('button',{name:'Enregistrer',exact:true}).click();
    await page.getByText('Présentations enregistrées.',{exact:true}).waitFor();
    await page.reload();await ready();await tools();
    assert.equal((await state()).documentComposition.invoices.closing[0].runs[1].fontFamily,'literata');
    await page.getByRole('button',{name:'Style',exact:true}).click();
    assert.equal(await page.getByLabel('Police du document',{exact:true}).inputValue(),'inter');
    assert.equal(await page.getByLabel('Police du titre',{exact:true}).inputValue(),'literata');
    await page.locator('.design-studio__font-sample').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:`${folder}/${width}-fonts.png`,fullPage:true});
    const preview=page.getByRole('button',{name:'Mon document',exact:true});if(await preview.isVisible())await preview.click();
    await ready();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    assert.deepEqual(errors,[]);
    report.push({width,height,allFourCategories:true,allEightFacesLoadedLocally:true,paste:true,undo:true,saveReload:true,exportSettings:true,noOverflow:true});
    await page.close();
  }
  await writeFile(`${folder}/report.json`,JSON.stringify({engine,scope:'Real editor with native sample PDFs and a simulated storage/export bridge; no physical device or installation claim.',report},null,2));
  console.log(JSON.stringify({engine,report}));
}finally{await browser.close();}
