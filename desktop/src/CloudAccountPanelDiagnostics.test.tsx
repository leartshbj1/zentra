// @vitest-environment jsdom
import './languageTestPacks';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:transport.invoke,Channel:class{},isTauri:()=>false,convertFileSrc:(v:string)=>v}));
// These connected-only siblings never participate in the pending-code scene.
vi.mock('./CloudTeamPanel',()=>({CloudTeamPanel:()=>null}));
vi.mock('./NativeSubscription',()=>({NativeSubscription:()=>null}));
import {CloudAccountPanel} from './CloudAccountPanel';
import {knownErrorIncident,recentDiagnosticEvents} from './diagnostics';
import {setAppLanguage} from './language';
import {userErrorCopy} from './userErrors';
import type {AppLanguage} from './language';
let root:Root|null=null,container:HTMLDivElement;
const code='PRIVATE_AUTHORIZATION_CODE', pending={status:'pending',userCode:code,authorizationExpiresAt:'2099-10-04T12:00:00Z',intervalSeconds:300};
const ids=()=>new Set(recentDiagnosticEvents().map(event=>event.id));
const fresh=(before:Set<string>)=>recentDiagnosticEvents().filter(event=>!before.has(event.id));
async function settle(){await act(async()=>{for(let i=0;i<20;i++)await Promise.resolve();});}
async function open(){root=createRoot(container);await act(async()=>root!.render(<CloudAccountPanel setup/>));await settle();expect(container.textContent).toContain(code);}
function copyButton(){const found=Array.from(container.querySelectorAll('button')).find(button=>button.textContent?.includes('Copier le code')||button.textContent?.includes('Code kopieren')||button.textContent?.includes('Copia il codice')||button.textContent?.includes('Copy code'));expect(found).toBeDefined();return found!;}
beforeEach(()=>{vi.useFakeTimers();transport.invoke.mockReset();transport.invoke.mockImplementation(async(command:string)=>{if(command==='get_cached_cloud_account_state'||command==='get_cloud_account_state')return pending;throw Error(`Closed IPC: ${command}`);});container=document.createElement('div');document.body.append(container);Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});});
afterEach(async()=>{if(root){await act(async()=>root!.unmount());root=null;}container.remove();vi.clearAllTimers();vi.useRealTimers();await setAppLanguage('fr');vi.unstubAllGlobals();});
describe('real pending account panel clipboard diagnostics',()=>{
  it.each(['fr','de','it','en'] as const)('links clipboard denial to the original operation and keeps an honest copy guide in %s',async(language:AppLanguage)=>{
    await setAppLanguage(language);const original=Error('PRIVATE clipboard denial private-synthetic@example.invalid'),writeText=vi.fn().mockRejectedValue(original);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
    await open();const before=ids(),calls=transport.invoke.mock.calls.length;await act(async()=>copyButton().click());await settle();
    const events=fresh(before);expect(events.map(event=>[event.operation,event.phase])).toEqual([['account.copy_authorization_code','start'],['account.copy_authorization_code','failure']]);
    expect(events[1].durationMs).toBeGreaterThanOrEqual(0);expect(writeText).toHaveBeenCalledExactlyOnceWith(code);expect(transport.invoke.mock.calls.slice(calls)).toEqual([]);
    const incident=`ZT-${events[1].id}`;expect(knownErrorIncident(original)?.code).toBe(incident);expect(container.querySelector('.error-guidance__incident code')?.textContent).toBe(incident);
    expect(container.querySelector('[role=alert]')?.textContent).toContain(userErrorCopy(language).copyFailed);
    expect(container.querySelector('[role=alert]')?.textContent).not.toContain(userErrorCopy(language).validation.title);expect(container.querySelector('[role=alert]')?.textContent).not.toContain(userErrorCopy(language).uncertain);
    expect(copyButton().disabled).toBe(false);expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|private-synthetic/);expect(container.textContent).not.toContain(original.message);
  });
  it('keeps the successful copy and records only its duration and fixed operation',async()=>{
    const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});await open();const before=ids(),calls=transport.invoke.mock.calls.length;await act(async()=>copyButton().click());await settle();
    const events=fresh(before);expect(events.map(event=>[event.operation,event.phase])).toEqual([['account.copy_authorization_code','start'],['account.copy_authorization_code','success']]);expect(events[1].durationMs).toBeGreaterThanOrEqual(0);expect(container.textContent).toContain('Code copié');expect(writeText).toHaveBeenCalledExactlyOnceWith(code);expect(transport.invoke.mock.calls.slice(calls)).toEqual([]);expect(JSON.stringify(events)).not.toContain(code);
  });
});
