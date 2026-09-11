import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out=new URL('../../.qa/assistant-real/',import.meta.url); await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:390,height:844}});
const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const modelPath='C:/Users/alb/Documents/ChatGPT/chantier/.qa/payroll143/models/Qwen3-0.6B-Q4_0.gguf';
const modelServer=createServer((req,res)=>{res.writeHead(200,{'Access-Control-Allow-Origin':'*','Content-Type':'application/octet-stream','Content-Length':'428970080'});if(req.method==='HEAD')res.end();else createReadStream(modelPath).pipe(res);});
await new Promise(resolve=>modelServer.listen(5194,'127.0.0.1',resolve));
let downloads=0;
await context.route('https://huggingface.co/**',async route=>{downloads++;await route.fulfill({status:302,headers:{location:'http://127.0.0.1:5194/Qwen3-0.6B-Q4_0.gguf','access-control-allow-origin':'*'}});});
await page.goto('http://127.0.0.1:5193/tests/mobile-harness.html?browsing=1&design=1');
await page.getByRole('button',{name:'Fermer le guide automatique',exact:true}).click();
await page.getByRole('button',{name:'Demander à l’assistant Zentra',exact:true}).click();
await page.getByRole('button',{name:'Installer Qwen · 429 Mo',exact:true}).waitFor({timeout:40000});
await page.getByRole('button',{name:'Installer Qwen · 429 Mo',exact:true}).click();
console.log('Installation réelle de Qwen en cours.');
await page.getByText('Qwen fonctionne sur cet appareil.',{exact:false}).waitFor({timeout:180000});
console.log('Modèle chargé.');
const questions=[
 {text:'Comment configurer la caisse de pension pour ma fiche de salaire ?',expect:/caisse|pension|LPP/i},
 {text:'Ma date du choix de cotisation est en 2025 et mon année choisie est 2026. Que faire ?',expect:/date|année|2026/i},
];
const results=[];
for(const item of questions){
 await page.getByLabel('Votre question',{exact:true}).fill(item.text);
 const start=Date.now();await page.getByRole('button',{name:'Envoyer la question',exact:true}).click();
 await page.getByRole('button',{name:'Arrêter la réponse',exact:true}).waitFor();
 await page.getByRole('button',{name:'Envoyer la question',exact:true}).waitFor({timeout:190000});
 const text=await page.locator('.assistant-message--assistant').last().innerText();
 assert.match(text,item.expect); results.push({question:item.text,response:text,durationMs:Date.now()-start}); console.log(JSON.stringify(results.at(-1)));
 if(item.text.includes('date du choix')) {assert.doesNotMatch(text,/26 juillet|<think>/);assert.match(text,/confirmation|déclaration/);}
}
await page.screenshot({path:new URL('mobile.png',out).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
await page.getByRole('button',{name:'Fermer « Assistant Zentra »',exact:true}).click();
await page.reload();
const downloadsBefore=downloads;
await context.unroute('https://huggingface.co/**');
await context.route('https://**',route=>route.abort());
await page.getByRole('button',{name:'Demander à l’assistant Zentra',exact:true}).click();
await page.getByText('Qwen fonctionne sur cet appareil.',{exact:false}).waitFor({timeout:30000});
await page.getByLabel('Votre question',{exact:true}).fill('Comment ajouter un collaborateur ?');
await page.getByRole('button',{name:'Envoyer la question',exact:true}).click();
await page.getByRole('button',{name:'Arrêter la réponse',exact:true}).waitFor();
await page.getByRole('button',{name:'Envoyer la question',exact:true}).waitFor({timeout:190000});
const offlineResponse=await page.locator('.assistant-message--assistant').last().innerText();
assert.match(offlineResponse,/collaborateur|identité|Équipe/i);
assert.equal(downloads,downloadsBefore);
// The same cached worker must still read imported employee information.
const extraction=await page.evaluate(async()=>{
 const {payrollLocalAi}=await import('/src/payrollLocalAi.ts');
 return payrollLocalAi.analyze({extractedText:'Bulletin de salaire janvier 2026\nEmployeur : Exemple SA\nMadame\nCamille Bernard\nRue du Lac 8\n2000 Neuchâtel\nPériode du 01.01.2026 au 31.01.2026'});
});
assert.equal(extraction.employeeDraft.fields.name,'Camille Bernard');
assert.deepEqual(errors,[]);
await writeFile(new URL('report.json',out),JSON.stringify({results,offlineResponse,downloads,errors},null,2));
console.log(JSON.stringify({results,offlineResponse,downloads,errors},null,2));
await browser.close();
modelServer.close();
