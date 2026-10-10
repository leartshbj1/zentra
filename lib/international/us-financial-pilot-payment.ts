import { validDate } from './accounting/ledger';
import { ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { decimalToMoney } from './money';

/** Local decimal input, never a grouped amount, exponent or rounded float. */
export function parseUsFinancialPilotPaymentAmount(input:string):string{
  const normalized=typeof input==='string'?input.trim().replace(',','.'):'';
  if(!/^(0|[1-9][0-9]{0,33})(?:\.[0-9]{1,2})?$/.test(normalized))throw new ErpError('invalid_financial_pilot_request',422);
  const minor=decimalToMoney('USD',normalized).minorUnits;
  if(BigInt(minor)<=BigInt(0))throw new ErpError('invalid_financial_pilot_request',422);
  return minor;
}

export interface UsFinancialPilotPaymentRequest {
  readonly consumer:'financial-pilot';
  readonly schemaVersion:1;
  readonly requestId:string;
  readonly expectedRevision:number;
  readonly command:Readonly<{type:'customer_payment';invoiceId:string;amountMinor:string;paymentDate:string;accountingDate:string;periodId:string;reference:string}>;
}
export interface UsFinancialPilotPaymentReceipt {
  readonly consumer:'financial-pilot'; readonly schemaVersion:1; readonly organizationId:string;
  readonly revision:number; readonly entityId:string; readonly action:'customer_payment';
}
export function usFinancialPilotPaymentEntityId(requestId:string):string{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId))throw new ErpError('invalid_financial_pilot_request',422);
  return `pilot-payment:${requestId}`;
}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new ErpError('invalid_financial_pilot_request',422);
  return value as Record<string,unknown>;
}
function text(value:unknown,maximum=160):string{
  if(typeof value!=='string'||!value||value!==value.trim()||value.length>maximum||/\p{Cc}/u.test(value))throw new ErpError('invalid_financial_pilot_request',422);
  return value;
}
export function validateUsFinancialPilotPaymentRequest(value:unknown):UsFinancialPilotPaymentRequest{
  let saved:unknown;try{saved=snapshotPrivateJson(value);}catch{throw new ErpError('invalid_financial_pilot_request',422);}
  const r=exact(saved,['consumer','schemaVersion','requestId','expectedRevision','command']);
  if(r.consumer!=='financial-pilot'||r.schemaVersion!==1||typeof r.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.requestId)||!Number.isSafeInteger(r.expectedRevision)||(r.expectedRevision as number)<1||(r.expectedRevision as number)>=Number.MAX_SAFE_INTEGER)throw new ErpError('invalid_financial_pilot_request',422);
  const c=exact(r.command,['type','invoiceId','amountMinor','paymentDate','accountingDate','periodId','reference']);
  if(c.type!=='customer_payment'||typeof c.amountMinor!=='string'||!/^[1-9][0-9]{0,35}$/.test(c.amountMinor)||typeof c.paymentDate!=='string'||!validDate(c.paymentDate)||c.paymentDate.startsWith('0000-')||typeof c.accountingDate!=='string'||!validDate(c.accountingDate)||c.accountingDate.startsWith('0000-'))throw new ErpError('invalid_financial_pilot_request',422);
  return Object.freeze({consumer:'financial-pilot',schemaVersion:1,requestId:r.requestId,expectedRevision:r.expectedRevision as number,command:Object.freeze({type:'customer_payment',invoiceId:text(c.invoiceId),amountMinor:c.amountMinor,paymentDate:c.paymentDate,accountingDate:c.accountingDate,periodId:text(c.periodId),reference:text(c.reference,500)})});
}
export function validateUsFinancialPilotPaymentReceipt(value:unknown,organizationId:string,expected?:UsFinancialPilotPaymentRequest):UsFinancialPilotPaymentReceipt{
  let saved:unknown;try{saved=snapshotPrivateJson(value);}catch{throw new ErpError('invalid_financial_pilot_response',503);}
  try{
    const r=exact(saved,['consumer','schemaVersion','organizationId','revision','entityId','action']);
    if(r.consumer!=='financial-pilot'||r.schemaVersion!==1||r.organizationId!==organizationId||!Number.isSafeInteger(r.revision)||(r.revision as number)<1||(r.revision as number)>=Number.MAX_SAFE_INTEGER||r.action!=='customer_payment')throw new Error();
    if(expected&&(r.entityId!==usFinancialPilotPaymentEntityId(expected.requestId)||r.revision!==expected.expectedRevision+1))throw new Error();
    return Object.freeze({consumer:'financial-pilot',schemaVersion:1,organizationId,revision:r.revision as number,entityId:text(r.entityId),action:'customer_payment'});
  }catch{throw new ErpError('invalid_financial_pilot_response',503);}
}
