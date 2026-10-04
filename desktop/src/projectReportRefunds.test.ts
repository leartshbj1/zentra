import './languageTestPacks';
import { afterAll, afterEach, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CustomerCreditSettlement, Invoice, Payment, Project, Workspace } from './types';
import { buildProjectReport, reportSections } from './projectReport';
import { salesTotalsByCurrency, formatSalesTotals } from './salesFinancials';
import { formatMoney } from './utils';
import { getAppLocale, setAppLanguage, t } from './language';

type CashCase={name:string;invoices:Invoice[];payments:Payment[];paid:Record<string,number>;cashRows:number};
const project={id:'p',clientId:'c',name:'Projet fictif rapprochement',status:'in_progress',budgetCents:0,plannedMinutes:0,notes:'PRIVATE PROJECT NOTE'} as Project;
function invoice(id:string,net:number,extra:Partial<Invoice>={}):Invoice {
  return {id,number:`DOC-${id}`,title:'Travaux publics',projectId:'p',clientId:'c',currency:'CHF',status:'issued',type:'standard',issueDate:'2026-02-01',dueDate:'2026-03-01',createdAt:'2026-02-01',creditedCents:0,lines:[{id:`line-${id}`,description:'Travail',quantity:1,unit:'pce',unitPriceCents:net,vatRateBp:810}],...extra} as Invoice;
}
function payment(id:string,invoiceId:string,amountCents:number):Payment {return {id,invoiceId,amountCents,date:'2026-02-15',method:'bank',reference:'PRIVATE BANK REFERENCE',notes:'PRIVATE PAYMENT NOTE'};}
function event(id:string,creditNoteId:string,eventType:CustomerCreditSettlement['eventType'],amountCents:number,invoiceId:string|null=null,reversesId:string|null=null):CustomerCreditSettlement {
  return {id,requestId:`request-${id}`,creditNoteId,eventType,amountCents,invoiceId,reversesId,date:reversesId?'2026-04-02':'2026-04-01',reference:'PRIVATE SETTLEMENT REFERENCE',reason:'PRIVATE SETTLEMENT REASON',bankAccountId:'PRIVATE BANK ACCOUNT',journalEntryId:'PRIVATE JOURNAL',journalValid:false};
}
function full(refunded=false,reversed=false,currency='CHF') {
  const sale=invoice(`sale-${currency}`,10000,{status:'paid',currency});
  const credit=invoice(`credit-${currency}`,-1000,{type:'credit_note',originalInvoiceId:sale.id,currency,issueDate:'2026-03-01'});
  const refund=event(`refund-${currency}`,credit.id,'refund',1081);
  credit.creditSettlements=refunded?[refund,...(reversed?[event(`reverse-${currency}`,credit.id,'reverse_refund',1081,null,refund.id)]:[])]:[];
  return {invoices:[sale,credit],payments:[payment(`receipt-${currency}`,sale.id,10810)]};
}
function partial(refunded=false,reversed=false) {
  const sale=invoice('partial-sale',10000,{creditedCents:reversed?0:5405});
  const credit=invoice('partial-credit',-7500,{type:'credit_note',originalInvoiceId:sale.id});
  const apply=event('application',credit.id,'apply',5405,sale.id),applications=[apply,...(reversed?[event('reverse-application',credit.id,'reverse_apply',5405,sale.id,apply.id)]:[])];
  sale.creditSettlements=applications;credit.creditSettlements=[...applications,...(refunded?[event('partial-refund',credit.id,'refund',2703)]:[])];
  return {invoices:[sale,credit],payments:[payment('partial-payment',sale.id,5405)]};
}
function legacy() {
  const sale=invoice('legacy-sale',20000,{creditedCents:undefined}),credit=invoice('legacy-credit',-2000,{type:'credit_note',originalInvoiceId:sale.id,creditedCents:undefined});
  return {invoices:[sale,credit],payments:[payment('legacy-payment',sale.id,21620),payment('legacy-signed-refund',sale.id,-2162)]};
}
function cases():CashCase[] {
  const modern=full(true),historical=legacy(),euros=full(true,false,'EUR'),duplicate=full(true);
  const canonical=duplicate.invoices[1].creditSettlements![0];
  duplicate.invoices[0].creditSettlements=[{...canonical}];
  duplicate.invoices[1].creditSettlements!.push({...canonical,requestId:'another-request-same-canonical-id'},event('foreign-credit-event','other-credit','refund',7777));
  const excluded=full(true);
  for(const status of ['draft','cancelled'] as const) {
    const sale=invoice(`${status}-sale`,999999,{status}),credit=invoice(`${status}-credit`,-999999,{type:'credit_note',status});
    credit.creditSettlements=[event(`${status}-refund`,credit.id,'refund',999999)];excluded.invoices.push(sale,credit);excluded.payments.push(payment(`${status}-payment`,sale.id,999999));
  }
  excluded.invoices.push(invoice('PRIVATE OTHER PROJECT',10000,{projectId:'other'}));excluded.payments.push(payment('other-project','PRIVATE OTHER PROJECT',10810),payment('orphan','unknown',1234));
  const creditPayment=full(true);creditPayment.payments.push(payment('ignored-credit-payment',creditPayment.invoices[1].id,999999));
  return [
    {name:'issued-credit-without-cash-refund',...full(),paid:{CHF:10810},cashRows:1},
    {name:'modern-refund',...modern,paid:{CHF:9729},cashRows:2},
    {name:'modern-refund-reversed',...full(true,true),paid:{CHF:10810},cashRows:3},
    {name:'compensation-without-cash',...partial(),paid:{CHF:5405},cashRows:1},
    {name:'compensation-then-refund',...partial(true),paid:{CHF:2702},cashRows:2},
    {name:'compensation-reversed',...partial(false,true),paid:{CHF:5405},cashRows:1},
    {name:'legacy-signed-payment',...historical,paid:{CHF:19458},cashRows:2},
    {name:'independent-modern-and-legacy',invoices:[...modern.invoices,...historical.invoices],payments:[...modern.payments,...historical.payments],paid:{CHF:29187},cashRows:4},
    {name:'currency-separation',invoices:[...modern.invoices,...euros.invoices],payments:[...modern.payments,...euros.payments],paid:{CHF:9729,EUR:9729},cashRows:4},
    {name:'canonical-id-deduplication',...duplicate,paid:{CHF:9729},cashRows:2},
    {name:'draft-cancelled-orphan-and-other-project-exclusion',...excluded,paid:{CHF:9729},cashRows:2},
    {name:'credit-note-payment-exclusion',...creditPayment,paid:{CHF:9729},cashRows:2},
  ];
}
function workspace(fixture:CashCase):Workspace {return {projects:[project],clients:[{id:'c',name:'Client public'}],invoices:fixture.invoices,payments:fixture.payments,quotes:[],timeEntries:[],employees:[],expenses:[],supplierInvoices:[],supplierCreditNotes:[],projectMilestones:[],projectTasks:[],agendaEvents:[],attachments:[],timeBillingEntries:[],timeBillingBatches:[]} as unknown as Workspace;}
function centsFromRenderedMoney(value:string):number {
  const decimal=new Intl.NumberFormat(getAppLocale()).formatToParts(0.1).find(part=>part.type==='decimal')!.value;
  const normalized=value.replace(decimal,'.').replace(/[^\d.-]/g,'');
  expect(normalized).toMatch(/^-?\d+\.\d{2}$/);
  const [whole,fraction]=normalized.replace('-','').split('.');return (normalized.startsWith('-')?-1:1)*Number(whole+fraction);
}
const proofs:unknown[]=[];
afterEach(async()=>await setAppLanguage('fr'));
afterAll(()=>{const directory=process.env.ZENTRA_PROJECT_REPORT_REFUND_PROOF_DIR;if(directory){mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'reconciliations.json'),JSON.stringify(proofs,null,2)+'\n');}});

