import {customerCreditRequestScopeKey,type CustomerCreditRequestScope} from './customerCreditRequest';
export {customerCreditRequestScopeKey as creditRecoveryScopeKey};
export type CreditRecoveryScope=CustomerCreditRequestScope;
export type CustomerCreditRecoveryPlan = {
  sourceToken: string; originalInvoiceId: string; number: string; currency: string;
  invoiceTotalCents: number; paidCents: number; blocker: string | null;
  receivedVat?: boolean;
  credits: {id: string; number: string; totalCents: number; issueDate: string; earliestApplicationDate: string}[];
};
export type CustomerCreditRecoveryInput = {
  requestId: string; originalInvoiceId: string; sourceToken: string; reference: string; reason: string;
  noPriorRefund: boolean;
  confirmVatReconciliation?: boolean;
  credits: {creditNoteId: string; appliedCents: number; applicationDate: string | null}[];
};
export type CustomerCreditRecoveryPreview = {
  originalInvoiceId: string; number: string; currency: string; invoiceRemainingCents: number;
  credits: {creditNoteId: string; number: string; allocatedCents: number; remainingCents: number}[];
  receivedVat?: boolean;
  vatAdjustments?: {sourceType:string;sourceId:string;date:string;reference:string;expectedVatCents:number;dueChangeCents:number}[];
};
export type PendingCreditRecovery = {input: CustomerCreditRecoveryInput; preview: CustomerCreditRecoveryPreview};
const storageKey=(id:string,scope?:CreditRecoveryScope|null)=>scope===undefined?`zentra.customer-credit-recovery.v1.${id}`:`zentra.customer-credit-recovery.v2.${encodeURIComponent(JSON.stringify([customerCreditRequestScopeKey(scope),id]))}`;
export function readCreditRecovery(id:string,scope?:CreditRecoveryScope|null): PendingCreditRecovery | undefined {
  if(scope!==undefined&&!customerCreditRequestScopeKey(scope))return;
  try {
    const stored=JSON.parse(localStorage.getItem(storageKey(id,scope)) || 'null');
    if(scope!==undefined&&(stored?.version!==2||stored.scope!==customerCreditRequestScopeKey(scope)))return;
    const value=(scope===undefined?stored:stored.request) as PendingCreditRecovery|null;
    if(!value || value.input?.originalInvoiceId!==id || value.preview?.originalInvoiceId!==id || !/^[a-f\d-]{36}$/i.test(value.input.requestId)
      || !value.input.noPriorRefund || !['sourceToken','reference','reason'].every(key=>typeof value.input[key as keyof CustomerCreditRecoveryInput]==='string')
      || !Array.isArray(value.input.credits) || !value.input.credits.length || !value.input.credits.every(c=>typeof c.creditNoteId==='string'&&Number.isSafeInteger(c.appliedCents)&&c.appliedCents>=0&&(c.applicationDate===null||typeof c.applicationDate==='string'))
      || (value.preview.receivedVat && (!value.input.confirmVatReconciliation || !Array.isArray(value.preview.vatAdjustments) || !value.preview.vatAdjustments.every(a=>typeof a.date==='string'&&typeof a.reference==='string'&&Number.isSafeInteger(a.dueChangeCents)&&Number.isSafeInteger(a.expectedVatCents))))
      || typeof value.preview.currency!=='string' || !Number.isSafeInteger(value.preview.invoiceRemainingCents) || !Array.isArray(value.preview.credits)
      || !value.preview.credits.every(c=>typeof c.creditNoteId==='string'&&Number.isSafeInteger(c.allocatedCents)&&Number.isSafeInteger(c.remainingCents))) return;
    return value;
  } catch {return;}
}
export class CreditRecoveryPendingConflictError extends Error {constructor(){super('Une autre demande de reprise reste à vérifier. Relisez son historique avant de continuer.');}}
export function requireCreditRecoveryAdmission(id:string,scope:CreditRecoveryScope|null,expected?:PendingCreditRecovery){
  if(!customerCreditRequestScopeKey(scope))throw Error('L’identité de cette entreprise doit être vérifiée avant de conserver la demande.');
  const raw=localStorage.getItem(storageKey(id,scope));if(raw===null)return;
  const retained=readCreditRecovery(id,scope);if(!retained||!expected||JSON.stringify(retained.input)!==JSON.stringify(expected.input))throw new CreditRecoveryPendingConflictError();
}
export function saveCreditRecovery(value:PendingCreditRecovery,scope?:CreditRecoveryScope|null) {
  if(scope!==undefined&&!customerCreditRequestScopeKey(scope))throw Error('L’identité de cette entreprise doit être vérifiée avant de conserver la demande.');
  if(scope!==undefined)requireCreditRecoveryAdmission(value.input.originalInvoiceId,scope,value);
  localStorage.setItem(storageKey(value.input.originalInvoiceId,scope),JSON.stringify(scope===undefined?value:{version:2,scope:customerCreditRequestScopeKey(scope),request:value}));
}
export function clearCreditRecovery(id:string,scope?:CreditRecoveryScope|null,expected?:PendingCreditRecovery) {if(scope!==undefined&&!customerCreditRequestScopeKey(scope))return;try{if(scope!==undefined)requireCreditRecoveryAdmission(id,scope,expected);localStorage.removeItem(storageKey(id,scope));}catch{/* Keep the exact completed receipt. */}}
const legacyDecisionKey=(id:string,scope:CreditRecoveryScope)=>`zentra.customer-credit-recovery-legacy-review.v1.${encodeURIComponent(JSON.stringify([customerCreditRequestScopeKey(scope),id]))}`;
export function legacyCreditRecoveryToken(id:string){return localStorage.getItem(storageKey(id));}
export function legacyCreditRecoveryReviewRequired(id:string,scope:CreditRecoveryScope|null){
  if(!customerCreditRequestScopeKey(scope))return false;
  try{const raw=legacyCreditRecoveryToken(id);if(raw===null)return false;const decision=JSON.parse(localStorage.getItem(legacyDecisionKey(id,scope!))||'null');return decision?.version!==1||decision.scope!==customerCreditRequestScopeKey(scope)||decision.originalInvoiceId!==id||!['other-company','assigned-here','completed-here'].includes(decision.decision)||decision.sourceRaw!==raw;}catch{return true;}
}
function requireLegacyCreditRecovery(id:string,scope:CreditRecoveryScope|null,expectedRaw:string){
  if(!customerCreditRequestScopeKey(scope))throw Error('L’identité de cette entreprise doit être vérifiée avant de conserver la vérification.');
  const raw=legacyCreditRecoveryToken(id);if(raw===null||raw!==expectedRaw)throw Error('L’ancienne demande a changé. Vérifiez à nouveau l’historique avant de choisir.');return raw;
}
export function adoptLegacyCreditRecovery(id:string,scope:CreditRecoveryScope|null,expectedRaw:string){
  requireLegacyCreditRecovery(id,scope,expectedRaw);const pending=readCreditRecovery(id);if(!pending)throw Error('L’ancienne reprise ne peut pas être relue. Vérifiez son dossier dans l’entreprise d’origine.');saveCreditRecovery(pending,scope);localStorage.setItem(legacyDecisionKey(id,scope!),JSON.stringify({version:1,scope:customerCreditRequestScopeKey(scope),originalInvoiceId:id,decision:'assigned-here',sourceRaw:expectedRaw}));return pending;
}
export function acknowledgeLegacyCreditRecoveryOtherCompany(id:string,scope:CreditRecoveryScope|null,expectedRaw:string){
  const raw=requireLegacyCreditRecovery(id,scope,expectedRaw);localStorage.setItem(legacyDecisionKey(id,scope!),JSON.stringify({version:1,scope:customerCreditRequestScopeKey(scope),originalInvoiceId:id,decision:'other-company',sourceRaw:raw}));
}
export function completeLegacyCreditRecovery(id:string,scope:CreditRecoveryScope|null,pending:PendingCreditRecovery){
  if(!customerCreditRequestScopeKey(scope))return;try{const raw=legacyCreditRecoveryToken(id),legacy=readCreditRecovery(id);if(raw===null||!legacy||JSON.stringify(legacy)!==JSON.stringify(pending))return;localStorage.setItem(legacyDecisionKey(id,scope!),JSON.stringify({version:1,scope:customerCreditRequestScopeKey(scope),originalInvoiceId:id,decision:'completed-here',sourceRaw:raw}));}catch{/* A retained legacy receipt stays quarantined. */}
}
export const definitiveRecoveryError=(message:string)=>/^(Champ invalide|Erreur de base de données locale|Enregistrement introuvable|Données JSON invalides)/.test(message);
