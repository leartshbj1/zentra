// Browser-only presentation fixture. Native transaction and accounting tests are separate.
import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';
import type { CustomerCreditRecoveryPlan } from '../src/customerCreditRecoveryState';
export function installCustomerCreditRecoveryFixture(get:()=>Workspace) {
  const workspace=get(),base=workspace.invoices[0];
  const invoice={...base,id:'legacy-invoice',number:'FAC-2026-201',title:'Dossier des avoirs historiques',type:'standard' as const,status:'partially_paid' as const,issueDate:'2026-02-01',originalInvoiceId:null,billingPair:null,creditedCents:7567,customerCredit:undefined,creditSettlements:[],lines:[{...base.lines[0],id:'legacy-invoice-line',quantity:1,unitPriceCents:10000,discountBp:0,vatRateBp:810}]};
  const credits=[5000,2000].map((net,index)=>({...structuredClone(invoice),id:`legacy-credit-${index}`,number:`AVO-2026-20${index+1}`,title:`Avoir historique ${index+1}`,type:'credit_note' as const,status:'issued' as const,issueDate:'2026-03-01',creditedCents:0,originalInvoiceId:invoice.id,lines:[{...invoice.lines[0],id:`legacy-credit-line-${index}`,unitPriceCents:-net}]}));
  workspace.invoices=[invoice,...credits];workspace.payments=[];
  const params=new URLSearchParams(location.search);
  const plan:CustomerCreditRecoveryPlan={originalInvoiceId:invoice.id,number:invoice.number,sourceToken:'synthetic-financial-snapshot',currency:'CHF',invoiceTotalCents:10810,paidCents:0,blocker:params.has('recoveryBlocked')?'Ces avoirs concernent la TVA à l’encaissement. Le rapprochement de leur TVA historique doit être documenté avant la reprise ; ce parcours n’est pas encore disponible.':null,credits:credits.map((credit,index)=>({id:credit.id,number:credit.number,totalCents:[5405,2162][index],issueDate:'2026-03-01',earliestApplicationDate:'2026-03-01'}))};
  desktopApi.getCustomerCreditRecovery=async()=>structuredClone(plan);
  desktopApi.previewCustomerCreditRecovery=async(input)=>{
    sessionStorage.setItem('recovery-preview-input',JSON.stringify(input));
    return {originalInvoiceId:invoice.id,number:invoice.number,currency:'CHF',invoiceRemainingCents:10810-input.credits.reduce((sum,c)=>sum+c.appliedCents,0),credits:input.credits.map(c=>({creditNoteId:c.creditNoteId,number:plan.credits.find(p=>p.id===c.creditNoteId)!.number,allocatedCents:c.appliedCents,remainingCents:plan.credits.find(p=>p.id===c.creditNoteId)!.totalCents-c.appliedCents}))};
  };
  const saved=new Map<string,string>();let lost=false;
  desktopApi.adoptCustomerCreditRecovery=async(input)=>{
    const data=get();const requests=JSON.parse(sessionStorage.getItem('recovery-requests')||'[]');requests.push(input);sessionStorage.setItem('recovery-requests',JSON.stringify(requests));
    if(saved.has(input.requestId)&&saved.get(input.requestId)!==JSON.stringify(input))throw Error('Champ invalide : identité réutilisée');
    if(!saved.has(input.requestId)) {
      saved.set(input.requestId,JSON.stringify(input));
      data.invoices.find(i=>i.id===invoice.id)!.creditedCents=input.credits.reduce((sum,c)=>sum+c.appliedCents,0);
      for(const c of input.credits) {
        const credit=data.invoices.find(i=>i.id===c.creditNoteId)!;credit.customerCredit={allocatedCents:c.appliedCents,remainingCents:plan.credits.find(p=>p.id===c.creditNoteId)!.totalCents-c.appliedCents,refundedCents:0};
        credit.creditRecovery={recordedAt:'2026-09-06T06:00:00Z',reference:input.reference,reason:input.reason};
        credit.creditSettlements=c.appliedCents?[{id:`recovered-${c.creditNoteId}`,creditNoteId:c.creditNoteId,invoiceId:invoice.id,eventType:'apply',date:c.applicationDate!,amountCents:c.appliedCents,reference:input.reference,reason:input.reason,reversesId:null,bankAccountId:null,journalEntryId:'synthetic-journal',journalValid:true}]:[];
      }
    }
    sessionStorage.setItem('recovery-count',String(saved.size));
    if(params.has('lostReply')&&!lost){lost=true;throw Error('Réponse interrompue après enregistrement.');}
    return structuredClone(data);
  };
}
