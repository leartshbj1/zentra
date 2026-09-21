// Local synthetic workflow: calls the production batch runner, never the company database.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SupplierInbox } from '../src/SupplierInboxPanel';
import { prepareMailboxBatch, type MailboxBatch } from '../src/supplierInboxBatch';
import type { MailInvoice, SupplierInboxState, useSupplierInbox } from '../src/supplierInbox';
import type { Workspace } from '../src/types';
import { setAppearance } from '../src/appearance';
import { parseLanguage, setAppLanguage } from '../src/language';
import '../src/styles.css';import '../src/workspace-design.css';import '../src/mobile.css';import '../src/dark.generated.css';import '../src/dark.css';
const params = new URLSearchParams(location.search);
setAppearance(params.get('theme') === 'dark' ? 'dark' : 'light');
setAppLanguage(parseLanguage(params.get('lang')) || 'fr');
const vendors = ['Atelier Étoile SA', 'Demo Delivery Services', 'Imprimerie du Léman', 'Fournitures & Équipements Romands'];
const initial: MailInvoice[] = Array.from({length:12},(_,i)=>({ id:`invoice-${i}`, organizationId:'local-qa', sha256:'test', subject:`Facture ${i}`, invoiceId:null, automatic:false, fileName:`facture-${i}.pdf`,mediaType:'application/pdf',
  sender:'factures@exemple.test',state:'review',otherDevice:false,createdAt:i,
  extraction:{kind:'unknown',kindConfidence:.5,confidence:0,fieldConfidence:{supplierName:.99},supplierName:vendors[i%4],
    reference:`ZT1802-20260922-${String(i+1).padStart(2,'0')}`,invoiceDate:'2026-09-22',dueDate:'2026-10-22',currency:'CHF',
    netCents:10000,vatCents:810,totalCents:10810,vatBp:810,category:'materials',issues:[],evidence:{}}
}));
if(params.get('scenario')==='mixed'){initial[2].extraction.netCents=null;initial[6].extraction.supplierName='Fournisseur à préciser';initial[6].extraction.fieldConfidence!.supplierName=.3;}
const data = {suppliers:[],supplierInvoices:[],accounts:[]} as unknown as Workspace;
Object.assign(window,{__TAURI_INTERNALS__:{invoke:async()=>null}});
function Preview(){
  const [items,setItems]=useState(initial),[batch,setBatch]=useState<MailboxBatch|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const state: SupplierInboxState={organizationId:'local-qa',linked:true,autoPost:false,automationActive:true,prepareEnabled:true,items,habits:[]};
  const run=async()=>{
    setBusy(true);
    try {await prepareMailboxBatch(state,{loadWorkspace:async()=>data,isCurrent:()=>true,progress:setBatch,
      request:async<T,>(raw:unknown):Promise<T>=>{
        const action=raw as {action:string;ids?:string[];id?:string};
        await new Promise(resolve=>setTimeout(resolve,80));
        if(action.action==='prepareSuppliers')return{results:action.ids!.map(id=>{
          const item=items.find(i=>i.id===id)!;
          if(item.extraction.fieldConfidence?.supplierName!==.99)return{id,error:'Le nom du fournisseur doit être confirmé.'};
          let supplier=data.suppliers.find(s=>s.name===item.extraction.supplierName);const created=!supplier;
          if(!supplier){supplier={id:`supplier-${data.suppliers.length}`,name:item.extraction.supplierName!,email:'',archivedAt:null} as Workspace['suppliers'][number];data.suppliers.push(supplier);}
          return{id,supplierId:supplier.id,created};
        })} as T;
        if(action.action==='import'){setItems(old=>old.map(i=>i.id===action.id?{...i,state:'imported',invoiceId:i.id}:i));return{id:action.id,saved:true,posted:false} as T;}
        throw Error('Unknown fixture action');
      }});
    }finally{setBusy(false);}
  };
  const inbox={state,batch,busy,error:'',prepareAll:run,refresh:async()=>{}} as unknown as ReturnType<typeof useSupplierInbox>;
  return <main className="desktop-app" data-experience="apple" style={{padding:16,maxWidth:1000,margin:'auto'}}>
    <p style={{fontSize:12,color:'var(--muted)'}}>Essai local · 12 factures fictives</p>
    <SupplierInbox embedded inbox={inbox} workspace={data} readOnly={false} onOpen={id=>setNotice(`Facture ouverte : ${id}`)} onCreateSupplier={async()=>''}/>
    {notice&&<output>{notice}</output>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
