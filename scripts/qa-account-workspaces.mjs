import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const directory='.qa/account-workspace-discovery/preview',output='.qa/account-workspace-discovery';
await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{const name=new URL(req.url,'http://127.0.0.1').pathname.slice(1);if(!/^(fr|en|de|it)-(light|dark)\.html$/.test(name)){res.writeHead(404);res.end();return;}try{const body=await readFile(`${directory}/${name}`);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(body);}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true});
const results=[];
try{
for(const language of ['fr','en','de','it'])for(const theme of ['light','dark'])for(const width of [320,390,1440]){
 const context=await browser.newContext({viewport:{width,height:960},reducedMotion:'reduce',serviceWorkers:'block'});const page=await context.newPage();const errors=[];
 page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(`${origin}/${language}-${theme}.html`,{waitUntil:'load'});
 const inspect=()=>page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,links:[...document.querySelectorAll('.account-space-choice')].map(node=>{const r=node.getBoundingClientRect();return {href:node.getAttribute('href'),width:r.width,height:r.height,text:node.textContent};}),foreground:getComputedStyle(document.querySelector('.account-experience')).color,background:getComputedStyle(document.querySelector('.account-experience')).backgroundColor}));
 const normal=await inspect();assert(normal.scroll<=normal.width+1,`${language}/${theme}/${width} overflow`);assert(normal.links.every(link=>link.width>=44&&link.height>=44));assert(normal.links[0].href.startsWith('/compte/espaces/us/'));assert(normal.links[1].href.startsWith('/compte/entreprise?organizationId='));assert.equal(errors.length,0);
 await page.keyboard.press('Tab');assert(await page.locator('.account-skip').evaluate(node=>document.activeElement===node));await page.keyboard.press('Enter');assert(await page.locator('#account-content').evaluate(node=>document.activeElement===node));
 await page.locator('#account-content').evaluate(node=>node.blur());
 if(width===390)await page.screenshot({path:`${output}/${language}-${theme}.png`,fullPage:true});
 let enlarged=null;if(width===320){await page.evaluate(()=>{const nodes=[...document.querySelectorAll('.account-experience *')].map(node=>({node,size:getComputedStyle(node).fontSize}));for(const {node,size} of nodes)node.style.fontSize=`${parseFloat(size)*2}px`;});enlarged=await inspect();assert(enlarged.scroll<=enlarged.width+1,`${language}/${theme}/200% text overflow`);assert(enlarged.links.every(link=>link.width>=44&&link.height>=44));}
 results.push({language,theme,width,normal,enlarged,errors});await context.close();
}
await writeFile(`${output}/browser.json`,JSON.stringify({fixture:'Actual React shell + picker rendered with scoped account and Apple account CSS. Auth, language picker and signout controls mocked; no live session/backend.',views:results.length,success:true,results},null,2));console.log(JSON.stringify({views:results.length,success:true,output:`${output}/browser.json`}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
