import { invoke as nativeInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';
import { diagnosticIntentOperation } from './diagnosticIntent';
import { localValidationDetails } from './localValidation';

export type DiagnosticArea = 'app' | 'command' | 'navigation' | 'sync' | 'draft' | 'error' | 'export';
export type DiagnosticEvent = { id: string; sessionId: string; timestamp: string; area: DiagnosticArea; operation: string; phase: 'start'|'success'|'failure'|'info'; durationMs?: number; errorCode?: string };
export type DiagnosticsSummary = { sessionId: string; appVersion: string; platform: string; eventCount: number; fileCount: number; sizeBytes: number; maxFileBytes: number; maxFiles: number; firstEventAt: string|null; lastEventAt: string|null; lastIncident: DiagnosticEvent|null };
const uuid = () => globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n=Math.floor(Math.random()*16);return (c==='x'?n:(n&3)|8).toString(16); });
const sessionId=uuid();
const queue:DiagnosticEvent[]=[];
const recent:DiagnosticEvent[]=[];
type IncidentReference={id:string;source:boolean;ambiguous:boolean;presentationId?:string};
let incidentObjects=new WeakMap<object,IncidentReference>();
type StringIncident={sourceId:string;source:boolean;ambiguous:boolean;presentationId?:string};
// Exact primitive strings live only in this ephemeral, bounded map. They are
// never copied into events or exports. UTF-16 units bound retained key content;
// object identities remain weak references, independent of message size.
const MAX_STRING_INCIDENTS=40;
const MAX_STRING_INCIDENT_CHARS=4096;
const MAX_STRING_INCIDENT_TOTAL_CHARS=65536;
const incidentStrings=new Map<string,StringIncident>();
let incidentStringChars=0;
function stringIncident(error:unknown):StringIncident|undefined {
  return typeof error==='string'&&error.length<=MAX_STRING_INCIDENT_CHARS?incidentStrings.get(error):undefined;
}
function rememberStringIncident(message:string,id:string,source:boolean){
  if(message.length>MAX_STRING_INCIDENT_CHARS)return;
  const previous=incidentStrings.get(message);
  // Identical strings from different operations do not identify one source.
  if(previous){if(previous.sourceId!==id)previous.ambiguous=true;return;}
  while(incidentStrings.size>=MAX_STRING_INCIDENTS||incidentStringChars+message.length>MAX_STRING_INCIDENT_TOTAL_CHARS){
    const oldest=incidentStrings.keys().next().value;
    if(oldest===undefined)break;
    incidentStrings.delete(oldest);incidentStringChars-=oldest.length;
  }
  incidentStrings.set(message,{sourceId:id,source,ambiguous:false});incidentStringChars+=message.length;
}
let timer:ReturnType<typeof setTimeout>|undefined;
let flight:Promise<void>|undefined;
let suppressedUntil=0;
let clearing=0;
const isNative = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const codes=['NETWORK','SESSION','PERMISSION','CONFLICT','VALIDATION','STORAGE','NOT_FOUND','INTERNAL','UNHANDLED','RENDER','LOG_WRITE_FAILED'];

// Categorise in memory only. Neither messages, arguments nor responses enter the journal.
export function classifyDiagnosticError(error:unknown):string {
  if(localValidationDetails(error))return 'VALIDATION';
  let text='';try { text=typeof error==='string'?error:error instanceof Error?String(error.message):typeof error==='object'&&error&&'message' in error?String(error.message):''; }catch{/* hostile object */}
  // Do not treat a native invoice reference as an HTTP/session status.
  const nativeMessage=/^(?:erreur de base de données locale|erreur de fichier local|données json invalides|formulaire pdf invalide|archive zentra invalide|champ invalide|enregistrement introuvable|chemin refusé car il sort du dossier local autorisé)\s*:/i.test(text.trimStart());
  const statusText=nativeMessage?text.match(/\b(?:http(?:\/[\d.]+)?|status(?:\s+code)?)\s*[:=]?\s*(\d{3})\b/i)?.[1]||'':text;
  if(/(?:network|fetch|offline|internet|réseau|timeout|timed out|connexion.*(?:perdue|impossible))/i.test(text))return 'NETWORK';
  if(/401/.test(statusText)||/(?:unauth|session.*(?:expir|invalid)|connectez.*compte)/i.test(text))return 'SESSION';
  if(/403/.test(statusText)||/(?:forbidden|permission|lecture seule|autorisé|accès refusé)/i.test(text))return 'PERMISSION';
  const nativeContextMessage=text.trim().replace(/^champ invalide\s*:\s*/i,'').toLowerCase();
  if(nativeContextMessage==='le compte connecté a changé. rouvrez cette action avec le bon compte.'||nativeContextMessage==='le contexte local du compte doit être vérifié. rouvrez votre espace.')return 'CONFLICT';
  if(/(?:la connexion ou l[’']entreprise ouverte a changé\. rouvrez la réception\.|l[’']entreprise ouverte a changé\. rouvrez cette action dans le bon espace\.|l[’']espace de travail a changé pendant l[’']actualisation des réglages enregistrés\.)/i.test(text))return 'CONFLICT';
  if(/409/.test(statusText)||/(?:conflict|conflit|entre.temps|déjà.*enregistr|révision)/i.test(text))return 'CONFLICT';
  if(/404/.test(statusText)||/(?:introuvable|not found)/i.test(text))return 'NOT_FOUND';
  if(/(?:database|sqlite|disk|quota|storage|stockage|fichier local|base de données|enospc)/i.test(text))return 'STORAGE';
  if(/(?:invalide|invalid|obligatoire|required|renseignez|choisissez)/i.test(text))return 'VALIDATION';
  return 'INTERNAL';
}

