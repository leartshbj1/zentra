import { useCallback,useEffect,useRef,useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktopApi } from './bridge';
import type { Workspace } from './types';
export type MailInvoice={id:string;organizationId:string;fileName:string;mediaType:string;sha256:string;sender:string;subject:string;state:string;invoiceId:string|null;automatic:boolean;otherDevice:boolean;createdAt:number;extraction:{supplierName:string|null;reference:string|null;invoiceDate:string|null;dueDate:string|null;currency:string|null;netCents:number|null;vatCents:number|null;totalCents:number|null;vatBp:number|null;category:string|null;confidence:number;issues:string[];evidence:Record<string,string>}};
export type SupplierInboxState={organizationId:string;linked:boolean;autoPost:boolean;automationActive:boolean;items:MailInvoice[]};
export type InboxDraft={supplier_id:string;date:string;due_date:string;reference:string;items:{description:string;quantity_milli:number;unit_price_cents:number;vat_bp:number;category:string;expense_account_id:string|null}[]};
export const inboxRequest=<T,>(data:unknown=null)=>invoke<T>('supplier_inbox_request',{data});
export function pendingMailInvoices(state:SupplierInboxState|null){return state?.items.filter(i=>!['imported','ignored'].includes(i.state))||[];}
export function useSupplierInbox(org:string|null,readOnly:boolean,blocked:()=>boolean,onWorkspace:(w:Workspace)=>void){
  const [state,setState]=useState<SupplierInboxState|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const current=useRef({org,blocked,onWorkspace});current.current={org,blocked,onWorkspace};
  const running=useRef(false);
  const refresh=useCallback(async()=>{
    if(!org||running.current||document.visibilityState==='hidden'||!navigator.onLine)return;
    running.current=true;
    try{
      const value=await inboxRequest<SupplierInboxState>();
      if(current.current.org!==org||value.organizationId!==org)return;
      setState(value);setError('');
      if(!readOnly&&!current.current.blocked()){
        const next=value.items.find(i=>!i.otherDevice&&(i.state==='processing'||(value.autoPost&&i.state==='ready')));
        if(next){
          const saved=await inboxRequest<{saved?:boolean;id:string;alreadyImported?:boolean}>({action:'import',id:next.id,automatic:next.state==='ready'});
          if(current.current.org!==org)return;
          if(saved.saved){const workspace=await desktopApi.loadWorkspace();if(current.current.org===org)current.current.onWorkspace(workspace);window.dispatchEvent(new Event('zentra-automation-updated'));}
          const updated=await inboxRequest<SupplierInboxState>();if(current.current.org===org&&updated.organizationId===org)setState(updated);
        }
      }
    }catch(reason){if(current.current.org===org)setError(String(reason instanceof Error?reason.message:reason));}
    finally{running.current=false;}
  },[org,readOnly]);
  useEffect(()=>{
    setState(null);setError('');void refresh();
    const resume=()=>void refresh();const timer=window.setInterval(resume,20000);
    window.addEventListener('online',resume);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);
    return()=>{clearInterval(timer);window.removeEventListener('online',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};
  },[refresh]);
  const importInvoice=async(item:MailInvoice,invoice:InboxDraft)=>{
    if(readOnly||running.current)throw Error('Attendez la fin de la réception en cours.');
    running.current=true;setBusy(true);
    try{
      const result=await inboxRequest<{saved?:boolean;id:string;alreadyImported?:boolean}>({action:'import',id:item.id,invoice,automatic:false});
      if(current.current.org!==org)throw Error('L’entreprise a changé.');
      const workspace=await desktopApi.loadWorkspace();if(current.current.org!==org)throw Error('L’entreprise a changé.');
      current.current.onWorkspace(workspace);window.dispatchEvent(new Event('zentra-automation-updated'));
      return {id:result.id,workspace};
    }finally{running.current=false;setBusy(false);void refresh();}
  };
  return {state,error,busy,refresh,importInvoice};
}
