import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5357';
const output='.qa/agenda-mobile-focus'; await mkdir(output,{recursive:true});
const proof=[];
for(const engine of ['chromium','webkit']) {
  const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
  try {for(const width of [320,390,844,1440]) for(const language of ['fr','de','it','en']) {
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith('data:')?r.continue():r.abort());
    await page.addInitScript(language=>localStorage.setItem('zentra.interface.language.v1',language),language);
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&agendaGuided=1`);
    const tr=text=>page.evaluate(async text=>(await import('/src/language.ts')).t(text),text);
    const guide=page.getByRole('button',{name:await tr('Fermer le guide automatique'),exact:true});
    if(await guide.isVisible()) await guide.click();
    await page.evaluate(async({language,width})=>{
      await (await import('/src/language.ts')).setAppLanguage(language);
      (await import('/src/appearance.ts')).setAppearance(width===320||width===844?'dark':'light');
      const fixture=window.agendaFixture;
      fixture.stored.agendaEvents=[9,11,14].map(hour=>({id:`demo-${hour}`,title:`Rendez-vous client ${hour} — atelier de démonstration`,location:'Lausanne',notes:'Informations client conservées en français',projectId:null,employeeId:null,allDay:false,startDate:fixture.today,endDate:fixture.today,startTime:`${String(hour).padStart(2,'0')}:00`,endTime:`${String(hour+1).padStart(2,'0')}:00`,kind:'appointment',status:'scheduled',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
      await window.__qaAgendaRefresh();
    },{language,width});
    await page.getByRole('button',{name:await tr('Aller à un écran'),exact:true}).click();
    await page.getByRole('searchbox',{name:await tr('Rechercher un écran')}).fill(await tr('Agenda'));
    await page.locator('.navigation-palette__results button').filter({has:page.getByText(await tr('Agenda'),{exact:true})}).click();
    await page.locator('.agenda-row').first().waitFor();
    const compact=width<=860;
    assert.equal(await page.locator('.agenda-main-grid').getAttribute('data-display'),compact?'day':'month');
    assert.equal(await page.locator('.agenda-options .mobile-details').count(),compact?1:0);
    const firstTop=await page.locator('.agenda-row').first().evaluate(n=>n.getBoundingClientRect().top);
    if(compact) assert.ok(firstTop<620,`${engine}/${width}/${language}: first content too low (${firstTop})`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:`${output}/${engine}-${width}-${language}.png`});
    if(compact) await page.locator('.agenda-options summary').click();
    await page.getByRole('group',{name:await tr('Vue de l’agenda')}).getByRole('button',{name:await tr('Semaine'),exact:true}).click();
    assert.equal(await page.locator('.agenda-main-grid').getAttribute('data-display'),'week');
    const categories=page.locator('.agenda-filters select');
    await categories.selectOption('agenda');
    assert.equal(await categories.inputValue(),'agenda');
    if(compact) {
      assert.ok((await page.locator('.agenda-options summary').innerText()).includes(await tr('Filtres actifs')));
      await page.locator('.agenda-options summary').click();
      assert.equal(await categories.isVisible(),false);
      assert.equal(await categories.inputValue(),'agenda');
      await page.locator('.agenda-options summary').click();
    }
    await page.getByRole('group',{name:await tr('Vue de l’agenda')}).getByRole('button',{name:await tr('Jour'),exact:true}).click();
    if(compact) await page.locator('.agenda-options summary').click();
    assert.ok((await page.locator('.agenda-row').first().innerText()).includes('atelier de démonstration'));
    const writes=await page.evaluate(()=>window.agendaFixture.writes);
    assert.equal(writes,0,'View and filter changes cannot write appointments');
    await page.getByRole('button',{name:await tr('Ajouter'),exact:true}).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    assert.deepEqual(errors,[]);
    proof.push({engine,width,language,firstTop,defaultView:compact?'day':'month',filtersPreserved:true,customerTextPreserved:true,overflow:false,writes});
    await page.close();
  }}finally{await browser.close();}
}
await writeFile(`${output}/proof.json`,JSON.stringify(proof,null,2));
console.log(JSON.stringify({passed:proof.length,proof:`${output}/proof.json`}));
