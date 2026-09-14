import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {mkdir,writeFile} from 'node:fs/promises';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const isWebKit=process.env.ZENTRA_QA_BROWSER==='webkit';const browser=await (isWebKit?webkit:chromium).launch({headless:true,...(!isWebKit?{channel:'msedge'}:{})});
const origin=process.env.ZENTRA_QA_ORIGIN||'http://127.0.0.1:5271',out=`.qa/mobile-team-${isWebKit?'webkit':'edge'}`;await mkdir(out,{recursive:true});const report=[];let page;
async function touch(selector,type,points){await page.locator(selector).first().evaluate((el,{type,points})=>{const touches=points.map((p,i)=>new Touch({identifier:i,target:el,clientX:p[0],clientY:p[1],pageX:p[0],pageY:p[1]}));el.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches,targetTouches:touches,changedTouches:touches}));},{type,points});await page.evaluate(()=>new Promise(requestAnimationFrame));}
async function edgeMove(from,to,cancel=false){await touch('.app-main','touchstart',[from]);for(let i=1;i<=5;i++){await touch('.app-main','touchmove',[[from[0]+(to[0]-from[0])*i/5,from[1]+(to[1]-from[1])*i/5]]);}await touch('.app-main',cancel?'touchcancel':'touchend',[]);await page.waitForTimeout(380);}
try{
for(const viewport of [{width:320,height:568},{width:390,height:844},{width:844,height:390}]){
 page=await browser.newPage({viewport,hasTouch:true});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/tests/mobile-harness.html?browsing=1&design=1');await page.getByRole('button',{name:'Fermer le guide automatique',exact:true}).click();
 const sidebar=page.locator('#primary-navigation');assert.equal(await sidebar.getAttribute('aria-hidden'),'true');
 await edgeMove([5,200],[8,320]);assert.equal(await sidebar.getAttribute('aria-hidden'),'true','vertical scroll stays closed');
 await edgeMove([100,200],[300,200]);assert.equal(await sidebar.getAttribute('aria-hidden'),'true','middle swipe stays closed');
 await touch('.app-main','touchstart',[[5,200]]);await touch('.app-main','touchmove',[[130,200]]);
 const mid=await sidebar.boundingBox();assert.ok(mid.x<0&&mid.x+mid.width>70,'drawer follows finger before release');
 assert.equal(await page.locator('html').getAttribute('data-drawer-dragging'),'true');await touch('.app-main','touchcancel',[]);await page.waitForTimeout(380);assert.equal(await sidebar.getAttribute('aria-hidden'),'true');
 await edgeMove([5,200],[290,205]);assert.equal(await sidebar.getAttribute('aria-hidden'),null,'edge swipe opens');
 await touch('#primary-navigation','touchstart',[[260,200]]);await touch('#primary-navigation','touchmove',[[20,205]]);await touch('#primary-navigation','touchend',[]);await page.waitForTimeout(380);assert.equal(await sidebar.getAttribute('aria-hidden'),'true','reverse closes');
 // Real Chromium touch dispatch additionally exercises the browser input path.
 if(!isWebKit){const cdp=await page.context().newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:5,y:220}]});for(const x of [30,70,130,200,290])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:220}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(400);assert.equal(await sidebar.getAttribute('aria-hidden'),null,'native browser touch opens');await page.locator('.navigation-scrim').click({position:{x:viewport.width-10,y:220}});}
 await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:`${out}/${viewport.width}-menu.png`});
 for(const view of ['document','image','pdf']){
  await page.goto(`${origin}/tests/touch-team-harness.html?view=${view}`);await page.locator('[data-touch-document]').waitFor();
  if(view==='pdf')await page.locator('canvas').waitFor();if(view==='image')await page.waitForFunction(()=>document.querySelector('.touch-image-reader img')?.naturalWidth>1);
  await page.evaluate(()=>{const s=document.documentElement.style;s.setProperty('--safe-top',innerWidth>600?'0px':'47px');s.setProperty('--safe-bottom','34px');s.setProperty('--safe-left',innerWidth>600?'47px':'0px');s.setProperty('--safe-right',innerWidth>600?'47px':'0px');});
  const selector=view==='document'?'.document-preview__paper':view==='image'?'.touch-image-reader img':'.pdf-attachment-preview__page';
  const zoom=()=>page.locator(selector).evaluate(el=>new DOMMatrix(getComputedStyle(el).transform).a);
  const before=await zoom(),area=await page.locator('[data-touch-document]').boundingBox();assert.ok(area.height>70,`${view} usable viewport`);const x=area.x+area.width/2,y=area.y+Math.min(area.height/2,130);
  await touch('[data-touch-document]','touchstart',[[x-25,y],[x+25,y]]);await touch('[data-touch-document]','touchmove',[[x-60,y],[x+60,y]]);await touch('[data-touch-document]','touchend',[]);
  assert.ok(await zoom()>before*2,`${view} pinch zoom`);assert.equal(await page.evaluate(()=>visualViewport.scale),1,'only document zooms');
  const close=page.getByRole('button',{name:/Fermer/}).first();const box=await close.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=viewport.width+1&&box.y>=0&&box.y+box.height<=viewport.height,'close accessible');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${view} no page overflow`);
  await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:`${out}/${viewport.width}-${view}.png`});await close.click();
 }
 assert.deepEqual(errors,[]);report.push({viewport,gestures:true,pinch:['document','image','pdf'],safeAreas:true,errors});await page.close();
}
page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});await page.goto(origin+'/tests/touch-team-harness.html');
await page.getByRole('button',{name:'Se connecter dans le navigateur',exact:true}).click();await page.getByText('TEST-1',{exact:true}).waitFor();
await page.waitForFunction(()=>typeof window.resolvePoll==='function');await page.getByRole('button',{name:'Demander un nouveau code',exact:true}).click();await page.getByText('TEST-2',{exact:true}).waitFor();await page.evaluate(()=>window.resolvePoll());await page.waitForTimeout(100);assert.equal(await page.getByText('TEST-1',{exact:true}).count(),0,'old poll cannot replace renewed code');
await page.evaluate(()=>window.connect());await page.getByRole('button',{name:'join',exact:true}).click();await page.getByRole('button',{name:'Ouvrir cette entreprise',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Ouvrir cette entreprise',exact:true}).isDisabled(),true,'missing company details explained');await page.getByRole('button',{name:/Fermer/}).first().click();
await page.getByRole('button',{name:'Partager les coordonnées',exact:true}).click();await page.getByLabel(/^Adresse e-mail/).fill('colleague@example.invalid');await page.getByLabel('Rôle',{exact:true}).selectOption('read_only');await page.getByRole('button',{name:'Créer le lien d’invitation',exact:true}).click();await page.getByLabel('Lien réservé à l’adresse invitée',{exact:true}).waitFor();assert.ok((await page.evaluate(()=>window.calls)).includes('invite:read_only'));
await page.getByRole('button',{name:'Annuler l’invitation',exact:true}).click();await page.getByRole('button',{name:'join',exact:true}).click();await page.getByRole('button',{name:'Ouvrir cette entreprise',exact:true}).click();await page.getByText('Entreprise ouverte',{exact:true}).waitFor();
report.push({renewCodeRace:true,roleInvitation:true,joinMissingProfile:true,joinSharedProfile:true});
for(const lang of ['de','it','en']){await page.goto(`${origin}/tests/touch-team-harness.html?lang=${lang}`);await page.evaluate(()=>window.connect());await page.getByRole('button',{name:'join',exact:true}).click();await page.waitForTimeout(150);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${lang} no overflow`);await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:`${out}/join-${lang}.png`});}
}catch(error){if(page){await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:`${out}/failure.png`});await writeFile(`${out}/failure.json`,JSON.stringify({error:String(error),text:await page.locator('body').innerText()},null,2));}throw error;}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();}
