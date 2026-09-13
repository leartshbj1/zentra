import type { SupplierCreditNote, SupplierCreditRefund, Workspace } from './types';
import { creditAmount } from './creditAllocationWorkflow';
import { supplierRefundDateError } from './supplierCreditRefunds';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

export type SupplierRefundReview = { availableCents: number; bankAccountId: string };
export type SupplierRefundDraft = { amount: string; date: string; reference: string; reason: string };
export type SupplierRefundProblem = { field: keyof SupplierRefundDraft | 'record'; message: string; destination?: 'accounts' | 'periods' | 'bank' };
export function supplierRefundAvailable(credit?: SupplierCreditNote) {
  if (!credit || ![credit.totalCents,credit.allocatedCents,credit.refundedCents].every(value=>Number.isSafeInteger(value)&&value>=0)) return null;
  const available=credit.totalCents-credit.allocatedCents-credit.refundedCents;
  return Number.isSafeInteger(available)&&available>=0 ? available : null;
}
export function supplierRefundProblem(credit: SupplierCreditNote | undefined, refund: SupplierCreditRefund | undefined, reversing: boolean, draft: SupplierRefundDraft, workspace: Workspace, today: string): SupplierRefundProblem | null {
  if (!credit || credit.status !== 'validated' || credit.currency !== 'CHF') return {field:'record',message:'Retrouvez un avoir validé en CHF dans Factures et avoirs avant d’enregistrer un remboursement.'};
  if (reversing && (!refund || refund.eventType!=='refund' || refund.supplierCreditNoteId!==credit.id || credit.refunds.some(row=>row.eventType==='reverse'&&row.reversesId===refund.id))) return {field:'record',message:'Ce remboursement a déjà été corrigé ou n’est plus accessible. Actualisez les avoirs pour retrouver son historique.'};
  const available=supplierRefundAvailable(credit);
  if (available===null) return {field:'record',message:'Le disponible sur l’avoir ne peut pas encore être lu. Actualisez les avoirs avant de continuer.'};
  const amount=reversing?refund?.amountCents:creditAmount(draft.amount);
  if (!amount || amount>9_000_000_000_000_000 || !Number.isSafeInteger(amount) || amount<=0) return {field:'amount',message:'Recopiez le montant réellement reçu, supérieur à zéro, avec deux décimales maximum. Exemple : 125,50.'};
  if (!reversing&&amount>available) return {field:'amount',message:'Ce montant dépasse le disponible sur l’avoir après ses utilisations et remboursements. Vérifiez le virement reçu ou actualisez les avoirs.'};
  if (reversing&&!Number.isSafeInteger(available+amount)) return {field:'record',message:'Le nouveau solde dépasse la capacité de calcul. Vérifiez les montants du dossier.'};
  const minimum=[credit.documentDate,refund?.date||''].sort().at(-1)!;
  if (supplierRefundDateError(draft.date,minimum,today)) return {field:'date',message:`Indiquez le jour réel de ${reversing?'la correction':'réception du virement'}, entre le ${minimum.split('-').reverse().join('.')} et aujourd’hui.`};
  if (!reversing&&(!draft.reference.trim() || [...draft.reference.trim()].length>255 || draft.reference.includes('\0'))) return {field:'reference',message:'Recopiez une référence du virement ou son libellé bancaire, en 255 caractères maximum.'};
  if ([...draft.reason.trim()].length<5 || [...draft.reason.trim()].length>1000 || draft.reason.includes('\0')) return {field:'reason',message:'Expliquez brièvement cette opération en 5 à 1 000 caractères. Exemple : « Retour de marchandises ».'};
  const bankId=reversing?refund?.bankAccountId:workspace.accountingSettings?.bankAccountId;
  const bank=workspace.accounts.find(row=>row.id===bankId);
  if ((!reversing&&!workspace.accountingSettings?.enabled) || !bank?.active || bank.accountType!=='asset') return {field:'record',message:reversing?'Le compte bancaire du remboursement initial doit être actif pour enregistrer sa correction. Vérifiez le plan comptable.':'Choisissez un compte bancaire actif dans Plan & liaisons pour enregistrer ce virement.',destination:'accounts'};
  return null;
}
export function supplierRefundNativeProblem(message: string): SupplierRefundProblem {
  if (/Dissociez|rapproch|relevé/i.test(message)) return {field:'record',message:'Ce remboursement est lié à un mouvement bancaire. Ouvrez Banque, retrouvez le mouvement et dissociez son rapprochement avant de corriger le remboursement.',destination:'bank'};
  if (/période|exercice|clôtur|fermée/i.test(message)) return {field:'record',message:'La date choisie appartient à un exercice fermé. Vérifiez cet exercice. Ne changez la date que si elle a été mal recopiée.',destination:'periods'};
  if (/changé depuis/i.test(message)) return {field:'record',message:'Le disponible sur l’avoir ou le compte bancaire a changé. Actualisez les avoirs, puis relisez le remboursement avant de confirmer.'};
  if (/compte|liaison/i.test(message)) return {field:'record',message:'Un compte nécessaire à cette écriture doit être vérifié dans Plan & liaisons. Votre saisie est conservée.',destination:'accounts'};
  if (/solde|disponible|changé/i.test(message)) return {field:'record',message:'Le solde de l’avoir a changé. Actualisez les avoirs, puis relisez le montant avant de confirmer.'};
  return {field:'record',message:'Le remboursement n’a pas pu être confirmé. Actualisez son historique avant de réessayer ; votre saisie reste présente.'};
}
export type SupplierRefundIntent = {kind:'refund'|'reverse';requestId:string;date:string;reason:string;creditId?:string;amountCents?:number;reference?:string;refundId?:string};
export function requireSupplierRefundWorkspace(workspace:Workspace) {
  if (!workspace.onboardingCompleted||!workspace.settings||!Array.isArray(workspace.supplierCreditNotes)||!Array.isArray(workspace.accounts)||workspace.supplierCreditNotes.some(row=>!Array.isArray(row.refunds))) throw Error('Les avoirs, les remboursements et les comptes doivent être accessibles. Réessayez l’actualisation.');
}
export function supplierRefundWasRecorded(workspace:Workspace,intent:SupplierRefundIntent) {
  requireSupplierRefundWorkspace(workspace);
  return workspace.supplierCreditNotes.some(credit=>credit.refunds.some(row=>row.requestId===intent.requestId&&row.eventType===intent.kind&&row.date===intent.date&&row.reason===intent.reason.trim()&&Boolean(row.journalEntryId)&& (intent.kind==='refund'?credit.id===intent.creditId&&row.amountCents===intent.amountCents&&row.reference===intent.reference?.trim():row.reversesId===intent.refundId)));
}
export class SupplierRefundOutcomeUnknownError extends Error {
  constructor(readonly intent:SupplierRefundIntent,readonly mutationCause:unknown){super('La réponse du remboursement a été interrompue. Vérifions son historique avant de réessayer.');}
  wasRecorded(workspace:Workspace){return supplierRefundWasRecorded(workspace,this.intent);}
}
export class SupplierRefundRefreshError extends WorkspaceRefreshAfterMutationError {
  constructor(readonly intent:SupplierRefundIntent,cause:unknown){super(cause);}
  validateRead(workspace:Workspace){if(!supplierRefundWasRecorded(workspace,this.intent))throw Error('Le remboursement enregistré et son écriture ne figurent pas encore dans les données relues. Actualisez à nouveau sans renvoyer l’opération.');}
}
export async function runSupplierRefundMutation(intent:SupplierRefundIntent,write:()=>Promise<unknown>,load:()=>Promise<Workspace>){
  try{await write();}catch(reason){throw new SupplierRefundOutcomeUnknownError(intent,reason);}
  try{const next=await load();new SupplierRefundRefreshError(intent,null).validateRead(next);return next;}catch(reason){throw new SupplierRefundRefreshError(intent,reason);}
}