for(const preset of ['client','internal'] as const) it.each(cases())(`${preset}: $name reconciles visible signed cash with the actual Finance aggregate`,fixture=>{
  const w=workspace(fixture),before=JSON.stringify(w);
  const report=buildProjectReport(w,project,Object.keys(reportSections) as (keyof typeof reportSections)[],{preset});
  const detail=report.sections.find(section=>section.title==='Encaissements et remboursements')!;
  expect(detail.headers).toEqual(['Document','Mouvement','Date','Montant signé']);
  expect(detail.rows).toHaveLength(fixture.cashRows);
  const included=fixture.invoices.filter(invoice=>invoice.projectId==='p'),totals=salesTotalsByCurrency(included,fixture.payments);
  expect(Object.fromEntries(totals.map(total=>[total.currency,total.paidCents]))).toEqual(fixture.paid);
  const paid=report.sections.find(section=>section.title==='Situation financière')!.rows.find(row=>row[0]==='Encaissé net · remboursements déduits')!;
  expect(paid[1]).toBe(formatSalesTotals(totals,'paidCents'));
  const visible:Record<string,number>={};
  for(const row of detail.rows) {
    const document=included.find(invoice=>invoice.number===row[0])!;expect(document).toBeDefined();
    const cents=centsFromRenderedMoney(row[3]);expect(row[3]).toBe(formatMoney(cents,document.currency));
    visible[document.currency]=(visible[document.currency]??0)+cents;
  }
  expect(visible).toEqual(fixture.paid);expect(JSON.stringify(w)).toBe(before);
  if(preset==='client')expect(JSON.stringify(report)).not.toContain('PRIVATE');
  proofs.push({name:fixture.name,preset,expected:fixture.paid,aggregate:totals,visible,summary:paid,detail,passed:true});
});
it('keeps each refund and reversal on its exact credit note date and currency without publishing private metadata',async()=>{
  const fixture=cases().find(fixture=>fixture.name==='modern-refund-reversed')!,credit=fixture.invoices[1],report=buildProjectReport(workspace(fixture),project,['overview','sales'],{preset:'client'});
  const rows=report.sections.find(section=>section.title==='Encaissements et remboursements')!.rows;
  expect(rows).toContainEqual([credit.number,'Remboursement client','2026-04-01',formatMoney(-1081,'CHF')]);
  expect(rows).toContainEqual([credit.number,'Annulation du remboursement client','2026-04-02',formatMoney(1081,'CHF')]);
  expect(rows).toHaveLength(3);
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
});
it.each(['fr','de','it','en'] as const)('translates signed cash detail and net summary while keeping exact facts in %s',async language=>{
  await setAppLanguage(language);const fixture=cases().find(fixture=>fixture.name==='modern-refund-reversed')!,report=buildProjectReport(workspace(fixture),project,['overview','sales'],{preset:'client'});
  const detail=report.sections.find(section=>section.title===t('Encaissements et remboursements'))!;
  expect(detail.rows).toContainEqual([fixture.invoices[1].number,t('Remboursement client'),'2026-04-01',formatMoney(-1081)]);
  expect(detail.rows).toContainEqual([fixture.invoices[1].number,t('Annulation du remboursement client'),'2026-04-02',formatMoney(1081)]);
  expect(report.sections.find(section=>section.title===t('Situation financière'))!.rows).toContainEqual([t('Encaissé net · remboursements déduits'),formatSalesTotals(salesTotalsByCurrency(fixture.invoices,fixture.payments),'paidCents')]);
  if(language!=='fr')for(const source of ['Encaissé net · remboursements déduits','Encaissements et remboursements','Mouvement','Montant signé','Paiement enregistré','Remboursement client','Annulation du remboursement client'])expect(JSON.stringify(report)).not.toContain(source);
});
