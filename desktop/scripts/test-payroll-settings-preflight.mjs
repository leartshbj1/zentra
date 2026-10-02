/** Bounded derivation of scripts/test-settings-action-lifecycle.mjs: real App/DOM/bridge/SDK. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as freePortServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const desktop = resolve(dirname(script), '..');
const out = resolve(process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), `zentra-payroll-settings-preflight-${Date.now()}`));
await mkdir(out, { recursive: true });
const require = createRequire(join(desktop, 'package.json'));
const vite = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href);
const playwrightModule = process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright';
const imported = await import(playwrightModule.startsWith('file:') ? playwrightModule : pathToFileURL(isAbsolute(playwrightModule) ? playwrightModule : require.resolve(playwrightModule)).href);
const pw = imported.default ?? imported;
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceNames = ['src/App.tsx','src/WorkspaceApp.tsx','src/CompanyAccountGate.tsx','src/PayrollSettingsForm.tsx','src/payrollSettingsDraft.ts','src/bridge.ts','src/useWorkspaceRecovery.ts','tests/mobile-harness.tsx','tests/app-draft-identity-fixture.ts','tests/payroll-settings-preflight-fixture.ts','scripts/test-payroll-settings-preflight.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, sha(await readFile(join(desktop, name)))])));
const report = { startedAt: new Date().toISOString(),  node: { version: process.version, executable: process.execPath }, before: await hashes(), cases: [], limits: 'Actual App/SettingsScreen/PayrollSettingsForm/bridge/SDK and actual account-Gate button. Identity and native transport are assembled synthetic dependencies; update_settings acceptance is simulated and is not SQL/native evidence. All external/API requests blocked. No model/native app/CI/user data; 5363 untouched.' };
const original = await readFile(join(desktop, 'tests/app-draft-identity-fixture.ts'), 'utf8');
assert.equal(original.split('export function installAppDraftIdentityFixture(').length, 2);
const fixture = original.replace('export function installAppDraftIdentityFixture(', 'function installOriginalAppDraftIdentityFixture(') + `
import { installPayrollPreflightFixture } from '/tests/payroll-settings-preflight-fixture.ts';
export function installAppDraftIdentityFixture(workspace: Workspace) { installPayrollPreflightFixture(workspace, installOriginalAppDraftIdentityFixture); }
`;
const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, join(desktop, 'vite.config.ts'));
const probe = freePortServer();
await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
const port = probe.address().port;
await new Promise(ok => probe.close(ok));
assert.notEqual(port, 5363);
const origin = `http://127.0.0.1:${port}`;
const server = await vite.createServer({
  ...loaded.config, configFile: false, root: desktop,
  plugins: [{ name: 'closed-payroll-preflight-fixture', enforce: 'pre', load(id) { const clean=id.replaceAll('\\','/').split('?')[0];if(clean.endsWith('/tests/app-draft-identity-fixture.ts'))return fixture; } }, ...loaded.config.plugins],
  cacheDir: join(tmpdir(), `zentra-payroll-preflight-vite-${port}`),
  resolve: { ...loaded.config.resolve, dedupe: ['react','react-dom'] },
  optimizeDeps: { entries: [join(desktop,'tests/mobile-harness.html')], noDiscovery: true, include: ['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react','qrcode.react','@tauri-apps/api/core','@tauri-apps/api/event','@tauri-apps/plugin-dialog','@tauri-apps/plugin-fs'] },
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/src-tauri/**'] } }, logLevel: 'silent',
});
async function screen(page, label) {
  await page.getByRole('button',{name:'Aller à un écran',exact:true}).click();
  await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill(label);
  await page.locator('.navigation-palette__results button').filter({has:page.getByText(label,{exact:true})}).click();
  await page.locator('.navigation-palette').waitFor({state:'detached'});
}
async function snapshot(page) {
  return page.evaluate(() => ({
    company: document.querySelector('.sidebar__company strong')?.textContent,
    visibleB: document.body.textContent.includes('Client fictif B'),
    successNotice: !!document.querySelector('.notice--success'),
    dialogs: [...document.querySelectorAll('[role=dialog]')].map(node => node.textContent.slice(0,200)),
    proof: structuredClone(window.__qaPayrollPreflight.proof),
    database: window.__qaPayrollPreflight.snapshot(),
  }));
}
try {
  await server.listen(); report.origin = origin;
  for (const engine of ['chromium','webkit']) {
    const browser = await pw[engine].launch({headless:true,...engine==='chromium'?(process.env.ZENTRA_EDGE_PATH?{executablePath:process.env.ZENTRA_EDGE_PATH}:process.platform==='win32'?{channel:'msedge'}:{}):{}});
    try {
      for (const scenario of (process.env.ZENTRA_QA_CASES || 'stale-preflight-to-B,current-save-control,double-submit-control,read-only-control,read-only-after-preflight').split(',')) {
        const item = { engine, browserVersion: browser.version(), scenario, errors: [], blockedRequests: [] };
        report.cases.push(item);
        const page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
        page.setDefaultTimeout(15000); page.on('pageerror',error=>item.errors.push(error.message));
        await page.route('**/*',route=>{ const req=route.request(),url=new URL(req.url()); if(url.origin===origin&&req.method()==='GET'&&!/^\/api(?:\/|$)/.test(url.pathname))return route.continue();item.blockedRequests.push({method:req.method(),pathname:url.pathname,origin:url.origin});return route.abort(); });
        try {
          await page.addInitScript(()=>localStorage.setItem('elyko-guided-tour-v3','completed'));
          await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1`,{waitUntil:'domcontentloaded'});
          await page.waitForFunction(()=>window.__qaAppDraftIdentity?.proof.identityReads.some(read=>read.pending));
          await page.evaluate(()=>{window.__qaAppDraftIdentity.identityMode('ready');for(const read of window.__qaAppDraftIdentity.proof.identityReads.filter(read=>read.pending))window.__qaAppDraftIdentity.releaseIdentity(read.id);});
          await page.locator('.desktop-app').waitFor(); await screen(page,'Paramètres');
          await page.locator('[data-settings-link=payroll]').click();
          const form = page.locator('.payroll-settings form');
          await form.locator('[name=avsFund]').fill('CAISSE FICTIVE MODIFIEE A');
          if (scenario === 'read-only-control') {
            await page.evaluate(()=>window.__qaPayrollPreflight.makeReadOnly());
            await page.getByText('Accès « Lecture seule » : consultation et exports autorisés, modifications bloquées sur ce poste.',{exact:true}).waitFor();
            assert.equal(await form.getByRole('button',{name:'Enregistrer la paie',exact:true}).isDisabled(),true);
            await form.evaluate(form=>form.requestSubmit());
            await page.waitForTimeout(200);
            item.after=await snapshot(page);
            item.controlPassed=item.after.proof.writes.length===0;
            assert.equal(item.controlPassed,true);
          } else {
            if (scenario !== 'current-save-control') await page.evaluate(()=>window.__qaPayrollPreflight.holdNext());
            await form.getByRole('button',{name:'Enregistrer la paie',exact:true}).click();
            if (scenario !== 'current-save-control') {
              await page.waitForFunction(()=>window.__qaPayrollPreflight.proof.reads.some(read=>read.pending));
              const held=await page.evaluate(()=>window.__qaPayrollPreflight.proof.reads.find(read=>read.pending).id);
              item.beforeRelease=await snapshot(page);
              assert.equal(item.beforeRelease.proof.writes.length,0,'Preflight, not mutation, must be held');
              if (scenario==='double-submit-control') {
                await form.evaluate(form=>{form.requestSubmit();form.requestSubmit();});
                assert.equal((await snapshot(page)).proof.reads.filter(read=>read.pending).length,1);
              } else if (scenario==='read-only-after-preflight') {
                await page.evaluate(()=>window.__qaPayrollPreflight.makeReadOnly());
                await page.getByText('Accès « Lecture seule » : consultation et exports autorisés, modifications bloquées sur ce poste.',{exact:true}).waitFor();
                assert.equal(await form.getByRole('button',{name:'Enregistrer la paie',exact:true}).isDisabled(),true);
                item.readOnlyObservedBeforeRelease=true;
              } else {
                await page.evaluate(()=>window.__qaPayrollPreflight.switchVerifiedAccount());
                await page.getByRole('button',{name:'Ouvrir l’espace du compte',exact:true}).click();
                await page.locator('.desktop-app').waitFor(); await screen(page,'Clients');
                await page.getByText('Client fictif B',{exact:true}).first().waitFor();
                item.openedB=await snapshot(page);
                assert.equal(item.openedB.database.scope,'synthetic-company-b');
                assert.equal(item.openedB.proof.writes.length,0);
              }
              await page.evaluate(read=>window.__qaPayrollPreflight.settle(read),held);
            }
            if (scenario==='stale-preflight-to-B' || scenario==='read-only-after-preflight') {
              await page.waitForTimeout(300); item.after=await snapshot(page);
              item.defectReproduced=scenario==='read-only-after-preflight'?item.after.proof.writes.length>0:item.after.proof.writes.some(write=>write.workspaceAtDispatch==='synthetic-company-b');
              item.originScopeMissing=item.after.proof.writes.some(write=>!write.scopePresent);
              item.stalePublicationPrevented=scenario==='read-only-after-preflight'?!item.after.successNotice&&item.after.dialogs.length===0:item.after.company==='SYNTHETIC COMPANY B'&&item.after.visibleB&&!item.after.successNotice&&item.after.dialogs.length===0;
              item.safetyOraclePassed=!item.defectReproduced&&!item.originScopeMissing&&item.stalePublicationPrevented;
              assert.equal(item.safetyOraclePassed,true,'No write may continue after scope or permission changes');
            } else {
              await page.waitForFunction(()=>window.__qaPayrollPreflight.proof.writes.length===1);
              await page.waitForFunction(()=>!document.querySelector('.payroll-settings button[type=submit]')?.disabled);
              item.after=await snapshot(page);
              item.controlPassed=item.after.proof.writes.length===1&&item.after.proof.writes[0].payrollAvs==='CAISSE FICTIVE MODIFIEE A'&&item.after.database.scope==='synthetic-company-a';
              assert.equal(item.controlPassed,true);
              item.scopeExplicit=item.after.proof.writes[0].scopePresent;
              assert.deepEqual(item.after.proof.writes.map(write=>({present:write.scopePresent,scope:write.expectedScope})),[{present:true,scope:'synthetic-company-a'}]);
            }
          }
          assert.deepEqual(item.errors,[]); assert.deepEqual(item.blockedRequests,[]);
          await page.screenshot({path:join(out,`${engine}-${scenario}.png`)});
          item.completed=true;
        } catch(error) {item.failure={name:error.name,message:error.message,stack:error.stack}; await page.screenshot({path:join(out,`${engine}-${scenario}-failure.png`)}).catch(()=>{});}
        finally {await page.close();}
        console.log(JSON.stringify({engine,scenario,completed:item.completed??false,red:item.defectReproduced??false,control:item.controlPassed??null,failure:item.failure?.message??null}));
      }
    } finally {await browser.close();}
  }
  report.after=await hashes(); assert.deepEqual(report.after,report.before,'All tracked source bytes unchanged');
  assert.equal(report.cases.filter(row=>row.failure).length,0,'All payroll settings lifecycle contracts pass');
} catch(error) {report.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;}
finally {await server.close();report.previewClosed=true;report.finishedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output:out,cases:report.cases.length,red:report.cases.filter(row=>row.defectReproduced).length,controls:report.cases.filter(row=>row.controlPassed).length,fixtureFailures:report.cases.filter(row=>row.failure).length,failure:report.failure??null}));}
