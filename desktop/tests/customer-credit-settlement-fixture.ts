// Synthetic browser journey. The financial commands and transaction rollback are tested in Rust.
import { desktopApi } from '../src/bridge';
import type { CustomerCreditSettlement, Workspace } from '../src/types';
export function installCustomerCreditSettlementFixture(get:()=>Workspace) {
  const workspace=get();
  const base=workspace.invoices[0];
  const original={...base,id:'customer-original',number:'FAC-2026-101',title:'Facture réglée',type:'standard' as const,status:'paid' as const,issueDate:'2026-02-01',creditedCents:0,originalInvoiceId:null,billingPair:null,lines:[{...base.lines[0],id:'sale-line',quantity:1,unitPriceCents:10_000,vatRateBp:810,discountBp:0}]};
  const target={...structuredClone(original),id:'customer-target',number:'FAC-2026-102',title:'Autre facture à régler',status:'issued' as const,lines:[{...original.lines[0],id:'target-line'}]};
  const credit={...structuredClone(original),id:'customer-settlement-credit',number:'AVO-2026-101',title:'Avoir et remboursements',type:'credit_note' as const,status:'issued' as const,originalInvoiceId:original.id,issueDate:'2026-03-01',lines:[{...original.lines[0],id:'credit-line',unitPriceCents:-5_000}],customerCredit:{allocatedCents:0,refundedCents:0,remainingCents:5_405},creditSettlements:[] as CustomerCreditSettlement[]};
  workspace.invoices=[original,target,credit];
  workspace.payments=[{id:'customer-paid',invoiceId:original.id,amountCents:10_810,date:'2026-02-15',method:'bank',reference:'BANK-PAID',notes:''} as Workspace['payments'][number]];
  workspace.accounts=[{id:'customer-bank',code:'1020',name:'Compte bancaire CHF',accountType:'asset',normalBalance:'debit',reportSection:'current_assets',active:true} as Workspace['accounts'][number]];
  workspace.accountingSettings={...workspace.accountingSettings,enabled:true,bankAccountId:'customer-bank',arAccountId:'customer-ar'} as NonNullable<Workspace['accountingSettings']>;
  const saved=new Set<string>();let lost=false;
  desktopApi.recordCustomerCreditSettlement=async(input)=>{
    const data=get(),current=data.invoices.find((item)=>item.id===credit.id)!;
    const ids=JSON.parse(sessionStorage.getItem('customer-settlement-requests')||'[]');ids.push(input.requestId);sessionStorage.setItem('customer-settlement-requests',JSON.stringify(ids));
    if (!saved.has(input.requestId)) {
      saved.add(input.requestId);
      current.customerCredit!.remainingCents-=input.amountCents;
      if(input.eventType==='refund')current.customerCredit!.refundedCents+=input.amountCents;
      else {current.customerCredit!.allocatedCents+=input.amountCents;data.invoices.find((item)=>item.id===input.invoiceId)!.creditedCents!+=input.amountCents;}
      current.creditSettlements!.unshift({id:input.requestId,creditNoteId:credit.id,invoiceId:input.invoiceId,eventType:input.eventType,date:input.date,amountCents:input.amountCents,reference:input.reference,reason:input.reason,reversesId:null,bankAccountId:input.bankAccountId,journalEntryId:`journal-${input.requestId}`,journalValid:true});
    }
    sessionStorage.setItem('customer-settlement-count',String(saved.size));
    if(new URLSearchParams(location.search).has('lostReply')&&!lost){lost=true;throw new Error('Réponse interrompue après enregistrement du règlement.');}
    return structuredClone(data);
  };
  desktopApi.reverseCustomerCreditSettlement=async(input)=>{
    const data=get(),current=data.invoices.find((item)=>item.id===credit.id)!;
    if(!saved.has(input.requestId)){
      saved.add(input.requestId);const original=current.creditSettlements!.find((event)=>event.id===input.settlementId)!;
      current.customerCredit!.remainingCents+=original.amountCents;
      if(original.eventType==='refund')current.customerCredit!.refundedCents-=original.amountCents;
      else {current.customerCredit!.allocatedCents-=original.amountCents;data.invoices.find((item)=>item.id===original.invoiceId)!.creditedCents!-=original.amountCents;}
      current.creditSettlements!.unshift({...original,id:input.requestId,eventType:original.eventType==='apply'?'reverse_apply':'reverse_refund',date:input.date,reason:input.reason,reversesId:original.id});
    }
    return structuredClone(data);
  };
}
