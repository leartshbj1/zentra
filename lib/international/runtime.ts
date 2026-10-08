import { sha256Hex } from '../account-security';
import { validateCompanyConfiguration } from './country-config';
import { nationalAdapter } from './countries/adapters';
import { createLedger, closePeriod, LedgerError, minorInteger, type FinancialAuthority } from './accounting/ledger';
import { postCustomerInvoice, postCustomerPayment, postVendorBill, postVendorPayment } from './accounting/postings';
import { recordVendorBill, recordVendorPayment, vendorBillBalance } from './purchasing';
import { validateEstimate, estimateTotals, buildTaxRequest, invoiceFromEstimate, recordCustomerPayment, lineTotals, validatePublicSellerSnapshot, type PublicSellerSnapshot, type InvoicingAuthority, type TaxCalculationProvider } from './invoicing';
import { money } from './money';
import { parseInstant } from './localization';
import { recordProject } from './projects';
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
  const financial = ['issue_invoice','record_payment','close_period','save_vendor','record_vendor_bill','record_vendor_payment','save_projects'].includes(command.type);
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
  return {schemaVersion:state.schemaVersion,revision:state.revision,configuration:state.configuration,counters:state.counters,ledger};
}
export function erpCommit(before: ErpState | null, after: ErpState, receipt: ErpReceipt, actor: FinancialAuthority): ErpCommit {
  const changes: ErpCommit['changes'][number][] = [];
  const groups = [['customer',before?.customers,after.customers],['estimate',before?.estimates,after.estimates],['invoice',before?.invoices,after.invoices],['vendor',before?.vendors,after.vendors??[]],['vendor_bill',before?.vendorBills,after.vendorBills??[]],['vendor_payment',before?.vendorPayments,after.vendorPayments??[]],['project',before?.projects,after.projects??[]],['journal',before?.ledger.entries,after.ledger.entries]] as const;
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
  const purchasing = ['save_vendor','record_vendor_bill','record_vendor_payment'].includes(command.type);
  const capability=dependencies.store.supportedSchemaVersion??1;
  if (purchasing && capability < 2) throw new ErpError('purchasing_unavailable',409);
  if (command.type==='save_projects' && capability < 3) throw new ErpError('projects_unavailable',409);
  const hash = await sha256Hex(canonical([config.organizationId,dependencies.actor.userId,request]));
  const existing = await dependencies.store.receipt(config.organizationId,request.idempotencyKey);
  if (existing) {
    // A persisted receipt is not permission to disclose it after a slow read.
    const fresh=await dependencies.revalidate();authorize(config,fresh,command);
    if(fresh.userId!==dependencies.actor.userId)throw new ErpError('session_changed',401);
    if(existing.commandHash!==hash)throw new ErpError('idempotency_conflict',409);
    return {receipt:existing,replayed:true};
  }
  const before = await dependencies.store.read(config.organizationId);
  if (before && before.schemaVersion > capability) throw new ErpError('client_upgrade_required',409);
  if ((before?.revision??0)!==request.expectedRevision) throw new ErpError('revision_conflict',409);
  if (before && canonical(before.configuration)!==canonical(config) && command.type !== 'refresh_configuration') throw new ErpError('configuration_changed',409);
  let state: ErpState; let entityId: string;
  let finalizePurchase: ((actor:FinancialAuthority)=>void)|null=null;
  if (command.type === 'initialize') {
    if (before) throw new ErpError('already_initialized',409);
    state = {schemaVersion:1,revision:1,configuration:config,counters:{estimate:0,invoice:0},ledger:createLedger({organizationId:config.organizationId,currency:config.currency,basis:config.accountingBasis,accounts:nationalAdapter(config.country).starterChart,periods:command.periods}),customers:[],estimates:[],invoices:[]};
    entityId = config.organizationId;
  } else {
    if (!before) throw new ErpError('workspace_not_initialized',409);
    state = {...before,revision:nextCounter(before.revision)};
    if (purchasing && state.schemaVersion === 1) state = {...state,schemaVersion:2,vendors:[],vendorBills:[],vendorPayments:[]};
    switch (command.type) {
      case 'refresh_configuration': {
        const immutable = (c:CompanyConfiguration)=>[c.schemaVersion,c.organizationId,c.country,c.currency,c.accountingBasis];
        if (canonical(immutable(before.configuration))!==canonical(immutable(config))) throw new ErpError('jurisdiction_locked',409);
        state={...state,configuration:config}; entityId=config.organizationId; break;
      }
      case 'save_customer': state = {...state,customers:replace(state.customers,command.customer)}; entityId=command.customer.id; break;
      case 'save_vendor': state = {...state,vendors:replace(state.vendors??[],command.vendor)}; entityId=command.vendor.id; break;
      case 'save_projects': {
        const oldProjects=state.projects??[];
        const byId=new Map(command.projects.map(project=>[project.id,project]));
        // Legacy document links are review input, never an implicit backfill.
        // Each must have a genuine project in this exact promotion transaction.
        for(const document of [...state.estimates,...state.invoices])if(document.projectId){
          const project=byId.get(document.projectId)??oldProjects.find(project=>project.id===document.projectId);
          if(!project)throw new ErpError('legacy_project_review_required',409);
          if(project.customerId!==document.customer.id)throw new ErpError('project_customer_locked',409);
        }
        let counter=state.counters.project??0;
        const numbers=new Map<string,string>();
        for(const input of command.projects){
          const previous=oldProjects.find(project=>project.id===input.id)??null;
          if(!state.customers.some(customer=>customer.id===input.customerId))throw new ErpError('customer_required',422);
          if(previous&&(state.estimates.some(q=>q.projectId===previous.id)||state.invoices.some(i=>i.projectId===previous.id))&&previous.customerId!==input.customerId)throw new ErpError('project_customer_locked',409);
          for(const billId of input.vendorBillIds)if(!state.vendorBills?.some(bill=>bill.id===billId))throw new ErpError('vendor_bill_not_found',404);
          if((previous?.revision??0)!==input.expectedProjectRevision)throw new ErpError('project_revision_conflict',409);
          numbers.set(input.id,previous?.number??`PRJ-${String(counter=nextCounter(counter)).padStart(6,'0')}`);
        }
        const associations=new Set<string>();
        for(const project of [...oldProjects.filter(p=>!byId.has(p.id)),...command.projects])for(const billId of project.vendorBillIds){if(associations.has(billId))throw new ErpError('vendor_bill_project_conflict',409);associations.add(billId);}
        state={...state,schemaVersion:3,counters:{...state.counters,project:counter},vendors:state.vendors??[],vendorBills:state.vendorBills??[],vendorPayments:state.vendorPayments??[],projects:oldProjects};
        finalizePurchase=actor=>{let projects=oldProjects;for(const input of command.projects){const previous=oldProjects.find(p=>p.id===input.id)??null;projects=replace(projects,recordProject(config,input,previous,numbers.get(input.id)!,actor));}state={...state,projects};};
        entityId=command.projects[0].id;break;
      }
      case 'record_vendor_bill': {
        const vendor = state.vendors?.find(v=>v.id===command.vendorId); if (!vendor) throw new ErpError('vendor_required',422);
        if (state.vendorBills?.some(b=>b.id===command.id || (b.vendorId===command.vendorId && b.reference===command.reference && b.date===command.date))) throw new ErpError('vendor_bill_already_recorded',409);
        periodOpen(state,command.periodId,command.accountingDate);
        const approving = await dependencies.revalidate(); authorize(config,approving,command);
        if (approving.userId!==dependencies.actor.userId) throw new ErpError('session_changed',401);
        const {type:_type,...billInput} = command;
        recordVendorBill(config,vendor,billInput,approving,state.revision);
        // Compose the durable row and journal with the final admitted server
        // instant. Slow Auth must not create a mismatching approval/commit stamp.
        finalizePurchase=actor=>{const bill=recordVendorBill(config,vendor,billInput,actor,state.revision);state={...state,vendorBills:[...(state.vendorBills??[]),bill],ledger:postVendorBill(config,state.ledger,bill,command.periodId,actor)};};
        entityId=command.id; break;
      }
      case 'record_vendor_payment': {
        const bill = state.vendorBills?.find(b=>b.id===command.billId); if (!bill) throw new ErpError('vendor_bill_not_found',404);
        if (state.vendorPayments?.some(p=>p.id===command.id || p.idempotencyKey===request.idempotencyKey)) throw new ErpError('vendor_payment_already_recorded',409);
        periodOpen(state,command.periodId,command.accountingDate);
        const recording = await dependencies.revalidate(); authorize(config,recording,command);
        if (recording.userId!==dependencies.actor.userId) throw new ErpError('session_changed',401);
        const existingPayments = (state.vendorPayments??[]).filter(p=>p.billId===bill.id);
        const paidBefore = money(config.currency,(BigInt(bill.total.minorUnits)-BigInt(vendorBillBalance(bill,existingPayments).minorUnits)).toString());
        const {type:_type,...paymentInput} = command;
        recordVendorPayment(config,bill,existingPayments,paymentInput,recording,state.revision,request.idempotencyKey);
        finalizePurchase=actor=>{const payment=recordVendorPayment(config,bill,existingPayments,paymentInput,actor,state.revision,request.idempotencyKey);state={...state,vendorPayments:[...(state.vendorPayments??[]),payment],ledger:postVendorPayment(config,state.ledger,bill,{id:payment.id,idempotencyKey:payment.idempotencyKey,paymentDate:payment.paymentDate,accountingDate:payment.accountingDate,periodId:payment.periodId,amount:payment.amount,paidBefore,cashFlowCategory:'operating'},actor)};};
        entityId=command.id; break;
      }
      case 'save_estimate': {
        const previous = state.estimates.find(q=>q.id===command.id);
        if ((previous?.revision??0)!==command.expectedEstimateRevision) throw new ErpError('estimate_revision_conflict',409);
        if (state.invoices.some(i=>i.sourceEstimateId===command.id)) throw new ErpError('issued_estimate_locked',409);
        const customer = state.customers.find(c=>c.id===command.customerId); if (!customer) throw new ErpError('customer_required');
        if(command.projectId){
          if(state.schemaVersion===3){const project=state.projects?.find(project=>project.id===command.projectId);if(!project)throw new ErpError('project_not_found',422);if(project.status!=='active')throw new ErpError('project_archived',409);if(project.customerId!==command.customerId)throw new ErpError('project_customer_mismatch',422);}
          else if(!dependencies.projectExists || !await dependencies.projectExists(config.organizationId,command.projectId))throw new ErpError('project_not_found',422);
        }
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
  if(finalizePurchase)finalizePurchase(fresh);
  const receipt: ErpReceipt = {idempotencyKey:request.idempotencyKey,commandHash:hash,revision:state.revision,entityId,action:command.type};
  // Transport uncertainty is surfaced; caller retries the SAME request/key, never a new mutation.
  return {receipt:await dependencies.store.commit(erpCommit(before,state,receipt,fresh)),replayed:false};
}
