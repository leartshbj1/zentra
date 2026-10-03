// Synthetic, isolated UI journeys: actual production components; no native DB,
// SMTP, account, licence, provider, file-system mutation or production API.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BankImportWizard } from '../src/BankWorkflowDialogs';
import { CatalogImportWizard } from '../src/CatalogImportWizard';
import { BexioImportPanel } from '../src/BexioImportPanel';
import { SupplierEmailIntake } from '../src/SupplierEmailIntake';
import { SupplierInvoiceAttachments } from '../src/SupplierInvoiceAttachments';
import { SupplierInvoicePreparation } from '../src/SupplierInvoiceWizard';
import { AutomationCompanyProvider } from '../src/AutomationCompany';
import { desktopApi } from '../src/bridge';
import type { WorkspaceMutationOrigin } from '../src/workspaceMemberOrigin';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import type { Workspace, SupplierInvoice } from '../src/types';
import type { SupplierEmailInspection } from '../src/supplierEmail';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';

const kind = new URLSearchParams(location.search).get('kind') || 'bank';
type Call = { command: string; args: unknown; callbackVersion?: number };
const calls: Call[] = [];
let liveScope = 'scope-A';
let releaseSelection: ((path: string) => void) | undefined;
let releaseRead: (() => void) | undefined;
const names = ['clients','catalogItems','stockMovements','suppliers','projects','projectMilestones','projectTasks','agendaEvents','quotes','salesOrders','recurrenceSchedules','recurrenceOccurrences','deliveryNotes','stockReservationEvents','stockAvailability','salesOrderInvoiceBatches','salesOrderInvoiceAllocations','invoices','invoiceCorrectionWorkflows','payments','employees','timeEntries','timeBillingBatches','timeBillingEntries','expenses','supplierOrders','supplierOrderCancellationLines','supplierReceipts','supplierInvoices','supplierInvoicePayments','supplierInvoiceMatches','supplierCreditNotes','supplierExpenseReclassifications','payslips','payrollImports','employeePayrollTemplates','accounts','attachments'];
const workspace = { ...Object.fromEntries(names.map(name => [name, []])), workNotesScope: liveScope, settings: structuredClone(initialOnboardingSettings), accountingSettings: null, activeTimer: null, schemaVersion: 43, onboardingCompleted: true } as unknown as Workspace;
workspace.settings!.work.costCategories = ['Fournitures'];
workspace.settings!.organization.vatRegistered = false;
workspace.suppliers = [{ id: 'supplier-1', name: 'Synthetic supplier', archivedAt: null, paymentTermsDays: 30 }] as Workspace['suppliers'];
const invoice = { id: 'synthetic-invoice', documentStatus: 'draft', attachments: [] } as unknown as SupplierInvoice;
const inspected: SupplierEmailInspection = { fileName: 'synthetic.eml', fileSizeBytes: 100, sha256: 'a'.repeat(64), messageId: 'synthetic@example.invalid', subject: 'Facture SYNTHETIC-42', senderName: 'Synthetic supplier', senderEmail: 'invoice@example.invalid', attachmentNames: ['synthetic.pdf'], importableAttachments: [{name:'synthetic.pdf',mimeType:'application/pdf',sizeBytes:5,sha256:'b'.repeat(64)}], invoiceSignal: true, confidence:'high', matchedSupplierId:'supplier-1', duplicateInvoiceId:null, reference:'SYNTHETIC-42', documentDate:'2026-09-02',dueDate:'2026-10-02',currency:'CHF',netCents:10000,vatCents:0,totalCents:10000,issues:[],networkAccess:false,aiUsed:false };
const selected = () => new Promise<string>(resolve => { releaseSelection = resolve; });
desktopApi.chooseCamtFile = selected;
desktopApi.chooseSupplierEmailFile = selected;
desktopApi.chooseSupplierInvoiceAttachment = selected;
desktopApi.loadWorkspace = async () => structuredClone(workspace);
desktopApi.inspectSupplierEmailFile = async (path, expectedWorkspaceScope) => { calls.push({command:'inspect',args:{path,expectedWorkspaceScope}}); return inspected; };
desktopApi.saveSupplierInvoiceDraftFromEmail = async (input, source, expectedWorkspaceScope) => { calls.push({command:'email-save',args:{input,source,expectedWorkspaceScope}}); return structuredClone(workspace); };
desktopApi.addSupplierInvoiceAttachment = async (id, path, expectedWorkspaceScope) => { calls.push({command:'attachment',args:{id,path,expectedWorkspaceScope}}); return structuredClone(workspace); };
desktopApi.saveSupplierInvoiceDraft = async (input,expectedWorkspaceScope) => { calls.push({command:'generic-draft-save',args:{input,scope:liveScope,expectedWorkspaceScope}}); if(expectedWorkspaceScope!==undefined&&expectedWorkspaceScope!==liveScope)throw Error('Champ invalide : L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.'); return structuredClone(workspace); };
desktopApi.addScannedSupplierAttachment = async (id,file,expectedWorkspaceScope) => { calls.push({command:'scan-attachment',args:{id,fileName:file.name,expectedWorkspaceScope}}); return structuredClone(workspace); };
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: {data?:{action?:string}}|null) => {
  if (command === 'bexio_import_scope') return 'legacy-bexio-A';
  if (command === 'import_bexio_contacts') { calls.push({command,args}); return {created:1,skipped:0,rows:[]}; }
  if (command === 'automation_request') {
    if(kind==='scan'&&!args?.data) return {organizationId:'synthetic-company',active:true,canManage:true,available:['supplier_routing'],settings:{enabled:true,consent:true,flags:['supplier_routing'],thresholds:{medium:.75,high:.95},mode:'suggest'},activity:null};
    if(kind==='scan'&&args?.data?.action==='invoice_scan') return {status:'suggestion',extraction:{kind:'supplier_invoice',supplierName:'Synthetic supplier',reference:'SYNTHETIC-SCAN-42',invoiceDate:'2026-09-02',dueDate:'2026-10-02',currency:'CHF',netCents:10000,vatCents:0,totalCents:10000,vatBp:0,issues:[],confidence:.99,evidence:{}}};
    return {status:'inactive'};
  }
  if (command === 'append_diagnostic_events') return;
  throw Error(`Synthetic fixture does not allow command ${command}`);
} } });

