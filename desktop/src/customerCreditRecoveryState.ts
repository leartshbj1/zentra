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
const storageKey=(id:string)=>`zentra.customer-credit-recovery.v1.${id}`;
export function readCreditRecovery(id:string): PendingCreditRecovery | undefined {
  try {
    const value=JSON.parse(localStorage.getItem(storageKey(id)) || 'null') as PendingCreditRecovery | null;
    if(!value || value.input?.originalInvoiceId!==id || value.preview?.originalInvoiceId!==id || !/^[a-f\d-]{36}$/i.test(value.input.requestId)
      || !value.input.noPriorRefund || !['sourceToken','reference','reason'].every(key=>typeof value.input[key as keyof CustomerCreditRecoveryInput]==='string')
      || !Array.isArray(value.input.credits) || !value.input.credits.length || !value.input.credits.every(c=>typeof c.creditNoteId==='string'&&Number.isSafeInteger(c.appliedCents)&&c.appliedCents>=0&&(c.applicationDate===null||typeof c.applicationDate==='string'))
      || (value.preview.receivedVat && (!value.input.confirmVatReconciliation || !Array.isArray(value.preview.vatAdjustments) || !value.preview.vatAdjustments.every(a=>typeof a.date==='string'&&typeof a.reference==='string'&&Number.isSafeInteger(a.dueChangeCents)&&Number.isSafeInteger(a.expectedVatCents))))
      || typeof value.preview.currency!=='string' || !Number.isSafeInteger(value.preview.invoiceRemainingCents) || !Array.isArray(value.preview.credits)
      || !value.preview.credits.every(c=>typeof c.creditNoteId==='string'&&Number.isSafeInteger(c.allocatedCents)&&Number.isSafeInteger(c.remainingCents))) return;
    return value;
  } catch {return;}
}
export function saveCreditRecovery(value:PendingCreditRecovery) {localStorage.setItem(storageKey(value.input.originalInvoiceId),JSON.stringify(value));}
export function clearCreditRecovery(id:string) {try{localStorage.removeItem(storageKey(id));}catch{/* A retained completed request can be replayed safely. */}}
export const definitiveRecoveryError=(message:string)=>/^(Champ invalide|Erreur de base de données locale|Enregistrement introuvable|Données JSON invalides)/.test(message);
