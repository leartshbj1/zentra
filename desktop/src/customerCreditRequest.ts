import type { desktopApi } from './bridge';
export type PendingCustomerCreditRequest = {
  input: Parameters<typeof desktopApi.recordCustomerCreditSettlement>[0];
  reverseId?: string;
};
const key=(creditId:string)=>`zentra.customer-credit-request.v1.${creditId}`;
export function readCustomerCreditRequest(creditId:string):PendingCustomerCreditRequest | undefined {
  if(typeof localStorage==='undefined') return;
  try {
    const raw=localStorage.getItem(key(creditId));if(!raw)return;
    const value=JSON.parse(raw) as PendingCustomerCreditRequest;
    const input=value?.input;
    if(input?.creditNoteId!==creditId || typeof input.requestId!=='string' || !/^[a-f\d-]{36}$/i.test(input.requestId)
      || !['apply','refund'].includes(input.eventType) || !Number.isSafeInteger(input.amountCents) || input.amountCents<=0
      || !['date','reference','reason'].every((field)=>typeof input[field as keyof typeof input]==='string')
      || (input.invoiceId!==null&&typeof input.invoiceId!=='string') || (input.bankAccountId!==null&&typeof input.bankAccountId!=='string')
      || (value.reverseId!==undefined&&typeof value.reverseId!=='string')) return;
    return value;
  } catch {return;}
}
export function saveCustomerCreditRequest(value:PendingCustomerCreditRequest) {
  localStorage.setItem(key(value.input.creditNoteId),JSON.stringify(value));
}
export function clearCustomerCreditRequest(creditId:string) {
  try {localStorage.removeItem(key(creditId));} catch { /* The same completed request remains safe to replay. */ }
}
