import { invoke as nativeInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';
import { diagnosticIntentOperation } from './diagnosticIntent';

export type DiagnosticArea = 'app' | 'command' | 'navigation' | 'sync' | 'draft' | 'error' | 'export';
export type DiagnosticEvent = { id: string; sessionId: string; timestamp: string; area: DiagnosticArea; operation: string; phase: 'start'|'success'|'failure'|'info'; durationMs?: number; errorCode?: string };
export type DiagnosticsSummary = { sessionId: string; appVersion: string; platform: string; eventCount: number; fileCount: number; sizeBytes: number; maxFileBytes: number; maxFiles: number; firstEventAt: string|null; lastEventAt: string|null; lastIncident: DiagnosticEvent|null };
const uuid = () => globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n=Math.floor(Math.random()*16);return (c==='x'?n:(n&3)|8).toString(16); });
const sessionId=uuid();
const queue:DiagnosticEvent[]=[];
const recent:DiagnosticEvent[]=[];
let incidentObjects=new WeakMap<object,string>();
type StringIncident={sourceId:string;ambiguous:boolean;presentationId?:string};
const incidentStrings=new Map<string,StringIncident>();
let timer:ReturnType<typeof setTimeout>|undefined;
let flight:Promise<void>|undefined;
let suppressedUntil=0;
let clearing=0;
const isNative = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const codes=['NETWORK','SESSION','PERMISSION','CONFLICT','VALIDATION','STORAGE','NOT_FOUND','INTERNAL','UNHANDLED','RENDER','LOG_WRITE_FAILED'];

// Categorise in memory only. Neither messages, arguments nor responses enter the journal.
export function classifyDiagnosticError(error:unknown):string {
  let text='';try { text=typeof error==='string'?error:error instanceof Error?String(error.message):typeof error==='object'&&error&&'message' in error?String(error.message):''; }catch{/* hostile object */}
  if(/(?:network|fetch|offline|internet|réseau|timeout|timed out|connexion.*(?:perdue|impossible))/i.test(text))return 'NETWORK';
  if(/(?:401|unauth|session.*(?:expir|invalid)|connectez.*compte)/i.test(text))return 'SESSION';
  if(/(?:403|forbidden|permission|lecture seule|autorisé|accès refusé)/i.test(text))return 'PERMISSION';
  if(/(?:la connexion ou l[’']entreprise ouverte a changé\. rouvrez la réception\.|l[’']entreprise ouverte a changé\. rouvrez cette action dans le bon espace\.)/i.test(text))return 'CONFLICT';
  if(/(?:409|conflict|conflit|entre.temps|déjà.*enregistr|révision)/i.test(text))return 'CONFLICT';
  if(/(?:introuvable|not found|404)/i.test(text))return 'NOT_FOUND';
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

function rememberIncident(error:unknown,id:string){
  try{
    // Keep object identity before inspecting unknown JavaScript properties.
    if(error&&typeof error==='object')incidentObjects.set(error,id);
    const message=typeof error==='string'?error:error instanceof Error?error.message:undefined;
    if(message!==undefined){
      const key=incidentKey(message),previous=incidentStrings.get(key);
      // Native rejections are often strings. Equal messages from different
      // operations do not identify which failure an eventual UI message came from.
      if(previous){if(previous.sourceId!==id)previous.ambiguous=true;}
      else incidentStrings.set(key,{sourceId:id,ambiguous:false});
      if(incidentStrings.size>40)incidentStrings.delete(incidentStrings.keys().next().value!);
    }
  }catch{/* Best effort: an accessor or proxy must not replace the original error. */}
}
function incidentKey(message:string){let hash=2166136261;for(let i=0;i<message.length;i++)hash=Math.imul(hash^message.charCodeAt(i),16777619);return `${message.length}:${hash>>>0}`;}
export function resolveErrorIncident(error:unknown):{code:string}{
  const objectId=error&&typeof error==='object'?incidentObjects.get(error):undefined;
  if(objectId)return {code:`ZT-${objectId}`};
  const association=typeof error==='string'?incidentStrings.get(incidentKey(error)):undefined;
  if(association&&!association.ambiguous)return {code:`ZT-${association.sourceId}`};
  if(association?.presentationId)return {code:`ZT-${association.presentationId}`};
  const id=recordDiagnostic({area:'error',operation:'client.present_error',phase:'failure',errorCode:classifyDiagnosticError(error)});
  // A presentation incident honestly identifies the displayed error without
  // pretending an ambiguous string identifies one of the source operations.
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
  catch(error){recordDiagnostic({id,area,operation,phase:'failure',durationMs:performance.now()-started,errorCode:classifyDiagnosticError(error)});rememberIncident(error,id);throw error;}
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
  window.addEventListener('error',event=>{const id=recordDiagnostic({area:'error',operation:'client.window_error',phase:'failure',errorCode:'UNHANDLED'});rememberIncident(event.error,id);});
  window.addEventListener('unhandledrejection',event=>{const id=recordDiagnostic({area:'error',operation:'client.unhandled_rejection',phase:'failure',errorCode:'UNHANDLED'});rememberIncident(event.reason,id);});
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
      queue.length=0;recent.length=0;suppressedUntil=0;incidentObjects=new WeakMap<object,string>();incidentStrings.clear();
    }finally{clearing--;scheduleDiagnostics();}
  },
};
export function recentDiagnosticEvents():readonly DiagnosticEvent[]{return recent.map(event=>({...event}));}
