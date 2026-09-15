import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const output = fileURLToPath(new URL('../artifacts/qa/', import.meta.url));
await mkdir(output,{recursive:true});
const server = createServer(async (req,res) => {
  const path = {'/':'signature.html','/app.js':'app.js','/style.css':'style.css'}[req.url];
  if(!path){res.writeHead(404).end();return;}
  res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(await readFile(new URL(`../ui/${path}`,import.meta.url)));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({channel:'msedge',headless:true});
const results=[];
try {
  for(const viewport of [{width:1140,height:850},{width:820,height:650}]) {
    const page = await browser.newPage({viewport});
    page.setDefaultTimeout(10000);
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(() => {
      const payload={token_version:2,license_id:'lic_33333333-3333-4333-8333-333333333333',installation_id:'11111111-1111-4111-8111-111111111111',jti:'22222222-2222-4222-8222-222222222222',kid:'hc-prod-v1',customer_name:'Appareil de démonstration',access_role:'owner',account_user_id:null,account_session_id:null,plan:'zentra-monthly-50-chf',price_chf_cents:5000,issued_at:'2026-09-15T12:00:00Z',valid_from:'2026-09-14',valid_until:'2036-12-31'};
      const device={reference:'owner-license-token-demo.dpapi',payload};
      const signed={token:'jeton-local-de-demonstration.signature-fictive',payload,binding:'a'.repeat(64),fingerprint:'b'.repeat(64)};
      window.fixture={mode:'accepted',copied:'',payload,signed,calls:[]};
      window.__TAURI__={core:{invoke:async (command,args) => {
        window.fixture.calls.push(command);
        if(command==='status')return {keyReady:true,keyMessage:'Clé Zentra vérifiée · protégée par Windows',devices:[device],unreadable:0};
        if(command==='load_token')return 'jeton-existant-de-demonstration.signature-fictive';
        if(command==='inspect'){
          if(args.source==='invalide')throw 'Identifiant ou jeton invalide.';
          return {payload:window.fixture.payload,knownDevice:args.source.includes('jeton-'),sourceKind:args.source.includes('jeton-')?'signed':'installation'};
        }
        if(command==='sign_token')return window.fixture.signed;
        if(command==='verify_activation'){
          await new Promise(r=>setTimeout(r,180));
          if(window.fixture.mode==='failure')throw 'Réponse du serveur invalide.';
          if(window.fixture.mode==='unrecognized')return {accepted:false,status:'unrecognized',message:'Le serveur refuse cette activation.',signed:null};
          if(window.fixture.mode==='offline')return {accepted:false,status:'offline',message:'Serveur injoignable.',signed:null};
          const reply={...signed,token:'jeton-serveur-de-demonstration.signature-fictive',payload:{...payload,valid_until:'2036-12-31'}};
          window.fixture.payload=reply.payload;
          return {accepted:true,status:'accepted',message:'Le serveur Zentra accepte ce jeton pour cet appareil.',signed:reply};
        }
        if(command==='copy_text'){window.fixture.copied=args.text;return;}
        throw `Commande inconnue : ${command}`;
      }}};
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('.key-status.ready').waitFor();
    assert(await page.locator('#sign').isDisabled());
    await page.screenshot({path:`${output}/home-${viewport.width}.png`,fullPage:true});
    await page.locator('#source').fill('11111111-1111-4111-8111-111111111111');
    await page.locator('#inspect').click();
    await page.locator('#preview').waitFor();
    assert(await page.locator('#new-device-note').isVisible());
    await page.locator('#online').uncheck();
    await page.locator('#sign').click();
    await page.waitForFunction(()=>!document.getElementById('sign').disabled);
    assert.match(await page.locator('#result-message').innerText(),/pas encore été vérifiée/);
    assert.equal(await page.evaluate(()=>window.fixture.calls.filter(x=>x==='verify_activation').length),0);
    await page.evaluate(()=>window.fixture.mode='unrecognized');
    await page.locator('#verify').click();
    await page.waitForFunction(()=>document.getElementById('result-badge').textContent==='Activation à autoriser');
    assert(await page.locator('#technical').getAttribute('open') !== null);
    await page.screenshot({path:`${output}/authorization-${viewport.width}.png`,fullPage:true});
    await page.locator('#copy-binding').click();
    assert.equal(await page.evaluate(()=>window.fixture.copied),'a'.repeat(64));
    await page.evaluate(()=>window.fixture.mode='accepted');
    await page.locator('#verify').click();
    await page.waitForFunction(()=>document.getElementById('result-badge').textContent==='Activation acceptée');
    await page.locator('#copy').click();
    assert.equal(await page.evaluate(()=>window.fixture.copied),'jeton-serveur-de-demonstration.signature-fictive');
    await page.screenshot({path:`${output}/accepted-${viewport.width}.png`,fullPage:true});
    await page.locator('#until').fill('2030-01-01');
    console.log(`UI ${viewport.width}: signed result and copy passed`);
    assert(await page.locator('#result').isHidden());
    await page.locator('#source').fill('invalide');
    assert(await page.locator('#preview').isHidden());
    assert(await page.locator('#sign').isDisabled());
    await page.locator('#inspect').click();
    await page.locator('#error').waitFor();
    assert(await page.locator('#output').inputValue()==='');
    await page.locator('.device').click();
    console.log(`UI ${viewport.width}: invalid input passed`);
    await page.locator('#preview').waitFor();
    assert.equal(await page.locator('#source-state').innerText(),'Signature d’origine vérifiée');
    assert(await page.locator('#new-device-note').isHidden());
    await page.locator('#online').check();
    await page.evaluate(()=>window.fixture.mode='failure');
    await page.locator('#sign').click();
    console.log(`UI ${viewport.width}: waiting for failed verification`);
    await page.waitForFunction(()=>document.getElementById('result-badge').textContent==='Activation non confirmée');
    await page.waitForFunction(()=>!document.getElementById('sign').disabled);
    assert(await page.locator('#error').isVisible());
    assert.equal(await page.locator('#output').inputValue(),'jeton-local-de-demonstration.signature-fictive');
    await page.evaluate(()=>window.fixture.mode='offline');
    await page.locator('#verify').click();
    await page.waitForFunction(()=>document.getElementById('result-message').textContent==='Serveur injoignable.');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
    assert.deepEqual(errors,[]);
    results.push({viewport,passed:true,checks:['local-only','unsigned-new-device-warning','server-refusal','server-token-copy','stale-result-cleared','invalid-input','vault-selection','invalid-server-response','offline','no-horizontal-overflow','no-js-errors']});
    await page.close();
  }
  await writeFile(`${output}/ui-results.json`,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results));
} finally {await browser.close(); await new Promise(resolve=>server.close(resolve));}
