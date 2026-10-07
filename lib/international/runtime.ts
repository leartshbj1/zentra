import { sha256Hex } from '../account-security';
import { validateCompanyConfiguration } from './country-config';
import { nationalAdapter } from './countries/adapters';
import { createLedger, closePeriod, LedgerError, minorInteger, type FinancialAuthority } from './accounting/ledger';
import { postCustomerInvoice, postCustomerPayment } from './accounting/postings';
import { validateEstimate, estimateTotals, buildTaxRequest, invoiceFromEstimate, recordCustomerPayment, lineTotals, validatePublicSellerSnapshot, type PublicSellerSnapshot, type InvoicingAuthority, type TaxCalculationProvider } from './invoicing';
import { money } from './money';
import { parseInstant } from './localization';
import type { CompanyConfiguration } from './types';
import type { ErpCommand, ErpCommit, ErpHeader, ErpReceipt, ErpState, ErpStore } from './runtime-types';

import { ErpError,canonicalErpJson } from './erp-contract';
import { validateErpRequest } from './erp-request';
export { ErpError,canonicalErpJson } from './erp-contract';
export { validateErpRequest } from './erp-request';
function authorize(config: CompanyConfiguration, actor: FinancialAuthority, command?: ErpCommand): void {
  if (actor.organizationId !== config.organizationId) throw new ErpError('tenant_mismatch',403);
  if (!actor.managementEntitled) throw new ErpError('management_entitlement_required',402);
  if(typeof actor.userId!=='string'||!actor.userId.trim()||actor.userId.length>256||Array.from(actor.userId).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127))throw new ErpError('invalid_request');
  parseInstant(actor.timestamp);
  if (!['owner','admin','accountant','member','read_only'].includes(actor.role)) throw new ErpError('forbidden',403);
  if (!command) return;
  if (['initialize','refresh_configuration'].includes(command.type) && actor.role !== 'owner') throw new ErpError('owner_required',403);
  const financial = ['issue_invoice','record_payment','close_period'].includes(command.type);
  if (actor.role === 'read_only' || (financial && !['owner','admin','accountant'].includes(actor.role))) throw new ErpError('financial_permission_required',403);
}
const canonical = canonicalErpJson;
function replace<T extends {id:string}>(rows: readonly T[], value: T): readonly T[] { return [...rows.filter(row=>row.id !== value.id),value]; }
function nextCounter(n: number): number { if (!Number.isSafeInteger(n) || n < 0 || n >= Number.MAX_SAFE_INTEGER - 1) throw new ErpError('number_sequence_exhausted',409); return n+1; }
function periodOpen(state: ErpState, periodId: string, accountingDate: string): void {
  const p = state.ledger.periods.find(p=>p.id===periodId);
  if (!p || p.status !== 'open' || accountingDate < p.start || accountingDate > p.end) throw new ErpError('accounting_period_not_open',409);
}
export function erpHeader(state: ErpState): ErpHeader {
  const { entries: _entries, audit: _audit, ...ledger } = state.ledger;
  return {schemaVersion:1,revision:state.revision,configuration:state.configuration,counters:state.counters,ledger};
}
export function erpCommit(before: ErpState | null, after: ErpState, receipt: ErpReceipt, actor: FinancialAuthority): ErpCommit {
  const changes: ErpCommit['changes'][number][] = [];
  const groups = [['customer',before?.customers,after.customers],['estimate',before?.estimates,after.estimates],['invoice',before?.invoices,after.invoices],['journal',before?.ledger.entries,after.ledger.entries]] as const;
  for (const [kind,oldRows,rows] of groups) for (const row of rows) {
    const old = oldRows?.find(old=>old.id===row.id);
    if (!old || canonical(old)!==canonical(row)) changes.push({kind,id:row.id,payload:row});
  }
  return {organizationId:after.configuration.organizationId,expectedRevision:before?.revision??0,header:erpHeader(after),changes,ledgerAudit:after.ledger.audit.slice(before?.ledger.audit.length??0),receipt,actor};
}
export interface ErpExecutionDependencies {
  readonly store: ErpStore;
  readonly configuration: CompanyConfiguration;
  readonly actor: FinancialAuthority;
  /** Rechecks subscription, role, session and workspace after any external calculation. */
  revalidate(): Promise<FinancialAuthority>;
  taxProvider(configuration: CompanyConfiguration): Promise<TaxCalculationProvider | null>;
  projectExists?(organizationId:string,projectId:string):Promise<boolean>;
  seller?(configuration:CompanyConfiguration):Promise<PublicSellerSnapshot|null>;
}
/** All document/journal/number/payment changes leave the service in ONE atomic store commit. */
export async function executeErp(dependencies: ErpExecutionDependencies, input: unknown): Promise<{receipt:ErpReceipt;replayed:boolean}> {
  const config = validateCompanyConfiguration(dependencies.configuration);
  // First deployment is deliberately US-only. Never initialize or replace a historical Swiss book.
  if (config.country !== 'US') throw new ErpError('edition_unavailable',409);
  authorize(config,dependencies.actor);
  const request = validateErpRequest(input,config.organizationId);
  const command = request.command;
  authorize(config,dependencies.actor,command);
  const hash = await sha256Hex(canonical([config.organizationId,dependencies.actor.userId,request]));
  const existing = await dependencies.store.receipt(config.organizationId,request.idempotencyKey);
  if (existing) { if (existing.commandHash !== hash) throw new ErpError('idempotency_conflict',409); return {receipt:existing,replayed:true}; }
  const before = await dependencies.store.read(config.organizationId);
  if ((before?.revision??0)!==request.expectedRevision) throw new ErpError('revision_conflict',409);
  if (before && canonical(before.configuration)!==canonical(config) && command.type !== 'refresh_configuration') throw new ErpError('configuration_changed',409);
  let state: ErpState; let entityId: string;
  if (command.type === 'initialize') {
    if (before) throw new ErpError('already_initialized',409);
    state = {schemaVersion:1,revision:1,configuration:config,counters:{estimate:0,invoice:0},ledger:createLedger({organizationId:config.organizationId,currency:config.currency,basis:config.accountingBasis,accounts:nationalAdapter(config.country).starterChart,periods:command.periods}),customers:[],estimates:[],invoices:[]};
    entityId = config.organizationId;
  } else {
    if (!before) throw new ErpError('workspace_not_initialized',409);
    state = {...before,revision:nextCounter(before.revision)};
    switch (command.type) {
      case 'refresh_configuration': {
        const immutable = (c:CompanyConfiguration)=>[c.schemaVersion,c.organizationId,c.country,c.currency,c.accountingBasis];
        if (canonical(immutable(before.configuration))!==canonical(immutable(config))) throw new ErpError('jurisdiction_locked',409);
        state={...state,configuration:config}; entityId=config.organizationId; break;
      }
      case 'save_customer': state = {...state,customers:replace(state.customers,command.customer)}; entityId=command.customer.id; break;
      case 'save_estimate': {
        const previous = state.estimates.find(q=>q.id===command.id);
        if ((previous?.revision??0)!==command.expectedEstimateRevision) throw new ErpError('estimate_revision_conflict',409);
        if (state.invoices.some(i=>i.sourceEstimateId===command.id)) throw new ErpError('issued_estimate_locked',409);
        const customer = state.customers.find(c=>c.id===command.customerId); if (!customer) throw new ErpError('customer_required');
        if(command.projectId && (!dependencies.projectExists || !await dependencies.projectExists(config.organizationId,command.projectId))) throw new ErpError('project_not_found',422);
        command.lines.forEach(line=>lineTotals(line,config.currency));
        const counter = previous ? state.counters.estimate : nextCounter(state.counters.estimate);
        const estimate = validateEstimate(config,{...command,organizationId:config.organizationId,currency:config.currency,revision:nextCounter(previous?.revision??0),number:previous?.number??`EST-${String(counter).padStart(6,'0')}`,customer,status:'draft'});
        Object.values(estimateTotals(estimate)).forEach(total=>minorInteger(total.minorUnits));
        // Do not persist command-specific keys into document data.
        const {type:_type,expectedEstimateRevision:_expected,customerId:_customer,...document} = estimate as typeof estimate & typeof command;
        state = {...state,counters:{...state.counters,estimate:counter},estimates:replace(state.estimates,document)}; entityId=document.id; break;
      }
      case 'accept_estimate': {
        const estimate = state.estimates.find(q=>q.id===command.estimateId); if (!estimate) throw new ErpError('estimate_not_found',404);
        if (estimate.revision!==command.expectedEstimateRevision) throw new ErpError('estimate_revision_conflict',409);
        if (state.invoices.some(i=>i.sourceEstimateId===estimate.id)) throw new ErpError('issued_estimate_locked',409);
        state = {...state,estimates:replace(state.estimates,{...estimate,revision:nextCounter(estimate.revision),status:'accepted'})}; entityId=estimate.id; break;
      }
      case 'issue_invoice': {
        const estimate = state.estimates.find(q=>q.id===command.estimateId); if (!estimate) throw new ErpError('estimate_not_found',404);
        if (estimate.revision!==command.expectedEstimateRevision) throw new ErpError('estimate_revision_conflict',409);
        if (state.invoices.some(i=>i.id===command.id || i.sourceEstimateId===estimate.id)) throw new ErpError('invoice_already_issued',409);
        periodOpen(state,command.periodId,command.accountingDate);
        const provider = await dependencies.taxProvider(config);
        if (!provider || config.taxConfiguration.status !== 'configured') throw new LedgerError('TAX_CONFIGURATION_REQUIRED');
        const publicSeller = await dependencies.seller?.(config);
        if(!publicSeller)throw new ErpError('seller_configuration_required',409);
        const seller=validatePublicSellerSnapshot(publicSeller,config.organizationId);
        // Provider receives the invoice transaction date, not the earlier estimate date.
        const assessment = await provider.calculate(buildTaxRequest(config,estimate,command.date));
        const actor = await dependencies.revalidate(); authorize(config,actor,command);
        if (actor.userId!==dependencies.actor.userId) throw new ErpError('session_changed',401);
        const n = nextCounter(state.counters.invoice);
        const invoice = invoiceFromEstimate(config,estimate,{id:command.id,number:`${config.invoiceNumberPrefix}-${String(n).padStart(6,'0')}`,date:command.date,accountingDate:command.accountingDate,dueDate:command.dueDate},assessment,{...actor,canIssue:true} satisfies InvoicingAuthority,seller);
        state = {...state,counters:{...state.counters,invoice:n},invoices:[...state.invoices,invoice],ledger:postCustomerInvoice(config,state.ledger,invoice,command.periodId,actor)}; entityId=invoice.id; break;
      }
      case 'record_payment': {
        const invoice = state.invoices.find(i=>i.id===command.invoiceId); if (!invoice) throw new ErpError('invoice_not_found',404);
        periodOpen(state,command.periodId,command.accountingDate);
        const payment = {id:command.id,idempotencyKey:request.idempotencyKey,organizationId:config.organizationId,invoiceId:invoice.id,amount:money(config.currency,command.amountMinor),paymentDate:command.paymentDate,accountingDate:command.accountingDate,reference:command.reference,recordedBy:dependencies.actor.userId};
        const paid = recordCustomerPayment(config,invoice,payment,{...dependencies.actor,canIssue:true});
        state = {...state,invoices:replace(state.invoices,paid),ledger:postCustomerPayment(config,state.ledger,invoice,payment,command.periodId,dependencies.actor)}; entityId=command.id; break;
      }
      case 'close_period': state={...state,ledger:closePeriod(state.ledger,command.periodId,dependencies.actor,state.ledger.revision)}; entityId=command.periodId; break;
    }
  }
  const fresh = await dependencies.revalidate(); authorize(config,fresh,command);
  if (fresh.userId!==dependencies.actor.userId) throw new ErpError('session_changed',401);
  const receipt: ErpReceipt = {idempotencyKey:request.idempotencyKey,commandHash:hash,revision:state.revision,entityId,action:command.type};
  // Transport uncertainty is surfaced; caller retries the SAME request/key, never a new mutation.
  return {receipt:await dependencies.store.commit(erpCommit(before,state,receipt,fresh)),replayed:false};
}
