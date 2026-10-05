// @vitest-environment jsdom
import React, { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({probe:vi.fn(),inspect:vi.fn(),install:vi.fn(),remove:vi.fn(),cancel:vi.fn(),later:vi.fn(),open:vi.fn(),chat:vi.fn(),isBusy:vi.fn(),aiCancel:vi.fn(),foreignCancelled:vi.fn(),foreignActive:false,model:{phase:'missing',label:'',percent:null,error:'',deferred:false}}));
vi.mock('./diagnostics',async original=>({...await original<typeof import('./diagnostics')>(),diagnosticInvoke:state.probe}));
vi.mock('./localModelInstallation',()=>({localModelInstallation:{getSnapshot:()=>state.model,subscribe:()=>()=>{},inspect:state.inspect,install:state.install,remove:state.remove,cancel:state.cancel,later:state.later}}));
vi.mock('./payrollLocalAi',()=>({payrollLocalAi:{isBusy:state.isBusy,chat:state.chat,cancel:state.aiCancel,releaseIfIdle:()=>{},onProgress:()=>()=>{}}}));
import './languageTestPacks';
import { LocalAssistantSetup } from './LocalAssistantSetup';
import { AssistantContext } from './assistantContext';
import { ZentraAssistantProvider } from './ZentraAssistant';
import { beginAppOpeningAttempt, getAppOpeningPermit, isAppOpeningPermitCurrent, isStartupRecoveryFailure, STARTUP_RECOVERY_REFUSAL } from './appOpening';
let host:HTMLDivElement,root:Root;
const context={open:state.open,register:()=>{},remove:()=>{},setLauncherHost:()=>{}};
const element=()=> <StrictMode><AssistantContext.Provider value={context}><LocalAssistantSetup onboarding/></AssistantContext.Provider></StrictMode>;
async function mount(){await act(async()=>root.render(element()));}
async function admit(){const attempt=beginAppOpeningAttempt();await attempt.waitForNativeStartup();await act(async()=>attempt.complete());return attempt;}
// Capture the real React handler to exercise an already queued callback after
// its element is removed; disconnected DOM click delegation alone cannot do so.
function handler(label:string){const node=Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.includes(label))!;expect(node).toBeDefined();const key=Object.keys(node).find(x=>x.startsWith('__reactProps$'))!;return (node as any)[key].onClick as ()=>void;}
beforeEach(()=>{vi.clearAllMocks();state.foreignActive=false;state.aiCancel.mockImplementation(()=>{if(state.foreignActive)state.foreignCancelled();});state.isBusy.mockReturnValue(true);state.model={phase:'missing',label:'',percent:null,error:'',deferred:false};state.probe.mockResolvedValue(true);Object.assign(window,{__TAURI_INTERNALS__:{},__ZENTRA_NATIVE_READY__:false});(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete(window as any).__TAURI_INTERNALS__;delete(window as any).__ZENTRA_NATIVE_READY__;});
it.each(['missing','installed','installing'])('setup phase %s mounts no controls or inspection before admission',async(phase)=>{state.model={...state.model,phase};await mount();expect(host.children).toHaveLength(0);expect(state.inspect).not.toHaveBeenCalled();});
it('setup remains closed after exact native recovery refusal',async()=>{state.probe.mockRejectedValue(STARTUP_RECOVERY_REFUSAL);const attempt=beginAppOpeningAttempt();await attempt.waitForNativeStartup().catch(reason=>attempt.fail(reason));await mount();expect(host.children).toHaveLength(0);expect(state.inspect).not.toHaveBeenCalled();});
it.each([['missing','Installer Qwen','install'],['missing','Plus tard','later'],['installed','Désinstaller Qwen','remove'],['installed','Poser une question','open'],['installing','Annuler le téléchargement','cancel']] as const)('captured %s/%s callback refuses a new opening and a new ready generation',async(phase,label,method)=>{
 await admit();state.model={...state.model,phase};await mount();const callback=handler(label);state[method].mockClear();let next!:ReturnType<typeof beginAppOpeningAttempt>;await act(async()=>{next=beginAppOpeningAttempt();});
 await act(async()=>callback());expect(state[method]).not.toHaveBeenCalled();await next.waitForNativeStartup();await act(async()=>next.complete());await act(async()=>callback());expect(state[method]).not.toHaveBeenCalled();
});
it.each([['missing','Installer Qwen','install'],['missing','Plus tard','later'],['installed','Désinstaller Qwen','remove'],['installed','Poser une question','open'],['installing','Annuler le téléchargement','cancel']] as const)('normal admitted %s/%s remains explicit',async(phase,label,method)=>{await admit();state.model={...state.model,phase};await mount();expect(state.inspect).toHaveBeenCalledTimes(2);expect(state[method]).not.toHaveBeenCalled();await act(async()=>handler(label)());expect(state[method]).toHaveBeenCalledTimes(1);});
it('completion cannot grant a permit before actual native readiness and stale attempts cannot grant or clear it',async()=>{
 const first=beginAppOpeningAttempt();first.complete();expect(getAppOpeningPermit()).toBeNull();await first.waitForNativeStartup();
 const next=beginAppOpeningAttempt();first.complete();expect(getAppOpeningPermit()).toBeNull();await next.waitForNativeStartup();next.complete();const permit=getAppOpeningPermit();expect(permit).not.toBeNull();
 first.cancel();first.fail(new Error(STARTUP_RECOVERY_REFUSAL));expect(getAppOpeningPermit()).toBe(permit);expect(isAppOpeningPermitCurrent({} as typeof permit)).toBe(false);
});
it('genuine refusal stays closed after a forged late ready flag and remount without another probe',async()=>{
 state.probe.mockRejectedValue(STARTUP_RECOVERY_REFUSAL);const first=beginAppOpeningAttempt();const failure=await first.waitForNativeStartup().catch(reason=>reason);expect(isStartupRecoveryFailure(failure)).toBe(true);first.fail(failure);
 (window as any).__ZENTRA_NATIVE_READY__=true;const next=beginAppOpeningAttempt();expect(await next.waitForNativeStartup().catch(reason=>reason)).toBe(failure);next.complete();await mount();expect(host.children).toHaveLength(0);expect(state.inspect).not.toHaveBeenCalled();expect(state.probe).toHaveBeenCalledTimes(1);
});
it('a busy shared reader is never claimed or cancelled by an assistant that cannot start',async()=>{
 const attempt=await admit();state.model={...state.model,phase:'installed'};await act(async()=>root.render(<StrictMode><ZentraAssistantProvider><LocalAssistantSetup/></ZentraAssistantProvider></StrictMode>));
 await act(async()=>{(document.body.querySelector('.assistant-launcher') as HTMLButtonElement).click();});const textarea=document.body.querySelector('textarea')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Question locale');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));expect(state.chat).not.toHaveBeenCalled();expect(document.body.textContent).toContain('Qwen est déjà utilisé');
 await act(async()=>attempt.cancel());expect(state.aiCancel).not.toHaveBeenCalled();expect(document.body.querySelector('.zentra-assistant-dialog')).toBeNull();
});
it('resolved chat interleaved with a foreign reader is not globally cancelled by boot closure',async()=>{
 const attempt=await admit();state.model={...state.model,phase:'installed'};state.isBusy.mockReturnValue(false);let finish!:(value:unknown)=>void;state.chat.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 await act(async()=>root.render(<StrictMode><ZentraAssistantProvider><LocalAssistantSetup/></ZentraAssistantProvider></StrictMode>));await act(async()=>{(document.body.querySelector('.assistant-launcher') as HTMLButtonElement).click();});
 const textarea=document.body.querySelector('textarea')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Question locale');textarea.dispatchEvent(new Event('input',{bubbles:true}));});await act(async()=>textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));expect(state.chat).toHaveBeenCalledTimes(1);
 // The worker has removed/resolved its assistant request, but the UI await has
 // not resumed. A subsequent reader is now the owner of the shared engine.
 await act(async()=>{finish({output:'Réponse résolue',source:'qwen'});state.foreignActive=true;state.isBusy.mockReturnValue(true);attempt.cancel();await Promise.resolve();});
 expect(state.foreignCancelled).not.toHaveBeenCalled();expect(document.body.querySelector('.zentra-assistant-dialog')).toBeNull();
});
