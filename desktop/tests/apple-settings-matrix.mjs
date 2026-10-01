import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const pw=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const engine=process.env.ZENTRA_QA_BROWSER||'chromium';
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5363';
const output=`outputs/apple-redesign/settings-${engine}`;
await mkdir(output,{recursive:true});
const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'msedge'}:{})});
const report=[];
const ids=['readiness','company','account','payroll','documents','accounting','time','migration','automation','mail','appearance','personalization','language','assistant','storage'];
try{
  for(const [width,language,scale]of [[1440,'fr',100],[390,'fr',100],[320,'de',200]]){
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
    page.setDefaultTimeout(9000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(scale=>localStorage.setItem('zentra.text-size.v1',String(scale)),scale);
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=active&language=${language}`,{waitUntil:'networkidle'});
    const tr=value=>page.evaluate(async v=>(await import('/src/language.ts')).t(v),value);
    const tour=page.getByRole('button',{name:await tr('Fermer le guide automatique'),exact:true});
    if(await tour.isVisible())await tour.click();
    await page.keyboard.press('Control+k');
    await page.locator('.navigation-palette__search input').fill(await tr('Paramètres'));
    await page.locator('.navigation-palette__results button').filter({has:page.getByText(await tr('Paramètres'),{exact:true})}).click();
    for(const id of ids){
      const back=page.locator('.settings-browser__back');
      if(await back.isVisible())await back.click();
      await page.locator(`[data-settings-link="${id}"]`).click();
      const pane=page.locator(`[data-settings-id="${id}"][open]`);await pane.waitFor();
      for(const theme of ['light','dark','light']){
        await page.evaluate(async theme=>(await import('/src/appearance.ts')).setAppearance(theme),theme);
        await page.evaluate(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);});
        const layout=await pane.evaluate(e=>{
          const clipped=[...e.querySelectorAll('button,input,select,textarea,h2,h3,summary')].filter(n=>{
            const r=n.getBoundingClientRect();if(!n.getClientRects().length||r.bottom<0||r.top>innerHeight||n.closest('[hidden]'))return false;
            for(let p=n.parentElement;p&&p!==e;p=p.parentElement)if(['auto','scroll'].includes(getComputedStyle(p).overflowX)&&p.scrollWidth>p.clientWidth+1)return false;
            return r.left < -2||r.right>innerWidth+2;
          }).map(n=>({class:n.className,text:n.textContent.slice(0,80)}));
          const saved=window.scrollY;
          window.scrollTo(0,document.documentElement.scrollHeight);
          const dock=document.querySelector('.mobile-navigation');
          const dockBounds=dock?.getClientRects().length ? dock.getBoundingClientRect() : null;
          const controls=[...e.querySelectorAll('button:not(:disabled),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')].filter(n=>n.getClientRects().length&&!n.closest('[hidden]'));
          const last=controls.at(-1)?.getBoundingClientRect();
          const lastControlCovered=!!(dockBounds&&last&&last.height<innerHeight/2&&last.bottom>dockBounds.top-4);
          window.scrollTo(0,saved);
          return{overflow:document.documentElement.scrollWidth>innerWidth+1,clipped,lastControlCovered,dockHeight:dockBounds?.height||0};
        });
        if(theme!=='light'||!report.some(r=>r.id===id&&r.width===width&&r.theme==='light'))await page.screenshot({path:`${output}/${width}-${language}-${scale}-${theme}-${id}.png`});
        report.push({id,width,language,scale,theme,...layout});
      }
    }
    // An unsaved field survives category switches and theme changes.
    const back=page.locator('.settings-browser__back');if(await back.isVisible())await back.click();
    await page.locator('[data-settings-link="company"]').click();
    const name=page.locator('input[name="legalName"]');
    if(await name.count()){
      await name.fill('Brouillon à conserver');
      if(await back.isVisible())await back.click();await page.locator('[data-settings-link="appearance"]').click();
      if(await back.isVisible())await back.click();await page.locator('[data-settings-link="company"]').click();
      assert.equal(await name.inputValue(),'Brouillon à conserver');
    }
    assert.deepEqual(errors,[]);
    await page.close();
  }
}finally{await browser.close();await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));}
const issues=report.filter(r=>r.overflow||r.clipped.length||r.lastControlCovered);
console.log(JSON.stringify({cases:report.length,issues},null,2));
if(issues.length)process.exitCode=1;
