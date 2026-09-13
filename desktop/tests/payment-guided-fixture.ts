import {desktopApi} from '../src/bridge';
import {installCreditAllocationFixture} from './credit-allocation-fixture';
import type {Workspace} from '../src/types';
const native={payment:desktopApi.addPayment};
const camel=(row:any)=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
export function installPaymentGuidedFixture(data:Workspace){
  installCreditAllocationFixture(data);
  const fixture=window.creditAllocationFixture,state=fixture.state,stored=state.stored;
  stored.clients=[{id:'client-qa',name:'Client de recette',company:'Client de recette'}];
  stored.invoices??=[{id:'invoice-pay',client_id:'client-qa',title:'Prestation de recette',number:'F-2026-017',type:'facture',status:'emise',issue_date:'2026-05-01',due_date:'2026-05-31',service_date_from:'2026-05-01',currency:'CHF',credited_cents:0,total_cents:10000}];
  stored.invoice_items??=[{id:'line',invoice_id:'invoice-pay',description:'Prestation de recette',quantity:1,unit:'forfait',unit_price_cents:10000,vat_bp:0,discount_bp:0}];
  stored.payments??=[];
  stored.accounts??=[{id:'bank',code:'1020',name:'Banque principale',account_type:'asset',normal_balance:'debit',report_section:'current_assets',active:1},{id:'bank2',code:'1021',name:'Banque secondaire',account_type:'asset',normal_balance:'debit',report_section:'current_assets',active:1}];
  stored.accounting_settings??={enabled:1,bank_account_id:'bank',ar_account_id:'ar'};stored.journal_entries??=[];
  data.invoices=stored.invoices.map((row:any)=>({...camel(row),type:'final',status:row.status==='payee'?'paid':row.status==='partiellement_payee'?'partially_paid':'issued',lines:stored.invoice_items.map((line:any)=>({...camel(line),vatRateBp:line.vat_bp})),notes:'',terms:''}));
  data.payments=stored.payments.map(camel);data.accounts=stored.accounts.map((row:any)=>({...camel(row),active:!!row.active}));data.accountingSettings={...camel(stored.accounting_settings),enabled:!!stored.accounting_settings.enabled};
  const originalInvoke=(window as any).__TAURI_INTERNALS__.invoke;
  (window as any).__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
    if(command==='get_workspace'){const value=await originalInvoke(command,args);if(state.omitPayment)value.payments=[];return value;}
    if(command!=='record_payment')return originalInvoke(command,args);
    state.attempts.push({command,args:structuredClone(args)});const mode=state.mode;state.mode='';if(state.hold)await new Promise<void>(resolve=>state.release=resolve);
    if(mode==='period')throw Error('La période comptable est fermée.');
    const input=args.input,prior=stored.operations[input.request_id];if(prior){if(prior!==JSON.stringify(input))throw Error('Demande différente');return {idempotent:true};}
    const invoice=stored.invoices.find((row:any)=>row.id===input.invoice_id);if(!invoice)throw Error('Facture introuvable');
    const balance=invoice.total_cents-invoice.credited_cents-stored.payments.reduce((sum:number,row:any)=>sum+row.amount_cents,0),bank=stored.accounting_settings.bank_account_id;
    if(args.expectedReview&&(args.expectedReview.balanceCents!==balance||args.expectedReview.bankAccountId!==bank))throw Error('Le solde ou le compte d’encaissement a changé depuis votre vérification.');
    if(input.amount_cents<=0||input.amount_cents>balance)throw Error('Le paiement dépasse le solde restant de la facture.');
    const journal=crypto.randomUUID();stored.payments.push({...input,id:input.request_id,journal_entry_id:journal,journal_entry_semantically_valid:true,journal_entry_is_active:true});
    stored.journal_entries.push({id:journal,source_type:'payment',source_id:input.request_id,bank_account_id:bank,amount_cents:input.amount_cents});
    invoice.status=input.amount_cents===balance?'payee':'partiellement_payee';stored.operations[input.request_id]=JSON.stringify(input);state.writes++;fixture.persist();
    if(mode==='lost-unreadable'||mode==='ack-unreadable')state.blockRead=true;if(mode==='lost-unreadable'||mode==='lost')throw Error('Réponse perdue');return {};
  };
  desktopApi.addPayment=native.payment;
}
