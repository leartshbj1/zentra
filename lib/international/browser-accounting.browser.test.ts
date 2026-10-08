import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'vite';
import { executeErp } from './runtime';
import { applyErpDelta } from './runtime-sync';
import { createErpHandlers } from './runtime-server';
import { createUsSellerProfileHandlers } from './seller-profile-server';
import { createUsTaxProfileHandlers } from './us-tax-profile-server';
import { browserAccountingCopy } from './browser-accounting-copy';
import { browserWorkbenchCopy } from './browser-workbench-copy';
import { ErpError } from './erp-contract';
import type { ErpCommand, ErpReceipt, ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';

// Real React/HTTP/ERP/delta. Explicit fictitious Auth, RAM CAS and data only.
it.skipIf(process.env.ZENTRA_BROWSER_ACCOUNTING_QA !== '1')('runs journal and period reviews through the real browser workbench', async () => {
  const directory=resolve('.qa/us-journal-periods/browser'),client=resolve(directory,'client');await mkdir(directory,{recursive:true});
  const organizationId='fictitious-browser-accounting',userId='fictitious-owner';
  const configuration:CompanyConfiguration={schemaVersion:1,organizationId,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Fictional Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}};
  let state:ErpState|null=null,role:'owner'|'read_only'='owner',revoked=false,dropNext=false,commits=0;
  const receipts=new Map<string,ErpReceipt>(),bodies:string[]=[];
  const store:ErpStore={supportedSchemaVersion:4,read:async()=>structuredClone(state),receipt:async(_org,key)=>structuredClone(receipts.get(key)??null),commit:async input=>{
    const prior=receipts.get(input.receipt.idempotencyKey);if(prior){if(prior.commandHash!==input.receipt.commandHash)throw new ErpError('idempotency_conflict',409);return prior;}
    if((state?.revision??0)!==input.expectedRevision)throw new ErpError('revision_conflict',409);
    state=applyErpDelta(state,{schemaVersion:input.header.schemaVersion,organizationId,fromRevision:input.expectedRevision,toRevision:input.header.revision,headRevision:input.header.revision,hasMore:false,resetRequired:false,events:[{schemaVersion:input.header.schemaVersion,organizationId,revision:input.header.revision,header:input.header,changes:input.changes,ledgerAudit:input.ledgerAudit,receipt:input.receipt,actorId:userId,occurredAt:input.actor.timestamp}]},organizationId,4);
    receipts.set(input.receipt.idempotencyKey,input.receipt);commits++;return input.receipt;
  }};
  const authority=async()=>{if(revoked)throw new ErpError('unauthorized',401);return {mode:'browser' as const,actor:{organizationId,userId,role,managementEntitled:true,timestamp:'2026-10-08T12:00:00.000Z'}};};
  const shared={enabled:()=>true,authority,configuration:async()=>configuration,rateLimit:async()=>{},diagnostic:()=>{}};
  const handlers=createErpHandlers({...shared,store:()=>store,freshSupportedSchemaVersion:async()=>4 as const,taxProvider:async()=>null});
  const seller=createUsSellerProfileHandlers({...shared,store:()=>({rpc:async<T>():Promise<T>=>({status:'unconfigured',organizationId,revision:0} as T)})});
  const tax=createUsTaxProfileHandlers({...shared,store:()=>({rpc:async<T>():Promise<T>=>({status:'unconfigured',organizationId,revision:0,verification:'unverified'} as T)})});
  const send=async(command:ErpCommand)=>executeErp({store,configuration,actor:(await authority()).actor,revalidate:async()=>(await authority()).actor,taxProvider:async()=>null},{idempotencyKey:crypto.randomUUID(),expectedRevision:state?.revision??0,command});
  await send({type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]});commits=0;
  await writeFile(resolve(directory,'entry.tsx'),`import {createRoot} from 'react-dom/client';import {UsErpWorkbench} from '@/components/account/us-erp-workbench';import '@/app/compte/account.css';import '@/app/apple-account.css';const q=new URLSearchParams(location.search);document.documentElement.style.fontSize=q.get('large')==='1'?'200%':'100%';const root=createRoot(document.getElementById('root'));const render=(role='owner',user='${userId}')=>root.render(<div className="account-experience account-detail" data-theme={q.get('theme')==='dark'?'dark':'light'}><main className="account-content"><UsErpWorkbench organizationId="${organizationId}" expectedUserId={user} role={role} language={q.get('lang')||'en'} supportedSchemaVersion={4} salesEnabled/></main></div>);window.zentraQaRender=render;render();`);
  await writeFile(resolve(directory,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fictitious US accounting review</title><style>:root{--font-geist-sans:Arial,sans-serif}body{margin:0}*{box-sizing:border-box}button,input,select,textarea{font:inherit}</style></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await build({configFile:false,root:directory,resolve:{alias:{'@':resolve('.')}},build:{outDir:client,emptyOutDir:true},logLevel:'warn'});
  const server=createServer(async(req,res)=>{try{
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`,url=new URL(req.url??'/',origin);
    if(url.pathname.startsWith('/api/international/workspaces/')){
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString('utf8'),request=new Request(url,{method:req.method,headers:req.headers as Record<string,string>,...(req.method==='POST'?{body}:{})});
      const erp=url.pathname.endsWith('/erp');if(erp&&req.method==='POST')bodies.push(body);
      const response=erp?(req.method==='POST'?await handlers.POST(request,organizationId):await handlers.GET(request,organizationId)):url.pathname.endsWith('/seller')?await seller.GET(request,organizationId):await tax.GET(request,organizationId);
      if(erp&&req.method==='POST'&&dropNext&&response.status===200){dropNext=false;res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"service_unavailable"}');return;}
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    const pathname=url.pathname==='/'?'index.html':url.pathname.slice(1),path=resolve(client,pathname);if(!path.startsWith(client+'/')&&!path.startsWith(client+'\\'))throw new Error('Invalid local path');res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'text/html');res.end(await readFile(path));
  }catch{res.writeHead(500);res.end('Local fixture failure');}});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const require=createRequire(import.meta.url),{chromium}=require('C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');const browser=await chromium.launch({channel:'msedge',headless:true});
  const errors:string[]=[],checks:unknown[]=[];const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    const page=await browser.newPage({viewport:{width:1200,height:900}});page.on('pageerror',(error:Error)=>errors.push(error.message));
    await page.goto(origin+'/?lang=en');const accounting=page.locator('.us-accounting');await expect.poll(()=>accounting.getByRole('button',{name:browserAccountingCopy.en.newJournal,exact:true}).isEnabled()).toBe(true);
    await accounting.getByRole('button',{name:browserAccountingCopy.en.newJournal,exact:true}).click();
    const form=accounting.locator('form');await form.locator('[name=transactionDate]').fill('2026-10-08');await form.locator('[name=accountingDate]').fill('2026-10-08');await form.locator('[name=periodId]').selectOption('2026');await form.locator('[name=description]').fill('Fictitious opening capital');await form.locator('[name=sourceReference]').fill('APPROVAL-TEST');await form.locator('[name=cashFlowCategory]').selectOption('financing');
    const lineRows=form.locator('.us-erp-line');await lineRows.nth(0).getByLabel(browserAccountingCopy.en.account,{exact:true}).selectOption('cash');await lineRows.nth(0).getByLabel(browserAccountingCopy.en.debit,{exact:true}).fill('90071992547409.93');await lineRows.nth(1).getByLabel(browserAccountingCopy.en.account,{exact:true}).selectOption('equity');await lineRows.nth(1).getByLabel(browserAccountingCopy.en.credit,{exact:true}).fill('90071992547409.93');
    await form.getByRole('button',{name:browserAccountingCopy.en.review,exact:true}).click();await expect.poll(()=>accounting.locator('.us-erp-confirm').count()).toBe(1);
    await form.getByRole('button',{name:browserAccountingCopy.en.addLine,exact:true}).click();expect(await accounting.locator('.us-erp-confirm').count()).toBe(0);await lineRows.nth(2).getByRole('button',{name:browserAccountingCopy.en.removeLine}).click();
    await form.getByRole('button',{name:browserAccountingCopy.en.review,exact:true}).click();
    await send({type:'open_period',id:'2027',start:'2027-01-01',end:'2027-12-31'});await page.getByRole('button',{name:browserWorkbenchCopy.en.reload,exact:true}).click();await expect.poll(()=>accounting.locator('.us-erp-confirm').count()).toBe(0);expect(await form.locator('[name=description]').inputValue()).toBe('Fictitious opening capital');expect(await lineRows.nth(0).getByLabel(browserAccountingCopy.en.debit,{exact:true}).inputValue()).toBe('90071992547409.93');
    await form.getByRole('button',{name:browserAccountingCopy.en.review,exact:true}).click();dropNext=true;await accounting.getByRole('button',{name:browserAccountingCopy.en.confirm,exact:true}).click();await expect.poll(()=>page.locator('.us-erp-pending').count()).toBe(1);expect(state!.ledger.entries).toHaveLength(1);const beforeRetry=commits;await page.locator('.us-erp-pending').getByRole('button').click();await expect.poll(()=>page.locator('.us-erp-pending').count()).toBe(0);expect(commits).toBe(beforeRetry);expect(bodies.at(-1)).toBe(bodies.at(-2));expect(state!.ledger.entries[0].lines[0].debitMinor).toBe('9007199254740993');
    await accounting.getByRole('button',{name:browserAccountingCopy.en.periods,exact:true}).click();await expect.poll(()=>accounting.getByRole('button',{name:browserAccountingCopy.en.close,exact:true}).count()).toBe(2);expect(await accounting.getByRole('button',{name:browserAccountingCopy.en.close,exact:true}).nth(1).isEnabled()).toBe(false);
    await accounting.getByRole('button',{name:browserAccountingCopy.en.close,exact:true}).nth(0).click();await form.locator('[name=confirm]').check();await form.getByRole('button',{name:browserAccountingCopy.en.review,exact:true}).click();await accounting.getByRole('button',{name:browserAccountingCopy.en.confirm,exact:true}).click();await expect.poll(()=>state!.ledger.periods[0].status).toBe('closed');
    await accounting.getByRole('button',{name:browserAccountingCopy.en.journal,exact:true}).click();await accounting.getByRole('button',{name:browserAccountingCopy.en.reverse,exact:true}).click();await form.locator('[name=transactionDate]').fill('2027-01-08');await form.locator('[name=accountingDate]').fill('2027-01-08');await form.locator('[name=periodId]').selectOption('2027');await form.locator('[name=reason]').fill('Fictitious human-reviewed correction');await form.getByRole('button',{name:browserAccountingCopy.en.review,exact:true}).click();await accounting.getByRole('button',{name:browserAccountingCopy.en.confirm,exact:true}).click();await expect.poll(()=>state!.ledger.entries.length).toBe(2);expect(state!.ledger.entries[1].reversesEntryId).toBe(state!.ledger.entries[0].id);
    for(const language of ['fr','de','it','en'] as const)for(const theme of ['light','dark'])for(const width of [1200,390,320]){
      await page.setViewportSize({width,height:900});await page.goto(`${origin}/?lang=${language}&theme=${theme}${language==='de'&&width===320?'&large=1':''}`);const scope=page.locator('.us-accounting');await scope.waitFor();await scope.scrollIntoViewIfNeeded();await page.evaluate(()=>document.fonts.ready);const overflowing=await scope.evaluate((element:HTMLElement)=>Array.from(element.querySelectorAll<HTMLElement>('*')).filter(node=>node.getClientRects().length&&node.getBoundingClientRect().width>0&&(node.getBoundingClientRect().right>innerWidth+1||node.getBoundingClientRect().left<-1)).map(node=>node.tagName+':'+node.textContent?.slice(0,70)));expect(overflowing).toEqual([]);const selectedStyle=await scope.locator('.us-accounting-tabs button[aria-pressed="true"]').evaluate((element:HTMLElement)=>{const style=getComputedStyle(element);const luminance=(color:string)=>{const rgb=color.match(/\d+(?:\.\d+)?/g)!.slice(0,3).map(value=>{const channel=Number(value)/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};const foreground=luminance(style.color),background=luminance(style.backgroundColor);return {color:style.color,background:style.backgroundColor,contrast:(Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)};});expect(selectedStyle.contrast).toBeGreaterThanOrEqual(4.5);await scope.screenshot({path:resolve(directory,`${language}-${theme}-${width}.png`)});checks.push({language,theme,width,largeText:language==='de'&&width===320,overflowing,selectedStyle});
    }
    role='read_only';await page.evaluate(()=> (window as unknown as {zentraQaRender:(role:string)=>void}).zentraQaRender('read_only'));await expect.poll(()=>page.locator('.us-accounting').getByRole('button',{name:browserAccountingCopy.en.newJournal,exact:true}).count()).toBe(0);
    revoked=true;await page.getByRole('button',{name:browserWorkbenchCopy.en.reload,exact:true}).click();await expect.poll(()=>page.locator('.us-accounting').count()).toBe(0);expect(errors).toEqual([]);
    await writeFile(resolve(directory,'evidence.json'),JSON.stringify({scope:'Actual browser UI/HTTP/core/delta, fictitious Auth and RAM persistence; no hosted Auth/PG/native/production claim',checks,errors,commits,writes:bodies.length,finalRevision:state!.revision,ledgerRevision:state!.ledger.revision,exactRetry:true,staleDraftPreserved:true,accountPurge:true},null,2));
  }finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
},120000);
