import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const playwright = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.ZENTRA_QA_BROWSER || 'chromium';
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5363';
const out = path.resolve(process.env.ZENTRA_QA_OUTPUT || `outputs/apple-redesign/matrix-${engine}`);
await mkdir(out, {recursive:true});
const allViews = [
  ['dashboard','Tableau de bord',''], ['agenda','Agenda','agendaGuided=1'],
  ['notes','Notes','notes=1'], ['projects','Projets',''], ['clients','Clients',''],
  ['catalog','Produits & services','stockGuided=1'], ['quotes','Devis',''],
  ['invoices','Factures',''], ['orders','Commandes & livraisons',''],
  ['reminders','Relances',''], ['time','Temps',''], ['team','Équipe & salaires',''],
  ['expenses','Achats & fournisseurs',''], ['bank','Banque','bank=1'],
  ['reports','Rapports','reportTest=1'], ['accounting','Comptabilité','finance=1'],
  ['automation','Zentra Automation','automation=active&automationDesign=1'],
  ['settings','Paramètres',''],
];
const requestedViews = process.env.ZENTRA_QA_VIEWS?.split(',');
const views = requestedViews ? allViews.filter(([id])=>requestedViews.includes(id)) : allViews;
const languages = process.env.ZENTRA_QA_QUICK ? ['fr'] : ['fr','de','it','en'];
const sizes = [[1440,1000,'desktop'],[390,844,'mobile']];
const themes = ['light','dark'];
const browser = await playwright[engine].launch({...(engine === 'chromium' ? {channel:'msedge'} : {}),headless:true});
const report=process.env.ZENTRA_QA_APPEND ? JSON.parse(await readFile(path.join(out,'report.json'),'utf8')).filter(r=>!views.some(([id])=>id===r.id)) : [];
async function settle(page) {
  await page.evaluate(async()=>{
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
    await new Promise(requestAnimationFrame);
  });
}
async function translated(page,value) { return page.evaluate(async v=>(await import('/src/language.ts')).t(v),value); }
async function inspect(page) {
  return page.evaluate(()=>{
    const root=document.querySelector('.page-content');
    const visible=e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden' && !e.closest('[hidden]');
    const clipped=[...root.querySelectorAll('button,input,select,textarea,h1,h2,h3,strong')].filter(e=>{
      if(!visible(e))return false;
      const r=e.getBoundingClientRect();
      if(!r.width||!r.height||r.bottom<0||r.top>innerHeight)return false;
      for(let p=e.parentElement;p&&p!==root;p=p.parentElement)if(['auto','scroll'].includes(getComputedStyle(p).overflowX)&&p.scrollWidth>p.clientWidth+1)return false;
      return r.left < -2 || r.right > innerWidth+2;
    }).map(e=>({element:e.className,text:e.textContent.slice(0,80)}));
    const textClipped=[...root.querySelectorAll('button,h1,h2,h3')].filter(e=>visible(e)&&e.clientWidth&&e.scrollWidth>e.clientWidth+2&&getComputedStyle(e).textOverflow!=='ellipsis'&&getComputedStyle(e).overflowX==='hidden').map(e=>({element:e.className,text:e.textContent.slice(0,80)}));
    const crampedHeaderActions=[...document.querySelectorAll('.page-header__actions .button')].filter(e=>visible(e)&&e.textContent.trim().length>5&&e.getBoundingClientRect().width<100&&e.getBoundingClientRect().height>120).map(e=>e.textContent.trim());
    return {overflow:document.documentElement.scrollWidth>innerWidth+1,clipped,textClipped,crampedHeaderActions,title:document.querySelector('.page-header h1')?.textContent,view:document.querySelector('.desktop-app')?.dataset.view};
  });
}
try {
  // Independent browser contexts preserve each language/theme's own preferences.
  for(const language of languages) for(const [width,height,size]of sizes) for(const theme of themes) {
    const context=await browser.newContext({viewport:{width,height},hasTouch:width<600,reducedMotion:'reduce'});
    for(const [id,label,fixture,subtab]of views) {
      const page=await context.newPage();page.setDefaultTimeout(8000);
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      let result;
      try {
        await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&language=${language}&theme=${theme}&${fixture}`,{waitUntil:'networkidle'});
        const dismiss=page.getByRole('button',{name:await translated(page,'Fermer le guide automatique'),exact:true});
        if(await dismiss.isVisible())await dismiss.click();
        if(id!=='dashboard'&&id!=='automation') {
          await page.keyboard.press('Control+k');
          const search=page.locator('.navigation-palette__search input');
          await search.fill(await translated(page,label));
          await page.locator('.navigation-palette__results button').filter({has:page.getByText(await translated(page,label),{exact:true})}).click();
        }
        if(subtab)await page.locator('.sales-tabs button').filter({hasText:await translated(page,subtab)}).click();
        const ready = {agenda:'.agenda-layout',notes:'.notes-workspace',catalog:'.catalog-screen',orders:'.sales-orders-screen, .page-content > .empty-state',reminders:'.reminders-screen',expenses:'.purchase-workflow',reports:'.project-reports',bank:'.bank-screen',accounting:'.finance-overview',automation:'.automation-hub__activity'}[id];
        if (ready) await page.locator(ready).waitFor();
        await settle(page);
        result={...await inspect(page),loaded:ready ? await page.locator(ready).isVisible() : true};
        await page.screenshot({path:path.join(out,`${size}-${language}-${theme}-${id}.png`),fullPage:true});
      }catch(error){result={failure:error.message};}
      report.push({id,language,theme,width,height,...result,errors});
      await page.close();
    }
    await context.close();
    await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(`${language} ${size} ${theme}: ${report.length} surfaces`);
  }
}finally {await browser.close();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
const issues=report.filter(r=>r.failure||r.errors.length||r.overflow||r.clipped?.length||r.textClipped?.length||r.crampedHeaderActions?.length||!r.loaded);
console.log(JSON.stringify({surfaces:report.length,issues},null,2));
if(issues.length)process.exitCode=1;
