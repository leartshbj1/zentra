/** Real main/StrictMode/App/SDK regression; closed transport and synthetic clipboard.
 * Run from any cwd with Node, or set ZENTRA_NODE_PATH. Optional dependencies:
 * ZENTRA_PLAYWRIGHT_MODULE, ZENTRA_EDGE_PATH; output: ZENTRA_QA_OUTPUT.
 * No native binary, account, API, real clipboard or user data is used.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const script=fileURLToPath(import.meta.url);
if(process.env.ZENTRA_NODE_PATH&&resolve(process.env.ZENTRA_NODE_PATH).toLowerCase()!==resolve(process.execPath).toLowerCase()){
  const child=spawn(process.env.ZENTRA_NODE_PATH,[script],{stdio:'inherit',env:{...process.env,ZENTRA_NODE_PATH:''}});
  const code=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',code=>yes(code??1));});process.exit(code);
}
const desktop=resolve(dirname(script),'..');
const out=resolve(process.env.ZENTRA_QA_OUTPUT||join(tmpdir(),`zentra-app-opening-diagnostics-${Date.now()}`));
await mkdir(out,{recursive:true});
const require=createRequire(join(desktop,'package.json'));
const vite=await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')),'dist/node/index.js')).href);
const playwright=process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright';
const imported=await import(playwright.startsWith('file:')?playwright:pathToFileURL(isAbsolute(playwright)?playwright:require.resolve(playwright)).href),pw=imported.default??imported;
const sha=s=>createHash('sha256').update(s).digest('hex');
const sourceNames=['src/App.tsx','src/main.tsx','src/appOpening.ts','src/diagnostics.ts','src/diagnosticIntent.ts','src/bridge.ts','src/ui.tsx','src/ErrorGuidance.tsx','src/userErrors.ts','src/language.ts','tests/app-opening-diagnostics-lifecycle-fixture.ts'];
const hashes=async()=>Object.fromEntries(await Promise.all(sourceNames.map(async name=>[name,sha(await readFile(join(desktop,name)))])));
const report={startedAt:new Date().toISOString(),node:{version:process.version,executable:process.execPath},sourceBefore:await hashes(),cases:[],limits:'Actual main/StrictMode/App/bridge/SDK with closed synthetic IPC. Browser clock advances the real 75000ms timeout; not native DB acceptance, a physical device, real OS clipboard or wall-clock/disk latency.'};
const loaded=await vite.loadConfigFromFile({command:'serve',mode:'development'},join(desktop,'vite.config.ts'));
const entry=`import {installAppOpeningDiagnosticsFixture} from '/tests/app-opening-diagnostics-lifecycle-fixture.ts';
await installAppOpeningDiagnosticsFixture();
await import('/src/main.tsx');`;
const html='<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Closed opening diagnostic proof</title></head><body><div id="root"></div><script type="module" src="/opening-proof-entry.tsx"></script></body></html>';
const server=await vite.createServer({...loaded.config,configFile:false,root:desktop,
  plugins:[{name:'closed-opening-proof',enforce:'pre',resolveId(id){if(id==='/opening-proof-entry.tsx')return id;},load(id){if(id==='/opening-proof-entry.tsx')return entry;},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]==='/opening-proof.html'){res.setHeader('Content-Type','text/html');res.end(html);}else next();});}},...loaded.config.plugins],
  cacheDir:join(tmpdir(),`zentra-opening-proof-vite-${Date.now()}`),
  resolve:{...loaded.config.resolve,dedupe:['react','react-dom']},
  optimizeDeps:{entries:[join(desktop,'index.html')],noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react','qrcode.react','@tauri-apps/api/core','@tauri-apps/api/event','@tauri-apps/plugin-dialog','@tauri-apps/plugin-fs']},
  server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false,watch:{ignored:['**/src-tauri/**']}},logLevel:'silent'});
try{
  await server.listen();const port=server.httpServer.address().port;assert.notEqual(port,5363,'Preserve user preview');const origin='http://127.0.0.1:'+port;report.origin=origin;
  for(const engine of ['chromium','webkit']){
    const browser=await pw[engine].launch({headless:true,...engine==='chromium'?(process.env.ZENTRA_EDGE_PATH?{executablePath:process.env.ZENTRA_EDGE_PATH}:process.platform==='win32'?{channel:'msedge'}:{}):{}});
    try{
      const page=await browser.newPage({viewport:{width:1000,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(20000);
      const item={engine,browserVersion:browser.version(),errors:[],blockedRequests:[],languages:[]};report.cases.push(item);
      page.on('pageerror',error=>item.errors.push(String(error)));
      await page.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(url.origin===origin&&req.method()==='GET'&&!url.pathname.startsWith('/api/'))return route.continue();item.blockedRequests.push({url:url.origin+url.pathname,method:req.method()});return route.abort();});
      await page.clock.install();await page.goto(origin+'/opening-proof.html');await page.waitForFunction(()=>window.__qaOpening?.reads.length===1);
      await page.clock.fastForward(75001);await page.locator('.fatal-screen').waitFor();
      const state=()=>page.evaluate(()=>({code:document.querySelector('.fatal-screen .error-guidance__incident code')?.textContent,action:document.querySelector('.fatal-screen .error-guidance__recovery')?.textContent,events:window.__qaOpening.diagnostics(),reads:structuredClone(window.__qaOpening.reads),copies:[...window.__qaOpening.copies],detailsOpen:!!document.querySelector('.fatal-screen details[open]')}));
      item.timeout=await state();const initialFailure=item.timeout.events.filter(e=>e.operation==='workspace.open'&&e.phase==='failure').at(-1);
      assert.ok(initialFailure);assert.ok(initialFailure.durationMs>=75000,'Opening duration includes actual timeout');assert.equal(item.timeout.detailsOpen,false);assert.equal(item.timeout.code,'ZT-'+initialFailure.id);
      for(const lang of ['fr','de','it','en']){
        await page.evaluate(lang=>window.__qaOpening.setLanguage(lang),lang);await page.waitForFunction(lang=>document.documentElement.lang.startsWith(lang),lang);
        const observed=await state(),expected=await page.evaluate(lang=>window.__qaOpening.expectedReadAction(lang),lang);
        assert.equal(observed.code,item.timeout.code,'Reference stable during language renders');assert.equal(observed.action,expected);item.languages.push({lang,code:observed.code,action:observed.action});
      }
      await page.evaluate(()=>window.__qaOpening.setLanguage('fr'));await page.locator('.fatal-screen .error-guidance__incident button').click();assert.equal((await state()).copies.at(-1),item.timeout.code);
      await page.screenshot({path:join(out,engine+'-timeout.png')});await page.evaluate(()=>window.__qaOpening.mode('reject'));
      const retry=page.locator('.fatal-screen > button').first();
      for(let n=1;n<=2;n++){
        await retry.click();await page.waitForFunction(n=>window.__qaOpening.diagnostics().filter(e=>e.operation==='workspace.open'&&e.phase==='failure').length===n+1,n);await page.locator('.fatal-screen').waitFor();
        const value=await state(),failure=value.events.filter(e=>e.operation==='workspace.open'&&e.phase==='failure').at(-1);assert.equal(value.code,'ZT-'+failure.id);if(n===1)item.sameStringFirst=value;else item.sameStringSecond=value;
      }
      assert.notEqual(item.sameStringFirst.code,item.sameStringSecond.code,'Equal messages do not reuse an attempt reference');const currentCode=item.sameStringSecond.code;
      await page.evaluate(()=>window.__qaOpening.rejectOld(1));await page.waitForFunction(()=>window.__qaOpening.diagnostics().some(e=>e.operation==='get_workspace'&&e.phase==='failure'));
      item.lateOld=await state();assert.equal(item.lateOld.code,currentCode,'Old settlement cannot replace current incident');
      const openingEvents=item.lateOld.events.filter(e=>e.operation==='workspace.open');for(const failure of openingEvents.filter(e=>e.phase==='failure'))assert.ok(openingEvents.some(e=>e.phase==='start'&&e.id===failure.id));
      assert.equal(JSON.stringify(item.lateOld.events).includes('SYNTHETIC_PRIVATE'),false);const fields=new Set(['id','sessionId','timestamp','area','operation','phase','durationMs','errorCode']);assert.ok(item.lateOld.events.every(e=>Object.keys(e).every(k=>fields.has(k))));
      await page.evaluate(()=>window.__qaOpening.mode('success'));await retry.click();await page.waitForFunction(()=>window.__qaOpening.diagnostics().some(e=>e.operation==='workspace.open'&&e.phase==='success'));await page.locator('.fatal-screen').waitFor({state:'detached'});
      item.success={fatalAbsent:true,events:await page.evaluate(()=>window.__qaOpening.diagnostics()),nativeCalls:await page.evaluate(()=>[...window.__qaOpening.nativeCalls]),blockedNative:await page.evaluate(()=>[...window.__qaOpening.blockedNative])};
      assert.deepEqual(item.success.blockedNative,[]);assert.deepEqual(item.errors,[]);assert.deepEqual(item.blockedRequests,[]);item.result='GREEN';await page.close();
    }finally{await browser.close();}
  }
  report.sourceAfter=await hashes();assert.deepEqual(report.sourceBefore,report.sourceAfter);report.sourcesStable=true;
}catch(error){report.failure=String(error?.stack??error);process.exitCode=1;}
finally{await server.close();report.completedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));}
