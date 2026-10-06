// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutomationRunRow, type AutomationCentreState } from './AutomationControlCentre';
import { AutomationHub } from './AutomationHub';
import type { AutomationState } from './automation';
import type { Workspace } from './types';

const mock=vi.hoisted(()=>({language:'fr',company:{} as Record<string,unknown>,invoke:vi.fn()}));
vi.mock('./language',()=>({useAppLanguage:()=>mock.language,t:(text:string)=>text}));
vi.mock('./AutomationCompany',()=>({useCompanyAutomation:()=>mock.company}));
vi.mock('./diagnostics',()=>({diagnosticInvoke:mock.invoke}));

const ticketA='7418f947-06af-4dfb-84d0-0f2eae5fb946';
const ticketB='b8c6975a-6f44-4b15-a579-068b072d95f1';
const run:AutomationCentreState['runs'][number]={
  id:'workflow-a',sourceId:ticketA,title:'Demande Atelier Exemple',state:'review',revision:7,attempts:0,
  createdAt:1790180000,updatedAt:1790180000,dueAt:0,
  definition:{trigger:'email_classified',mode:'suggest',threshold:.95,conditions:{category:'after_sales',priority:'',sender:'',attachment:false},decision:null,actions:[]},
  result:{choice:'yes',summary:{subject:'Question reçue',sender:'client@example.test',excerpts:[{text:'Extrait à préserver'}],attachments:[],truncated:true}},
};
const mounted:{root:Root;host:HTMLDivElement}[]=[];
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  mock.language='fr';mock.invoke.mockReset();
});
afterEach(async()=>{
  for(const {root,host} of mounted.splice(0)){await act(async()=>root.unmount());host.remove();}
  vi.unstubAllGlobals();
});
async function mount(element:React.ReactNode){
  const host=document.createElement('div');document.body.append(host);
  const root=createRoot(host);mounted.push({root,host});
  await act(async()=>root.render(element));
  return {root,host};
}
const messageButton=(host:HTMLElement)=>host.querySelector<HTMLButtonElement>('.automation-journal__direct button')!;

it('opens the source of the chosen run without executing a workflow action',async()=>{
  const open=vi.fn().mockResolvedValue('https://zentraapp.ch/support/espace');const actWorkflow=vi.fn();
  const {host}=await mount(<AutomationRunRow run={run} canManage busy={false} act={actWorkflow} onOpenSourceMessage={open} quickMessage/>);
  await act(async()=>messageButton(host).click());
  expect(open).toHaveBeenCalledExactlyOnceWith(ticketA);
  expect(actWorkflow).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLDetailsElement>('.ac-source')?.open).toBe(false);
});

it.each([undefined,null,'','unknown','7418f94706af4dfb84d00f2eae5fb946',`${ticketA}&organizationId=other`,'00000000-0000-0000-0000-000000000000'])('keeps excerpts available without launching an invalid/absent source (%s)',async sourceId=>{
  const open=vi.fn();
  const {host}=await mount(<AutomationRunRow run={{...run,sourceId}} canManage={false} busy={false} act={vi.fn()} onOpenSourceMessage={open} quickMessage/>);
  expect(messageButton(host).textContent).toBe('Message reçu');
  await act(async()=>messageButton(host).click());
  expect(open).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLDetailsElement>('.ac-run')?.open).toBe(true);
  expect(host.querySelector<HTMLDetailsElement>('.ac-source')?.open).toBe(true);
  expect(document.activeElement).toBe(host.querySelector('.ac-source summary'));
  expect(host.textContent).toContain('Extrait à préserver');
});

it('falls back to excerpts when the source callback is unavailable',async()=>{
  const {host}=await mount(<AutomationRunRow run={run} canManage={false} busy={false} act={vi.fn()} quickMessage/>);
  await act(async()=>messageButton(host).click());
  expect(host.querySelector<HTMLDetailsElement>('.ac-source')?.open).toBe(true);
});

it('can open a valid source before a summary is available and offers no false excerpt fallback',async()=>{
  const open=vi.fn().mockRejectedValue(new Error('private native detail'));
  const {host}=await mount(<AutomationRunRow run={{...run,result:{}}} canManage={false} busy={false} act={vi.fn()} onOpenSourceMessage={open} quickMessage/>);
  await act(async()=>messageButton(host).click());
  expect(open).toHaveBeenCalledExactlyOnceWith(ticketA);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Réessayez ou ouvrez votre boîte de réception Support');
  expect(host.textContent).not.toContain('private native detail');
});