const originalArrayBuffer = File.prototype.arrayBuffer;
File.prototype.arrayBuffer = function() {
  const file = this;
  return new Promise<ArrayBuffer>((resolve, reject) => { releaseRead = () => { originalArrayBuffer.call(file).then(resolve,reject); }; });
};

function Fixture() {
  const [scope, setScope] = useState('scope-A'), [readOnly, setReadOnly] = useState(false), [version, setVersion] = useState(0);
  const current = { ...workspace, workNotesScope: scope };
  Object.assign(window, { __qaImport: { calls, release: () => releaseSelection?.('synthetic-file'), releaseRead: () => releaseRead?.(), pendingSelection: () => Boolean(releaseSelection), pendingRead: () => Boolean(releaseRead), change: (next='scope-B', restricted=false) => { liveScope=next; setScope(next);setReadOnly(restricted);setVersion(value=>value+1); } } });
  const runAction = async (action: (origin:WorkspaceMutationOrigin) => Promise<Workspace>) => { calls.push({command:'current-action',args:{scope},callbackVersion:version}); await action(Object.freeze({workspaceScope:scope,memberContextNonce:'0123456789abcdef0123456789abcdef'})); return true; };
  return <main style={{padding:24}} data-version={version}>
    {kind==='bank'&&<BankImportWizard workspaceScope={scope} automatic={false} onAutomaticChange={()=>{}} disabled={readOnly} accountingReady={true} onClose={()=>{}} onImport={async(path,automatic,expectedWorkspaceScope)=>{calls.push({command:'bank',args:{path,automatic,expectedWorkspaceScope},callbackVersion:version});return {result:{duplicate:false,import:{sourceName:path},importedCount:1,skippedDuplicateCount:0,ignoredCount:0,warnings:[]} as never,refreshWarnings:[]};}} onReview={()=>{}} onAccounts={()=>{}} onAccounting={()=>{}} onRefresh={async()=>[]}/>}
    {kind==='catalog'&&<CatalogImportWizard workspaceScope={scope} existingItems={[]} vatRatesBp={[0]} busy={false} readOnly={readOnly} close={()=>{}} onImport={async(rows,policy,_error,expectedWorkspaceScope)=>{calls.push({command:'catalog',args:{rows,policy,expectedWorkspaceScope},callbackVersion:version});return true;}}/>}
    {kind==='bexio'&&<BexioImportPanel workspace={current} disabled={readOnly} onWorkspace={()=>{calls.push({command:'bexio-publication',args:{scope},callbackVersion:version});}}/>}
    {kind==='email'&&<SupplierEmailIntake workspace={current} busy={false} readOnly={readOnly} runAction={runAction}/>}
    {kind==='attachment'&&<SupplierInvoiceAttachments invoice={invoice} workspaceScope={scope} busy={false} canEdit={!readOnly} act={runAction}/>}
    {kind==='scan'&&<AutomationCompanyProvider organizationId="synthetic-company" readOnly={readOnly}><SupplierInvoicePreparation workspace={current} busy={false} readOnly={readOnly} close={()=>{}} act={runAction} renderAttachments={()=>null}/></AutomationCompanyProvider>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
