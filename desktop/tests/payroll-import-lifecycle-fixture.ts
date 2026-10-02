import { desktopApi, type CloudAccountState } from '../src/bridge';
import type { Workspace, PayrollDocumentImport } from '../src/types';
const realRead = desktopApi.loadWorkspace, realConfirm = desktopApi.confirmPayrollDocumentImport, realReject = desktopApi.rejectPayrollDocumentImport, realUpdate = desktopApi.updatePayrollImportDraft, realPreview = desktopApi.getPayrollDocumentPreview;
export function installPayrollImportAuditFixture(workspace: Workspace, installIdentity: (w: Workspace) => void) {
    installIdentity(workspace);
    const identity = (window as any).__qaAppDraftIdentity, native = (window as any).__TAURI_INTERNALS__, previousInvoke = native.invoke, baseResolve = desktopApi.resolveConnectedCompany;
    let mode = 'current', readsAfterAck = 0, nextId = 0, armed = false;
    const held = new Map<number, {
        resolve: (v: any) => void;
        reject: (e: Error) => void;
        snapshot: any;
    }>();
    let pendingAck: (() => void) | undefined;
    const draft = { employee: { employeeNumber: '', name: 'Synthetic payroll employee', role: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '', birthDate: '', avsNumber: '', iban: '', employmentRate: 100, salaryMode: 'monthly' as const }, period: '2026-09', paymentDate: '2026-09-25', grossCents: 500000, netCents: 500000, lines: [{ id: 'synthetic-wage', label: 'Synthetic wage', kind: 'earning' as const, amountCents: 500000, recurring: false, confidenceBp: 10000 }], warnings: [] };
    const row: PayrollDocumentImport = { id: 'synthetic-payroll-import', status: 'needs_review', mediaKind: 'image', sourceName: 'synthetic.png', storedPath: '', extractionEngine: 'manual_review', engineVersion: 'fixture', extractedText: '', fileSha256: 'a'.repeat(64), fileSize: 128, pageCount: 1, confidenceBp: 10000, analysisManifest: null, errorMessage: '', employeeId: '', payslipId: '', reviewedAt: '', createdAt: '', updatedAt: '', draft };
    workspace.payrollImports = new URLSearchParams(location.search).has('payrollTwo') ? [row, { ...structuredClone(row), id: 'synthetic-payroll-import-2', sourceName: 'synthetic2.png' }] : [row];
    workspace.employees = [];
    workspace.payslips = [];
    workspace.employeePayrollTemplates = [];
    const proof = { confirmCalls: 0, confirmed: 0, rejectCalls: 0, updateCalls: 0, updates: [] as any[], reads: [] as any[], commands: [] as string[], pendingAck: false };
    function rawDraft(d: any) { return { employee: { employee_number: d.employee.employeeNumber, name: d.employee.name, role: d.employee.role, address_line1: '', address_line2: '', postal_code: '', city: '', canton: '', birth_date: '', avs_number: '', iban: '', employment_rate: 100, salary_mode: 'monthly' }, period: d.period, payment_date: d.paymentDate, gross_cents: d.grossCents, net_cents: d.netCents, lines: d.lines.map((l: any) => ({ id: l.id, label: l.label, kind: l.kind, amount_cents: l.amountCents, recurring: l.recurring, confidence_bp: l.confidenceBp })), warnings: [], review: d.review }; }
    function rawRow(r: any) { return { id: r.id, status: r.status, media_kind: 'image', source_name: r.sourceName, stored_path: '', file_sha256: r.fileSha256, file_size: r.fileSize, page_count: 1, extraction_engine: r.extractionEngine, engine_version: r.engineVersion, confidence_bp: r.confidenceBp, draft_json: JSON.stringify(rawDraft(r.draft)), analysis_manifest_json: null, employee_id: r.employeeId, payslip_id: r.payslipId }; }
    function raw() { const s = workspace.settings!, o = s.organization, b = s.billing; return { schema_version: 43, work_notes_scope: workspace.workNotesScope, settings: { company_name: o.legalName, legal_form: o.legalForm, owner_name: o.contactName, email: o.email, phone: o.phone, address_line1: o.address.street, address_line2: '', postal_code: o.address.postalCode, city: o.address.city, canton: o.address.canton, country: o.address.country, uid_number: o.uidNumber, vat_number: o.vatNumber, vat_registered: o.vatRegistered, default_vat_bp: b.vatRatesBp[0] ?? 0, iban: b.iban, bank_name: b.accountHolder, currency: 'CHF', quote_prefix: b.quotePrefix, invoice_prefix: b.invoicePrefix, credit_note_prefix: b.creditNotePrefix, quote_start_number: b.nextQuoteNumber, invoice_start_number: b.nextInvoiceNumber, credit_note_start_number: b.nextCreditNoteNumber, payment_terms_days: b.paymentTermsDays, quote_validity_days: b.quoteValidityDays, default_hourly_rate_cents: 0, logo_path: '', noga_section: s.business.nogaSection, noga_division: s.business.nogaDivision, activity_description: s.business.activityDescription, noga_detailed_code: s.business.nogaDetailedCode, extra_settings_json: JSON.stringify({ organization: { website: o.website, address: { buildingNumber: o.address.buildingNumber } }, billing: b, work: s.work, payroll: s.payroll, backup: s.backup, setupDeferred: s.setupDeferred }) }, payroll_document_imports: workspace.payrollImports.map(rawRow), clients: workspace.clients.map(c => ({ id: c.id, name: c.name, company: c.company, contact_person: c.contactPerson, email: c.email, phone: c.phone, address_line1: 'Rue fictive', address_line2: '', postal_code: '1000', city: 'Lausanne', country: 'CH', archived_at: null })) }; }
    desktopApi.loadWorkspace = realRead;
    desktopApi.confirmPayrollDocumentImport = realConfirm;
    desktopApi.rejectPayrollDocumentImport = realReject;
    desktopApi.updatePayrollImportDraft = realUpdate;
    desktopApi.getPayrollDocumentPreview = realPreview;
    desktopApi.resolveConnectedCompany = async (org, choice) => { if ((!choice || choice === 'auto') && org === 'synthetic-organization-b' && workspace.workNotesScope === 'synthetic-company-a')
        return { status: 'choose_remote', organizationId: org, changed: false }; const result = await baseResolve(org, choice); if (result.changed && workspace.workNotesScope === 'synthetic-company-b')
        workspace.payrollImports = []; return result; };
    native.invoke = async (command: string, args?: any, options?: unknown) => {
        proof.commands.push(command);
        if (command === 'get_payroll_document_preview')
            return { mime_type: 'image/png', data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSMsAAAAASUVORK5CYII=' };
        if (command === 'confirm_payroll_document_import') {
            proof.confirmCalls++;
            if (mode === 'native-refused') throw Error('Accès refusé : votre rôle permet la consultation uniquement.');
            if (!args.input.human_review_attested)
                throw Error('Synthetic attestation absent');
            if (proof.confirmed)
                throw Error('Ce document a déjà été confirmé.');
            proof.confirmed++;
            workspace.payrollImports[0].status = 'confirmed';
            workspace.payrollImports[0].employeeId = 'synthetic-created-employee';
            workspace.payrollImports[0].payslipId = 'synthetic-created-payslip';
            armed = true;
            if (mode === 'late-ack') {
                proof.pendingAck = true;
                return new Promise<void>(resolve => pendingAck = () => { proof.pendingAck = false; resolve(); });
            }
            return;
        }
        if (command === 'update_payroll_import_draft') {
            proof.updateCalls++;
            proof.updates.push({ id: args.input.id, scope: workspace.workNotesScope, expectedScope: args.expectedWorkspaceScope ?? null });
            const r = workspace.payrollImports.find(r => r.id === args.input.id)!;
            r.draft = structuredClone(args.input.draft);
            if (mode.startsWith('save-') && proof.updateCalls === 1) {
                proof.pendingAck = true;
                return new Promise(resolve => pendingAck = () => { proof.pendingAck = false; resolve({ ...rawRow(r), draft_json: JSON.stringify(args.input.draft) }); });
            }
            return { ...rawRow(r), draft_json: JSON.stringify(args.input.draft) };
        }
        if (command === 'reject_payroll_document_import') {
            proof.rejectCalls++;
            workspace.payrollImports[0].status = 'rejected';
            armed = true;
            return;
        }
        if (command === 'get_app_state')
            return { onboarding_completed: true, activity_profile_required: false, data_dir: '', app_version: 'synthetic' };
        if (command === 'get_workspace') {
            const id = ++nextId, afterAck = armed, readNumber = afterAck ? ++readsAfterAck : 0, snapshot = structuredClone(raw());
            if (afterAck && mode === 'foreign')
                snapshot.work_notes_scope = 'synthetic-company-b';
            if (afterAck && mode === 'wrong-status')
                snapshot.payroll_document_imports[0].status = 'needs_review';
            const pending = afterAck && ['held', 'late-switch', 'all-fail'].includes(mode) && (mode !== 'late-switch' || snapshot.work_notes_scope === 'synthetic-company-a');
            proof.reads.push({ id, scope: snapshot.work_notes_scope, afterAck, readNumber, pending });
            if (afterAck && mode === 'fail-first' && readNumber === 1)
                throw Error('Synthetic payroll final GET unavailable');
            if (pending)
                return new Promise((resolve, reject) => held.set(id, { resolve, reject, snapshot }));
            return snapshot;
        }
        return previousInvoke(command, args, options);
    };
    Object.assign(window, { __qaPayrollImport: { proof, begin(next: string) { mode = next; }, settle(id: number, failure = false) { const r = held.get(id); if (!r)
                throw Error('No held read'); held.delete(id); proof.reads.find(r => r.id === id).pending = false; failure ? r.reject(Error('Synthetic payroll final GET unavailable')) : r.resolve(r.snapshot); }, releaseAck() { if (!pendingAck)
                throw Error('No held ACK'); pendingAck(); pendingAck = undefined; }, addSecond() { workspace.payrollImports.push({ ...structuredClone(row), id: 'synthetic-payroll-import-2', status: 'needs_review', sourceName: 'synthetic2.png' }); },
            switchVerifiedAccount() { const next: CloudAccountState = { status: 'connected', organizationId: 'synthetic-organization-b', organizationName: 'SYNTHETIC COMPANY B', role: 'owner' }; identity.link(next, 'synthetic-member-b', 'synthetic-company-b'); identity.setAccount(next, 'synthetic-member-b'); identity.identityMode('ready'); identity.releaseAccount(1); },
            makeReadOnly() { identity.setAccount({ status: 'connected', organizationId: 'automation-qa', organizationName: 'Entreprise fictive A', role: 'read_only' }); identity.releaseAccount(1); },
            state() { return { proof: structuredClone(proof), database: { scope: workspace.workNotesScope, status: workspace.payrollImports[0]?.status }, company: document.querySelector('.sidebar__company strong')?.textContent, dialog: !!document.querySelector('.payroll-import-shell'), recovery: Array.from(document.querySelectorAll('[role=dialog]')).some(d => d.textContent?.includes('Enregistrement effectué')), confirmDisabled: (Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Confirmer et créer à contrôler')) as HTMLButtonElement | undefined)?.disabled, queue: document.querySelector('.payroll-import-queue')?.textContent, notice: document.querySelector('.notice--floating')?.textContent, rootInert: document.getElementById('root')?.inert }; } } });
}
