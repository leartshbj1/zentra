import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'vite';
import tailwindcss from '@tailwindcss/postcss';
import { sqliteUsDeviceDatabase, seedUsDeviceFixture } from './us-device-test-fixture';
import { usApprovalCopy } from './us-device-approval-copy';

// Private local proof: actual React, HTTP, server factory and SQLite 0000..0088.
// Auth, PG configuration and payment evidence are fictional trusted test ports.
it.skipIf(process.env.ZENTRA_BROWSER_US_ADMISSION_QA!=='1')('authorizes an explicitly selected US company and reviews the real controls in four languages',async()=>{
  const directory=resolve('.qa/us-native-admission-browser'),client=resolve(directory,'client');await mkdir(directory,{recursive:true});
  const db=sqliteUsDeviceDatabase(),fixture=await seedUsDeviceFixture(db.database),challenge=await fixture.start();
  const fakeOrg='22222222-2222-4222-8222-222222222222',longName='Fictitious US company — Énergie et services internationaux '.repeat(2);
  await writeFile(resolve(directory,'entry.tsx'),`import{createRoot}from'react-dom/client';import{UsDeviceApproval}from'@/components/us-device-approval';import{usApprovalCopy}from'@/lib/international/us-device-approval-copy';import'@/app/globals.css';import'@/app/refined.css';import'@/app/product-navigation.css';import'@/app/studio.css';import'@/app/intuitive-site.css';import'@/app/page-system.css';import'@/app/brand-identity.css';import'@/app/product-clarity.css';import'@/app/quiet-site.css';import'@/app/apple-design.css';import'@/app/apple-pages.css';import'@/app/apple-account.css';import'@/app/support/apple-support.css';import'@/app/site-language.css';import'@/app/user-clarity.css';import'@/.vinext/fonts/geist-8ac0455e797f/style.css';const q=new URLSearchParams(location.search);const language=['fr','de','it','en'].includes(q.get('lang'))?q.get('lang'):'en';const c=usApprovalCopy[language];document.documentElement.style.fontSize=q.get('large')==='1'?'200%':'100%';createRoot(document.getElementById('root')).render(<main className="apple-task-page us-device-page" lang={language}><div className="apple-task-wrap"><a className="apple-task-return" href="/compte">Zentra</a><h1 className="apple-task-title">{c.title}</h1><p className="apple-task-lead">{c.lead}</p><p className="us-device-account">{c.connected}: <strong>fictitious-long-account-for-layout@example.test</strong></p><UsDeviceApproval userId="${fixture.actor}" initialCode="${challenge.userCode}" language={language} workspaces={q.get('empty')?[ ]:[{organizationId:'${fakeOrg}',name:'Another fictitious company',edition:'us_experimental',role:'owner'},{organizationId:'${fixture.intent.organizationId}',name:${JSON.stringify(longName)},edition:'us_experimental',role:'owner'}]}/></div></main>);`);
  await writeFile(resolve(directory,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private fictional US authorization proof</title><style>:root{--font-geist-sans:Geist,Arial,sans-serif}body{margin:0}*{box-sizing:border-box}button,input{font:inherit}</style></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await build({configFile:false,root:directory,resolve:{alias:{'@':resolve('.')}},css:{postcss:{plugins:[tailwindcss()]}},build:{outDir:client,emptyOutDir:true},logLevel:'warn'});
  let requests=0;const captured:unknown[]=[];
  const server=createServer(async(req,res)=>{
    try{
      const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`,url=new URL(req.url??'/',origin);
      if(url.pathname==='/api/international/device/approve'){
        const chunks:Buffer[]=[];for await(const chunk of req) chunks.push(Buffer.from(chunk));const text=Buffer.concat(chunks).toString('utf8');
        const request=new Request(url,{method:'POST',headers:req.headers as Record<string,string>,body:text});
        captured.push({body:JSON.parse(text),expectedUser:request.headers.get('X-Zentra-Expected-User'),authorization:request.headers.get('Authorization')});requests++;
        const response=await fixture.handlers.APPROVE(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
      }
      const path=url.pathname==='/'?'index.html':url.pathname.slice(1);if(!/^[A-Za-z0-9._/-]+$/.test(path)||path.includes('..')){res.writeHead(404);res.end();return;}
      const bytes=await readFile(resolve(client,path));res.writeHead(200,{'Content-Type':extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':extname(path)==='.woff2'?'font/woff2':'text/html'});res.end(bytes);
    }catch{res.writeHead(500);res.end('Fictional test unavailable');}
  });await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const require=createRequire(import.meta.url),{chromium}=require(process.env.ZENTRA_PLAYWRIGHT_MODULE||'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage(),errors:string[]=[],views:unknown[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
  try{
    for(const language of ['fr','de','it','en'] as const)for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:920});await page.goto(`${origin}/?lang=${language}`);await page.locator('.us-device').waitFor();await page.evaluate(async()=>{await document.fonts.ready;if(!document.fonts.check('16px Geist'))throw new Error('Geist not loaded');});
      expect(await page.getByRole('radio',{checked:true}).count()).toBe(0);expect(await page.getByRole('button',{name:usApprovalCopy[language].approve,exact:true}).isDisabled()).toBe(true);
      const metrics=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,controls:[...document.querySelectorAll<HTMLElement>('.us-device input,.us-device button')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.left<0||r.right>innerWidth+1);}).length,buttonHeight:document.querySelector('.us-device-submit')!.getBoundingClientRect().height}));
      expect(metrics.scroll).toBeLessThanOrEqual(width+1);expect(metrics.controls).toBe(0);expect(metrics.buttonHeight).toBeGreaterThanOrEqual(48);views.push({language,width,metrics});
      if(language==='de'||language==='en')await page.screenshot({path:resolve(directory,`${language}-${width}.png`),fullPage:true});
    }
    await page.setViewportSize({width:320,height:920});await page.goto(`${origin}/?lang=de&large=1`);await page.locator('.us-device').waitFor();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
    const largeMetrics=await page.locator('.us-device-code').evaluate((e:HTMLInputElement)=>{const style=getComputedStyle(e),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d')!;ctx.font=style.font||`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;return {textWidth:ctx.measureText(e.value).width+parseFloat(style.letterSpacing)*(e.value.length-1),available:e.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),returnHeight:document.querySelector('.apple-task-return')!.getBoundingClientRect().height};});expect(largeMetrics.textWidth).toBeLessThanOrEqual(largeMetrics.available);expect(largeMetrics.returnHeight).toBeGreaterThanOrEqual(48);await page.screenshot({path:resolve(directory,'de-320-large.png'),fullPage:true});
    await page.setViewportSize({width:390,height:920});await page.goto(`${origin}/?lang=en&empty=1`);await page.getByText(usApprovalCopy.en.empty,{exact:true}).waitFor();expect(await page.locator('.us-device .zentra-text-link').evaluate((e:Element)=>e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(48);await page.screenshot({path:resolve(directory,'en-390-empty.png'),fullPage:true});
    await page.goto(`${origin}/?lang=en`);await page.locator('.us-device').waitFor();const radio=page.locator(`input[value="${fixture.intent.organizationId}"]`);await radio.check();await page.keyboard.press('Tab');expect(await page.locator('.us-device-submit').evaluate((e:Element)=>e===document.activeElement)).toBe(true);const outline=await page.locator('.us-device-submit').evaluate((e:Element)=>getComputedStyle(e).outlineStyle);expect(outline).not.toBe('none');await page.screenshot({path:resolve(directory,'en-390-focus.png'),fullPage:true});
    // Switching Auth while the old page remains mounted must not authorize.
    fixture.setUser(fakeOrg);await page.getByRole('button',{name:usApprovalCopy.en.approve,exact:true}).click();await page.getByRole('alert').waitFor();expect(await page.getByRole('alert').textContent()).toBe(usApprovalCopy.en.session);await page.screenshot({path:resolve(directory,'en-390-session-error.png'),fullPage:true});
    fixture.setUser(fixture.actor);await page.getByRole('button',{name:usApprovalCopy.en.approve,exact:true}).click();await page.getByRole('heading',{name:usApprovalCopy.en.done,exact:true}).waitFor();await page.screenshot({path:resolve(directory,'en-390-success.png'),fullPage:true});
    expect(requests).toBe(2);expect(captured.every(value=>(value as {authorization:unknown}).authorization===null)).toBe(true);expect(captured.every(value=>(value as {expectedUser:string}).expectedUser===fixture.actor)).toBe(true);
    const response=await fixture.exchange(challenge.deviceCode);expect(response.status).toBe(200);const session=await response.json() as {organizationId:string;userId:string;supportedSchemaVersion:number};expect(session.organizationId).toBe(fixture.intent.organizationId);expect(session.userId).toBe(fixture.actor);expect(session.supportedSchemaVersion).toBe(3);
    expect((await fixture.handlers.ME(fixture.request('me',undefined,true))).status).toBe(200);
    const text=await page.locator('body').textContent();expect(text).not.toContain('zus_');expect(text).not.toContain('zud_');expect(errors).toEqual([]);
    await writeFile(resolve(directory,'evidence.json'),JSON.stringify({scope:'LOCAL_TEST_ONLY',authority:'fictional Auth/PG/payment evidence; real React+HTTP+SQLite SQL',requests,views,largeText:{language:'de',width:320,scale:'200%',metrics:largeMetrics},errors,session:{organizationId:session.organizationId,userId:session.userId,supportedSchemaVersion:session.supportedSchemaVersion},limitations:['not real Auth','not real PostgreSQL API','not native executable','not physical device','not production']},null,2));
  }finally{await browser.close();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));db.sql.close();}
},120000);
