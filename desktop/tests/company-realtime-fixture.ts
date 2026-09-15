// Synthetic native transport, with the real bridge, scheduler and dashboard.
import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';

export function installCompanyRealtimeFixture(data: Workspace, synchronize: typeof desktopApi.syncProjectDocuments) {
  let revision=1, received=1;
  let remote=structuredClone(data);
  let local=structuredClone(data);
  let invoiceSequence=0;
  let heldApply:Promise<void>|null=null;
  let finishApply:((fail?:boolean)=>void)|null=null;
  const calls: {command:string;at:number}[]=[];
  const state=()=>({enabled:true,organizationId:'synthetic-company',revision:received,pending:false,conflict:false,ready:revision>received});
  Object.assign(window,{
    __TAURI_INTERNALS__:{transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string)=>{
      calls.push({command,at:Date.now()});
      if(command==='get_company_sync_state'||command==='sync_company_workspace')return state();
      if(command==='apply_company_update'){
        if(heldApply){const hold=heldApply;heldApply=null;await hold;}
        await new Promise(resolve=>setTimeout(resolve,100));
        local=structuredClone(remote);received=revision;return {...state(),changed:true};
      }
      if(command==='watch_company_workspace')return {enabled:false,revision:received};
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected native fixture call: ${command}`);
    }},
    companyRealtimeFixture:{calls,
      issue:()=>{invoiceSequence++;const invoice=structuredClone(remote.invoices[0]);invoice.id=`phone-invoice-${invoiceSequence}`;invoice.number=`F-2026-${999+invoiceSequence}`;invoice.title='Facture créée sur iPhone';invoice.status='issued';invoice.lines=[{...invoice.lines[0],id:`phone-line-${invoiceSequence}`,quantity:1,unitPriceCents:100000,vatBp:0,discountBp:0}];remote.invoices.push(invoice);revision++;},
      pay:()=>{remote.payments.push({id:`phone-payment-${revision}`,invoiceId:`phone-invoice-${invoiceSequence}`,amountCents:25000,date:'2026-09-15',method:'bank',reference:'TEST',notes:''});revision++;},
      holdNextApply:()=>{heldApply=new Promise<void>((resolve,reject)=>{finishApply=(fail=false)=>{finishApply=null;fail?reject(new Error('Synthetic interrupted reception')):resolve();};});},
      finishApply:(fail=false)=>finishApply?.(fail),
      snapshot:()=>structuredClone(remote),
    },
  });
  desktopApi.getProjectSyncStatus=async()=>({mode:'business',pending:0,syncing:false,connected:true,documents:[]});
  desktopApi.loadWorkspace=async()=>structuredClone(local);
  desktopApi.syncProjectDocuments=synchronize;
}