it('prevents repeated taps while the external opening is pending',async()=>{
  let complete!:()=>void;
  const open=vi.fn(()=>new Promise<void>(resolve=>{complete=resolve;}));
  const {host}=await mount(<AutomationRunRow run={run} canManage={false} busy={false} act={vi.fn()} onOpenSourceMessage={open} quickMessage/>);
  const button=messageButton(host);
  await act(async()=>{button.click();button.click();});
  expect(open).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);expect(button.getAttribute('aria-busy')).toBe('true');
  await act(async()=>complete());
  expect(button.disabled).toBe(false);expect(button.hasAttribute('aria-busy')).toBe(false);
});

it('explains an opening failure and focuses the preserved excerpts without leaking an error',async()=>{
  const open=vi.fn().mockRejectedValue(new Error('zds_private_token'));
  const {host}=await mount(<AutomationRunRow run={run} canManage={false} busy={false} act={vi.fn()} onOpenSourceMessage={open} quickMessage/>);
  await act(async()=>messageButton(host).click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Vous pouvez consulter les extraits');
  expect(host.querySelector<HTMLDetailsElement>('.ac-source')?.open).toBe(true);
  expect(document.activeElement).toBe(host.querySelector('.ac-source summary'));
  expect(host.textContent).not.toContain('zds_private_token');
});

it('does not show a previous run opening failure on a replacement run',async()=>{
  let fail!:(reason:Error)=>void;
  const open=vi.fn(()=>new Promise<void>((_,reject)=>{fail=reject;}));
  const {host,root}=await mount(<AutomationRunRow run={run} canManage={false} busy={false} act={vi.fn()} onOpenSourceMessage={open} quickMessage/>);
  await act(async()=>messageButton(host).click());
  await act(async()=>root.render(<AutomationRunRow run={{...run,id:'workflow-b',sourceId:ticketB}} canManage={false} busy={false} act={vi.fn()} onOpenSourceMessage={open} quickMessage/>));
  await act(async()=>fail(new Error('stale failure')));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(messageButton(host).disabled).toBe(false);
  expect(open).toHaveBeenCalledExactlyOnceWith(ticketA);
});

it.each([
  ['fr','Ouvrir le message dans Support'],['de','Nachricht in Support öffnen'],
  ['it','Apri il messaggio in Support'],['en','Open message in Support'],
])('localizes the direct source action in %s',async(language,text)=>{
  mock.language=language;
  const {host}=await mount(<AutomationRunRow run={run} canManage={false} busy={false} act={vi.fn()} onOpenSourceMessage={vi.fn()} quickMessage/>);
  expect(messageButton(host).textContent).toBe(text);
  expect(host.textContent).toContain('Question reçue');
});

it('routes a message from the real Hub journal to the native command for that ticket only',async()=>{
  const state:AutomationState={organizationId:'org_fictitious',active:true,canManage:true,available:['document_routing'],settings:{enabled:true,consent:true,mode:'suggest',flags:['document_routing'],thresholds:{medium:.75,high:.95}}};
  mock.company={state,status:'ready',refresh:vi.fn(),readOnly:false};
  const second={...run,id:'workflow-b',sourceId:ticketB,title:'Demande Client B',updatedAt:1790181000};
  mock.invoke.mockImplementation(async(command:string)=>{
    if(command==='automation_request')return {organizationId:state.organizationId,canManage:true,canWork:true,rules:[],runs:[run,second],items:[],templates:[],members:[]};
    if(command==='open_supplier_inbox_settings')return 'https://zentraapp.ch/support/espace';
    throw new Error('Unexpected native command');
  });
  const workspace={invoices:[],settings:{organization:{legalName:'Entreprise Exemple'}}} as unknown as Workspace;
  const {host}=await mount(<AutomationHub workspace={workspace} page="overview" onPage={vi.fn()} onNavigate={vi.fn()}/>);
  const entries=[...host.querySelectorAll<HTMLElement>('.automation-journal__entry')];
  const selected=entries.find(entry=>entry.textContent?.includes('Demande Client B'))!;
  expect(selected).toBeDefined();
  await act(async()=>messageButton(selected).click());
  expect(mock.invoke.mock.calls.filter(([command])=>command==='open_supplier_inbox_settings')).toEqual([
    ['open_supplier_inbox_settings',{section:'inbox',ticketId:ticketB}],
  ]);
  expect(mock.invoke.mock.calls.filter(([command])=>command==='automation_request')).toHaveLength(1);
});