export function recordDiagnostic(input:Omit<DiagnosticEvent,'id'|'sessionId'|'timestamp'> & {id?:string}):string {
  const id=input.id&&/^[a-f0-9-]{36}$/i.test(input.id)?input.id:uuid();
  if(!['app','command','navigation','sync','draft','error','export'].includes(input.area)||!/^[a-zA-Z0-9_.-]{1,80}$/.test(input.operation)||!['start','success','failure','info'].includes(input.phase))return id;
  const event:DiagnosticEvent={id,sessionId,timestamp:new Date().toISOString(),area:input.area,operation:input.operation,phase:input.phase};
  if(Number.isFinite(input.durationMs)&&input.durationMs!>=0)event.durationMs=Math.min(86400000,Math.round(input.durationMs!));
  if(input.errorCode&&codes.includes(input.errorCode))event.errorCode=input.errorCode;
  recent.push(event);if(recent.length>300)recent.shift();
  if(isNative()){queue.push(event);if(queue.length>500)queue.shift();scheduleDiagnostics();}
  return id;
}

function cancelDiagnosticTimer(){if(timer!==undefined)clearTimeout(timer);timer=undefined;}
function scheduleDiagnostics(){
  if(timer!==undefined||flight||clearing||!queue.length||!isNative())return;
  timer=setTimeout(()=>{timer=undefined;void flushDiagnostics();},Math.max(300,suppressedUntil-Date.now()));
}

function rememberIncident(error:unknown,id:string,source=false){
  try{
    // Keep object identity before inspecting unknown JavaScript properties.
    if(error&&typeof error==='object'){
      const previous=incidentObjects.get(error);
      if(previous){if(previous.id!==id)previous.ambiguous=true;}
      else incidentObjects.set(error,{id,source,ambiguous:false});
    }
    const message=typeof error==='string'?error:error instanceof Error?error.message:undefined;
    if(typeof message==='string')rememberStringIncident(message,id,source);
  }catch{/* Best effort: an accessor or proxy must not replace the original error. */}
}
/** Read an already known incident only. Never inspect messages, causes or getters. */
export function knownErrorIncident(error:unknown):{code:string}|undefined {
  const object=error&&typeof error==='object'?incidentObjects.get(error):undefined;
  if(object){const id=object.ambiguous?object.presentationId:object.id;return id?{code:`ZT-${id}`}:undefined;}
  const string=stringIncident(error);
  if(string){const id=string.ambiguous?string.presentationId:string.sourceId;return id?{code:`ZT-${id}`}:undefined;}
  return undefined;
}

/** Explicit wrapper boundary only. A known presentation is not a source failure,
 * and multiple failures never authorize choosing the latest or first source. */
export function withKnownErrorIncident<T extends object>(wrapper:T,source:unknown):T {
  if(incidentObjects.has(wrapper))return wrapper;
  const object=source&&typeof source==='object'?incidentObjects.get(source):undefined;
  const string=stringIncident(source);
  const reference=object??(string?{id:string.sourceId,source:string.source,ambiguous:string.ambiguous}:undefined);
  if(reference?.source&&!reference.ambiguous)incidentObjects.set(wrapper,{id:reference.id,source:true,ambiguous:false});
  return wrapper;
}

export function resolveErrorIncident(error:unknown):{code:string}{
  const known=knownErrorIncident(error);if(known)return known;
  const object=error&&typeof error==='object'?incidentObjects.get(error):undefined;
  const association=stringIncident(error);
  const id=recordDiagnostic({area:'error',operation:'client.present_error',phase:'failure',errorCode:classifyDiagnosticError(error)});
  // A presentation honestly identifies what was displayed. It does not identify
  // which command failed when a primitive string or an Error object was reused.
  if(object){object.presentationId=id;return {code:`ZT-${id}`};}
  if(association){association.presentationId=id;return {code:`ZT-${id}`};}
  rememberIncident(error,id);return {code:`ZT-${id}`};
}

