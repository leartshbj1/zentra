import { createRoot } from 'react-dom/client';
import { UsErpWorkbench } from '../components/account/us-erp-workbench';
import { AUTH_CHANGED_EVENT } from '../lib/auth-browser-events';
import { isSiteLanguage } from '../lib/site-language';
import { createLedger } from '../lib/international/accounting/ledger';
import { usStarterChart } from '../lib/international/countries/us/accounting';
import { sha256Hex } from '../lib/international/canonical-hash';
import { hashUsMailboxImportRequest, validateUsMailboxImportRequest } from '../lib/international/us-support-mailbox-import-contract';
import { validateStoredErp } from '../lib/international/runtime-validation';
import { validateUsSupplierProposal } from '../lib/international/us-supplier-proposal';
import { US_SUPPLIER_FIELDS, validateUsSupplierExtraction } from '../lib/international/us-supplier-extraction';
import type { UsSupplierDocument } from '../lib/international/us-supplier-document-contract';
import type { UsSupplierProposal } from '../lib/international/us-supplier-contract';
import type { CompanyConfiguration } from '../lib/international/types';
import '../app/compte/account.css';
import '../app/apple-account.css';

// Actual React workbench and transports, isolated synthetic fetch only. There
// is no Auth, provider, real archive or financial persistence in this fixture.
const organizationId = '54b7ee3b-5753-4af1-98f6-b2a568fb3890', userId = '53e1704e-9cc6-431b-ac4d-2186c5fe5f6d';
const workspaceId = '18eb4d45-81a6-496f-8a6d-44bc8d9130d1', connectionId = '65e370ac-e6fa-408d-bb6f-e92d2b3bbc80';
const query = new URLSearchParams(location.search), selected = query.get('lang'), language = isSiteLanguage(selected) ? selected : 'en', role = query.get('role') === 'admin' ? 'admin' : query.get('role') === 'accountant' ? 'accountant' : query.get('role') === 'read_only' ? 'read_only' : 'owner';
const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language, timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
const state = validateStoredErp({ schemaVersion: 4, revision: 2, configuration, counters: { estimate: 0, invoice: 0, project: 0 }, ledger: createLedger({ organizationId, currency: 'USD', basis: 'accrual', accounts: usStarterChart, periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] }), customers: [], estimates: [], invoices: [], projects: [], vendors: [{ id: 'fictitious-vendor', organizationId, kind: 'business', name: 'Fictitious Harbor LLC', billingAddress: configuration.address, paymentTermsDays: 30 }], vendorBills: [], vendorPayments: [] }, organizationId);
const text = 'Fictitious Harbor LLC\nInvoice Number US-1043\nInvoice Date April 5, 2026\nDue Date May 5, 2026\nSubtotal USD 1,000.00\nSales Tax USD 82.50\nTotal USD 1,082.50';
const pdf = new TextEncoder().encode('%PDF-1.7\nFictitious local review original.\n' + text), photo = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), reserved = new TextEncoder().encode('Fictitious reserved original');
const documents = new Map<string, UsSupplierDocument>(), objects = new Map<string, Uint8Array<ArrayBuffer>>(), proposals = new Map<string, UsSupplierProposal>();
const mailImports = new Map<string, UsSupplierDocument>();
const makeDocument = async (id: string, fileName: string, mediaType: UsSupplierDocument['mediaType'], bytes: Uint8Array, readable: boolean, stored = true) => { const row: UsSupplierDocument = { schemaVersion: 1, organizationId, id, fileName, mediaType, sizeBytes: bytes.length, contentSha256: await sha256Hex(bytes), createdBy: userId, createdAt: '2026-10-10T12:00:00.000Z', readable, stored, proposalId: null }; documents.set(id, row); objects.set(id, bytes.slice()); return row; };
await makeDocument('af6e5eae-23c8-4535-bb3c-a8eafc1bf8a7', 'Fictitious supplier invoice.pdf', 'application/pdf', pdf, true);
await makeDocument('bf6e5eae-23c8-4535-bb3c-a8eafc1bf8a7', 'Fictitious scanned receipt.png', 'image/png', photo, false);
await makeDocument('cf6e5eae-23c8-4535-bb3c-a8eafc1bf8a7', 'Fictitious interrupted original.txt', 'text/plain', reserved, true, false);
const extraction = validateUsSupplierExtraction({ schemaVersion: 1, kind: 'vendor_invoice', confidence: 0.99, fields: { supplierName: 'Fictitious Harbor LLC', reference: 'US-1043', invoiceDate: '2026-04-05', dueDate: '2026-05-05', currency: 'USD', netMinor: '100000', printedTaxMinor: '8250', totalMinor: '108250' }, evidence: Object.fromEntries(US_SUPPLIER_FIELDS.map(field => [field, 'Fictitious printed evidence'])), fieldConfidence: Object.fromEntries(US_SUPPLIER_FIELDS.map(field => [field, 0.99])), issues: [] });
let revoked = false, loseUpload = false, loseAnalysis = false, automationDenied = false, hold = false, release: (() => void) | null = null;
const requests: { path: string; method: string; body: string; bytes: number[]; fileName: string | null; status: number }[] = [];
const fixture = { scope: 'Actual React workbench/transports; synthetic RAM HTTP, actor, archive, provider and ERP. No production or physical-device proof.', requests, documents, proposals, state,
  loseNextUpload: () => { loseUpload = true; }, loseNextAnalysis: () => { loseAnalysis = true; }, denyAutomation: () => { automationDenied = true; }, allowAutomation: () => { automationDenied = false; }, holdNextWrite: () => { hold = true; }, release: () => { release?.(); release = null; }, revoke: () => { revoked = true; window.dispatchEvent(new Event(AUTH_CHANGED_EVENT)); },
};
Object.assign(window, { __US_SUPPLIER_DOCUMENTS_FIXTURE__: fixture });
window.fetch = async (input, init = {}) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, method = init.method ?? 'GET', headers = new Headers(init.headers), binary = init.body instanceof ArrayBuffer ? new Uint8Array(init.body).slice() : null;
  const record = { path, method, body: typeof init.body === 'string' ? init.body : '', bytes: binary ? [...binary] : [], fileName: headers.get('X-Zentra-File-Name'), status: 0 }; requests.push(record);
  const respond = (value: unknown, status = 200) => { record.status = status; return Response.json(value, { status }); };
  if (revoked || headers.get('X-Zentra-Expected-User') !== userId) return respond({ error: 'session_changed' }, 401);
  if (hold && method !== 'GET') { hold = false; await new Promise<void>(done => { release = done; }); }
  if (path.endsWith('/erp') && method === 'GET') return respond({ status: 'ready', state });
  if (path.endsWith('/support-workspace') && method === 'GET') return respond({ schemaVersion: 1, organizationId, userId, role, canCreate: false, stage: 'registry_only', mailboxAvailable: false, classificationAvailable: false, workspace: { schemaVersion: 1, organizationId, workspaceId, ownerUserId: userId, connectedBy: userId, name: 'Fictitious Harbor Support', revision: 1, createdAt: 1791600000 } });
  if (path.endsWith('/support-mailbox') && method === 'GET') return respond({ schemaVersion: 1, organizationId, userId, role, workspaceId, revision: 1, canManage: ['owner', 'admin'].includes(role), connection: { id: connectionId, provider: 'infomaniak', email: 'fictitious@example.invalid', verifiedAt: 1791600000 } });
  if (path.includes('/support-mailbox/messages?') && method === 'GET') return respond({ schemaVersion: 1, organizationId, userId, role, workspaceId, connectionId, revision: 1, offset: 0, nextOffset: null, messages: [{ uid: '1043', version: '1791600000', subject: 'Fictitious supplier original — imported through Support', sender: 'Fictitious vendor', receivedAt: 1791600000, attachments: [{ id: '1.2', name: 'Fictitious mail original.pdf', sizeBytes: pdf.length }, { id: '1.3', name: 'Fictitious meeting.ics', sizeBytes: 120 }] }] });
  if (path.endsWith('/support-mailbox/import') && method === 'POST') {
    const command = validateUsMailboxImportRequest(JSON.parse(record.body));
    if (headers.get('X-Zentra-Erp-Schema-Version') !== '4') return respond({ error: 'client_schema_required' }, 409);
    const prior = mailImports.get(command.requestId);
    const original = prior ?? await makeDocument('df6e5eae-23c8-4535-bb3c-a8eafc1bf8a7', 'Fictitious mail original.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.7\nFictitious mailbox-only original'), true);
    mailImports.set(command.requestId, original);
    return respond({ schemaVersion: 1, organizationId, userId, role, workspaceId, requestId: command.requestId, requestHash: await hashUsMailboxImportRequest(organizationId, userId, command), document: original, replayed: !!prior });
  }
  if (path.endsWith('/seller')) return respond({ status: 'unconfigured', organizationId, revision: 0 });
  if (path.endsWith('/tax-profile')) return respond({ status: 'unconfigured', organizationId, revision: 0, verification: 'unverified' });
  if (path.endsWith('/supplier-analysis-settings')) { const now = Math.floor(Date.now() / 1000); return respond({ schemaVersion: 1, organizationId, revision: 1, mode: 'active', availability: 'ready', reason: null, mayConfigure: role === 'owner' || role === 'admin', policyVersion: 'fixture-v1', acceptedPolicyVersion: 'fixture-v1', quota: { limit: 100, used: proposals.size, reserved: 0, remaining: 100 - proposals.size, periodStart: now - 3600, periodEnd: now + 3600 }, checkedAt: now, expiresAt: now + 120 }); }
  if (path.endsWith('/supplier-proposals') && method === 'GET') return respond({ schemaVersion: 1, organizationId, erpRevision: state.revision, proposals: [...proposals.values()] });
  if (path.endsWith('/supplier-documents') && method === 'GET') return respond({ documents: [...documents.values()] });
  const match = path.match(/\/supplier-documents\/([a-f0-9-]{36})(?:\/(content|analyze))?$/);
  if (match) {
    const id = match[1], action = match[2];
    if (method === 'PUT' && !action && binary) {
      const hash = await sha256Hex(binary), existing = documents.get(id) ?? [...documents.values()].find(row => row.contentSha256 === hash);
      if (existing && existing.contentSha256 !== hash) return respond({ error: 'supplier_document_conflict' }, 409);
      const document = existing ?? await makeDocument(id, decodeURIComponent(headers.get('X-Zentra-File-Name') ?? ''), headers.get('Content-Type') as UsSupplierDocument['mediaType'], binary, headers.get('Content-Type') === 'text/plain');
      if (loseUpload) { loseUpload = false; return respond({ error: 'supplier_document_archive_unavailable' }, 503); }
      return respond({ document, replayed: !!existing });
    }
    const document = documents.get(id); if (!document) return respond({ error: 'supplier_document_not_found' }, 404);
    if (action === 'content' && method === 'GET') { record.status = 200; return new Response(objects.get(id)!.slice(), { headers: { 'Content-Type': document.mediaType, 'Content-Disposition': 'attachment' } }); }
    if (action === 'analyze' && method === 'POST') {
      if (automationDenied) return respond({ error: 'automation_entitlement_required' }, 402);
      if (record.body !== '{"schemaVersion":1,"action":"analyze","consent":true}') return respond({ error: 'invalid_request' }, 422);
      if (!document.stored || !document.readable) return respond({ error: 'supplier_source_unreadable' }, 422);
      const existing = document.proposalId ? proposals.get(document.proposalId) : null;
      const proposal = existing ?? validateUsSupplierProposal({ schemaVersion: 1, organizationId, id: crypto.randomUUID(), revision: 0, state: 'review', source: { kind: 'document_import', sha256: await sha256Hex(text), fileName: document.fileName, mediaType: document.mediaType, workspaceId: null, connectionId: null, messageId: null, receivedAt: document.createdAt, documentText: text }, extraction, createdBy: userId, createdAt: document.createdAt }, organizationId);
      proposals.set(proposal.id, proposal); const linked = { ...document, proposalId: proposal.id }; documents.set(id, linked);
      if (loseAnalysis) { loseAnalysis = false; return respond({ error: 'configuration_changed' }, 409); }
      return respond({ document: linked, proposal, replayed: !!existing });
    }
  }
  return respond({ error: 'feature_unavailable' }, 404);
};
document.documentElement.lang = language;
createRoot(document.getElementById('root')!).render(<div className="account-experience account-detail" data-theme={query.get('theme') === 'dark' ? 'dark' : 'light'}><main className="account-content preview-content"><UsErpWorkbench organizationId={organizationId} expectedUserId={userId} role={role} language={language} supportedSchemaVersion={4} documentsEnabled supportWorkspaceEnabled={query.get('mailImport') === '1'} supportMailboxEnabled={query.get('mailImport') === '1'} supportMailImportEnabled={query.get('mailImport') === '1'} supplierEnabled={query.get('automation') !== 'off'} /><aside className="preview-controls" aria-label="Local fixture controls"><p>Local synthetic review fixture · no provider or real archive</p><button onClick={fixture.loseNextUpload}>Lose next save response</button><button onClick={fixture.loseNextAnalysis}>Lose next analysis response</button><button onClick={fixture.denyAutomation}>Refuse Automation only</button><button onClick={fixture.allowAutomation}>Restore Automation</button><button onClick={fixture.holdNextWrite}>Hold next write</button><button onClick={fixture.release}>Release held write</button><button onClick={fixture.revoke}>Revoke access</button></aside></main></div>);
