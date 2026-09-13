import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';
const native = { load:desktopApi.loadWorkspace, apply:desktopApi.applySupplierCredit, reverse:desktopApi.reverseSupplierCreditAllocation };
const camel = (row:any) => Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
export function installCreditAllocationFixture(data:Workspace) {
  const stored=JSON.parse(sessionStorage.getItem('credit-allocation-store')||'null')||{
    settings:{company_name:'Atelier de recette',extra_settings_json:JSON.stringify(data.settings)},
    suppliers:[{id:'supplier',name:'Couleurs du Léman'}],
    supplier_invoices:[{id:'invoice',supplier_id:'supplier',supplier_name:'Couleurs du Léman',reference:'FA-2026-017',document_date:'2026-05-01',due_date:'2026-06-01',status:'validated',currency:'CHF',total_cents:10000,paid_cents:0,credited_cents:0,validated_at:'2026-05-01T12:00:00Z',validation_journal_entry_id:'journal'}],
    supplier_credit_notes:[{id:'credit',supplier_id:'supplier',supplier_name:'Couleurs du Léman',number:'AV-2026-003',reference:'Retour peinture',document_date:'2026-05-02',currency:'CHF',status:'validated',total_cents:5405}],
    supplier_credit_allocations:[],supplier_credit_refunds:[{id:'refund',supplier_credit_note_id:'credit',event_type:'refund',amount_cents:500,date:'2026-05-02',reference:'Retour',reason:'Remboursement',sequence:1}],operations:{},
  };
  const state={stored,attempts:[] as any[],writes:0,mode:'',blockRead:false,empty:false,omitHistory:false,hold:false,release:()=>{}};
  const persist=()=>sessionStorage.setItem('credit-allocation-store',JSON.stringify(stored));
  const available=()=>5405-500-stored.supplier_credit_allocations.reduce((sum:number,row:any)=>sum+(row.event_type==='reverse'?-1:1)*row.amount_cents,0);
  const balance=()=>stored.supplier_invoices[0].total_cents-stored.supplier_invoices[0].paid_cents-stored.supplier_invoices[0].credited_cents;
  data.suppliers=stored.suppliers.map(camel);
  data.supplierInvoices=stored.supplier_invoices.map((row:any)=>({...camel(row),documentStatus:row.status,paymentStatus:balance()?'pending':'paid',balanceCents:balance(),matchStatus:'unmatched',lines:[],payments:[],attachments:[],items:[],note:''}));
  data.supplierCreditNotes=stored.supplier_credit_notes.map((row:any)=>({...camel(row),allocatedCents:5405-500-available(),refundedCents:500,allocations:stored.supplier_credit_allocations.map(camel),refunds:stored.supplier_credit_refunds.map(camel),items:[],note:''}));
  Object.assign(window,{creditAllocationFixture:{state,persist},__TAURI_INTERNALS__:{invoke:async(command:string,args:any)=>{
    if(command==='get_app_state'||command==='get_workspace') {
      if(state.blockRead)throw Error('Lecture interrompue');
      if(command==='get_app_state')return {onboarding_completed:!state.empty};
      return structuredClone({...stored,supplier_credit_allocations:state.omitHistory?[]:stored.supplier_credit_allocations});
    }
    if(!['apply_supplier_credit','reverse_supplier_credit_allocation'].includes(command))throw Error(`Commande hors recette : ${command}`);
    state.attempts.push({command,args:structuredClone(args)});
    const mode=state.mode;state.mode='';if(state.hold)await new Promise<void>(resolve=>state.release=resolve);
    if(mode==='refuse')throw Error('La période comptable est fermée.');
    const input=args.input,prior=stored.operations[input.request_id];
    if(prior){if(prior!==JSON.stringify(input))throw Error('Demande différente');return {idempotent:true};}
    if(args.expectedBalances&&(args.expectedBalances.creditAvailableCents!==available()||args.expectedBalances.invoiceBalanceCents!==balance()))throw Error('Les soldes ont changé depuis votre vérification.');
    const source=command==='reverse_supplier_credit_allocation'?stored.supplier_credit_allocations.find((row:any)=>row.id===input.supplier_credit_allocation_id):null;
    const amount=source?.amount_cents??input.amount_cents;
    if(source&&stored.supplier_credit_allocations.some((row:any)=>row.reverses_allocation_id===source.id))throw Error('Déjà annulée');
    if(!source&&(amount<=0||amount>available()||amount>balance()))throw Error('Solde insuffisant');
    stored.supplier_credit_allocations.push({id:crypto.randomUUID(),sequence:stored.supplier_credit_allocations.length+1,request_id:input.request_id,supplier_credit_note_id:'credit',supplier_invoice_id:'invoice',event_type:source?'reverse':'apply',reverses_allocation_id:source?.id||null,amount_cents:amount,effective_date:input.effective_date,reason:input.reason||''});
    stored.supplier_invoices[0].credited_cents+=(source?-1:1)*amount;
    stored.operations[input.request_id]=JSON.stringify(input);state.writes++;persist();
    if(mode==='ack-unreadable'||mode==='lost-unreadable')state.blockRead=true;
    if(mode==='lost'||mode==='lost-unreadable')throw Error('Réponse perdue');
    return {};
  }}});
  desktopApi.loadWorkspace=native.load;desktopApi.applySupplierCredit=native.apply;desktopApi.reverseSupplierCreditAllocation=native.reverse;
}
declare global { interface Window {creditAllocationFixture:{state:any;persist:()=>void};__qaCreditAllocationRefresh:()=>Promise<void>} }