export async function flushDiagnostics(force=false):Promise<void>{
  if(!isNative())return;
  if(flight)return flight;
  if(clearing)return;
  if(!force&&Date.now()<suppressedUntil){scheduleDiagnostics();return;}
  cancelDiagnosticTimer();
  flight=(async()=>{
    while(queue.length){
      const batch=queue.splice(0,100);
      try{await nativeInvoke('append_diagnostic_events',{events:batch});suppressedUntil=0;}
      catch{queue.unshift(...batch);if(queue.length>500)queue.splice(0,queue.length-500);suppressedUntil=Date.now()+30000;break;}
    }
  })();
  try{await flight;}finally{flight=undefined;scheduleDiagnostics();}
}

// The caller supplies a fixed operation name. This wrapper receives neither
// arguments nor results for logging, including for native plugin operations.
export async function diagnosticOperation<T>(area:DiagnosticArea,operation:string,call:()=>Promise<T>):Promise<T>{
  const started=performance.now();const id=recordDiagnostic({area,operation,phase:'start'});
  try{const value=await call();recordDiagnostic({id,area,operation,phase:'success',durationMs:performance.now()-started});return value;}
  catch(error){recordDiagnostic({id,area,operation,phase:'failure',durationMs:performance.now()-started,errorCode:classifyDiagnosticError(error)});rememberIncident(error,id,true);throw error;}
}

export async function diagnosticInvoke<T>(command:string,args?:InvokeArgs,options?:InvokeOptions):Promise<T>{
  const call = () => options !== undefined ? nativeInvoke<T>(command,args,options) : args !== undefined ? nativeInvoke<T>(command,args) : nativeInvoke<T>(command);
  // Diagnostics commands are never recursively diagnosed. Do not add args/result here.
  if(['append_diagnostic_events','get_diagnostics_summary','export_diagnostics','clear_diagnostics','get_form_draft_identity'].includes(command))return call();
  // Only this registered plugin command gets a fixed log name. Its transport
  // name and input remain unchanged; arbitrary plugin strings stay rejected.
  const operation=diagnosticIntentOperation(command,args) ?? (command==='plugin:zentra-mobile|configure_navigation'?'plugin.zentra_mobile.configure_navigation':command);
  return diagnosticOperation('command',operation,call);
}

let installed=false;
export function installDiagnosticCapture(){
  if(installed||typeof window==='undefined')return;installed=true;
  recordDiagnostic({area:'app',operation:'client.startup',phase:'start'});
  window.addEventListener('error',event=>{const id=recordDiagnostic({area:'error',operation:'client.window_error',phase:'failure',errorCode:'UNHANDLED'});rememberIncident(event.error,id,true);});
  window.addEventListener('unhandledrejection',event=>{const id=recordDiagnostic({area:'error',operation:'client.unhandled_rejection',phase:'failure',errorCode:'UNHANDLED'});rememberIncident(event.reason,id,true);});
  window.addEventListener('online',()=>recordDiagnostic({area:'sync',operation:'network.online',phase:'info'}));
  window.addEventListener('offline',()=>recordDiagnostic({area:'sync',operation:'network.offline',phase:'info'}));
  window.addEventListener('pagehide',()=>{recordDiagnostic({area:'app',operation:'client.pagehide',phase:'info'});void flushDiagnostics();});
  document.addEventListener('visibilitychange',()=>{recordDiagnostic({area:'app',operation:document.visibilityState==='visible'?'client.visible':'client.hidden',phase:'info'});void flushDiagnostics();});
}
export const diagnosticsApi={
  async summary(){await flushDiagnostics(true);return nativeInvoke<DiagnosticsSummary>('get_diagnostics_summary');},
  async export(){await flushDiagnostics(true);if(queue.length)throw new Error('Le diagnostic récent ne peut pas être conservé. Vérifiez le stockage de cet appareil puis réessayez l’export.');return nativeInvoke<string>('export_diagnostics');},
  async clear(){
    clearing++;cancelDiagnosticTimer();
    try{
      // Wait for writes already admitted, then pause retries until clearing ends.
      if(flight)await flight;
      await nativeInvoke('clear_diagnostics');
      queue.length=0;recent.length=0;suppressedUntil=0;incidentObjects=new WeakMap<object,IncidentReference>();incidentStrings.clear();incidentStringChars=0;
    }finally{clearing--;scheduleDiagnostics();}
  },
};
export function recentDiagnosticEvents():readonly DiagnosticEvent[]{return recent.map(event=>({...event}));}
