import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {chromium} = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.connectOverCDP(process.env.ZENTRA_FOUNDER_CDP || 'http://127.0.0.1:9225');
const page = browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost'));
assert(page,'The local founder application must be running with its test WebView2 debug port.');
if(!page.url().endsWith('/signature.html'))await page.goto('http://tauri.localhost/signature.html');
page.setDefaultTimeout(40000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const output=fileURLToPath(new URL('../artifacts/qa/',import.meta.url));await mkdir(output,{recursive:true});
const id='67977efd-492e-4e01-b719-5fe42b7c3d2d';
let qaFile;
try {
  await page.locator('.key-status.ready').waitFor();
  await page.locator(`.device[title^="${id}"]`).click();
  await page.locator('#preview').waitFor();
  assert.equal(await page.locator('#installation').innerText(),id);
  const before=await page.evaluate(()=>window.__TAURI__.core.invoke('inspect',{source:document.getElementById('source').value}));
  await page.locator('#sign').click();
  await page.waitForFunction(()=>document.getElementById('result-badge').textContent==='Activation acceptée',null,{timeout:40000});
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  const token=await page.locator('#output').inputValue();
  const [encoded,sig]=token.split('.');
  const raw=Buffer.from((await readFile(new URL('../public-key.b64url',import.meta.url),'utf8')).trim(),'base64url');
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),type:'spki',format:'der'});
  assert(verify(null,Buffer.from(encoded),key,Buffer.from(sig,'base64url')));
  const payload=JSON.parse(Buffer.from(encoded,'base64url'));
  assert.equal(payload.installation_id,id);assert.equal(payload.license_id,before.payload.license_id);
  await page.locator('#copy').click();
  await page.locator('#toast').waitFor();
  assert.match(await page.locator('#toast').innerText(),/Jeton copié/);
  const tokenSha256=createHash('sha256').update(token).digest('hex');
  await page.screenshot({path:`${output}/native-accepted-redacted.png`,fullPage:true,mask:[page.locator('#source'),page.locator('#output')],maskColor:'#e2ebdf'});
  const report={nativeApp:true,keyMatchesZentra:true,signatureVerifiedIndependently:true,serverAccepted:true,installationId:id,licenseIdentityPreserved:true,validUntil:payload.valid_until,clipboardCommandSucceeded:true,tokenSha256,errors};
  assert.deepEqual(errors,[]);
  await writeFile(`${output}/native-results.json`,JSON.stringify(report,null,2));
  // Confirm recovery after a renderer reload (the encrypted vault is native).
  await page.reload();await page.locator('.key-status.ready').waitFor();
  await page.locator(`.device[title^="${id}"]`).click();await page.locator('#preview').waitFor();
  const recovered=await page.locator('#source').inputValue();
  assert.equal(createHash('sha256').update(recovered).digest('hex'),tokenSha256);
  report.vaultRecoveredAfterReload=true;
  // Exercise the new-installation path locally with a disposable identity.
  // Only its exact encrypted fixture file is deleted at the end.
  await page.locator('#new').click();
  await page.locator('#online').uncheck();
  const qaId=randomUUID();
  await page.locator('#source').fill(qaId);await page.locator('#inspect').click();
  await page.locator('#new-device-note').waitFor();
  const planned=await page.evaluate(()=>window.__TAURI__.core.invoke('inspect',{source:document.getElementById('source').value}));
  // Re-inspecting a new UUID creates another candidate; the app must sign the
  // exact candidate already displayed by its own preview, not this extra one.
  assert.equal(planned.payload.installation_id,qaId);
  await page.locator('#customer').fill('Recette locale du signataire');
  await page.locator('#sign').click();
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  const qaToken=await page.locator('#output').inputValue();
  const [qaEncoded,qaSignature]=qaToken.split('.');
  assert(verify(null,Buffer.from(qaEncoded),key,Buffer.from(qaSignature,'base64url')));
  const qaPayload=JSON.parse(Buffer.from(qaEncoded,'base64url'));
  assert.equal(qaPayload.installation_id,qaId);
  const qaBinding=createHash('sha256').update(`${qaPayload.license_id}:${qaId}`).digest('hex');
  const qaRoot=path.resolve(process.env.LOCALAPPDATA,'ZentraFondateur','vault');
  qaFile=path.resolve(qaRoot,`signed-${qaBinding}.dpapi`);
  assert(qaFile.startsWith(qaRoot+path.sep));
  assert.match(await page.locator('#result-message').innerText(),/pas encore été vérifiée/);
  await page.locator('#source').fill(qaId);await page.locator('#inspect').click();
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert(await page.locator('#new-device-note').isHidden());
  await page.locator('#sign').click();await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  const repeated=JSON.parse(Buffer.from((await page.locator('#output').inputValue()).split('.')[0],'base64url'));
  assert.equal(repeated.license_id,qaPayload.license_id);
  report.newInstallationSignatureVerified=true;report.newInstallationIdentityStable=true;
  await unlink(qaFile);qaFile=null;
  await writeFile(`${output}/native-results.json`,JSON.stringify(report,null,2));
  await page.locator('#new').click();
  await page.locator('#reload').click();
  await page.locator('#online').check();
  await page.screenshot({path:`${output}/native-home.png`,fullPage:true});
  console.log(JSON.stringify(report));
} finally { if(qaFile)await unlink(qaFile).catch(()=>{}); await browser.close(); }
