import './languageTestPacks';
import { afterEach, expect, it } from 'vitest';
import { buildProjectReport } from './projectReport';
import { formatMinutes, documentTotals, formatMoney } from './utils';
import { setAppLanguage } from './language';
import type { Invoice, Project, Workspace } from './types';
afterEach(async()=>await setAppLanguage('fr'));
function fixture(quantity=11/60) {
 const project={id:'p',name:'Projet',clientId:'c'} as Project;
 const invoice={id:'invoice',projectId:'p',number:'FACTURE',title:'Heures',status:'issued',type:'standard',currency:'CHF',issueDate:'2026-10-03',dueDate:'2026-10-31',lines:[{id:'line',description:'Prestation',quantity,unit:'h',unitPriceCents:5010,vatRateBp:810}]} as Invoice;
 const workspace={projects:[project],clients:[],invoices:[invoice],quotes:[],payments:[],timeEntries:[],expenses:[],supplierInvoices:[],supplierCreditNotes:[],projectMilestones:[],projectTasks:[],agendaEvents:[],attachments:[],employees:[],timeBillingBatches:[{id:'batch',invoiceId:'invoice'}],timeBillingEntries:[{id:'entry',batchId:'batch',invoiceItemId:'line',minutes:11}]} as unknown as Workspace;
 return {project,invoice,workspace};
}
function details(workspace:Workspace,project:Project) {return buildProjectReport(workspace,project,['sales']).sections.filter(s=>s.headers[0]==='Prestation');}
it.each([1,11,61,73,1441,5256000])('shows the authoritative %i minute snapshot without a raw floating fraction',minutes=>{
 const {workspace,project,invoice}=fixture(minutes/60); workspace.timeBillingEntries[0].minutes=minutes;
 const before=JSON.stringify(workspace); const row=details(workspace,project)[0].rows[0];
 expect(row).toEqual(['Prestation',formatMinutes(minutes),formatMoney(documentTotals(invoice.lines).netCents,'CHF')]);
 expect(JSON.stringify(workspace)).toBe(before);
});
it('does not apply an invoice snapshot to a quote with identical document and line IDs',()=>{
 const {workspace,project,invoice}=fixture(); workspace.quotes=[{...invoice,number:'DEVIS',status:'accepted'} as never];
 const result=details(workspace,project); expect(result).toHaveLength(2);
 expect(result[0].rows[0][1]).toBe(String(invoice.lines[0].quantity)); expect(result[1].rows[0][1]).toBe(formatMinutes(11));
});
it('keeps ordinary invoice quantities and four decimal places intact',()=>{
 const {workspace,project}=fixture(1.2345); workspace.timeBillingBatches=[]; workspace.timeBillingEntries=[];
 expect(details(workspace,project)[0].rows[0][1]).toBe('1.2345');
});
it('does not reuse a snapshot from another invoice batch even when line IDs coincide',()=>{
 const {workspace,project,invoice}=fixture(); workspace.timeBillingBatches[0].invoiceId='other';
 expect(details(workspace,project)[0].rows[0][1]).toBe(String(invoice.lines[0].quantity));
});
it('retains legacy reports whose time snapshot arrays are absent',()=>{
 const {workspace,project,invoice}=fixture(); delete (workspace as Partial<Workspace>).timeBillingBatches;delete (workspace as Partial<Workspace>).timeBillingEntries;
 expect(details(workspace,project)[0].rows[0][1]).toBe(String(invoice.lines[0].quantity));
});
it.each([0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('falls back to the existing quantity for invalid minute snapshot %s',minutes=>{
 const {workspace,project,invoice}=fixture(); workspace.timeBillingEntries[0].minutes=minutes;
 expect(details(workspace,project)[0].rows[0][1]).toBe(String(invoice.lines[0].quantity));
});
it('retains client-report filtering for draft and cancelled time invoices',()=>{
 const {workspace,project,invoice}=fixture(); invoice.status='draft';
 const result=buildProjectReport(workspace,project,['sales'],{preset:'client'});
 expect(result.sections.some(s=>s.headers[0]==='Prestation')).toBe(false);
});
