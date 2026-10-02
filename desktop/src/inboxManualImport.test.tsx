import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {diagnosticInvoke} from './diagnostics';
import {desktopApi} from './bridge';
import {useSupplierInbox,type InboxDraft,type MailInvoice,type SupplierInboxState} from './supplierInbox';
import {useAppointmentInbox,type AppointmentInboxState} from './AppointmentInbox';

vi.mock('./diagnostics',()=>({diagnosticInvoke:vi.fn()}));
vi.mock('./bridge',()=>({desktopApi:{loadWorkspace:vi.fn()}}));

const supplierState:SupplierInboxState={organizationId:'synthetic-org',linked:true,autoPost:false,automationActive:true,items:[]};
const appointmentState:AppointmentInboxState={organizationId:'synthetic-org',active:true,automatic:false,items:[]};
const invoice={id:'synthetic-mail',organizationId:'synthetic-org'} as MailInvoice;
const draft={supplier_id:'synthetic-supplier',date:'2026-10-02',due_date:'2026-11-02',reference:'SYN',items:[]} satisfies InboxDraft;
const invoke=vi.mocked(diagnosticInvoke),load=vi.mocked(desktopApi.loadWorkspace);

// Real React executes the actual hook handlers here, with synthetic SDK calls.
// SSR does not run lifetime effects: scope changes/unmount/modal publication
// are covered separately by inbox-manual-lifecycle.mjs in Edge and WebKit.
function handlers(readOnly=false,refreshWorkspace?:()=>Promise<void>){
  let supplier!:ReturnType<typeof useSupplierInbox>,appointment!:ReturnType<typeof useAppointmentInbox>;
  const publish=vi.fn();
  function Probe(){
    supplier=useSupplierInbox('synthetic-org',readOnly,()=>false,publish,refreshWorkspace,'synthetic-scope');
    appointment=useAppointmentInbox('synthetic-org',readOnly,()=>false,publish,refreshWorkspace,'synthetic-scope');
    return null;
  }
  renderToStaticMarkup(<Probe/>);
  return{supplier,appointment,publish};
}
beforeEach(()=>{
  vi.clearAllMocks();
  vi.stubGlobal('window',{dispatchEvent:vi.fn()});
  vi.stubGlobal('document',{visibilityState:'visible'});
  vi.stubGlobal('navigator',{onLine:true});
  invoke.mockImplementation(async(command,args)=>{
    if((args as {data?:{action?:string}})?.data?.action)return{id:'synthetic-mail',saved:true,posted:true};
    return command==='supplier_inbox_request'?supplierState:appointmentState;
  });
  load.mockRejectedValue(new Error('Synthetic read failure after saved import'));
});
afterEach(()=>vi.unstubAllGlobals());

describe('individual inbox imports keep their native receipt',()=>{
  it('returns the posted supplier receipt when reconciliation fails without repeating the import',async()=>{
    const refresh=vi.fn().mockRejectedValue(new Error('Synthetic reconciliation failure'));
    const {supplier,publish}=handlers(false,refresh);
    await expect(supplier.importInvoice(invoice,draft,true)).resolves.toEqual({id:'synthetic-mail',posted:true,current:true});
    expect(refresh).toHaveBeenCalledTimes(1);expect(load).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter(([,args])=>(args as {data?:{action?:string}})?.data?.action==='import')).toHaveLength(1);
  });
  it('does not invent draft or posted status for an already-imported receipt',async()=>{
    invoke.mockImplementation(async(command,args)=>((args as {data?:unknown})?.data
      ?{id:'synthetic-mail',alreadyImported:true}:command==='supplier_inbox_request'?supplierState:appointmentState));
    const {supplier}=handlers(false,async()=>{});
    await expect(supplier.importInvoice(invoice,draft)).resolves.toMatchObject({id:'synthetic-mail',posted:undefined,current:true});
    expect(load).not.toHaveBeenCalled();
  });
  it('returns before a slow reconciliation so the supplier form can close',async()=>{
    const refresh=vi.fn(()=>new Promise<void>(()=>{}));
    const {supplier}=handlers(false,refresh);
    await expect(supplier.importInvoice(invoice,draft,true)).resolves.toMatchObject({id:'synthetic-mail',posted:true});
    expect(refresh).toHaveBeenCalledTimes(1);expect(load).not.toHaveBeenCalled();
  });
  it('keeps an appointment confirmation when its read fails',async()=>{
    const refresh=vi.fn().mockRejectedValue(new Error('Synthetic reconciliation failure'));
    const {appointment,publish}=handlers(false,refresh);
    await expect(appointment.act({action:'import',id:'synthetic-mail',event:{},automatic:false})).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);expect(load).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter(([,args])=>(args as {data?:{action?:string}})?.data?.action==='import')).toHaveLength(1);
  });
  it.each(['supplier','appointment'] as const)('also preserves the %s receipt with the standalone read fallback',async type=>{
    const {supplier,appointment,publish}=handlers();
    const result=type==='supplier'?supplier.importInvoice(invoice,draft,true):appointment.act({action:'import',id:'synthetic-mail'});
    if(type==='supplier')await expect(result).resolves.toMatchObject({id:'synthetic-mail',posted:true});
    else await expect(result).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);expect(publish).not.toHaveBeenCalled();
  });
  it.each(['supplier','appointment'] as const)('preserves a %s native rejection and never reconciles or retries it',async type=>{
    const reason=new Error('Synthetic native refusal'),refresh=vi.fn(async()=>{});
    invoke.mockImplementation(async(command,args)=>{
      if((args as {data?:{action?:string}})?.data?.action==='import')throw reason;
      return command==='supplier_inbox_request'?supplierState:appointmentState;
    });
    const {supplier,appointment}=handlers(false,refresh);
    await expect(type==='supplier'?supplier.importInvoice(invoice,draft):appointment.act({action:'import',id:'synthetic-mail'})).rejects.toBe(reason);
    expect(refresh).not.toHaveBeenCalled();expect(load).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter(([,args])=>(args as {data?:{action?:string}})?.data?.action==='import')).toHaveLength(1);
  });
  it.each(['supplier','appointment'] as const)('refuses a %s write in read-only mode before IPC',async type=>{
    const {supplier,appointment}=handlers(true,async()=>{});
    await expect(type==='supplier'?supplier.importInvoice(invoice,draft):appointment.act({action:'import',id:'synthetic-mail'})).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();expect(load).not.toHaveBeenCalled();
  });
  it('refuses a supplier item from a different organization before IPC',async()=>{
    const {supplier}=handlers(false,async()=>{});
    await expect(supplier.importInvoice({...invoice,organizationId:'synthetic-other'},draft)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
