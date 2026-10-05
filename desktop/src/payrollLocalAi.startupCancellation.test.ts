import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const controls=vi.hoisted(()=>({invoke:vi.fn(async()=>undefined)}));
vi.mock('@tauri-apps/api/core',()=>({invoke:controls.invoke}));
import { diagnosticsApi, flushDiagnostics, recentDiagnosticEvents } from './diagnostics';
import { payrollLocalAi, PAYROLL_ENGINE_CHECK_TIMEOUT_MS, PAYROLL_MODEL_LOAD_TIMEOUT_MS, PAYROLL_ANALYSIS_STALL_TIMEOUT_MS } from './payrollLocalAi';

// The actual singleton and its public methods/message listeners run. This
// inert Worker does not load Qwen, decode documents, fetch assets or run WASM.
class SyntheticWorker {
 static instances:SyntheticWorker[]=[];
 static postError:unknown;
 terminated=0;
 messages:Array<Record<string,unknown>>=[];
 listeners=new Map<string,Array<(event:{data?:Record<string,unknown>;message?:string})=>void>>();
 constructor(){SyntheticWorker.instances.push(this);}
 addEventListener(name:string,listener:(event:{data?:Record<string,unknown>;message?:string})=>void){this.listeners.set(name,[...(this.listeners.get(name)??[]),listener]);}
 postMessage(value:Record<string,unknown>){if(SyntheticWorker.postError!==undefined)throw SyntheticWorker.postError;this.messages.push(value);}
 terminate(){this.terminated++;}
 emit(value:Record<string,unknown>){this.listeners.get('message')?.forEach(listener=>listener({data:value}));}
 fail(name='error'){this.listeners.get(name)?.forEach(listener=>listener({message:'Synthetic worker failure token=PRIVATE_WORKER_VALUE'}));}
}
const input={question:'PRIVATE_QUESTION',screen:'PRIVATE_SCREEN',facts:{synthetic:'PRIVATE_FACT'},history:[]};
const worker=()=>SyntheticWorker.instances.at(-1)!;
const request=(type:string)=>worker().messages.find(x=>x.type===type)!;
const finishChat=()=>worker().emit({type:'assistant_result',requestId:request('assistant_chat').requestId,output:'PRIVATE_OUTPUT',source:'guide'});
const finishAnalysis=()=>worker().emit({type:'analysis',requestId:request('analyze').requestId,primaryOutput:'first',verifiedOutput:'second',mode:'wasm'});
const events=()=>recentDiagnosticEvents().filter(x=>x.operation==='assistant.local_chat');
beforeEach(async()=>{
 vi.useFakeTimers();await diagnosticsApi.clear();controls.invoke.mockClear();
 vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});vi.stubGlobal('Worker',SyntheticWorker);SyntheticWorker.instances=[];SyntheticWorker.postError=undefined;
});
afterEach(async()=>{payrollLocalAi.cancel();await flushDiagnostics(true);vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('scoped cancellation through actual local AI public APIs',()=>{
 it('already aborted signal creates no Worker or request timer',async()=>{
  const controller=new AbortController();controller.abort();const remove=vi.spyOn(controller.signal,'removeEventListener');await expect(payrollLocalAi.chat(input,()=>{},controller.signal)).rejects.toThrow('Analyse locale annulée');
  expect(SyntheticWorker.instances).toHaveLength(0);expect(payrollLocalAi.isBusy()).toBe(false);expect(remove).not.toHaveBeenCalled();await flushDiagnostics(true);expect(vi.getTimerCount()).toBe(0);expect(events().map(x=>x.phase)).toEqual(['start','info']);
 });
 it('pending owned request abort rejects only it and double abort removes listener once',async()=>{
  const controller=new AbortController(),remove=vi.spyOn(controller.signal,'removeEventListener'),chunks=vi.fn();const response=payrollLocalAi.chat(input,chunks,controller.signal);const rejected=response.catch(reason=>reason);const own=worker(),id=request('assistant_chat').requestId;
  controller.abort();controller.abort();expect(await rejected).toBeInstanceOf(Error);expect(own.terminated).toBe(1);expect(payrollLocalAi.isBusy()).toBe(false);expect(remove).toHaveBeenCalledTimes(1);
  own.emit({type:'assistant_chunk',requestId:id,output:'OBSOLETE'});expect(chunks).not.toHaveBeenCalled();expect(events().map(x=>x.phase)).toEqual(['start','info']);
 });
 it('already aborted chat does not create another Worker or interrupt an active document load',async()=>{
  const load=payrollLocalAi.load(),foreign=worker(),controller=new AbortController();controller.abort();await expect(payrollLocalAi.chat(input,()=>{},controller.signal)).rejects.toThrow('Analyse locale annulée');
  expect(SyntheticWorker.instances).toHaveLength(1);expect(foreign.terminated).toBe(0);expect(payrollLocalAi.isBusy()).toBe(true);foreign.emit({type:'ready',mode:'wasm'});await expect(load).resolves.toBe('wasm');
 });
 it('exact interleaving: handleMessage retires chat then a foreign analysis starts before UI await/abort',async()=>{
  const controller=new AbortController(),remove=vi.spyOn(controller.signal,'removeEventListener');const response=payrollLocalAi.chat(input,()=>{},controller.signal);const own=worker();
  finishChat();const foreign=payrollLocalAi.analyze({extractedText:'synthetic document'});controller.abort();expect(own.terminated).toBe(0);expect(payrollLocalAi.isBusy()).toBe(true);expect(remove).toHaveBeenCalledTimes(1);
  finishAnalysis();await expect(foreign).resolves.toMatchObject({rawOutput:'second',primaryRawOutput:'first',verifiedRawOutput:'second',passes:2,mode:'wasm'});await expect(response).resolves.toMatchObject({output:'PRIVATE_OUTPUT',source:'guide'});expect(payrollLocalAi.isBusy()).toBe(false);
 });
 it('completed chat abort preserves a subsequent documentary model load and its historical15min limit',async()=>{
  const controller=new AbortController();const response=payrollLocalAi.chat(input,()=>{},controller.signal);finishChat();const load=payrollLocalAi.load(),own=worker();controller.abort();expect(own.terminated).toBe(0);expect(payrollLocalAi.isBusy()).toBe(true);expect(PAYROLL_MODEL_LOAD_TIMEOUT_MS).toBe(900000);
  own.emit({type:'ready',mode:'webgpu'});await expect(load).resolves.toBe('webgpu');await response;
 });
 it('owned chat abort retains a concurrent public checkWaiter',async()=>{
  const controller=new AbortController();const response=payrollLocalAi.chat(input,()=>{},controller.signal),rejected=response.catch(reason=>reason);const check=payrollLocalAi.check(),own=worker();controller.abort();expect(own.terminated).toBe(0);expect(await rejected).toBeInstanceOf(Error);
  own.emit({type:'check',mode:'wasm'});await expect(check).resolves.toBe('wasm');expect(PAYROLL_ENGINE_CHECK_TIMEOUT_MS).toBe(15000);
 });
 it('cancelled physical chat with a foreign checkWaiter blocks analysis until actual finish',async()=>{
  const check=payrollLocalAi.check(),controller=new AbortController(),chunks=vi.fn();const chat=payrollLocalAi.chat(input,chunks,controller.signal),rejected=chat.catch(reason=>reason),own=worker(),id=request('assistant_chat').requestId;controller.abort();await rejected;
  const analysis=payrollLocalAi.analyze({extractedText:'must not run concurrently'}).catch(reason=>reason);expect(own.messages.filter(x=>x.type==='analyze')).toHaveLength(0);expect(payrollLocalAi.isBusy()).toBe(true);expect(await analysis).toBeInstanceOf(Error);
  own.emit({type:'assistant_chunk',requestId:id,output:'OBSOLETE'});expect(chunks).not.toHaveBeenCalled();finishChat();expect(payrollLocalAi.isBusy()).toBe(false);expect(own.terminated).toBe(0);
  const after=payrollLocalAi.analyze({extractedText:'after physical finish'});expect(own.messages.filter(x=>x.type==='analyze')).toHaveLength(1);finishAnalysis();await after;own.emit({type:'check',mode:'wasm'});await expect(check).resolves.toBe('wasm');expect(payrollLocalAi.isBusy()).toBe(false);
 });
 it('last foreign check finishes without cancellation then safely retires physical chat before a new reader',async()=>{
  const check=payrollLocalAi.check(),controller=new AbortController(),remove=vi.spyOn(controller.signal,'removeEventListener');const chat=payrollLocalAi.chat(input,()=>{},controller.signal),rejected=chat.catch(reason=>reason),old=worker(),id=request('assistant_chat').requestId;
  controller.abort();await rejected;expect(old.terminated).toBe(0);expect(payrollLocalAi.isBusy()).toBe(true);old.emit({type:'check',mode:'webgpu'});await expect(check).resolves.toBe('webgpu');expect(old.terminated).toBe(1);expect(payrollLocalAi.isBusy()).toBe(false);expect(remove).toHaveBeenCalledTimes(1);
  const after=payrollLocalAi.analyze({extractedText:'after safe termination'}),fresh=worker();expect(fresh).not.toBe(old);controller.signal.dispatchEvent(new Event('abort'));old.emit({type:'assistant_result',requestId:id,output:'OBSOLETE'});expect(fresh.terminated).toBe(0);expect(payrollLocalAi.isBusy()).toBe(true);finishAnalysis();await after;await flushDiagnostics(true);expect(vi.getTimerCount()).toBe(0);
 });
 it.each(['error','messageerror'])('retained cancelled physical chat %s clears ownership and preserves later reader',async(kind)=>{
  const check=payrollLocalAi.check(),controller=new AbortController(),remove=vi.spyOn(controller.signal,'removeEventListener');const chat=payrollLocalAi.chat(input,()=>{},controller.signal),rejected=chat.catch(reason=>reason),old=worker();controller.abort();await rejected;old.fail(kind);
  await expect(check).resolves.toBe('unavailable');expect(old.terminated).toBe(1);expect(payrollLocalAi.isBusy()).toBe(false);expect(remove).toHaveBeenCalledTimes(1);const after=payrollLocalAi.analyze({extractedText:'after failed physical chat'}),fresh=worker();controller.abort();expect(fresh.terminated).toBe(0);finishAnalysis();await after;
 });
 it('foreign check keeps its historical15s timeout while cancelled chat remains physically busy',async()=>{
  const check=payrollLocalAi.check(),controller=new AbortController();const chat=payrollLocalAi.chat(input,()=>{},controller.signal),rejected=chat.catch(reason=>reason),old=worker();controller.abort();await rejected;
  await vi.advanceTimersByTimeAsync(PAYROLL_ENGINE_CHECK_TIMEOUT_MS-1);expect(old.terminated).toBe(0);expect(payrollLocalAi.isBusy()).toBe(true);await expect(payrollLocalAi.load()).rejects.toThrow('Qwen est déjà utilisé');await vi.advanceTimersByTimeAsync(1);await expect(check).resolves.toBe('unavailable');expect(old.terminated).toBe(1);expect(payrollLocalAi.isBusy()).toBe(false);
  const after=payrollLocalAi.analyze({extractedText:'after original check deadline'}),fresh=worker();expect(fresh).not.toBe(old);finishAnalysis();await after;
 });
 it('old signal cannot terminate a replacement Worker or a new reader generation',async()=>{
  const controller=new AbortController();const ownChat=payrollLocalAi.chat(input,()=>{},controller.signal),rejected=ownChat.catch(reason=>reason),old=worker();controller.abort();await rejected;
  const foreign=payrollLocalAi.analyze({extractedText:'new synthetic reader'}),fresh=worker();expect(fresh).not.toBe(old);controller.abort();controller.signal.dispatchEvent(new Event('abort'));expect(fresh.terminated).toBe(0);finishAnalysis();await foreign;
 });
 it.each(['assistant_error','error','messageerror'])('listener cleanup on %s preserves a later reader after old abort',async(kind)=>{
  const controller=new AbortController(),remove=vi.spyOn(controller.signal,'removeEventListener');const response=payrollLocalAi.chat(input,()=>{},controller.signal),rejected=response.catch(reason=>reason);
  if(kind==='assistant_error')worker().emit({type:kind,requestId:request('assistant_chat').requestId,error:'Synthetic chat failure token=PRIVATE_ERROR'});else worker().fail(kind);
  await rejected;expect(remove).toHaveBeenCalledTimes(1);const foreign=payrollLocalAi.analyze({extractedText:'synthetic reader after failure'}),fresh=worker(),before=fresh.terminated;controller.abort();expect(fresh.terminated).toBe(before);finishAnalysis();await foreign;
 });
 it('postMessage failure preserves original rejection and removes the abort listener',async()=>{
  const controller=new AbortController(),remove=vi.spyOn(controller.signal,'removeEventListener'),original=new Error('Synthetic post failure');SyntheticWorker.postError=original;await expect(payrollLocalAi.chat(input,()=>{},controller.signal)).rejects.toBe(original);expect(remove).toHaveBeenCalledTimes(1);SyntheticWorker.postError=undefined;
  const foreign=payrollLocalAi.analyze({extractedText:'synthetic post reader'}),own=worker();controller.abort();expect(own.terminated).toBe(0);finishAnalysis();await foreign;
 });
 it('chat timeout remains180s and cleanup prevents old abort from terminating new analysis',async()=>{
  const controller=new AbortController(),remove=vi.spyOn(controller.signal,'removeEventListener');const response=payrollLocalAi.chat(input,()=>{},controller.signal),rejected=response.catch(reason=>reason),old=worker();
  await vi.advanceTimersByTimeAsync(179999);expect(old.terminated).toBe(0);await vi.advanceTimersByTimeAsync(1);expect(await rejected).toBeInstanceOf(Error);expect(old.terminated).toBe(1);expect(remove).toHaveBeenCalledTimes(1);
  const foreign=payrollLocalAi.analyze({extractedText:'synthetic reader after timeout'}),fresh=worker();controller.abort();expect(fresh.terminated).toBe(0);finishAnalysis();await foreign;expect(PAYROLL_ANALYSIS_STALL_TIMEOUT_MS).toBe(900000);
 });
 it('historical no-signal chat keeps output shape and redacted diagnostics',async()=>{
  const chunks=vi.fn(),response=payrollLocalAi.chat(input,chunks);worker().emit({type:'assistant_chunk',requestId:request('assistant_chat').requestId,output:'PRIVATE_CHUNK'});finishChat();await expect(response).resolves.toEqual({output:'PRIVATE_OUTPUT',truncated:false,source:'guide'});expect(chunks).toHaveBeenCalledWith('PRIVATE_CHUNK');expect(events().map(x=>x.phase)).toEqual(['start','success']);
  await flushDiagnostics(true);expect(JSON.stringify({events:events(),journal:controls.invoke.mock.calls})).not.toMatch(/PRIVATE_QUESTION|PRIVATE_SCREEN|PRIVATE_FACT|PRIVATE_OUTPUT|PRIVATE_CHUNK/);
 });
});
