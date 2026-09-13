import {desktopApi} from '../src/bridge';
import {installCreditAllocationFixture} from './credit-allocation-fixture';
import type {Workspace} from '../src/types';
const native={record:desktopApi.recordCustomerCreditSettlement,reverse:desktopApi.reverseCustomerCreditSettlement};
const camel=(row:any)=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
export function installCustomerSettlementGuidedFixture(data:Workspace){
 installCreditAllocationFixture(data);const fixture=window.creditAllocationFixture,state=fixture.state,stored=state.stored;
 stored.clients=[{id:'client-qa',name:'Client de recette',company:'Client de recette'}];
 stored.invoices??=[{id:'original',client_id:'client-qa',title:'Facture d’origine',number:'F-2026-001',type:'facture',status:'payee',issue_date:'2026-02-01',due_date:'2026-02-28',currency:'CHF',total_cents:10000,credited_cents:0},{id:'target',client_id:'client-qa',title:'Facture à régler',number:'F-2026-002',type:'facture',status:'emise',issue_date:'2026-03-01',due_date:'2026-03-31',currency:'CHF',total_cents:10000,credited_cents:0},{id:'credit',client_id:'client-qa',title:'Avoir à utiliser',number:'AV-2026-001',type:'avoir',status:'emise',original_invoice_id:'original',issue_date:'2026-03-01',due_date:'2026-03-31',currency:'CHF',total_cents:-5405,credited_cents:0}];
 stored.invoice_items??=stored.invoices.map((row:any)=>({id:`line-${row.id}`,invoice_id:row.id,description:row.title,quantity:1,unit:'forfait',unit_price_cents:row.total_cents,vat_bp:0,discount_bp:0}));
 stored.payments??=[{id:'original-paid',invoice_id:'original',amount_cents:10000,date:'2026-02-15',method:'bank',reference:'ORIGINAL'}];
 stored.accounts??=[{id:'bank',code:'1020',name:'Banque principale',account_type:'asset',normal_balance:'debit',report_section:'current_assets',active:1},{id:'bank2',code:'1021',name:'Banque secondaire',account_type:'asset',normal_balance:'debit',report_section:'current_assets',active:1}];
 stored.accounting_settings??={enabled:1,bank_account_id:'bank',ar_account_id:'ar'};stored.customer_credit_settlements??=[];stored.journal_entries??=[];
 function rebalance(){const sum=(kind:string)=>stored.customer_credit_settlements.reduce((total:number,row:any)=>total+(row.event_type===kind?1:row.event_type===`reverse_${kind}`?-1:0)*row.amount_cents,0);const allocated=sum('apply'),refunded=sum('refund');stored.customer_credit_balances=[{credit_note_id:'credit',allocated_cents:allocated,refunded_cents:refunded,remaining_cents:5405-allocated-refunded}];stored.invoices.find((row:any)=>row.id==='target').credited_cents=allocated;}
 rebalance();
 data.invoices=stored.invoices.map((row:any)=>({...camel(row),type:row.type==='avoir'?'credit_note':'standard',status:row.status==='payee'?'paid':'issued',lines:stored.invoice_items.filter((line:any)=>line.invoice_id===row.id).map((line:any)=>({...camel(line),vatRateBp:line.vat_bp})),customerCredit:row.id==='credit'?{allocatedCents:stored.customer_credit_balances[0].allocated_cents,refundedCents:stored.customer_credit_balances[0].refunded_cents,remainingCents:stored.customer_credit_balances[0].remaining_cents}:undefined,creditSettlements:stored.customer_credit_settlements.filter((event:any)=>event.credit_note_id===row.id||event.invoice_id===row.id).map(camel),notes:'',terms:''}));
 data.payments=stored.payments.map(camel);data.accounts=stored.accounts.map((row:any)=>({...camel(row),active:!!row.active}));data.accountingSettings={...camel(stored.accounting_settings),enabled:!!stored.accounting_settings.enabled};
 const originalInvoke=(window as any).__TAURI_INTERNALS__.invoke;
 (window as any).__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
  if(command==='get_workspace'){rebalance();const value=await originalInvoke(command,args);if(state.omitCustomerHistory)value.customer_credit_settlements=[];return value;}
  if(!['record_customer_credit_settlement','reverse_customer_credit_settlement'].includes(command))return originalInvoke(command,args);
  state.attempts.push({command,args:structuredClone(args)});const mode=state.mode;state.mode='';if(state.hold)await new Promise<void>(resolve=>state.release=resolve);
  if(mode==='period')throw Error('Champ invalide: La période comptable est fermée.');if(mode==='bank-linked')throw Error('Champ invalide: Dissociez le rapprochement bancaire avant correction.');if(mode==='unknown')throw Error('Réponse interrompue avant confirmation.');
  const input=args.input,key=JSON.stringify({command,input}),prior=stored.operations[input.request_id];if(prior){if(prior!==key)throw Error('Champ invalide: Demande différente');return {};}
  rebalance();const original=command==='reverse_customer_credit_settlement'?stored.customer_credit_settlements.find((row:any)=>row.id===input.settlement_id):undefined;
  if(command==='reverse_customer_credit_settlement'&&!original)throw Error('Enregistrement introuvable');
  const kind=original?`reverse_${original.event_type}`:input.event_type,amount=original?.amount_cents??input.amount_cents,invoiceId=original?.invoice_id??input.invoice_id??null,bankId=original?.bank_account_id??input.bank_account_id??null;
  const balance=stored.customer_credit_balances[0].remaining_cents,target=stored.invoices.find((row:any)=>row.id===invoiceId),targetBalance=target?target.total_cents-target.credited_cents-stored.payments.filter((row:any)=>row.invoice_id===invoiceId).reduce((sum:number,row:any)=>sum+row.amount_cents,0):null;
  const expected=args.expectedReview;if(expected&&(expected.creditAvailableCents!==balance||expected.invoiceBalanceCents!==targetBalance||expected.bankAccountId!==bankId||expected.accountingEnabled!==Boolean(stored.accounting_settings.enabled)))throw Error('Champ invalide: Les soldes ou la comptabilisation ont changé depuis votre vérification.');
  if(original&&stored.customer_credit_settlements.some((row:any)=>row.reverses_id===original.id))throw Error('Champ invalide: Déjà corrigé');if(!original&&(amount<=0||amount>balance||targetBalance!==null&&amount>targetBalance))throw Error('Champ invalide: Solde insuffisant');
  const id=crypto.randomUUID(),journal=stored.accounting_settings.enabled?crypto.randomUUID():null;
  stored.customer_credit_settlements.push({id,request_id:input.request_id,credit_note_id:'credit',invoice_id:invoiceId,event_type:kind,date:input.date,amount_cents:amount,reference:original?.reference??input.reference,reason:input.reason,reverses_id:original?.id||null,bank_account_id:bankId,journal_entry_id:journal,journal_valid:Boolean(journal)});
  if(journal)stored.journal_entries.push({id:journal,source_type:'customer_credit_settlement',source_id:id,amount_cents:amount,event_type:kind});stored.operations[input.request_id]=key;state.writes++;rebalance();fixture.persist();
  if(mode==='lost-unreadable'||mode==='ack-unreadable')state.blockRead=true;if(mode==='lost'||mode==='lost-unreadable')throw Error('Réponse perdue');return {};
 };
 desktopApi.recordCustomerCreditSettlement=native.record;desktopApi.reverseCustomerCreditSettlement=native.reverse;
}
