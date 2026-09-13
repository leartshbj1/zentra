import type { Invoice, Workspace } from './types';
import { creditAmount } from './creditAllocationWorkflow';
import { isSalesDate } from './salesFormValidation';
import { invoiceOpenBalance } from './utils';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

export type PaymentReview = { balanceCents: number; bankAccountId: string };
export type PaymentDraft = { amount: string; date: string; method: string; reference: string; notes: string };
export type PaymentProblem = { field: keyof PaymentDraft | 'record'; message: string; accounting?: boolean; section?: 'accounts' | 'periods' };
export function paymentProblem(invoice: Invoice | undefined, workspace: Workspace, draft: PaymentDraft, today: string): PaymentProblem | null {
  if (!invoice || invoice.type==='credit_note' || !['issued','overdue','partially_paid','paid'].includes(invoice.status) || !invoice.number) return {field:'record',message:'Retrouvez une facture émise et active avant d’enregistrer un paiement. Actualisez les factures si nécessaire.'};
  const balance=invoiceOpenBalance(invoice,workspace.invoices,workspace.payments), amount=creditAmount(draft.amount);
  if (!Number.isSafeInteger(balance)||balance<=0) return {field:'record',message:'Cette facture n’a plus de montant à encaisser. Actualisez son historique pour consulter les paiements et avoirs.'};
  if (!amount||amount>9_000_000_000_000_000) return {field:'amount',message:'Recopiez le montant réellement reçu, supérieur à zéro, avec deux décimales maximum. Exemple : 125,50.'};
  if (amount>balance) return {field:'amount',message:'Ce montant dépasse le reste à encaisser. Vérifiez le virement reçu et le solde de la facture.'};
  const minimum=[invoice.issueDate,...(invoice.creditSettlements??[]).filter(row=>row.invoiceId===invoice.id).map(row=>row.date),...workspace.invoices.flatMap(row=>(row.creditSettlements??[]).filter(event=>event.invoiceId===invoice.id).map(event=>event.date))].sort().at(-1)!;
  if (!isSalesDate(draft.date)||draft.date<minimum||draft.date>today) return {field:'date',message:`Indiquez le jour réel de réception, entre le ${minimum.split('-').reverse().join('.')} et aujourd’hui.${minimum>invoice.issueDate?' Cette limite tient compte des avoirs déjà appliqués à cette facture.':''}`};
  for (const [field,max,label] of [['method',80,'Le mode de paiement'],['reference',160,'La référence'],['notes',5000,'La note']] as const) {
    if ((field==='method'&&!draft[field].trim()) || [...draft[field].trim()].length>max || draft[field].includes('\0')) return {field,message:`${label} ${field==='method'?'est requis et ':''}doit contenir au maximum ${max} caractères.`};
  }
  const bank=workspace.accounts.find(row=>row.id===workspace.accountingSettings?.bankAccountId);
  if (!workspace.accountingSettings?.enabled || !bank?.active || bank.accountType!=='asset') return {field:'record',message:'Choisissez un compte bancaire actif dans les réglages comptables pour enregistrer l’argent reçu.',accounting:true};
  return null;
}
export function paymentNativeProblem(message:string):PaymentProblem {
  if (/changé depuis|solde restant|dépasse le solde/i.test(message)) return {field:'record',message:'Le solde ou le compte d’encaissement a changé. Actualisez les factures, puis reprenez la vérification.'};
  if (/période|exercice|clôtur|fermée/i.test(message)) return {field:'record',message:'Cette date appartient à un exercice fermé. Ouvrez la comptabilité pour vérifier l’exercice. Corrigez la date uniquement si elle a été mal recopiée.',accounting:true,section:'periods'};
  if (/compt|écriture|liaison/i.test(message)) return {field:'record',message:'La comptabilisation doit être vérifiée avant d’enregistrer ce paiement. Ouvrez les réglages comptables ; le message détaillé précise le point concerné.',accounting:true};
  return {field:'record',message:'Le paiement n’a pas pu être confirmé. Vos informations restent présentes. Actualisez les factures avant de réessayer.'};
}
export type PaymentIntent = Omit<PaymentDraft,'amount'> & {requestId:string;invoiceId:string;amountCents:number};
export function requirePaymentWorkspace(workspace:Workspace) {
  if (!workspace.onboardingCompleted||!workspace.settings||!Array.isArray(workspace.invoices)||!Array.isArray(workspace.payments)||!Array.isArray(workspace.accounts)) throw Error('Les factures, paiements et comptes doivent être relus avant de continuer.');
}
export function paymentWasRecorded(workspace:Workspace,intent:PaymentIntent) {
  requirePaymentWorkspace(workspace);
  return workspace.invoices.some(row=>row.id===intent.invoiceId)&&workspace.payments.some(row=>row.id===intent.requestId&&row.invoiceId===intent.invoiceId&&row.amountCents===intent.amountCents&&row.date===intent.date&&row.method===intent.method.trim()&&row.reference===intent.reference.trim()&&(row.notes??'')===intent.notes.trim()&&Boolean(row.journalEntryId)&&row.journalEntrySemanticallyValid===true);
}
export class PaymentOutcomeUnknownError extends Error {
  constructor(readonly intent:PaymentIntent,readonly mutationCause:unknown){super('La réponse du paiement a été interrompue. Vérifions son enregistrement avant de réessayer.');}
  wasRecorded(workspace:Workspace){return paymentWasRecorded(workspace,this.intent);}
}
export class PaymentRefreshError extends WorkspaceRefreshAfterMutationError {
  constructor(readonly intent:PaymentIntent,cause:unknown){super(cause);}
  validateRead(workspace:Workspace){if(!paymentWasRecorded(workspace,this.intent))throw Error('Le paiement et son lien comptable ne figurent pas encore dans les données relues. Actualisez sans enregistrer un autre paiement.');}
}
export async function runPaymentMutation(intent:PaymentIntent,write:()=>Promise<unknown>,load:()=>Promise<Workspace>){
  try{await write();}catch(cause){throw new PaymentOutcomeUnknownError(intent,cause);}
  try{const next=await load();new PaymentRefreshError(intent,null).validateRead(next);return next;}catch(cause){throw new PaymentRefreshError(intent,cause);}
}
