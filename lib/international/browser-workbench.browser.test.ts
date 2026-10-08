import {it,expect} from 'vitest';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {build} from 'vite';
import {createErpHandlers} from './runtime-server';
import {createUsSellerProfileHandlers} from './seller-profile-server';
import {AccountPublicError, type AccountRole} from '../account-security';
import {SupabaseServerError} from '../supabase-server';
import {canonicalErpJson} from './erp-contract';
import {browserSellerCopy,browserWorkbenchCopy} from './browser-workbench-copy';
import type {SellerProfileStore,UsSellerProfileReceipt,UsSellerProfileState} from './seller-profile';
import {ErpError} from './erp-contract';
import type {ErpCommit,ErpReceipt,ErpState,ErpStore} from './runtime-types';
import type {CompanyConfiguration} from './types';

// Explicit local proof only. No customer data, credentials, tax provider or hosted database.
const enabled=process.env.ZENTRA_BROWSER_WORKBENCH_QA==='1';
it.skipIf(!enabled)('exercises the real US client and ERP engine in a local browser',async()=>{
 const directory=resolve('.qa/us-seller-browser'),clientDir=resolve(directory,'client');await mkdir(directory,{recursive:true});
 const organizationId='10000000-0000-4000-8000-000000000001',userId='10000000-0000-4000-8000-000000000002';
 const configuration:CompanyConfiguration={schemaVersion:1,organizationId,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Fictitious Street',city:'Brooklyn',postalCode:'11201',subdivision:'NY'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}};
 let state:ErpState|null=null,role:AccountRole='owner',dropNext=false,revoked=false;let commits=0;const receipts=new Map<string,ErpReceipt>(),writes:string[]=[];
 let sellerState:UsSellerProfileState={status:'unconfigured',organizationId,revision:0},sellerDropNext=false,revokeSellerAfterCommit=false,sellerCommits=0;
 const sellerWrites:string[]=[],sellerReceipts=new Map<string,{input:string;receipt:UsSellerProfileReceipt}>();
 const store:ErpStore={
  async read(org){if(org!==organizationId)throw new ErpError('tenant_mismatch',403);return structuredClone(state);},
  async receipt(org,key){if(org!==organizationId)throw new ErpError('tenant_mismatch',403);return structuredClone(receipts.get(key)??null);},
  async commit(input:ErpCommit){
   const prior=receipts.get(input.receipt.idempotencyKey);if(prior){if(prior.commandHash!==input.receipt.commandHash)throw new ErpError('idempotency_conflict',409);return structuredClone(prior);}
   if(input.organizationId!==organizationId)throw new ErpError('tenant_mismatch',403);
   if((state?.revision??0)!==input.expectedRevision)throw new ErpError('revision_conflict',409);
   function rows<T extends{id:string}>(kind:ErpCommit['changes'][number]['kind'],before:readonly T[]):T[]{const values=new Map(before.map(row=>[row.id,row]));for(const change of input.changes.filter(change=>change.kind===kind))values.set(change.id,structuredClone(change.payload) as T);return [...values.values()];}
   state={...structuredClone(input.header),customers:rows('customer',state?.customers??[]),estimates:rows('estimate',state?.estimates??[]),invoices:rows('invoice',state?.invoices??[]),ledger:{...structuredClone(input.header.ledger),entries:rows('journal',state?.ledger.entries??[]),audit:[...(state?.ledger.audit??[]),...structuredClone(input.ledgerAudit)]}};
   receipts.set(input.receipt.idempotencyKey,structuredClone(input.receipt));commits++;return structuredClone(input.receipt);
  }
 };
 const authority=async()=>{if(revoked)throw new AccountPublicError('synthetic Auth revoked',401);return {mode:'browser' as const,actor:{organizationId,userId,role,managementEntitled:true,timestamp:new Date().toISOString()}};};
 const handlers=createErpHandlers({enabled:()=>true,authority,configuration:async()=>configuration,store:()=>store,taxProvider:async()=>null,rateLimit:async()=>{},diagnostic:()=>{}});
 // Actual seller service/HTTP; the RPC persistence model below is synthetic RAM,
 // separate from the real PostgreSQL migration evidence in seller-profile.postgres.test.
 const sellerStore:SellerProfileStore={async rpc<T>(name:string,parameters:Readonly<Record<string,unknown>>):Promise<T>{
  if(parameters.p_organization!==organizationId)throw new SupabaseServerError(400,'PS003');
  if(name==='zentra_read_us_seller_profile')return structuredClone(sellerState) as T;
  if(name!=='zentra_put_us_seller_profile')throw new Error('Unexpected local seller RPC');
  const key=String(parameters.p_request_id),input=canonicalErpJson(parameters),earlier=sellerReceipts.get(key);
  if(earlier){if(earlier.input!==input)throw new SupabaseServerError(400,'PS002');return {...structuredClone(earlier.receipt),replayed:true} as T;}
  if(parameters.p_expected_revision!==sellerState.revision)throw new SupabaseServerError(400,'PS001');
  sellerState={status:'configured',organizationId,revision:sellerState.revision+1,profile:structuredClone(parameters.p_profile) as UsSellerProfileReceipt['profile'],updatedBy:String(parameters.p_actor),updatedAt:new Date().toISOString()};
  const receipt={...sellerState,requestId:key,replayed:false};sellerReceipts.set(key,{input,receipt:structuredClone(receipt)});sellerCommits++;if(revokeSellerAfterCommit){revokeSellerAfterCommit=false;revoked=true;}return structuredClone(receipt) as T;
 }};
 const sellerHandlers=createUsSellerProfileHandlers({enabled:()=>true,authority,configuration:async()=>configuration,store:()=>sellerStore,rateLimit:async()=>{},diagnostic:()=>{}});
 // Compile the actual component and styles; no duplicate UI or financial engine.
 await writeFile(resolve(directory,'entry.tsx'),`import {createRoot} from 'react-dom/client';import {UsErpWorkbench} from '@/components/account/us-erp-workbench';import '@/app/compte/account.css';import '@/app/apple-account.css';const q=new URLSearchParams(location.search);const language=['fr','en','de','it'].includes(q.get('lang')||'')?q.get('lang'):'en';document.documentElement.lang=language;const role=['owner','admin','accountant','member','read_only'].includes(q.get('role')||'')?q.get('role'):'owner';createRoot(document.getElementById('root')).render(<div className="account-experience account-detail" data-theme={q.get('theme')==='dark'?'dark':'light'}><main className="account-content"><UsErpWorkbench organizationId="${organizationId}" expectedUserId="${userId}" role={role} language={language}/></main></div>);`);
 await writeFile(resolve(directory,'index.html'),'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local US browser proof</title><style>:root{--font-geist-sans:Arial,sans-serif}body{margin:0}*{box-sizing:border-box}button,input,select,textarea{font:inherit}</style></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
 await build({configFile:false,root:directory,resolve:{alias:{'@':resolve('.')}},build:{outDir:clientDir,emptyOutDir:true},logLevel:'warn'});
 const server=createServer(async(req,res)=>{
  try{
   const origin=`http://127.0.0.1:${(server.address() as{port:number}).port}`,url=new URL(req.url||'/',origin);
   const sellerPath=url.pathname===`/api/international/workspaces/${organizationId}/seller`;
   if(sellerPath||url.pathname===`/api/international/workspaces/${organizationId}/erp`){
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString('utf8');if(req.method==='POST')writes.push(body);if(sellerPath&&req.method==='PUT')sellerWrites.push(body);
    const request=new Request(url,{method:req.method,headers:req.headers as Record<string,string>,...(['POST','PUT'].includes(req.method??'')?{body}:{})});
    const response=sellerPath?(req.method==='PUT'?await sellerHandlers.PUT(request,organizationId):await sellerHandlers.GET(request,organizationId)):(req.method==='POST'?await handlers.POST(request,organizationId):await handlers.GET(request,organizationId));
    if((req.method==='POST'&&dropNext||sellerPath&&req.method==='PUT'&&sellerDropNext)&&response.status===200){if(sellerPath)sellerDropNext=false;else dropNext=false;res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"error":"service_unavailable"}');return;}
    const responseBody=await response.text();res.writeHead(response.status,Object.fromEntries(response.headers));res.end(responseBody);return;
   }
   const file=url.pathname==='/'?'index.html':url.pathname.slice(1);if(!/^[A-Za-z0-9._/-]+$/.test(file)||file.includes('..')){res.writeHead(404);res.end();return;}
   let asset:Buffer;try{asset=await readFile(resolve(clientDir,file));}catch{res.writeHead(404);res.end();return;}
   res.writeHead(200,{'Content-Type':extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'text/html','Cache-Control':'no-store'});res.end(asset);
  }catch{if(res.headersSent)res.destroy();else{res.writeHead(500);res.end('local fixture unavailable');}}
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${(server.address() as{port:number}).port}`;
 const require=createRequire(import.meta.url);const {chromium}=require(process.env.ZENTRA_PLAYWRIGHT_MODULE||'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');const browser=await chromium.launch({channel:'msedge',headless:true});
 const views:unknown[]=[],errors:string[]=[];
 try{
  // Interaction selectors are named public form controls from the actual component.
  const page=await browser.newPage({viewport:{width:390,height:920},reducedMotion:'reduce'});page.on('pageerror',(error:Error)=>errors.push(error.message));
  await page.goto(origin);await page.waitForSelector('.us-erp-workbench');
  await page.getByRole('button',{name:'Initialize workspace',exact:true}).waitFor();
  expect(commits).toBe(0);expect(writes).toEqual([]);
  // Seller configuration is independent of accounting initialization and revision.
  const sellerPanel=page.locator('.us-seller-profile'),sellerEndpoint=`${origin}/api/international/workspaces/${organizationId}/seller`;
  const openSeller=async()=>{const details=sellerPanel.locator('details');if(!await details.evaluate((node:HTMLDetailsElement)=>node.open))await details.locator('summary').click();};
  const sellerIdle=()=>page.waitForFunction(()=>{const button=document.querySelector<HTMLButtonElement>('.us-seller-profile .us-erp-record-heading button');return !!button&&!button.disabled;});
  const peerSeller=async(expectedRevision:number,displayName:string,key:string)=>page.request.put(sellerEndpoint,{headers:{Origin:origin,'X-Zentra-Expected-User':userId},data:{expectedRevision,requestId:key,profile:{displayName}}});
  await page.getByLabel('Seller display name',{exact:true}).fill('Fictitious Seller');await page.getByLabel('Seller email (optional)',{exact:true}).fill('seller@example.test');
  sellerDropNext=true;await page.getByRole('button',{name:'Save seller details',exact:true}).click();await page.getByRole('button',{name:'Retry same seller request',exact:true}).waitFor();
  expect(sellerCommits).toBe(1);expect(commits).toBe(0);expect(await page.getByRole('button',{name:'Initialize workspace',exact:true}).isDisabled()).toBe(true);const interruptedSeller=sellerWrites.at(-1);
  expect((await peerSeller(1,'Latest Seller','10000000-0000-4000-8000-000000000010')).status()).toBe(200);expect(sellerCommits).toBe(2);
  await page.getByRole('button',{name:'Retry same seller request',exact:true}).click();await sellerPanel.getByText('Latest Seller',{exact:true}).waitFor();expect(sellerWrites.at(-1)).toBe(interruptedSeller);expect(sellerCommits).toBe(2);expect(commits).toBe(0);
  await openSeller();await page.getByLabel('Seller display name',{exact:true}).fill('Keep this seller draft');await page.getByRole('button',{name:'Reload seller details',exact:true}).click();await sellerIdle();expect(await page.getByLabel('Seller display name',{exact:true}).inputValue()).toBe('Keep this seller draft');
  await page.getByLabel('Period start',{exact:true}).fill('2026-01-01');await page.getByLabel('Period end',{exact:true}).fill('2026-12-31');
  await page.getByRole('button',{name:'Initialize workspace',exact:true}).click();await page.locator('summary').filter({hasText:/^New customer$/}).waitFor();
  await page.locator('summary').filter({hasText:/^New customer$/}).click();
  const fillCustomer=async(name:string)=>{await page.getByLabel('Customer name',{exact:true}).fill(name);await page.getByLabel('Street address',{exact:true}).fill('1 Fictitious Street');await page.getByLabel('City',{exact:true}).fill('Brooklyn');await page.getByLabel('State / district',{exact:true}).selectOption('NY');await page.getByLabel('ZIP code',{exact:true}).fill('11201');await page.getByLabel('Payment terms (days)',{exact:true}).first().fill('30');};
  await fillCustomer('Fictitious Company');await page.getByRole('button',{name:'Save customer',exact:true}).click();
  await page.locator('.us-erp-records').getByText('Fictitious Company',{exact:true}).waitFor();expect(commits).toBe(2);
  await page.getByLabel('Customer name',{exact:true}).fill('Keep this unsaved draft');await page.getByRole('button',{name:'Reload data',exact:true}).click();
  await page.getByRole('button',{name:'Reload data',exact:true}).waitFor();expect(await page.getByLabel('Customer name',{exact:true}).inputValue()).toBe('Keep this unsaved draft');
  await page.locator('summary').filter({hasText:/^New estimate$/}).click();
  const customerIds=()=>state?.customers.map(row=>row.id)??[];
  await page.getByLabel('Customer',{exact:true}).selectOption(customerIds()[0]);await page.getByLabel('Estimate date',{exact:true}).fill('2026-10-08');await page.getByLabel('Valid until',{exact:true}).fill('2026-11-08');
  await page.getByLabel('Payment terms (days)',{exact:true}).last().fill('30');await page.getByLabel('Description',{exact:true}).fill('Fictitious service');await page.getByLabel('Quantity',{exact:true}).fill('2.5');await page.getByLabel('Unit price (USD)',{exact:true}).fill('19.99');await page.getByLabel('Notes',{exact:true}).fill('Fictitious terms\nKeep the second line.');
  dropNext=true;await page.getByRole('button',{name:'Save estimate',exact:true}).click();await page.getByRole('button',{name:'Retry same operation',exact:true}).waitFor();
  expect(commits).toBe(3);const interruptedBody=writes.at(-1);expect(await page.getByRole('button',{name:'Save customer',exact:true}).isDisabled()).toBe(true);
  await page.getByRole('button',{name:'Retry same operation',exact:true}).click();await page.getByRole('button',{name:'Record acceptance',exact:true}).waitFor();
  expect(writes.at(-1)).toBe(interruptedBody);expect(commits).toBe(3);expect(await page.locator('.us-erp-estimate').innerText()).toContain('$49.98');expect(await page.getByLabel('Description',{exact:true}).inputValue()).toBe('');
  await page.getByRole('button',{name:'Record acceptance',exact:true}).click();await page.getByRole('button',{name:'Confirm internal acceptance',exact:true}).click();
  await page.getByText('Acceptance recorded',{exact:true}).waitFor();expect(commits).toBe(4);
  // A peer changes the same shared revision while the form stays open. No automatic resubmission.
  await fillCustomer('Conflicting draft');
  const peerWrite=await page.request.post(`${origin}/api/international/workspaces/${organizationId}/erp`,{headers:{Origin:origin,'X-Zentra-Expected-User':userId},data:{idempotencyKey:'peer-change',expectedRevision:4,command:{type:'save_customer',customer:{id:'peer-customer',organizationId,kind:'business',name:'LongCompanyNameWithoutAnySpace'.repeat(5),billingAddress:configuration.address,paymentTermsDays:30}}}});expect(peerWrite.status()).toBe(200);expect(commits).toBe(5);
  await page.getByRole('button',{name:'Save customer',exact:true}).click();await page.getByRole('alert').filter({hasText:/Data changed/}).waitFor();expect(commits).toBe(5);expect(await page.getByRole('button',{name:'Save customer',exact:true}).isDisabled()).toBe(true);
  await page.getByRole('button',{name:'Reload data',exact:true}).click();await page.getByRole('button',{name:'Reload data',exact:true}).waitFor();expect(await page.getByLabel('Customer name',{exact:true}).inputValue()).toBe('Conflicting draft');expect(commits).toBe(5);
  await page.getByRole('button',{name:'Save customer',exact:true}).click();await page.locator('.us-erp-records').getByText('Conflicting draft',{exact:true}).waitFor();expect(commits).toBe(6);expect(await page.getByLabel('Customer name',{exact:true}).inputValue()).toBe('');
  // A seller CAS conflict keeps the draft and requires an explicit reread/save.
  expect((await peerSeller(2,'Peer Seller','10000000-0000-4000-8000-000000000011')).status()).toBe(200);expect(sellerCommits).toBe(3);
  await page.getByRole('button',{name:'Save seller details',exact:true}).click();await sellerPanel.getByRole('alert').filter({hasText:/Seller details changed/}).waitFor();expect(sellerCommits).toBe(3);expect(await page.getByRole('button',{name:'Save seller details',exact:true}).isDisabled()).toBe(true);
  await page.getByRole('button',{name:'Reload seller details',exact:true}).click();await sellerPanel.getByText('Peer Seller',{exact:true}).waitFor();expect(await page.getByLabel('Seller display name',{exact:true}).inputValue()).toBe('Keep this seller draft');expect(sellerCommits).toBe(3);
  await page.getByRole('button',{name:'Save seller details',exact:true}).click();await sellerPanel.getByText('Keep this seller draft',{exact:true}).waitFor();expect(sellerCommits).toBe(4);
  // Real HTTP postflight revocation after the synthetic RPC commit purges both
  // public snapshots, but retains the exact seller request in the same instance.
  await openSeller();await page.getByLabel('Seller display name',{exact:true}).fill('Revocation Seller');revokeSellerAfterCommit=true;
  await page.getByRole('button',{name:'Save seller details',exact:true}).click();await page.getByRole('button',{name:'Retry same seller request',exact:true}).waitFor();expect(sellerCommits).toBe(5);const revokedBody=sellerWrites.at(-1);
  expect(await page.locator('.us-erp-estimate').count()).toBe(0);expect(await page.locator('.us-seller-details').count()).toBe(0);expect(await page.getByLabel('Seller display name',{exact:true}).count()).toBe(0);
  revoked=false;await page.getByRole('button',{name:'Retry same seller request',exact:true}).click();await sellerPanel.getByText('Revocation Seller',{exact:true}).waitFor();expect(sellerWrites.at(-1)).toBe(revokedBody);expect(sellerCommits).toBe(5);await openSeller();expect(await page.getByRole('button',{name:'Save seller details',exact:true}).isDisabled()).toBe(true);
  await page.getByRole('button',{name:'Reload data',exact:true}).click();await page.getByText('Acceptance recorded',{exact:true}).waitFor();await page.locator('summary').filter({hasText:/^New customer$/}).click();expect(await page.getByRole('button',{name:'Save customer',exact:true}).isDisabled()).toBe(true);
  // A successful GET cannot restore the stale owner prop after access denial.
  await page.goto(origin);await page.getByText('Acceptance recorded',{exact:true}).waitFor();await sellerPanel.getByText('Revocation Seller',{exact:true}).waitFor();
  await openSeller();await page.getByLabel('Seller display name',{exact:true}).fill('Private unsaved seller');
  let sellerReadStarted!:()=>void,sellerReadReleased!:()=>void;const sellerStarted=new Promise<void>(done=>{sellerReadStarted=done;}),sellerHeld=new Promise<void>(done=>{sellerReadReleased=done;});
  const sellerDelayed=async(route:{fetch:()=>Promise<unknown>;fulfill:(options:{response:unknown})=>Promise<void>})=>{const response=await route.fetch();sellerReadStarted();await sellerHeld;await route.fulfill({response});};
  await page.route(sellerEndpoint,sellerDelayed);await page.getByRole('button',{name:'Reload seller details',exact:true}).click();await sellerStarted;revoked=true;
  // Reloads share the busy fence: wait for the already-authorized seller GET
  // before asking ERP to refresh its now-revoked authority.
  expect(await page.getByRole('button',{name:'Reload data',exact:true}).isDisabled()).toBe(true);sellerReadReleased();await sellerIdle();
  await page.getByRole('button',{name:'Reload data',exact:true}).click();await page.locator('.us-erp-workbench>.us-erp-notice').filter({hasText:/session or workspace access/}).waitFor();
  expect(await page.locator('.us-seller-details').count()).toBe(0);expect(await page.locator('.us-erp-estimate').count()).toBe(0);expect(await page.getByLabel('Seller display name',{exact:true}).count()).toBe(0);await page.unroute(sellerEndpoint,sellerDelayed);revoked=false;
  await page.getByRole('button',{name:'Reload seller details',exact:true}).click();await sellerPanel.getByText('Revocation Seller',{exact:true}).waitFor();await openSeller();expect(await page.getByRole('button',{name:'Save seller details',exact:true}).isDisabled()).toBe(true);
  await page.goto(origin);await page.getByText('Acceptance recorded',{exact:true}).waitFor();await sellerPanel.getByText('Revocation Seller',{exact:true}).waitFor();
  // The SSR owner prop is now stale: a current member may still GET the seller
  // but cannot reactivate edits. Only the original request can be retried later.
  await openSeller();await page.getByLabel('Seller display name',{exact:true}).fill('Stale Owner Seller');role='member';
  await page.getByRole('button',{name:'Save seller details',exact:true}).click();await page.getByRole('button',{name:'Retry same seller request',exact:true}).waitFor();expect(sellerCommits).toBe(5);const staleOwnerBody=sellerWrites.at(-1);
  await page.getByRole('button',{name:'Reload seller details',exact:true}).click();await sellerPanel.getByText('Revocation Seller',{exact:true}).waitFor();await openSeller();expect(await page.getByRole('button',{name:'Save seller details',exact:true}).isDisabled()).toBe(true);
  role='owner';await page.getByRole('button',{name:'Retry same seller request',exact:true}).click();await sellerPanel.getByText('Stale Owner Seller',{exact:true}).waitFor();expect(sellerWrites.at(-1)).toBe(staleOwnerBody);expect(sellerCommits).toBe(6);
  await page.goto(origin);await page.getByText('Acceptance recorded',{exact:true}).waitFor();await sellerPanel.getByText('Stale Owner Seller',{exact:true}).waitFor();
  // Hold a read after the actual server already authorized it, then announce an account change.
  let startRead!:()=>void,releaseRead!:()=>void;const started=new Promise<void>(done=>{startRead=done;}),held=new Promise<void>(done=>{releaseRead=done;});
  const endpoint=`${origin}/api/international/workspaces/${organizationId}/erp`;
  const delayed=async(route:{fetch:()=>Promise<unknown>;fulfill:(options:{response:unknown})=>Promise<void>})=>{const response=await route.fetch();startRead();await held;await route.fulfill({response});};
  await page.route(endpoint,delayed);await page.getByRole('button',{name:'Reload data',exact:true}).click();await started;
  await page.evaluate(()=>window.dispatchEvent(new Event('zentra-auth-changed')));releaseRead();await page.getByRole('button',{name:'Reload data',exact:true}).waitFor();
  expect(await page.locator('.us-erp-estimate').count()).toBe(0);await page.unroute(endpoint,delayed);await page.getByRole('button',{name:'Reload data',exact:true}).click();await page.getByText('Acceptance recorded',{exact:true}).waitFor();
  // Reload a second browser page: the first page's records come from the same actual handler/store.
  const peer=await browser.newPage({viewport:{width:1440,height:960}});await peer.goto(origin);await peer.getByText('Acceptance recorded',{exact:true}).waitFor();await peer.close();
  role='member';await page.goto(`${origin}/?role=member`);await sellerPanel.getByText('Stale Owner Seller',{exact:true}).waitFor();expect(await page.getByLabel('Seller display name',{exact:true}).count()).toBe(0);expect(await sellerPanel.locator('summary').count()).toBe(0);
  const memberSeller=await peerSeller(6,'Forbidden Member Seller','10000000-0000-4000-8000-000000000012');expect(memberSeller.status()).toBe(403);expect(sellerCommits).toBe(6);
  // A synthetic role transition demonstrates UI suppression and authoritative server refusal.
  role='read_only';await page.goto(`${origin}/?role=read_only`);await page.getByText('Acceptance recorded',{exact:true}).waitFor();expect(await page.locator('summary').count()).toBe(0);
  const forbidden=await page.request.post(`${origin}/api/international/workspaces/${organizationId}/erp`,{headers:{Origin:origin,'X-Zentra-Expected-User':userId},data:{idempotencyKey:'readonly-attempt',expectedRevision:6,command:{type:'save_customer',customer:{id:'forbidden-customer',organizationId,kind:'business',name:'Forbidden fixture',billingAddress:configuration.address,paymentTermsDays:30}}}});expect(forbidden.status()).toBe(403);expect(commits).toBe(6);
  role='owner';
  for(const language of ['fr','en','de','it'] as const)for(const theme of ['light','dark'])for(const width of [320,390,1440]){
   await page.setViewportSize({width,height:960});await page.goto(`${origin}/?lang=${language}&theme=${theme}`);await page.waitForSelector('.us-erp-workbench');await page.evaluate(()=>document.fonts.ready);
   await page.locator('.us-erp-estimate').waitFor();await page.locator('.us-seller-details').waitFor();for(const label of [browserSellerCopy[language].edit,browserWorkbenchCopy[language].newCustomer,browserWorkbenchCopy[language].newEstimate])await page.locator('summary').filter({hasText:label}).click();
   const inspected=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,headings:[...document.querySelectorAll('h1,h2')].map(node=>node.textContent),controls:[...document.querySelectorAll('button,input,select,textarea,summary')].filter(node=>node.getBoundingClientRect().height).map(node=>({tag:node.tagName,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}))}));expect(inspected.scroll).toBeLessThanOrEqual(width+1);expect(inspected.controls.every((control:{width:number;height:number})=>control.width>=44&&control.height>=44)).toBe(true);views.push({language,theme,width,inspected});
   if(width===390)await page.screenshot({path:resolve(directory,`${language}-${theme}.png`),fullPage:true});
   if(language==='fr'&&(width===390||width===1440))await sellerPanel.screenshot({path:resolve(directory,`seller-${language}-${theme}-${width}.png`)});
   if(width===320){await page.evaluate(()=>{const sizes=[...document.querySelectorAll<HTMLElement>('.us-erp-workbench,.us-erp-workbench *')].map(node=>({node,size:parseFloat(getComputedStyle(node).fontSize)}));for(const{node,size}of sizes)node.style.fontSize=`${size*2}px`;});const enlarged=await page.evaluate(()=>document.documentElement.scrollWidth);expect(enlarged).toBeLessThanOrEqual(width+1);views.push({language,theme,width,textScale:2,scroll:enlarged});}
  }
  expect(errors).toEqual([]);expect(commits).toBe(6);expect(sellerCommits).toBe(6);
  await writeFile(resolve(directory,'browser.json'),JSON.stringify({scope:'Actual React client, seller service/HTTP and ERP engine. Synthetic Auth, ERP memory store and seller RPC memory model; no hosted database, D1/payment/tax provider or staging. Private tax UI is tested separately. Local PostgreSQL invariants and replay tested separately; no restart/crash durability proof. Second page is shared local state, not real multi-device accounts.',views,errors,commits,sellerCommits,operations:['explicit initialization','customer','estimate with exact rounding','actual commit followed by synthetic HTTP 503 instead of receipt','same-key recovery without duplicate','internal acceptance','conflict and explicit reread/confirmation','late authorized read withheld after synthetic Auth event','second page read','read-only UI and server refusal','draft preserved on reload','long company name','seller before accounting initialization','seller postcommit503 exact retry after newer peer head','independent seller revision','seller CAS conflict explicit reread/confirmation','seller postcommit401 purges ERP and seller, exact retry retained','stale owner remains locked after GET','held seller GET blocks ERP reload; later ERP denial purges seller draft','member reads seller without owner form'],success:true},null,2));
 }catch(error){await writeFile(resolve(directory,'browser-failure.json'),JSON.stringify({commits,writes,state,sellerCommits,sellerWrites,sellerState,errors,reason:String(error)},null,2));throw error;}
 finally{await browser.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
},180000);
