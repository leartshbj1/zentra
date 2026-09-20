import {sign,verify,createPublicKey,createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {unlink} from 'node:fs/promises';
import path from 'node:path';
import {rawPublic} from './vault.mjs';
import {PlatformBackend,desktopAccount} from './platform.mjs';

const PUBLIC='FySkIPXpEIfZ9UCBlXuhFAgFx3LpchgBFWTh65Aa040';
const licenseKey=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:PUBLIC},format:'jwk'});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields=['token_version','license_id','installation_id','jti','kid','customer_name','access_role','account_user_id','account_session_id','plan','price_chf_cents','issued_at','valid_from','valid_until'];
const pendingFile='founder-pending-access.dpapi';
const sha=value=>createHash('sha256').update(value).digest('hex');
const day=ms=>new Date(ms).toISOString().slice(0,10);
const binding=p=>sha(p.license_id+':'+p.installation_id);
const result=(token,payload)=>({token,payload,binding:binding(payload),fingerprint:sha(token)});
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||day(Date.parse(value+'T00:00:00Z'))!==value)throw Error('Date invalide.');return value;}
export function validatePayload(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k)))throw Error('Contenu de licence invalide.');
  const p={...input,access_role:input.access_role??'owner',account_user_id:input.account_user_id??null,account_session_id:input.account_session_id??null};
  const prices={'zentra-monthly-50-chf':5000,'elyko-monthly-50-chf':5000,'helvichantier-monthly-50-chf':5000,'zentra-solo-monthly-49-chf':4900,'zentra-start-monthly-59-chf':5900,'zentra-pro-monthly-89-chf':8900};
  if(p.token_version!==2||p.kid!=='hc-prod-v1'||!UUID.test(p.license_id?.slice(4))||!p.license_id?.startsWith('lic_')||!UUID.test(p.installation_id)||!UUID.test(p.jti)||!Object.hasOwn(prices,p.plan)||prices[p.plan]!==p.price_chf_cents||!['owner','admin','accountant','member','read_only'].includes(p.access_role))throw Error('Cette licence n’est pas compatible avec Zentra.');
  if((p.customer_name!==null&&typeof p.customer_name!=='string')||typeof p.issued_at!=='string'||!Number.isFinite(Date.parse(p.issued_at)))throw Error('Contenu de licence incomplet.');
  if(p.account_user_id!==null||p.account_session_id!==null){if(typeof p.account_user_id!=='string'||!p.account_user_id.trim()||p.account_user_id.length>255||typeof p.account_session_id!=='string'||!p.account_session_id.startsWith('dss_')||!UUID.test(p.account_session_id.slice(4)))throw Error('Liaison au compte invalide.');}
  if(date(p.valid_until)<date(p.valid_from))throw Error('Dates de validité incohérentes.');return p;
}
export function verifyToken(token){
  if(typeof token!=='string'||token.length<100||token.length>8192)throw Error('Taille de jeton invalide.');
  const parts=token.trim().split('.');
  if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0])||!/^[A-Za-z0-9_-]{86}$/.test(parts[1])||!verify(null,Buffer.from(parts[0]),licenseKey,Buffer.from(parts[1],'base64url')))throw Error('Signature de jeton invalide.');
  return validatePayload(JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')));
}
export function validateAction(a){
  if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!['operation','email','duration','customDate','operationId','expectedRevision','note','product','plan','organizationId'].includes(k))||!['lookup','list','grant','revoke','reassign'].includes(a.operation))throw Error('Commande d’accès invalide.');
  if(a.product!==undefined&&!['support','automation'].includes(a.product))throw Error('Produit inconnu.');
  if(a.organizationId!==undefined&&(a.product!=='automation'||!['grant','reassign'].includes(a.operation)||typeof a.organizationId!=='string'||!/^[a-zA-Z0-9_-]{1,255}$/.test(a.organizationId)))throw Error('Entreprise invalide.');
  if(a.plan!==undefined&&(a.product!=='support'||a.operation!=='grant'))throw Error('Formule inattendue.');
  if(a.product==='support'&&a.operation==='grant'&&!['starter','team','business'].includes(a.plan))throw Error('Choisissez une formule Zentra Support.');
  if(a.operation!=='list'&&(typeof a.email!=='string'||a.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)))throw Error('Saisissez une adresse e-mail complète.');
  if(a.operation==='reassign'&&(a.product!=='automation'||!a.organizationId||a.duration!==undefined||a.customDate!==undefined))throw Error('Correction d’entreprise invalide.');
  if(writes(a)){
    if(!UUID.test(a.operationId)||!Number.isSafeInteger(a.expectedRevision)||a.expectedRevision<0||typeof a.note!=='string'||a.note.length>300||a.note.split('').some(c=>c.charCodeAt(0)<32))throw Error('Vérifiez le compte avant de modifier son accès.');
    if(a.operation==='grant'&&!['14_days','one_month','custom'].includes(a.duration))throw Error('Durée invalide.');
  }return a;
}
const writes=a=>['grant','revoke','reassign'].includes(a.operation);
export function envelope(action,key){validateAction(action);const payload=Buffer.from(JSON.stringify({version:1,timestamp:Math.floor(Date.now()/1000),nonce:randomUUID(),action})).toString('base64url');return {payload,signature:sign(null,Buffer.from('zentra-founder-access-v1\n'+payload),key).toString('base64url')};}
async function post(url,body,max=262144){
  const response=await fetch(url,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>max)throw Error('Réponse trop volumineuse.');chunks.push(chunk);}return {status:response.status,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
}
export class Backend {
  constructor(vault,options={}){this.vault=vault;this.post=options.post||post;this.platform=new PlatformBackend(vault,this.post);this.tail=Promise.resolve();}
  invoke(command,args={}){const next=this.tail.then(()=>this.dispatch(command,args));this.tail=next.catch(()=>{});return next;}
  async pending(){try{const clear=await this.vault.read(pendingFile);try{return validateAction(JSON.parse(clear.toString('utf8')));}finally{clear.fill(0);}}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async founderStatus(){try{await this.vault.key('admin');return {ready:true,message:'Clé personnelle protégée par Windows',pending:await this.pending()};}catch{return {ready:false,message:'Le coffre Windows ou la clé personnelle est indisponible.',pending:null};}}
  async founderRequest(action){
    validateAction(action);const request=envelope(action,await this.vault.key('admin'));
    if(writes(action)) {const pending=await this.pending();if(pending&&!isDeepStrictEqual(pending,action))throw Error('Une demande attend sa confirmation. Reprenez-la avant de modifier un autre accès.');const bytes=Buffer.from(JSON.stringify(action));try{await this.vault.write(pendingFile,bytes);}finally{bytes.fill(0);}}
    let response;try{response=await this.post('https://www.zentraapp.ch/api/founder/access',request);}catch{throw Error('Connexion interrompue. Si une demande est en attente, reprenez-la pour connaître le résultat.');}
    if((response.status===200||[400,401,403,404,409,422].includes(response.status))&&writes(action))await unlink(path.join(this.vault.root,pendingFile));
    if(response.status!==200)throw Error(typeof response.body?.error==='string'?response.body.error.slice(0,500):'Le service Zentra est momentanément indisponible.');return response.body;
  }
  async devices(){const devices=[];let unreadable=0;for(const reference of await this.vault.tokens()){try{const payload=verifyToken(await this.vault.token(reference));const previous=devices.findIndex(d=>binding(d.payload)===binding(payload));if(previous<0)devices.push({reference,payload});else if(payload.issued_at>devices[previous].payload.issued_at)devices[previous]={reference,payload};}catch{unreadable++;}}devices.sort((a,b)=>b.payload.issued_at.localeCompare(a.payload.issued_at));return {devices,unreadable};}
  async licenseSigner(){const key=await this.vault.key('license');if(rawPublic(key)!==PUBLIC)throw Error('La clé ne correspond pas aux applications Zentra.');return key;}
  async prepare(source){
    if(typeof source!=='string'||source.length>8192)throw Error('Contenu trop volumineux.');source=source.trim();const {devices}=await this.devices();let payload;let sourceKind;
    if(UUID.test(source)){
      const matches=devices.filter(d=>d.payload.installation_id.toLowerCase()===source.toLowerCase());if(matches.length>1)throw Error('Choisissez le jeton précis de cet appareil dans la liste.');
      payload=matches[0]?.payload||{token_version:2,license_id:'lic_'+randomUUID(),installation_id:source.toLowerCase(),jti:randomUUID(),kid:'hc-prod-v1',customer_name:'Licence propriétaire Zentra',access_role:'owner',account_user_id:null,account_session_id:null,plan:'zentra-monthly-50-chf',price_chf_cents:5000,issued_at:new Date().toISOString(),valid_from:day(Date.now()-86400000),valid_until:'2036-12-31'};sourceKind='installation';
    }else if(source.startsWith('{')){payload=validatePayload(JSON.parse(source));sourceKind='payload';}
    else if(source.includes('.')){payload=verifyToken(source);sourceKind='signed';}
    else{payload=validatePayload(JSON.parse(Buffer.from(source,'base64url').toString('utf8')));sourceKind='payload';}
    return {payload,sourceKind,knownDevice:devices.some(d=>binding(d.payload)===binding(payload))};
  }
  async save(token,payload){const bytes=Buffer.from(token);try{await this.vault.write('signed-'+binding(payload)+'.dpapi',bytes);}finally{bytes.fill(0);}}
  async issue(request){
    const preview=await this.prepare(request.source);const expected=validatePayload(request.expectedPayload);let canonical={...preview.payload};
    if(preview.sourceKind==='installation'&&!preview.knownDevice)canonical={...canonical,license_id:expected.license_id,jti:expected.jti,issued_at:expected.issued_at};
    if(!isDeepStrictEqual(canonical,expected))throw Error('Le contenu a changé depuis l’aperçu. Relisez-le avant de signer.');
    if(date(request.validUntil)<day(Date.now())||request.validUntil>'2099-12-31'||typeof request.customerName!=='string'||request.customerName.length>120)throw Error('Nom ou échéance invalide.');
    const payload=validatePayload({...expected,customer_name:request.customerName.trim(),valid_until:request.validUntil,valid_from:day(Date.now()-86400000),issued_at:new Date().toISOString(),jti:randomUUID()});
    const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');const token=encoded+'.'+sign(null,Buffer.from(encoded),await this.licenseSigner()).toString('base64url');verifyToken(token);await this.save(token,payload);return result(token,payload);
  }
  async check(token){
    const candidate=verifyToken(token);let response;try{response=await this.post('https://elyko.alb-leart1.chatgpt.site/api/stripe/refresh',{token},16384);}catch{return {accepted:false,status:'offline',message:'Serveur injoignable. La signature locale est valide, mais l’activation n’a pas été vérifiée.',signed:null};}
    if(response.status!==200)return {accepted:false,status:response.status===403?'unrecognized':'unavailable',message:response.status===403?'Le serveur refuse cette activation. Vérifiez son autorisation avant de l’installer.':'Le serveur ne peut pas valider ce jeton actuellement.',signed:null};
    const payload=verifyToken(response.body.token);if(payload.license_id!==candidate.license_id||payload.installation_id!==candidate.installation_id||payload.valid_from>day(Date.now())||payload.valid_until<day(Date.now()))throw Error('La licence renvoyée ne correspond pas à cet appareil ou à la date actuelle.');
    await this.save(response.body.token,payload);return {accepted:true,status:'accepted',message:'Le serveur Zentra accepte ce jeton pour cet appareil.',signed:result(response.body.token,payload)};
  }
  async dispatch(command,args){
    switch(command){
      case 'desktop_account':return desktopAccount();
      case 'platform_status':return this.platform.status();
      case 'platform_request':return this.platform.request(args.action);
      case 'platform_retry':return this.platform.retry();
      case 'founder_status':return this.founderStatus();
      case 'founder_request':return this.founderRequest(args.action);
      case 'status':{let keyReady=true;let keyMessage='Clé Zentra vérifiée · protégée par Windows';try{await this.licenseSigner();}catch{keyReady=false;keyMessage='La clé des licences n’est pas disponible.';}return {keyReady,keyMessage,...await this.devices()};}
      case 'load_token':{const token=await this.vault.token(args.reference);verifyToken(token);return token;}
      case 'inspect':return this.prepare(args.source);
      case 'sign_token':return this.issue(args.request);
      case 'verify_activation':return this.check(args.token);
      default:throw Error('Commande inconnue.');
    }
  }
}
