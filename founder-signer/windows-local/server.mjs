import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,unlink,open} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {Vault} from './vault.mjs';
import {Backend} from './backend.mjs';

const textTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const allowedFiles=new Set(['index.html','signature.html','keys.html','keys.js','access.js','access.css','app.js','style.css']);
export async function startServer(root,backend,options={}){
  const launchToken=randomBytes(32).toString('base64url'),cookie=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
  let origin,host,cookieName,lastSeen=Date.now(),active=0;
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
    if(req.headers.host!==host||req.socket.remoteAddress!=='127.0.0.1')return json(403,{error:'Origine locale requise.'});
    if(req.headers.origin&&req.headers.origin!==origin)return json(403,{error:'Origine refusée.'});
    const url=new URL(req.url,origin);
    if(url.pathname==='/health'&&req.method==='GET'&&req.headers['x-launch-token']===launchToken){lastSeen=Date.now();return json(200,{app:'ZentraFondateur',version:'1.4.1',pid:process.pid});}
    if(url.pathname==='/launch/'+launchToken&&req.method==='GET'){
      lastSeen=Date.now();res.writeHead(303,{'Set-Cookie':`${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/`,Location:'/'});return res.end();
    }
    if(!(req.headers.cookie||'').split(';').some(c=>c.trim()===cookieName+'='+cookie))return json(403,{error:'Ouvrez Zentra Fondateur depuis votre raccourci personnel.'});
    if(req.method==='POST'&&['/invoke','/heartbeat'].includes(url.pathname)){
      if(req.headers.origin!==origin||req.headers['x-zentra-session']!==csrf||req.headers['content-type']!=='application/json')return json(403,{error:'Session locale invalide.'});
      lastSeen=Date.now();if(url.pathname==='/heartbeat')return json(200,{ok:true});
      if(active>=8)return json(429,{error:'Une opération est déjà en cours.'});active++;
      try{let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>32768){json(413,{error:'Demande trop volumineuse.'});req.destroy();return;}chunks.push(chunk);}const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!input||typeof input.command!=='string'||input.command.length>40)return json(400,{error:'Commande invalide.'});
        return json(200,{result:await backend.invoke(input.command,input.args||{})});
      }catch(e){return json(400,{error:String(e?.message||'La commande n’a pas abouti.').slice(0,500)});}finally{active--;lastSeen=Date.now();}
    }
    if(req.method!=='GET')return json(405,{error:'Méthode refusée.'});
    if(url.pathname==='/bridge.js'){
      res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});
      return res.end(`'use strict';(()=>{const csrf=${JSON.stringify(csrf)};window.__TAURI__={core:{invoke:async(command,args={})=>{if(command==='copy_text'){if(typeof args.text!=='string'||args.text.length>16384)throw Error('Texte invalide.');await navigator.clipboard.writeText(args.text);return;}const r=await fetch('/invoke',{method:'POST',headers:{'Content-Type':'application/json','X-Zentra-Session':csrf},body:JSON.stringify({command,args})});const body=await r.json();if(!r.ok)throw Error(body.error||'Connexion locale indisponible.');return body.result;}}};setInterval(()=>fetch('/heartbeat',{method:'POST',headers:{'Content-Type':'application/json','X-Zentra-Session':csrf},body:'{}'}).catch(()=>{}),20000);})();`);
    }
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!allowedFiles.has(name))return json(404,{error:'Fichier introuvable.'});
    try{let content=await readFile(path.join(root,'ui',name));if(name.endsWith('.html'))content=Buffer.from(content.toString('utf8').replace(/<script src="(access|app|keys)\.js"/,'<script src="bridge.js" defer></script><script src="$1.js"').replace(/Zentra Fondateur 1\.\d+(?:\.\d+)?/g,'Zentra Fondateur 1.4.1'));
      res.writeHead(200,{'Content-Type':textTypes[path.extname(name)]});res.end(content);
    }catch{json(404,{error:'Fichier local indisponible.'});}
  });
  server.requestTimeout=40000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;host='127.0.0.1:'+port;origin='http://'+host;cookieName='zentra_founder_'+port;
  const timer=setInterval(()=>{if(!active&&Date.now()-lastSeen>(options.idleMs??300000))server.close();},10000);timer.unref();server.on('close',()=>clearInterval(timer));
  return {server,port,origin,launchToken,pid:process.pid};
}
async function openWindow(root,state){
  const edge=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  if(!edge)throw Error('Microsoft Edge est nécessaire pour ouvrir cette version locale.');
  const child=spawn(edge,[`--app=http://127.0.0.1:${state.port}/launch/${state.launchToken}`,'--user-data-dir='+path.join(root,'edge-profile'),'--no-first-run','--no-default-browser-check','--window-size=1140,850'],{windowsHide:false,detached:true,stdio:'ignore'});
  // Keep the launcher alive until Edge has taken over the app window.
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',()=>setTimeout(resolve,2500));});child.unref();
}
async function main(){
  const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));const statePath=path.join(root,'local-session.json'),lockPath=path.join(root,'local-session.lock');
  let lock;
  for(let attempt=0;attempt<10;attempt++){
    try{lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid}));break;}
    catch(e){if(e.code!=='EEXIST')throw e;
      try{const state=JSON.parse(await readFile(statePath,'utf8'));if(Number.isSafeInteger(state.port)&&/^[A-Za-z0-9_-]{43}$/.test(state.launchToken)){
        const response=await fetch('http://127.0.0.1:'+state.port+'/health',{headers:{'X-Launch-Token':state.launchToken},signal:AbortSignal.timeout(1000)});
        if(response.ok&&(await response.json()).app==='ZentraFondateur'){await openWindow(root,state);return;}
      }}catch{}
      try{const owner=JSON.parse(await readFile(lockPath,'utf8'));try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH'){await unlink(lockPath);continue;}}}catch{}
      await new Promise(resolve=>setTimeout(resolve,400));
    }
  }
  if(!lock)throw Error('Une autre ouverture est en cours. Patientez quelques secondes.');
  try{
    const service=await startServer(root,new Backend(new Vault(path.join(root,'vault'))));
    await writeFile(statePath,JSON.stringify({port:service.port,launchToken:service.launchToken,pid:process.pid}),{mode:0o600});
    service.server.on('close',async()=>{await lock.close();await unlink(lockPath).catch(()=>{});await unlink(statePath).catch(()=>{});});
    await openWindow(root,service);
  }catch(e){await lock.close();await unlink(lockPath).catch(()=>{});throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{process.stderr.write('Impossible d’ouvrir Zentra Fondateur. Vérifiez les composants locaux et le coffre Windows.\n');process.exitCode=1;});
