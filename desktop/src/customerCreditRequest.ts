import type {CustomerSettlementInput} from './customerSettlementWorkflow';
export type PendingCustomerCreditRequest = {
  input: CustomerSettlementInput;
  reverseId?: string;
};
export type CustomerCreditRequestScope={companyId:string;organizationId?:string;memberId?:string};
export function customerCreditRequestScopeKey(scope:CustomerCreditRequestScope|null|undefined):string|null {
  return scope && typeof scope.companyId==='string' && Boolean(scope.companyId.trim()) && typeof scope.memberId==='string' && Boolean(scope.memberId.trim()) && (scope.organizationId===undefined||typeof scope.organizationId==='string') ? JSON.stringify([scope.companyId,scope.organizationId||'',scope.memberId]) : null;
}
const key=(creditId:string,scope?:CustomerCreditRequestScope|null)=>scope===undefined ? `zentra.customer-credit-request.v1.${creditId}` : `zentra.customer-credit-request.v2.${encodeURIComponent(JSON.stringify([customerCreditRequestScopeKey(scope),creditId]))}`;
export function readCustomerCreditRequest(creditId:string,scope?:CustomerCreditRequestScope|null):PendingCustomerCreditRequest | undefined {
  if(typeof localStorage==='undefined'||scope!==undefined&&!customerCreditRequestScopeKey(scope)) return;
  try {
    const raw=localStorage.getItem(key(creditId,scope));if(!raw)return;
    const stored=JSON.parse(raw);
    if(scope!==undefined&&(stored?.version!==2||stored.scope!==customerCreditRequestScopeKey(scope))) return;
    const value=(scope===undefined?stored:stored.request) as PendingCustomerCreditRequest;
    const input=value?.input;
    if(input?.creditNoteId!==creditId || typeof input.requestId!=='string' || !/^[a-f\d-]{36}$/i.test(input.requestId)
      || !['apply','refund'].includes(input.eventType) || !Number.isSafeInteger(input.amountCents) || input.amountCents<=0
      || !['date','reference','reason'].every((field)=>typeof input[field as keyof typeof input]==='string')
      || (input.invoiceId!==null&&typeof input.invoiceId!=='string') || (input.bankAccountId!==null&&typeof input.bankAccountId!=='string')
      || (value.reverseId!==undefined&&typeof value.reverseId!=='string')) return;
    const review=input.expectedReview;
    if(review!==undefined&&(!review||typeof review!=='object'||!Number.isSafeInteger(review.creditAvailableCents)||review.creditAvailableCents<0
      || (review.invoiceBalanceCents!==null&&(!Number.isSafeInteger(review.invoiceBalanceCents)||review.invoiceBalanceCents<0))
      || review.bankAccountId!==input.bankAccountId||typeof review.accountingEnabled!=='boolean')) return;
    return value;
  } catch {return;}
}
export function saveCustomerCreditRequest(value:PendingCustomerCreditRequest,scope?:CustomerCreditRequestScope|null) {
  if(scope!==undefined&&!customerCreditRequestScopeKey(scope)) throw Error('L’identité de cette entreprise doit être vérifiée avant de conserver la demande.');
  localStorage.setItem(key(value.input.creditNoteId,scope),JSON.stringify(scope===undefined?value:{version:2,scope:customerCreditRequestScopeKey(scope),request:value}));
}
export function clearCustomerCreditRequest(creditId:string,scope?:CustomerCreditRequestScope|null) {
  if(scope!==undefined&&!customerCreditRequestScopeKey(scope)) return;
  try {localStorage.removeItem(key(creditId,scope));} catch { /* The same completed request remains safe to replay. */ }
}
const legacyReviewKey=(creditId:string,scope:CustomerCreditRequestScope)=>`zentra.customer-credit-legacy-review.v1.${encodeURIComponent(JSON.stringify([customerCreditRequestScopeKey(scope),creditId]))}`;
// A v1 receipt has no trustworthy company/member origin. Keep it untouched;
// only an explicit human assignment can adopt it or allow a fresh local request.
export function legacyCustomerCreditReviewToken(creditId:string):string|null {return localStorage.getItem(key(creditId));}
export function legacyCustomerCreditReviewRequired(creditId:string,scope:CustomerCreditRequestScope|null):boolean {
  if(!customerCreditRequestScopeKey(scope))return false;
  try {
    const raw=legacyCustomerCreditReviewToken(creditId);if(raw===null)return false;
    const review=JSON.parse(localStorage.getItem(legacyReviewKey(creditId,scope!))||'null');
    return review?.version!==1||review.scope!==customerCreditRequestScopeKey(scope)||review.creditId!==creditId||!['other-company','completed-here'].includes(review.decision)||review.sourceRaw!==raw;
  } catch {return true;}
}
function requireLegacyCustomerCreditReview(creditId:string,scope:CustomerCreditRequestScope|null,expectedRaw:string) {
  if(!customerCreditRequestScopeKey(scope))throw Error('L’identité de cette entreprise doit être vérifiée avant de conserver la vérification.');
  const raw=legacyCustomerCreditReviewToken(creditId);if(raw===null||raw!==expectedRaw)throw Error('L’ancienne demande a changé. Vérifiez à nouveau l’historique avant de choisir.');
  return raw;
}
export function acknowledgeLegacyCustomerCreditOtherCompany(creditId:string,scope:CustomerCreditRequestScope|null,expectedRaw:string) {
  const raw=requireLegacyCustomerCreditReview(creditId,scope,expectedRaw);
  localStorage.setItem(legacyReviewKey(creditId,scope!),JSON.stringify({version:1,scope:customerCreditRequestScopeKey(scope),creditId,decision:'other-company',sourceRaw:raw}));
}
export function adoptLegacyCustomerCreditRequest(creditId:string,scope:CustomerCreditRequestScope|null,expectedRaw:string):PendingCustomerCreditRequest {
  requireLegacyCustomerCreditReview(creditId,scope,expectedRaw);
  const pending=readCustomerCreditRequest(creditId);if(!pending)throw Error('L’ancienne demande ne peut pas être reprise. Vérifiez son règlement dans l’entreprise d’origine.');
  saveCustomerCreditRequest(pending,scope);return pending;
}
export function completeLegacyCustomerCreditRequest(creditId:string,scope:CustomerCreditRequestScope|null,pending:PendingCustomerCreditRequest|undefined) {
  if(!customerCreditRequestScopeKey(scope)||!pending)return;
  try {
    const raw=legacyCustomerCreditReviewToken(creditId),legacy=readCustomerCreditRequest(creditId);
    if(raw===null||!legacy||JSON.stringify(legacy)!==JSON.stringify(pending))return;
    localStorage.setItem(legacyReviewKey(creditId,scope!),JSON.stringify({version:1,scope:customerCreditRequestScopeKey(scope),creditId,decision:'completed-here',sourceRaw:raw}));
  } catch { /* A missing local acknowledgement keeps the old receipt blocked. */ }
}
