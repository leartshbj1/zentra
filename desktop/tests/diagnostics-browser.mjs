import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const module=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const {chromium}=module.chromium?module:module.default;
const base=process.env.ZENTRA_PREVIEW_URL||'http://127.0.0.1:5363';
const out=path.resolve('artifacts/drafts-diagnostics-browser');await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.ZENTRA_BROWSER_PATH?{executablePath:process.env.ZENTRA_BROWSER_PATH}:{})});
const results=[];
try{for(const lang of ['fr','de','it','en'])for(const theme of ['light','dark'])for(const size of [{width:320,height:780,text:100},{width:390,height:844,text:200},{width:1440,height:1000,text:100}]){
  const page=await browser.newPage({viewport:{width:size.width,height:size.height},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}/tests/diagnostics-preview.html?language=${lang}&theme=${theme}&text=${size.text}`);await page.locator('[data-diagnostics-panel] .settings-actions .button').first().waitFor();
  await page.locator('[data-error-preview] .error-guidance__actions button').click();if(await page.locator('[data-read-count]').textContent()!=='1')throw Error('Read retry did not run');
  if(await page.locator('[data-mutation-preview] .error-guidance__actions button').count())throw Error('Unsafe mutation retry');
  const overflow=await page.evaluate(()=>({width:document.documentElement.scrollWidth,view:innerWidth,details:[...document.querySelectorAll('.error-guidance__details')].some(node=>node.open)}));
  if(overflow.width>overflow.view+1||overflow.details||errors.length)throw Error(JSON.stringify({lang,theme,size,overflow,errors}));
  if(lang==='fr'&&size.width===390||lang==='de'&&size.width===1440)await page.screenshot({path:path.join(out,`${lang}-${theme}-${size.width}.png`),fullPage:true});
  results.push({lang,theme,...size,overflow:false,mutationRetry:false,readRetry:true});await page.close();
}await writeFile(path.join(out,'proof.json'),JSON.stringify({synthetic:true,cases:results},null,2));console.log(JSON.stringify({cases:results.length,status:'passed',output:out}));}
finally{await browser.close();}
