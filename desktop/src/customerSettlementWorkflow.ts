import type {CustomerCreditSettlement,Invoice,Workspace} from './types';
import type {PendingCustomerCreditRequest} from './customerCreditRequest';
import {creditAmount} from './creditAllocationWorkflow';
import {invoiceOpenBalance} from './utils';
import {isSalesDate} from './salesFormValidation';
import {WorkspaceRefreshAfterMutationError} from './workspaceMutation';

export type CustomerSettlementInput={requestId:string;creditNoteId:string;eventType:'apply'|'refund';invoiceId:string|null;date:string;amountCents:number;bankAccountId:string|null;reference:string;reason:string;expectedReview?:CustomerSettlementReview};
export type CustomerSettlementReview={creditAvailableCents:number;invoiceBalanceCents:number|null;bankAccountId:string|null;accountingEnabled:boolean};
export type CustomerSettlementDraft={amount:string;date:string;invoiceId:string;bankAccountId:string;reference:string;reason:string};
export type CustomerSettlementProblem={field:keyof CustomerSettlementDraft|'record';message:string;destination?:'accounts'|'periods'|'bank'};
export function customerSettlementAvailable(credit?:Invoice){const balance=credit?.customerCredit;return balance&&[balance.allocatedCents,balance.refundedCents,balance.remainingCents].every(value=>Number.isSafeInteger(value)&&value>=0)?balance.remainingCents:null;}
export function customerSettlementTargets(credit:Invoice|undefined,workspace:Workspace){return credit?workspace.invoices.filter(row=>row.type!=='credit_note'&&['issued','overdue','partially_paid','paid'].includes(row.status)&&row.number&&row.clientId===credit.clientId&&row.currency===credit.currency&&invoiceOpenBalance(row,workspace.invoices,workspace.payments)>0).sort((a,b)=>b.issueDate.localeCompare(a.issueDate)||(b.createdAt||'').localeCompare(a.createdAt||'')||b.id.localeCompare(a.id)):[];}
export function customerSettlementMinimum(credit:Invoice|undefined,target:Invoice|undefined,workspace:Workspace){const ids=[credit?.id,target?.id];return [credit?.issueDate||'',target?.issueDate||'',...workspace.invoices.flatMap(row=>(row.creditSettlements??[]).filter(event=>ids.includes(event.creditNoteId)||Boolean(event.invoiceId&&ids.includes(event.invoiceId))).map(event=>event.date)),...workspace.payments.filter(row=>ids.includes(row.invoiceId)).map(row=>row.date)].sort().at(-1)!;}
export function customerSettlementProblem(credit:Invoice|undefined,reverse:CustomerCreditSettlement|undefined,reverseId:string|undefined,mode:'apply'|'refund',draft:CustomerSettlementDraft,workspace:Workspace,today:string):CustomerSettlementProblem|null{
 if(!credit||credit.type!=='credit_note'||!['issued','paid','partially_paid','overdue'].includes(credit.status)||customerSettlementAvailable(credit)===null)return {field:'record',message:'Actualisez les factures pour retrouver cet avoir et son solde. Un avoir historique doit d’abord être repris dans le guide dédié.'};
 if(reverseId&&(!reverse||!['apply','refund'].includes(reverse.eventType)||reverse.creditNoteId!==credit.id||(credit.creditSettlements??[]).some(row=>row.reversesId===reverseId)))return {field:'record',message:'Ce règlement a déjà été corrigé ou n’est plus accessible. Actualisez son historique.'};
 if(reverse?.bankMatchId)return {field:'record',message:'Ce remboursement est rapproché d’un relevé. Ouvrez Banque et dissociez le mouvement avant de le corriger.',destination:'bank'};
 const target=workspace.invoices.find(row=>row.id===(reverse?.invoiceId||draft.invoiceId)),available=customerSettlementAvailable(credit)!;
 if(!reverse&&mode==='apply'&&!customerSettlementTargets(credit,workspace).some(row=>row.id===draft.invoiceId))return {field:'invoiceId',message:customerSettlementTargets(credit,workspace).length?'Choisissez une facture encore à encaisser pour ce client et dans la même monnaie.':'Ce client n’a aucune facture émise avec un reste à payer dans cette monnaie. Conservez l’avoir pour sa prochaine facture, ou annulez cette saisie pour enregistrer un remboursement déjà versé.'};
 if(reverse?.invoiceId&&!target)return {field:'record',message:'La facture liée n’a pas pu être relue. Actualisez les factures avant de corriger ce règlement.'};
 const amount=reverse?.amountCents??creditAmount(draft.amount);
 if(!amount||!Number.isSafeInteger(amount)||amount<0||amount>9_000_000_000_000_000)return {field:'amount',message:'Indiquez un montant supérieur à zéro, avec deux décimales maximum. Exemple : 125,50.'};
 if(!reverse&&amount>available)return {field:'amount',message:'Ce montant dépasse le disponible sur l’avoir. Vérifiez le montant ou actualisez les factures.'};
 if(!reverse&&mode==='apply'&&target&&amount>invoiceOpenBalance(target,workspace.invoices,workspace.payments))return {field:'amount',message:'Ce montant dépasse le reste à payer de la facture choisie. Utilisez une partie de l’avoir.'};
 const minimum=customerSettlementMinimum(credit,mode==='apply'?target:undefined,workspace);
 if(!isSalesDate(draft.date)||draft.date<minimum||draft.date>today)return {field:'date',message:`Choisissez la date réelle de cette opération, entre le ${minimum.split('-').reverse().join('.')} et aujourd’hui. Les règlements existants doivent rester dans l’ordre des dates.`};
 if(!reverse&&(!draft.reference.trim()||[...draft.reference.trim()].length>255||draft.reference.includes('\0')))return {field:'reference',message:'Indiquez une référence de 1 à 255 caractères : le libellé bancaire ou le numéro de la facture.'};
 if([...draft.reason.trim()].length<5||[...draft.reason.trim()].length>1000||draft.reason.includes('\0'))return {field:'reason',message:'Une courte explication suffit, de 5 à 1 000 caractères. Exemple : « Retour de marchandises ».'};
 if(mode==='refund'){const bank=workspace.accounts.find(row=>row.id===(reverse?.bankAccountId||draft.bankAccountId));if(!bank?.active||bank.accountType!=='asset'||bank.id===workspace.accountingSettings?.arAccountId)return {field:'bankAccountId',message:'Choisissez un compte de trésorerie actif, distinct du compte client. Vérifiez Plan & liaisons si nécessaire.',destination:'accounts'};}
 return null;
}
export function customerSettlementNativeProblem(message:string):CustomerSettlementProblem{
 if(/changé depuis|solde|disponible/i.test(message))return {field:'record',message:'Un solde a changé. Actualisez les factures, puis relisez les montants avant de confirmer.'};
 if(/rapproch|Dissociez|relevé/i.test(message))return {field:'record',message:'Ce règlement est lié à un mouvement bancaire. Ouvrez Banque pour vérifier et dissocier le rapprochement avant sa correction.',destination:'bank'};
 if(/période|exercice|clôtur|fermée/i.test(message))return {field:'record',message:'Cette date appartient à un exercice fermé. Vérifiez l’exercice ; corrigez la date uniquement si elle a été mal recopiée.',destination:'periods'};
 if(/compte|comptabilis|écriture|preuve comptable|liaison/i.test(message))return {field:'record',message:'La comptabilisation de ce règlement demande une vérification. Ouvrez Plan & liaisons et consultez le message détaillé.',destination:'accounts'};
 return {field:'record',message:'Le règlement n’a pas pu être confirmé. Votre saisie est conservée. Vérifiez son historique avant de réessayer.'};
}
export function requireCustomerSettlementWorkspace(workspace:Workspace){if(!workspace.onboardingCompleted||!workspace.settings||!Array.isArray(workspace.invoices)||!Array.isArray(workspace.payments)||!Array.isArray(workspace.accounts))throw Error('Les avoirs, factures et règlements doivent être accessibles. Réessayez l’actualisation.');}
export function customerSettlementWasRecorded(workspace:Workspace,intent:PendingCustomerCreditRequest){
 requireCustomerSettlementWorkspace(workspace);const input=intent.input,credit=workspace.invoices.find(row=>row.id===input.creditNoteId);if(!credit||!Array.isArray(credit.creditSettlements))throw Error('L’avoir et son historique doivent être relus avant de reprendre.');
 const original=intent.reverseId?credit.creditSettlements.find(row=>row.id===intent.reverseId):undefined;
 const mustPost=Boolean(input.expectedReview?.accountingEnabled||workspace.accountingSettings?.enabled||original?.journalEntryId);
 if(intent.reverseId&&(!original||original.eventType!==input.eventType||original.creditNoteId!==input.creditNoteId||original.amountCents!==input.amountCents||original.invoiceId!==input.invoiceId||original.bankAccountId!==input.bankAccountId||original.reference!==input.reference.trim()))return false;
 return credit.creditSettlements.some(row=>row.requestId===input.requestId&&row.creditNoteId===input.creditNoteId&&row.date===input.date&&row.reason===input.reason.trim()&&row.amountCents===input.amountCents&&row.invoiceId===input.invoiceId&&row.bankAccountId===input.bankAccountId&&row.reference===input.reference.trim()&&(intent.reverseId?row.reversesId===intent.reverseId&&row.eventType===`reverse_${input.eventType}`:row.eventType===input.eventType&&!row.reversesId)&&(!mustPost&&!row.journalEntryId||Boolean(row.journalEntryId)&&row.journalValid));
}
export function requireCustomerSettlementReverseContext(input:{requestId:string;settlementId:string;date:string;reason:string;context?:PendingCustomerCreditRequest}){
 const context=input.context;
 if(context&&(context.reverseId!==input.settlementId||context.input.requestId!==input.requestId||context.input.date!==input.date||context.input.reason.trim()!==input.reason.trim()))throw Error('Champ invalide: La correction ne correspond plus à la demande vérifiée. Relisez le règlement avant de confirmer.');
}
export class CustomerSettlementOutcomeUnknownError extends Error{constructor(readonly intent:PendingCustomerCreditRequest,readonly mutationCause:unknown){super('La réponse du règlement client a été interrompue. Vérifions son historique.');}wasRecorded(workspace:Workspace){return customerSettlementWasRecorded(workspace,this.intent);}}
export class CustomerSettlementRefreshError extends WorkspaceRefreshAfterMutationError{constructor(readonly intent:PendingCustomerCreditRequest,cause:unknown){super(cause);}validateRead(workspace:Workspace){if(!customerSettlementWasRecorded(workspace,this.intent))throw Error('Le règlement enregistré et sa preuve ne figurent pas encore dans les données relues. Actualisez sans créer une nouvelle demande.');}}
export async function runCustomerSettlementMutation(intent:PendingCustomerCreditRequest,write:()=>Promise<unknown>,load:()=>Promise<Workspace>){try{await write();}catch(cause){throw new CustomerSettlementOutcomeUnknownError(intent,cause);}try{const next=await load();new CustomerSettlementRefreshError(intent,null).validateRead(next);return next;}catch(cause){throw new CustomerSettlementRefreshError(intent,cause);}}
