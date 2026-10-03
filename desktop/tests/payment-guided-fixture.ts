import {desktopApi} from '../src/bridge';
import {installCreditAllocationFixture} from './credit-allocation-fixture';
import type {Workspace} from '../src/types';

const native={payment:desktopApi.addPayment};
const camel=(row:any)=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
const runtimeKey='qa-payment-fixture-runtime.v1';
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export type PaymentGuidedMode=''|'period'|'unknown'|'lost'|'lost-unreadable'|'ack-unreadable'|'alias-lost';

/** Development-only IPC double; real WorkspaceApp, PaymentForm and bridge remain mounted.
 * Models serialized commands, normalized UUID/payload identity before review, aliases
 * and a checked journal. No native SQL/rollback/merge or act/recovery mock is executed.
 * Globals: window.paymentGuidedFixture.state, configure, persist, releaseWrite,
 * releaseProof, aliasPayment, unlockReads. Flag blockRead persists through reload.
 */
export function installPaymentGuidedFixture(data:Workspace){
  installCreditAllocationFixture(data);
  const fixture=window.creditAllocationFixture,state=fixture.state,stored=state.stored;
  const savedRuntime=JSON.parse(sessionStorage.getItem(runtimeKey)||'null')||{};
  stored.work_notes_scope=new URLSearchParams(location.search).get('paymentCompany')||'qa-payment-company';
  data.workNotesScope=stored.work_notes_scope;
  stored.clients=[{id:'client-qa',name:'Client de recette',company:'Client de recette'}];
  stored.invoices??=[{id:'invoice-pay',client_id:'client-qa',title:'Prestation de recette',number:'F-2026-017',type:'facture',status:'emise',issue_date:'2026-05-01',due_date:'2026-05-31',service_date_from:'2026-05-01',service_date_to:'2026-05-01',currency:'CHF',credited_cents:0,total_cents:10000}];
  stored.invoice_items??=[{id:'line',invoice_id:'invoice-pay',description:'Prestation de recette',quantity:1,unit:'forfait',unit_price_cents:10000,vat_bp:0,discount_bp:0}];
  stored.payments??=[];
  stored.accounts??=[{id:'bank',code:'1020',name:'Banque principale',account_type:'asset',normal_balance:'debit',report_section:'current_assets',active:1},{id:'bank2',code:'1021',name:'Banque secondaire',account_type:'asset',normal_balance:'debit',report_section:'current_assets',active:1}];
  stored.accounting_settings??={enabled:1,bank_account_id:'bank',ar_account_id:'ar'};
  stored.journal_entries??=[];stored.payment_aliases??={};stored.payment_closed_dates??=[];
  Object.assign(state,{attempts:savedRuntime.attempts||[],reads:savedRuntime.reads||[],writes:savedRuntime.writes??stored.payments.length,replayCount:savedRuntime.replayCount||0,blockRead:!!savedRuntime.blockRead,readMode:'',proofHold:false,proofWaiting:false,writeWaiting:false,releaseProof:()=>{},lockDepth:0});
  const persistBase=fixture.persist;
  const persist=()=>{persistBase();sessionStorage.setItem(runtimeKey,JSON.stringify({attempts:state.attempts,reads:state.reads,writes:state.writes,replayCount:state.replayCount,blockRead:state.blockRead}));};
  fixture.persist=persist;
  data.invoices=stored.invoices.map((row:any)=>({...camel(row),type:'final',status:row.status==='payee'?'paid':row.status==='partiellement_payee'?'partially_paid':'issued',lines:stored.invoice_items.filter((line:any)=>line.invoice_id===row.id).map((line:any)=>({...camel(line),vatRateBp:line.vat_bp})),notes:'',terms:''}));
  data.payments=stored.payments.map(camel);data.accounts=stored.accounts.map((row:any)=>({...camel(row),active:!!row.active}));data.accountingSettings={...camel(stored.accounting_settings),enabled:!!stored.accounting_settings.enabled};
  const optional=(value:unknown,limit:number)=>typeof value==='string'&&value.trim()?Array.from(value.trim()).slice(0,limit).join(''):null;
  const normalized=(input:any)=>{
    const requestId=String(input?.request_id||'').trim().toLowerCase(),date=String(input?.date||'').trim();
    if(!uuid.test(requestId)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isSafeInteger(input?.amount_cents)||input.amount_cents<=0)throw Error('Champ invalide: Demande de paiement invalide.');
    return {requestId,payload:{invoice_id:String(input.invoice_id),amount_cents:input.amount_cents,date,method:optional(input.method,80),reference:optional(input.reference,160),notes:optional(input.notes,5000)}};
  };
  const canonical=(original:string)=>{let id=original;const seen=new Set<string>();while(stored.payment_aliases[id]){if(seen.has(id))throw Error('Alias de paiement cyclique');seen.add(id);id=stored.payment_aliases[id];}return id;};
  const same=(row:any,payload:any)=>Object.keys(payload).every(key=>(row[key]??null)===payload[key]);
  const validJournal=(row:any)=>{
    const invoice=stored.invoices.find((invoice:any)=>invoice.id===row.invoice_id),journal=stored.journal_entries.find((entry:any)=>entry.id===row.journal_entry_id);
    return row.journal_entry_semantically_valid===true&&row.journal_entry_is_active!==false&&journal&&journal.source_type==='payment'&&journal.source_id===row.id&&journal.amount_cents===row.amount_cents&&journal.date===row.date&&journal.currency===invoice?.currency&&typeof journal.bank_account_id==='string';
  };
  const requireScope=(args:any)=>{if(typeof args?.expectedWorkspaceScope!=='string'||args.expectedWorkspaceScope!==stored.work_notes_scope)throw Error('Champ invalide: L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.');};
  let tail=Promise.resolve();
  const locked=<T,>(operation:()=>Promise<T>):Promise<T>=>{const run=tail.then(async()=>{state.lockDepth++;try{return await operation();}finally{state.lockDepth--;}});tail=run.then(()=>undefined,()=>undefined);return run;};
  function aliasPayment(original:string,target=crypto.randomUUID()){
    const source=canonical(original),row=stored.payments.find((payment:any)=>payment.id===source);if(!row)throw Error('No synthetic payment to alias');
    row.id=target;for(const journal of stored.journal_entries)if(journal.source_id===source)journal.source_id=target;
    stored.payment_aliases[original]=target;stored.operations[target]=stored.operations[source];delete stored.operations[source];persist();return target;
  }
  Object.assign(window,{paymentGuidedFixture:{state,persist,configure:(patch:Record<string,unknown>)=>{Object.assign(state,patch);persist();},releaseWrite:()=>{state.hold=false;state.release();},releaseProof:()=>{state.proofHold=false;state.releaseProof();},aliasPayment,unlockReads:()=>{state.blockRead=false;state.readMode='';persist();},limitations:'IPC/serialization/journal fixture only; native SQLite, OS restart and financial concurrency require native tests.'}});
  const originalInvoke=(window as any).__TAURI_INTERNALS__.invoke;
  (window as any).__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
    if(command==='get_workspace'){const value=await originalInvoke(command,args);if(state.omitPayment)value.payments=[];return value;}
    if(!['record_payment','read_payment_request'].includes(command))return originalInvoke(command,args);
    if(command==='read_payment_request'){
      state.reads.push({command,args:structuredClone(args)});persist();
      return locked(async()=>{
        requireScope(args);if(state.proofHold){state.proofWaiting=true;try{await new Promise<void>(resolve=>state.releaseProof=resolve);}finally{state.proofWaiting=false;}}requireScope(args);
        if(state.blockRead||state.readMode==='throw'){state.readMode='';throw Error('Lecture de la preuve du paiement interrompue.');}
        if(!Array.isArray(args.inputs)||!args.inputs.length)throw Error('Champ invalide: Une variante de paiement est requise.');
        const variants=args.inputs.map(normalized),originalRequestId=variants[0].requestId,workspaceScope=stored.work_notes_scope;
        if(variants.some((variant:any)=>variant.requestId!==originalRequestId||variant.payload.invoice_id!==variants[0].payload.invoice_id))return {status:'conflict',originalRequestId,workspaceScope};
        const id=canonical(originalRequestId),row=stored.payments.find((payment:any)=>payment.id===id);
        if(!row)return {status:id===originalRequestId?'absent':'conflict',originalRequestId,workspaceScope};
        const variantIndex=variants.findIndex((variant:any)=>same(row,variant.payload));
        if(variantIndex<0||!validJournal(row)||state.readMode==='conflict'){state.readMode='';return {status:'conflict',originalRequestId,workspaceScope};}
        // Review metadata is outside payload identity; first matching variant wins.
        return {status:'recorded',originalRequestId,canonicalPaymentId:id,wasAliased:id!==originalRequestId,workspaceScope,variantIndex,journalEntryId:row.journal_entry_id};
      });
    }
    state.attempts.push({command,args:structuredClone(args)});persist();
    return locked(async()=>{
      requireScope(args);const mode=state.mode as PaymentGuidedMode;state.mode='';if(state.hold){state.writeWaiting=true;try{await new Promise<void>(resolve=>state.release=resolve);}finally{state.writeWaiting=false;}}requireScope(args);
      const {requestId,payload}=normalized(args.input),id=canonical(requestId),prior=stored.payments.find((row:any)=>row.id===id);
      if(prior){if(!same(prior,payload)||!validJournal(prior))throw Error('Champ invalide: Cet identifiant de reprise correspond déjà à un autre paiement.');state.replayCount++;persist();return structuredClone(prior);}
      if(id!==requestId)throw Error('Champ invalide: L’encaissement confirmé est introuvable. Aucun paiement supplémentaire n’a été créé.');
      if(mode==='period'){stored.payment_closed_dates.push(payload.date);persist();}
      if(stored.payment_closed_dates.includes(payload.date))throw Error('Champ invalide: La période comptable est fermée.');
      if(mode==='unknown')throw Error('Réponse interrompue avant confirmation.');
      const invoice=stored.invoices.find((row:any)=>row.id===payload.invoice_id);if(!invoice)throw Error('Enregistrement introuvable: Facture');
      const balance=invoice.total_cents-invoice.credited_cents-stored.payments.filter((row:any)=>row.invoice_id===invoice.id).reduce((sum:number,row:any)=>sum+row.amount_cents,0),bank=stored.accounting_settings.bank_account_id;
      if(args.expectedReview&&(args.expectedReview.balanceCents!==balance||args.expectedReview.bankAccountId!==bank))throw Error('Champ invalide: Le solde ou le compte d’encaissement a changé depuis votre vérification.');
      if(payload.amount_cents>balance)throw Error('Champ invalide: Le paiement dépasse le solde restant de la facture.');
      const journal=crypto.randomUUID();stored.payments.push({...payload,id:requestId,journal_entry_id:journal,journal_entry_semantically_valid:true,journal_entry_is_active:true});
      stored.journal_entries.push({id:journal,source_type:'payment',source_id:requestId,bank_account_id:bank,amount_cents:payload.amount_cents,date:payload.date,currency:invoice.currency});
      invoice.status=payload.amount_cents===balance?'payee':'partiellement_payee';stored.operations[requestId]=JSON.stringify(payload);state.writes++;
      if(mode==='alias-lost')aliasPayment(requestId);
      if(mode==='lost-unreadable'||mode==='ack-unreadable')state.blockRead=true;persist();
      if(mode==='lost-unreadable'||mode==='lost'||mode==='alias-lost')throw Error('Réponse perdue');
      return structuredClone(stored.payments.find((row:any)=>row.id===canonical(requestId)));
    });
  };
  desktopApi.addPayment=native.payment;persist();
}
declare global {interface Window {paymentGuidedFixture:{state:any;persist:()=>void;configure:(patch:Record<string,unknown>)=>void;releaseWrite:()=>void;releaseProof:()=>void;aliasPayment:(original:string,target?:string)=>string;unlockReads:()=>void;limitations:string}}}
