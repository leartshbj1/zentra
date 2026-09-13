import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({ headless:true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel:'msedge' } : {}) });
const folder = `.qa/document-paragraph-${engine}`;
await mkdir(folder, { recursive:true });
const report=[];
try {
  for(const [width,height] of [[320,568],[390,844],[844,390],[1440,1000]]) {
    const page=await browser.newPage({ viewport:{width,height}, reducedMotion:'reduce' });
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    try {
      await page.route('**/native-design-fixture/*.pdf',async route=>{
        const kind=new URL(route.request().url()).pathname.split('/').at(-1).split('-')[0];
        await route.fulfill({contentType:'application/pdf',body:await readFile(`.qa/paragraph-pdfs/${kind}-paragraphs.pdf`)});
      });
      await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271'}/tests/document-design-harness.html?tools=1`);
      const ready=()=>page.locator('.design-studio__preview[aria-busy=false] .design-studio__pages img').first().waitFor({state:'attached',timeout:30000});
      const tools=async()=>{const b=page.getByRole('button',{name:'Mes réglages',exact:true});if(await b.isVisible())await b.click();};
      const draft=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('design-draft')||localStorage.getItem('design-settings')||'{}'));
      const select=async (box,start,end)=>box.evaluate((element,{start,end})=>{
        element.focus();const nodes=[];const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode())nodes.push(n);
        const point=offset=>{for(const node of nodes){if(offset<=node.textContent.length)return[node,offset];offset-=node.textContent.length;}throw Error('Out of text');};
        const range=document.createRange();range.setStart(...point(start));range.setEnd(...point(end));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));
      },{start,end});
      const categories=[['invoices','Factures'],['quotes','Devis'],['accounts','Bilan'],['payslips','Fiches de salaire']];
      await ready();
      for(const [kind,label] of categories) {
        await tools();await page.getByRole('button',{name:label,exact:true}).click();
        await page.getByRole('button',{name:'Textes',exact:true}).click();
        await page.getByLabel('Zone de texte',{exact:true}).selectOption('closing');
        const box=page.getByRole('textbox',{name:kind==='accounts'?'Commentaire après les comptes':'Conditions et message de fin',exact:true});
        await box.fill('Première condition\nDeuxième condition');
        await select(box,0,35);
        await page.getByRole('button',{name:'Liste numérotée',exact:true}).click();
        assert.equal((await draft()).documentComposition[kind].closing.every(p=>p.numbered),true);
        await page.locator('.rich-editor__paragraph-options summary').click();
        await page.getByLabel('Espace après le paragraphe',{exact:true}).selectOption('6');
        await select(box,0,4);await page.getByRole('button',{name:'Augmenter le retrait',exact:true}).click();
        let value=(await draft()).documentComposition[kind].closing;
        assert.equal(value[0].indent,1);assert.equal(value[1].indent,undefined);assert.equal(value[1].spaceAfter,6);
        await select(box,0,8);await page.getByRole('button',{name:'Gras',exact:true}).click();
        await page.getByLabel('Police du passage',{exact:true}).selectOption('times');
        await select(box,8,8);await box.press('Enter');await page.keyboard.insertText('Nouvelle');
        value=(await draft()).documentComposition[kind].closing;
        assert.equal(value.length,3);assert.equal(value[1].indent,1);assert.equal(value[2].indent,undefined);
        assert.equal(value[2].runs.map(r=>r.text).join(''),'Deuxième condition');
        assert.deepEqual(await box.locator('.rich-editor__paragraph').evaluateAll(nodes=>nodes.map(n=>n.dataset.marker)),['1.','2.','1.']);
        // A blank list item exits the list; it does not add a third blank paragraph.
        const end=value.map(p=>p.runs.map(r=>r.text).join('')).join('\n').length;
        await select(box,end,end);await box.press('Enter');await box.press('Enter');
        value=(await draft()).documentComposition[kind].closing;
        assert.equal(value.length,4);assert.equal(value[3].numbered,undefined);
        await page.keyboard.insertText('Merci');
        assert.equal((await draft()).documentComposition[kind].closing[3].runs[0].text,'Merci');
        // Selection-format actions are one undo step and preserve the other paragraph properties.
        await select(box,0,8);await page.getByRole('button',{name:'Diminuer le retrait',exact:true}).click();
        assert.equal((await draft()).documentComposition[kind].closing[0].indent,undefined);
        await page.getByRole('button',{name:'Annuler la modification du texte',exact:true}).click();
        assert.equal((await draft()).documentComposition[kind].closing[0].indent,1);
        const beforePaste=(await draft()).documentComposition[kind].closing;
        const html=await box.evaluate(el=>el.innerHTML);
        await select(box,0,beforePaste.map(p=>p.runs.map(r=>r.text).join('')).join('\n').length);
        await box.evaluate((el,html)=>{const data=new DataTransfer();data.setData('text/html',html);el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},html);
        const afterPaste=(await draft()).documentComposition[kind].closing;
        assert.deepEqual(afterPaste.map(p=>[p.numbered,p.indent,p.spaceAfter]),beforePaste.map(p=>[p.numbered,p.indent,p.spaceAfter]));
        await ready();await page.getByRole('button',{name:'Exporter cet exemple',exact:true}).click();
        const exported=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('design-export')));
        assert.deepEqual(exported.style.composition.closing,(await draft()).documentComposition[kind].closing);
      }
      await page.locator('.rich-editor').screenshot({path:`${folder}/${width}-editor.png`});
      await page.screenshot({path:`${folder}/${width}-tools.png`,fullPage:true});
      const frozen=await draft();
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('design-fixture-update',{detail:{busy:true}})));
      await page.waitForFunction(()=>document.querySelector('button[aria-label="Liste numérotée"]')?.disabled);
      assert.equal(await page.getByRole('button',{name:'Liste numérotée',exact:true}).isDisabled(),true);
      assert.equal(await page.getByRole('button',{name:'Augmenter le retrait',exact:true}).isDisabled(),true);
      assert.deepEqual(await draft(),frozen);
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('design-fixture-update',{detail:{busy:false}})));
      await page.getByRole('button',{name:'Enregistrer les présentations',exact:true}).click();
      await page.getByText('Présentations enregistrées.',{exact:true}).waitFor();
      await page.reload();await ready();
      const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('design-settings')));
      for(const [kind] of categories)assert.deepEqual(saved.documentComposition[kind].closing,frozen.documentComposition[kind].closing);
      const preview=page.getByRole('button',{name:'Mon document',exact:true});if(await preview.isVisible())await preview.click();
      await page.screenshot({path:`${folder}/${width}-preview.png`,fullPage:true});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      assert.deepEqual(errors,[]);report.push({width,height,categories:4,numbering:true,paragraphInsertion:true,spacing:true,readOnly:true,undo:true,pdfPayload:true,persistence:true});
    } catch(e) {
      await page.screenshot({path:`${folder}/${width}-failure.png`,fullPage:true});
      await writeFile(`${folder}/${width}-failure.txt`,`${e.stack}\n${await page.locator('body').innerText()}`);throw e;
    } finally {await page.close();}
  }
  await writeFile(`${folder}/report.json`,JSON.stringify({engine,report},null,2));console.log(JSON.stringify({engine,report}));
} finally {await browser.close();}
