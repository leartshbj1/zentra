// @vitest-environment jsdom
import React, { StrictMode, act, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({probe:vi.fn(),workspace:vi.fn(),access:vi.fn(),revalidate:vi.fn(),export:vi.fn(),diag:vi.fn(),inspect:vi.fn(),install:vi.fn(),remove:vi.fn(),cancel:vi.fn(),chat:vi.fn(),release:vi.fn(),unsubscribe:vi.fn(),progress:null as null|((value:{label:string})=>void),model:{phase:'missing',label:'',percent:null,error:'',deferred:false}}));
vi.mock('./diagnostics',async original=>({...await original<typeof import('./diagnostics')>(),diagnosticInvoke:state.probe,recordDiagnostic:state.diag,resolveErrorIncident:()=>({code:'ZT-BOUNDARY'}),diagnosticsApi:{export:state.export}}));
vi.mock('./bridge',()=>({desktopApi:{loadWorkspace:state.workspace}}));
vi.mock('./cloudAccessRevalidation',()=>({CLOUD_ACCESS_REVALIDATION_INTERVAL_MS:60000,cloudAccountChangeNeedsLicenseRefresh:()=>false,createSingleFlightCloudAccessRevalidator:()=>Object.assign(state.revalidate,{invalidate:vi.fn()}),readLocalCloudAccess:state.access,readCloudAccessForAccount:vi.fn()}));
vi.mock('./useMobileLayout',()=>({useMobileLayout:()=>{}}));
vi.mock('./AppUpdater',()=>({AppUpdater:()=>null}));
vi.mock('./BusinessProfileEditor',()=>({BusinessProfileGate:()=>null}));
vi.mock('./DevelopmentNotice',()=>({DevelopmentNotice:()=>null}));
vi.mock('./CloudAccountAccess',()=>({CloudAccountAccess:()=>null}));
vi.mock('./CompanyAccountGate',()=>({CompanyAccountGate:()=>null}));
vi.mock('./useFormDraft',()=>({FormDraftIdentityProvider:()=>null}));
vi.mock('./WorkspaceApp',()=>({WorkspaceApp:()=>null}));
vi.mock('./Onboarding',()=>({Onboarding:()=> <div data-normal-opening/>}));
vi.mock('./AutomationControls',()=>({useAutomation:()=>null}));
vi.mock('./localModelInstallation',()=>({localModelInstallation:{getSnapshot:()=>state.model,subscribe:()=>()=>{},inspect:state.inspect,install:state.install,remove:state.remove}}));
vi.mock('./payrollLocalAi',()=>({payrollLocalAi:{isBusy:()=>false,releaseIfIdle:state.release,cancel:state.cancel,chat:state.chat,onProgress:(listener:(value:{label:string})=>void)=>{state.progress=listener;return state.unsubscribe;}}}));
import './languageTestPacks';
import { App } from './App';
import { ZentraAssistantProvider } from './ZentraAssistant';
import { DiagnosticBoundary } from './DiagnosticBoundary';
import { LanguageBoot } from './LanguageStatus';
import { AssistantContext } from './assistantContext';
import { STARTUP_RECOVERY_REFUSAL, NATIVE_READY_EVENT } from './appOpening';
import { setAppLanguage } from './language';
let host:HTMLDivElement, root:Root, capturedOpen:(()=>void)|undefined;
function CaptureContext(){const context=useContext(AssistantContext);if(context)capturedOpen=context.open;return null;}
const mainTree=(app=true)=> <StrictMode><DiagnosticBoundary><LanguageBoot><ZentraAssistantProvider><CaptureContext/>{app&&<App/>}</ZentraAssistantProvider></LanguageBoot></DiagnosticBoundary></StrictMode>;
async function render(tree:React.ReactNode){await act(async()=>{root.render(tree);await Promise.resolve();});}
const noAssistant=()=>{expect(document.body.querySelector('.assistant-launcher')).toBeNull();expect(document.body.querySelector('.zentra-assistant-dialog')).toBeNull();expect(state.inspect).not.toHaveBeenCalled();expect(state.install).not.toHaveBeenCalled();expect(state.remove).not.toHaveBeenCalled();expect(state.chat).not.toHaveBeenCalled();};
const button=(text:string)=>Array.from(document.body.querySelectorAll('button')).find(x=>x.textContent?.includes(text))!;
async function open(){await act(async()=>{(document.body.querySelector('.assistant-launcher') as HTMLButtonElement).click();await Promise.resolve();});}
async function startPendingChat(){
 await open();const textarea=document.body.querySelector('textarea')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Question de génération détenue');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
}
function chatButton(label:'Arrêter la réponse'|'Fermer'){
 const node=Array.from(document.body.querySelectorAll('button')).find(x=>label==='Fermer'?x.getAttribute('aria-label')?.startsWith('Fermer « Assistant Zentra'):x.getAttribute('aria-label')===label);
 expect(node).toBeDefined();return node!;
}
function retainedClick(label:'Arrêter la réponse'|'Fermer'){
 const node=chatButton(label),prop=Object.keys(node).find(x=>x.startsWith('__reactProps$'))!;
 // Exercise the genuine queued React callback even after its DOM disconnects.
 return (node as any)[prop].onClick as ()=>void;
}
beforeEach(async()=>{
 vi.clearAllMocks();vi.useRealTimers();capturedOpen=undefined;state.progress=null;state.model={phase:'missing',label:'',percent:null,error:'',deferred:false};
 state.probe.mockRejectedValue(STARTUP_RECOVERY_REFUSAL);state.diag.mockReturnValue('BOOT-BOUNDARY');state.export.mockResolvedValue('D:/synthetic/diagnostics.jsonl');
 state.workspace.mockResolvedValue({onboardingCompleted:false,settings:null,workNotesScope:'synthetic'});state.access.mockResolvedValue({license:{status:'valid'},account:{status:'disconnected'}});state.revalidate.mockResolvedValue({license:{status:'valid'},account:{status:'disconnected'}});
 Object.assign(window,{__TAURI_INTERNALS__:{},__ZENTRA_NATIVE_READY__:false});(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 host=document.createElement('div');document.body.append(host);root=createRoot(host);await setAppLanguage('fr');
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();delete(window as any).__TAURI_INTERNALS__;delete(window as any).__ZENTRA_NATIVE_READY__;});
describe('actual Main wrappers close assistant admission',()=>{
 it.each([['fr','Récupération locale à terminer','Exporter le diagnostic'],['de','Lokale Wiederherstellung abschließen','Diagnose exportieren'],['it','Completare il ripristino locale','Esporta diagnostica'],['en','Complete local recovery','Export diagnostics']] as const)('same v1 bootstrap witness: recovery closes assistant in %s',async(language,title,label)=>{
  await setAppLanguage(language);await render(mainTree());expect(host.querySelector('h1')?.textContent).toBe(title);noAssistant();
  expect(state.workspace).not.toHaveBeenCalled();expect(state.access).not.toHaveBeenCalled();expect(state.revalidate).not.toHaveBeenCalled();
  await act(async()=>{window.dispatchEvent(new Event(NATIVE_READY_EVENT));await Promise.resolve();});noAssistant();
  expect(state.export).not.toHaveBeenCalled();await act(async()=>{button(label).click();await Promise.resolve();});expect(state.export).toHaveBeenCalledTimes(1);
  state.export.mockRejectedValueOnce(new Error('Export refusal token=SYNTHETIC_PRIVATE_VALUE'));await act(async()=>{button(label).click();await Promise.resolve();});
  expect(host.textContent).not.toContain('SYNTHETIC_PRIVATE_VALUE');expect(host.querySelectorAll('details')).toHaveLength(2);noAssistant();
 });
 it('same v1 bootstrap witness: unresolved native readiness starts no assistant effects',async()=>{
  vi.useFakeTimers();state.probe.mockImplementation(()=>new Promise(()=>{}));await render(mainTree());noAssistant();
  await act(async()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true}));window.dispatchEvent(new CustomEvent('zentra-automation-action',{detail:'create_invoice'}));await vi.advanceTimersByTimeAsync(60000);});noAssistant();expect(state.release).not.toHaveBeenCalled();
 });
 it.each(['workspace','access'] as const)('same v1 bootstrap witness: readiness alone does not admit assistant while %s is unresolved',async(which)=>{
  state.probe.mockResolvedValue(true);let finish!:(value:unknown)=>void;state[which].mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));await render(mainTree());noAssistant();
  await act(async()=>{finish(which==='workspace'?{onboardingCompleted:false,settings:null,workNotesScope:'synthetic'}:{license:{status:'valid'},account:{status:'disconnected'}});await Promise.resolve();});
  expect(document.body.querySelector('.assistant-launcher')).not.toBeNull();expect(state.inspect).not.toHaveBeenCalled();
 });
 it('same v1 bootstrap witness: business failure carrying sentinel cannot open assistant or recovery',async()=>{
  state.probe.mockResolvedValue(true);state.workspace.mockRejectedValue(STARTUP_RECOVERY_REFUSAL);await render(mainTree());expect(host.querySelector('[data-startup-recovery]')).toBeNull();noAssistant();
 });
 it('normal admitted bootstrap inspects and installs only after explicit clicks',async()=>{
  state.probe.mockResolvedValue(true);await render(mainTree());expect(document.body.querySelector('.assistant-launcher')).not.toBeNull();expect(state.inspect).not.toHaveBeenCalled();expect(state.probe.mock.calls.every(x=>x[0]==='is_native_ready')).toBe(true);expect(state.probe).toHaveBeenCalledTimes(2);
  await open();expect(state.inspect).toHaveBeenCalled();expect(state.install).not.toHaveBeenCalled();await act(async()=>button('Installer Qwen').click());expect(state.install).toHaveBeenCalledTimes(1);
 });
 it('captured open callback cannot inspect after App unmount or under a later recovery lifecycle',async()=>{
  state.probe.mockResolvedValue(true);await render(mainTree());const oldOpen=capturedOpen!;expect(oldOpen).toBeDefined();await render(mainTree(false));state.inspect.mockClear();
  await act(async()=>oldOpen());expect(state.inspect).not.toHaveBeenCalled();expect(document.body.querySelector('.assistant-launcher')).toBeNull();
  state.probe.mockRejectedValue(STARTUP_RECOVERY_REFUSAL);(window as any).__ZENTRA_NATIVE_READY__=false;await render(mainTree());await act(async()=>oldOpen());expect(state.inspect).not.toHaveBeenCalled();
 });
 it('owned chat is invalidated and its late progress chunks result and callbacks stay closed',async()=>{
  state.probe.mockResolvedValue(true);state.model={...state.model,phase:'installed'};let finish!:(value:unknown)=>void;let chunk!:(value:string)=>void;
  state.chat.mockImplementation((_:unknown,callback:(value:string)=>void)=>{chunk=callback;return new Promise(resolve=>{finish=resolve;});});await render(mainTree());await open();
  const textarea=document.body.querySelector('textarea')!;await act(async()=>{const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!;setter.call(textarea,'Question locale');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));expect(state.chat).toHaveBeenCalledTimes(1);const oldProgress=state.progress!;
  await render(mainTree(false));expect(state.cancel).not.toHaveBeenCalled();expect(state.chat.mock.calls[0][2]).toBeInstanceOf(AbortSignal);expect((state.chat.mock.calls[0][2] as AbortSignal).aborted).toBe(true);expect(state.unsubscribe).toHaveBeenCalled();
  await act(async()=>{oldProgress({label:'OBSOLETE_PROGRESS'});chunk('OBSOLETE_CHUNK');finish({output:'OBSOLETE_RESULT',source:'qwen'});await Promise.resolve();});
  expect(document.body.textContent).not.toContain('OBSOLETE');expect(document.body.querySelector('.zentra-assistant-dialog')).toBeNull();
 });
 it('normal admitted chat retains its output',async()=>{
  state.probe.mockResolvedValue(true);state.model={...state.model,phase:'installed'};state.chat.mockResolvedValue({output:'Réponse locale vérifiée',source:'qwen'});await render(mainTree());await open();
  const textarea=document.body.querySelector('textarea')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Ma question');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));expect(state.chat).toHaveBeenCalledTimes(1);expect(document.body.textContent).toContain('Réponse locale vérifiée');expect(state.cancel).not.toHaveBeenCalled();
 });
 it('normal admitted chat retains explicit stop without cancelling an unrelated idle worker',async()=>{
  state.probe.mockResolvedValue(true);state.model={...state.model,phase:'installed'};state.chat.mockImplementation(()=>new Promise(()=>{}));await render(mainTree());await open();
  const textarea=document.body.querySelector('textarea')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Ma question');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));expect(state.chat).toHaveBeenCalledTimes(1);
  await act(async()=>{(document.body.querySelector('button[aria-label="Arrêter la réponse"]') as HTMLButtonElement).click();});expect(state.cancel).not.toHaveBeenCalled();expect((state.chat.mock.calls[0][2] as AbortSignal).aborted).toBe(true);expect(document.body.textContent).toContain('Réponse interrompue');
  await render(mainTree(false));expect(state.cancel).not.toHaveBeenCalled();
 });
 it.each(['Arrêter la réponse','Fermer'] as const)('retained old %s callback cannot abort a newly admitted chat after App remount',async(label)=>{
  state.probe.mockResolvedValue(true);state.model={...state.model,phase:'installed'};state.chat.mockImplementation(()=>new Promise(()=>{}));
  await render(mainTree());await startPendingChat();expect(state.chat).toHaveBeenCalledTimes(1);const oldSignal=state.chat.mock.calls[0][2] as AbortSignal,callback=retainedClick(label);
  await render(mainTree(false));expect(oldSignal.aborted).toBe(true);await render(mainTree());await startPendingChat();expect(state.chat).toHaveBeenCalledTimes(2);const newSignal=state.chat.mock.calls[1][2] as AbortSignal;
  expect(newSignal).not.toBe(oldSignal);expect(newSignal.aborted).toBe(false);await act(async()=>callback());
  expect(newSignal.aborted).toBe(false);expect(document.body.querySelector('.zentra-assistant-dialog')).not.toBeNull();expect(chatButton('Arrêter la réponse')).toBeDefined();expect(state.cancel).not.toHaveBeenCalled();
 });
 it.each(['Arrêter la réponse','Fermer'] as const)('retained old %s callback cannot abort the successor chat under the same App permit',async(label)=>{
  state.probe.mockResolvedValue(true);state.model={...state.model,phase:'installed'};state.chat.mockImplementation(()=>new Promise(()=>{}));
  await render(mainTree());await startPendingChat();const oldSignal=state.chat.mock.calls[0][2] as AbortSignal,callback=retainedClick(label),probeCount=state.probe.mock.calls.length;
  await act(async()=>chatButton('Fermer').click());expect(oldSignal.aborted).toBe(true);await startPendingChat();const newSignal=state.chat.mock.calls[1][2] as AbortSignal;expect(newSignal.aborted).toBe(false);
  await act(async()=>callback());expect(newSignal.aborted).toBe(false);expect(document.body.querySelector('.zentra-assistant-dialog')).not.toBeNull();expect(chatButton('Arrêter la réponse')).toBeDefined();expect(state.probe).toHaveBeenCalledTimes(probeCount);expect(state.cancel).not.toHaveBeenCalled();
 });
 it('normal current Close aborts only its owned chat and preserves the next admitted chat',async()=>{
  state.probe.mockResolvedValue(true);state.model={...state.model,phase:'installed'};state.chat.mockImplementation(()=>new Promise(()=>{}));
  await render(mainTree());await startPendingChat();const first=state.chat.mock.calls[0][2] as AbortSignal;await act(async()=>chatButton('Fermer').click());expect(first.aborted).toBe(true);expect(document.body.querySelector('.zentra-assistant-dialog')).toBeNull();
  await startPendingChat();const second=state.chat.mock.calls[1][2] as AbortSignal;expect(second.aborted).toBe(false);await act(async()=>chatButton('Arrêter la réponse').click());expect(second.aborted).toBe(true);expect(document.body.querySelector('.zentra-assistant-dialog')).not.toBeNull();expect(state.cancel).not.toHaveBeenCalled();
 });
});
