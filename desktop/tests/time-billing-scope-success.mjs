import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const desktop = path.resolve(process.env.ZENTRA_DESKTOP_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const out = path.resolve(process.env.ZENTRA_QA_OUTPUT || path.join(os.tmpdir(), 'zentra-time-billing-scope-success'));
await fs.mkdir(out, { recursive: true });
const fixturePath = process.env.ZENTRA_TIME_BILLING_FIXTURE || path.join(desktop, 'tests/time-billing-scope-success-fixture.ts');
const require = createRequire(path.join(desktop, 'package.json'));
const runtimeRequire = require;
const vite = await import(pathToFileURL(path.join(path.dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href);
const pwModule = await import(pathToFileURL(runtimeRequire.resolve(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')).href), pw = pwModule.default ?? pwModule;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const tracked = ['src/App.tsx', 'src/WorkspaceApp.tsx', 'src/TimeBillingWizard.tsx', 'src/bridge.ts', 'src-tauri/src/commands.rs', 'tests/app-draft-identity-fixture.ts'];
const hashes = () => Promise.all(tracked.map(async file => [file, sha(await fs.readFile(path.join(desktop, file)))]));
const report = { before: await hashes(), cases: [], limits: 'Actual App, WorkspaceApp.act, TimeBillingWizard, bridge and Tauri SDK. ACK and invoice rows are synthetic local transport data; no native/SQL engine, API or customer data. Only synthetic test fixture injection. App, WorkspaceApp, Wizard and bridge are current source, without product overlays.', resourcesClosed: false };
const fixture = await fs.readFile(fixturePath, 'utf8');
const original = await fs.readFile(path.join(desktop, 'tests/app-draft-identity-fixture.ts'), 'utf8');
const injected = original.replace('export function installAppDraftIdentityFixture(', 'function originalIdentityFixture(') + '\n' + fixture.replace("import { desktopApi } from '/src/bridge';", '') + '\nexport function installAppDraftIdentityFixture(workspace){installTimeBillingScopeAudit(workspace,originalIdentityFixture);}';
report.syntheticFixtureSha = sha(fixture);
async function screen(page, label) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
  await page.locator('.navigation-palette').waitFor({ state: 'detached' });
}
try {
  for (const variant of ['fixed-success', 'fixed-late']) {
    const portProbe = createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve)); const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const config = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(desktop, 'vite.config.ts'));
    const server = await vite.createServer({ ...config.config, configFile: false, root: desktop, plugins: [{ name: 'independent-time-success', enforce: 'pre', load(id) { const file=id.replaceAll('\\','/').split('?')[0]; if(file.endsWith('/tests/app-draft-identity-fixture.ts'))return injected;} }, ...config.config.plugins], cacheDir: path.join(os.tmpdir(), `time-success-${port}`), resolve: { ...config.config.resolve, dedupe: ['react', 'react-dom'] }, optimizeDeps: { entries: [path.join(desktop, 'tests/mobile-harness.html')], noDiscovery: true, include: ['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react','qrcode.react','@tauri-apps/api/core','@tauri-apps/api/event','@tauri-apps/plugin-dialog','@tauri-apps/plugin-fs'] }, server: { host:'127.0.0.1',port,strictPort:true,hmr:false,watch:{ignored:['**/src-tauri/**']} }, logLevel: 'silent' });
    try {
      await server.listen();
      for(const engine of ['chromium','webkit']) {
        const browser = await pw[engine].launch({ headless: true, ...(engine==='chromium'?{...(process.env.ZENTRA_CHROMIUM_EXECUTABLE?{executablePath:process.env.ZENTRA_CHROMIUM_EXECUTABLE}:{})}:{}) });
        try {
          const row={variant,engine,errors:[],blocked:[],responses:[]};report.cases.push(row);
          const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);
          page.on('pageerror',error=>row.errors.push(error.message));
          page.on('response',response=>{if(response.status()>=400)row.responses.push({status:response.status(),url:response.url()});});
          await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin&&route.request().method()==='GET'&&!/^\/api(?:\/|$)/.test(url.pathname))return route.continue();row.blocked.push(url.origin+url.pathname);return route.abort();});
          try {
            await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
            await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1`);
            await page.waitForFunction(()=>window.__qaAppDraftIdentity?.proof.identityReads.some(row=>row.pending));
            await page.evaluate(()=>{window.__qaAppDraftIdentity.identityMode('ready');for(const row of window.__qaAppDraftIdentity.proof.identityReads.filter(row=>row.pending))window.__qaAppDraftIdentity.releaseIdentity(row.id);});
            await page.locator('.desktop-app').waitFor();
            await screen(page,'Temps');
            await page.evaluate(mode=>window.__qaTimeBillingScope.begin(mode),variant==='fixed-late'?'late-success':'success');
            await page.getByRole('button',{name:/Facturer les heures/}).click();
            await page.getByRole('dialog',{name:'Facturer les heures',exact:true}).waitFor();
            await page.getByRole('button',{name:'Créer la facture brouillon',exact:true}).click();
            if(variant==='fixed-late'){
              await page.waitForFunction(()=>window.__qaTimeBillingScope.proof.timeCommands.length===1);
              await page.evaluate(()=>window.__qaTimeBillingScope.switchVerifiedAccount());
              await page.getByRole('button',{name:'Ouvrir l’espace du compte',exact:true}).click();
              await page.waitForFunction(()=>document.querySelector('.sidebar__company strong')?.textContent==='CURRENT COMPANY C');
              row.beforeLate=await page.evaluate(()=>({screen:document.querySelector('.page-content')?.getAttribute('data-screen'),company:document.querySelector('.sidebar__company strong')?.textContent}));
              await page.evaluate(()=>window.__qaTimeBillingScope.releaseBilling());
            }
            await page.getByRole('dialog',{name:'Facturer les heures',exact:true}).waitFor({state:'detached'});
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
            row.after=await page.evaluate(()=>({screen:document.querySelector('.page-content')?.getAttribute('data-screen'),title:document.querySelector('.page-header h1')?.textContent,dialogs:[...document.querySelectorAll('[role=dialog]')].map(node=>node.textContent),proof:structuredClone(window.__qaTimeBillingScope.proof),text:document.body.innerText}));
            assert.equal(row.after.proof.timeCommands.length,1);assert.equal(row.after.proof.timeCommands[0].expectedScopePresent,true);assert.equal(row.after.proof.timeCommands[0].expectedScope,row.after.proof.timeCommands[0].databaseScope);assert.equal(row.after.proof.reads,variant==='fixed-late'?2:1);assert.deepEqual(row.errors,[]);assert.deepEqual(row.blocked,[]);
            row.navigatedToInvoices=row.after.screen==='invoices';if(variant==='fixed-success')assert.equal(row.navigatedToInvoices,true);else{assert.equal(row.after.screen,row.beforeLate.screen);assert.equal(row.navigatedToInvoices,false);assert.equal(row.after.proof.timeCommands.length,1);}row.completed=true;
            await page.screenshot({path:path.join(out,`${variant}-${engine}-success.png`)});
          } catch(error) {row.failure=error.stack;throw error;} finally {await page.close();}
        } finally {await browser.close();}
      }
    } finally {await server.close();}
  }
} catch(error) {report.failure=error.stack;process.exitCode=1;} finally {report.after=await hashes();report.sourcesStable=JSON.stringify(report.before)===JSON.stringify(report.after);report.resourcesClosed=true;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
assert(report.sourcesStable);
console.log(JSON.stringify({cases:report.cases.map(row=>({variant:row.variant,engine:row.engine,screen:row.after?.screen,navigatedToInvoices:row.navigatedToInvoices,completed:row.completed})),failure:!!report.failure,sourcesStable:report.sourcesStable,resourcesClosed:report.resourcesClosed}));
