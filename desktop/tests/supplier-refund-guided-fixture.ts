import {desktopApi} from '../src/bridge';
import {installCreditAllocationFixture} from './credit-allocation-fixture';
import type {Workspace} from '../src/types';
const native={record:desktopApi.recordSupplierCreditRefund,reverse:desktopApi.reverseSupplierCreditRefund};
const camel=(row:any)=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
export function installSupplierRefundGuidedFixture(data:Workspace){
  installCreditAllocationFixture(data);
  const fixture=window.creditAllocationFixture,state=fixture.state,stored=state.stored;
  stored.accounts??=[{id:'bank',code:'1020',name:'Banque principale',account_type:'asset',normal_balance:'debit',report_section:'current_assets',active:1},{id:'bank2',code:'1021',name:'Banque secondaire',account_type:'asset',normal_balance:'debit',report_section:'current_assets',active:1}];
  stored.accounting_settings??={enabled:1,bank_account_id:'bank',expense_account_id:'expense',supplier_payable_account_id:'payable',vat_receivable_account_id:'vat-in'};
  stored.journal_entries??=[];
  const initial=stored.supplier_credit_refunds[0];Object.assign(initial,{request_id:'initial',bank_account_id:'bank',payable_account_id:'payable',journal_entry_id:'initial-journal'});
  data.accounts=stored.accounts.map((row:any)=>({...camel(row),active:!!row.active}));data.accountingSettings={...camel(stored.accounting_settings),enabled:true} as Workspace['accountingSettings'];
  data.supplierCreditNotes[0].refunds=stored.supplier_credit_refunds.map(camel);
  const originalInvoke=(window as any).__TAURI_INTERNALS__.invoke;
  const available=()=>stored.supplier_credit_notes[0].total_cents-stored.supplier_credit_allocations.reduce((sum:number,row:any)=>sum+(row.event_type==='reverse'?-1:1)*row.amount_cents,0)-stored.supplier_credit_refunds.reduce((sum:number,row:any)=>sum+(row.event_type==='reverse'?-1:1)*row.amount_cents,0);
  (window as any).__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
    if(command==='get_workspace'&&state.omitRefund){const result=await originalInvoke(command,args);result.supplier_credit_refunds=[];return result;}
    if(!['record_supplier_credit_refund','reverse_supplier_credit_refund'].includes(command))return originalInvoke(command,args);
    state.attempts.push({command,args:structuredClone(args)});const mode=state.mode;state.mode='';if(state.hold)await new Promise<void>(resolve=>state.release=resolve);
    if(mode==='period')throw Error('La période comptable est fermée.');
    if(mode==='bank-linked')throw Error('Dissociez d’abord le remboursement du relevé dans Banque.');
    const input=args.input,prior=stored.operations[input.request_id];if(prior){if(prior!==JSON.stringify(input))throw Error('Demande différente');return {idempotent:true};}
    const source=command==='reverse_supplier_credit_refund'?stored.supplier_credit_refunds.find((row:any)=>row.id===input.refund_id):null;
    const bank=source?.bank_account_id||stored.accounting_settings.bank_account_id,amount=source?.amount_cents??input.amount_cents;
    if(args.expectedReview&&(args.expectedReview.availableCents!==available()||args.expectedReview.bankAccountId!==bank))throw Error('Le solde ou le compte bancaire a changé depuis votre vérification.');
    if(!stored.accounts.some((row:any)=>row.id===bank&&row.active&&row.account_type==='asset'))throw Error('Configurez un compte bancaire actif.');
    if(source&&stored.supplier_credit_refunds.some((row:any)=>row.reverses_id===source.id))throw Error('Ce remboursement a déjà été corrigé.');
    if(!source&&(amount<=0||amount>available()))throw Error('Solde insuffisant.');
    const id=crypto.randomUUID(),journal=crypto.randomUUID();
    stored.supplier_credit_refunds.push({id,request_id:input.request_id,sequence:stored.supplier_credit_refunds.length+1,supplier_credit_note_id:'credit',event_type:source?'reverse':'refund',reverses_id:source?.id||null,amount_cents:amount,date:input.date,reference:source?.reference??input.reference,reason:input.reason,bank_account_id:bank,payable_account_id:'payable',journal_entry_id:journal});
    stored.journal_entries.push({id:journal,source_type:'supplier_credit_refund',source_id:id,amount_cents:amount,event:source?'reverse':'refund',bank_account_id:bank});
    stored.operations[input.request_id]=JSON.stringify(input);state.writes++;fixture.persist();
    if(mode==='lost-unreadable'||mode==='ack-unreadable')state.blockRead=true;
    if(mode==='lost'||mode==='lost-unreadable')throw Error('Réponse perdue');return {};
  };
  desktopApi.recordSupplierCreditRefund=native.record;desktopApi.reverseSupplierCreditRefund=native.reverse;
}
