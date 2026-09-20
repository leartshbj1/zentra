import {sign,randomUUID} from 'node:crypto';
import {readFile,unlink} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {dpapi} from './vault.mjs';
const pendingFile='founder-pending-platform.dpapi';
export function validatePlatformAction(a){
 if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!['operation','apiKey','operationId','expectedRevision'].includes(k))||!['state','test','save_key'].includes(a.operation))throw Error('Commande de configuration invalide.');
 if(a.operation!=='save_key'){if(Object.keys(a).length!==1)throw Error('Champ inattendu.');return a;}
 if(typeof a.apiKey!=='string'||!a.apiKey.trim()||a.apiKey.length>8192||/[\x00-\x20\x7f]/.test(a.apiKey.trim())||!(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(a.operationId))||typeof a.expectedRevision!=='string'||!(/^(initial|[a-f0-9]{64})$/.test(a.expectedRevision)))throw Error('Vérifiez la clé et actualisez son état avant de l’enregistrer.');
 return {...a,apiKey:a.apiKey.trim()};
}
export function platformEnvelope(action,key){action=validatePlatformAction(action);const payload=Buffer.from(JSON.stringify({version:1,timestamp:Math.floor(Date.now()/1000),nonce:randomUUID(),action})).toString('base64url');return {payload,signature:sign(null,Buffer.from('zentra-founder-platform-v1\n'+payload),key).toString('base64url')};}
export class PlatformBackend{
 constructor(vault,post){this.vault=vault;this.post=post;}
 async pending(){try{const bytes=await this.vault.read(pendingFile);try{const a=validatePlatformAction(JSON.parse(bytes.toString('utf8')));if(a.operation!=='save_key')throw Error('Demande en attente invalide.');return a;}finally{bytes.fill(0);}}catch(e){if(e.code==='ENOENT')return null;throw Error('La demande de clé en attente est illisible.');}}
 async status(){const a=await this.pending();return {pending:a?{operation:a.operation,operationId:a.operationId}:null};}
 async retry(){const a=await this.pending();if(!a)throw Error('Aucune modification de clé en attente.');return this.request(a);}
 async request(input){
  const action=validatePlatformAction(input);
  if(action.operation==='save_key'){
   const pending=await this.pending();if(pending&&!isDeepStrictEqual(pending,action))throw Error('Reprenez la modification de clé en attente avant d’en envoyer une autre.');
   const bytes=Buffer.from(JSON.stringify(action));try{await this.vault.write(pendingFile,bytes);}finally{bytes.fill(0);}
  }
  const body=platformEnvelope(action,await this.vault.key('admin'));
  let response;try{response=await this.post('https://www.zentraapp.ch/api/founder/platform',body);}catch{throw Error('Connexion interrompue. Reprenez la modification en attente pour confirmer son résultat.');}
  if(action.operation==='save_key'&&(response.status===200||[400,401,403,404,409,422].includes(response.status)))await unlink(path.join(this.vault.root,pendingFile));
  if(response.status!==200){let message=typeof response.body?.error==='string'?response.body.error.slice(0,500):'Le service est momentanément indisponible.';if(action.apiKey)message=message.replaceAll(action.apiKey,'[clé masquée]');throw Error(message);}
  return response.body;
 }
}
export async function desktopAccount(options={}){
 const file=path.join(os.homedir(),'AppData','Local','ch.helvichantier.desktop','cloud-account-session.protected');
 let session;
 try{const clear=(options.unprotect||dpapi)(await (options.read||readFile)(file));try{session=JSON.parse(clear.toString('utf8'));}finally{clear.fill(0);}}catch{return {connected:false,message:'Aucun compte Zentra associé à ce PC. Connectez-vous dans Zentra → Paramètres → Compte et accès.'};}
 if(session.version!==1||typeof session.session_token!=='string'||!session.session_token||session.session_token.length>1024||!Number.isFinite(Date.parse(session.session_expires_at))||Date.parse(session.session_expires_at)<=Date.now())return {connected:false,message:'Reconnectez votre compte dans Zentra pour retrouver son adresse.'};
 try{
  const identity=(options.unprotect||dpapi)(await (options.read||readFile)(path.join(path.dirname(file),'installation-identity.dpapi')));
  let installationId;try{installationId=identity.toString('utf8').trim();}finally{identity.fill(0);}
  if(!installationId||session.installation_id!==installationId)return {connected:false,message:'L’ancienne connexion ne correspond pas à cette installation. Reconnectez le compte dans Zentra.'};
  const res=await (options.fetcher||fetch)('https://zentraapp.ch/api/account/me',{headers:{Authorization:'Bearer '+session.session_token},redirect:'manual',signal:AbortSignal.timeout(12000)});
  if(!res.ok)return {connected:false,message:'Le compte associé au PC doit être reconnecté dans Zentra.'};
  const body=await res.json();
  if(typeof body.email!=='string'||body.email.length>254||!body.email.includes('@')||body.organization?.id!==session.organization_id||body.installationId!==installationId)throw Error('Réponse invalide');
  return {connected:true,email:body.email,organizationName:String(body.organization.name||'').slice(0,160),organizationId:body.organization.id,role:body.organization.role};
 }catch{return {connected:false,message:'Impossible de vérifier le compte du PC pour le moment. Vous pouvez saisir un e-mail manuellement.'};}
 finally{session.session_token='';}
}
