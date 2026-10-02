import { desktopApi, type CloudAccountState } from '../src/bridge';
import type { Workspace } from '../src/types';

// Capture the actual bridge before mobile-harness replaces business methods.
const productionSave = desktopApi.saveSettings;
const productionRead = desktopApi.loadWorkspace;
type Held = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

export function installPayrollPreflightFixture(workspace: Workspace, installIdentity: (workspace: Workspace) => void) {
  installIdentity(workspace);
  const identity = (window as any).__qaAppDraftIdentity;
  const native = (window as any).__TAURI_INTERNALS__;
  const previousInvoke = native.invoke;
  const resolveCompany = desktopApi.resolveConnectedCompany;
  const proof = { reads: [] as any[], writes: [] as any[], resolutions: [] as any[], native: [] as string[], blockedNative: [] as string[] };
  const held = new Map<number, Held>();
  let id = 0, nextHeld = false;
  const settings = workspace.settings!;
  let rawSettings: Record<string, any> = {
    company_name: settings.organization.legalName, legal_form: settings.organization.legalForm,
    owner_name: settings.organization.contactName, email: settings.organization.email, phone: settings.organization.phone,
    address_line1: settings.organization.address.street, address_line2: '', postal_code: settings.organization.address.postalCode,
    city: settings.organization.address.city, canton: settings.organization.address.canton, country: settings.organization.address.country,
    uid_number: settings.organization.uidNumber, vat_number: settings.organization.vatNumber,
    vat_registered: settings.organization.vatRegistered, default_vat_bp: settings.billing.vatRatesBp[0] || 0,
    iban: settings.billing.iban, bank_name: settings.billing.accountHolder, currency: 'CHF',
    quote_prefix: settings.billing.quotePrefix, invoice_prefix: settings.billing.invoicePrefix,
    credit_note_prefix: settings.billing.creditNotePrefix, quote_start_number: settings.billing.nextQuoteNumber,
    invoice_start_number: settings.billing.nextInvoiceNumber, credit_note_start_number: settings.billing.nextCreditNoteNumber,
    payment_terms_days: settings.billing.paymentTermsDays, quote_validity_days: settings.billing.quoteValidityDays,
    logo_path: '', noga_section: settings.business.nogaSection, noga_division: settings.business.nogaDivision,
    activity_description: settings.business.activityDescription, noga_detailed_code: settings.business.nogaDetailedCode,
    extra_settings_json: JSON.stringify({ ...settings, organization: { website: settings.organization.website, address: { buildingNumber: settings.organization.address.buildingNumber } } }),
  };
  const raw = () => ({
    schema_version: 43, work_notes_scope: workspace.workNotesScope,
    settings: { ...structuredClone(rawSettings), company_name: workspace.settings!.organization.legalName },
    clients: workspace.clients.map(client => ({ id: client.id, company: client.company, name: client.name, contact_person: client.contactPerson, email: client.email, phone: client.phone, address_line1: 'Rue fictive', postal_code: '1000', city: 'Lausanne', archived_at: null })),
  });
  desktopApi.loadWorkspace = productionRead;
  desktopApi.saveSettings = productionSave;
  desktopApi.resolveConnectedCompany = async (organizationId, choice) => {
    proof.resolutions.push({ organizationId, choice: choice || 'auto' });
    if (organizationId === 'synthetic-organization-b' && workspace.workNotesScope === 'synthetic-company-a' && (!choice || choice === 'auto')) return { status: 'choose_remote', organizationId, changed: false };
    return resolveCompany(organizationId, choice);
  };
  native.invoke = async (command: string, args: any, options: unknown) => {
    proof.native.push(command);
    if (command === 'get_app_state') return { onboarding_completed: true, activity_profile_required: false, data_dir: '', app_version: 'synthetic' };
    if (command === 'get_workspace') {
      // Contributions/rules also read the workspace on opening the category.
      // Hold only the genuine SettingsScreen callback's preflight, not those reads.
      const stack = new Error('Synthetic read lineage').stack || '';
      const holdPreflight = nextHeld && stack.includes('/src/WorkspaceApp.tsx') && !stack.includes('refreshWorkspaceAfterMutation');
      const entry = { id: ++id, scope: workspace.workNotesScope, pending: holdPreflight, kind: holdPreflight ? 'payroll-preflight' : 'ordinary', stack };
      proof.reads.push(entry);
      if (holdPreflight) {
        nextHeld = false;
        return new Promise((resolve, reject) => held.set(entry.id, { resolve, reject }));
      }
      return raw();
    }
    if (command === 'update_settings') {
      const extra = JSON.parse(args.data.extra_settings_json);
      proof.writes.push({ workspaceAtDispatch: workspace.workNotesScope, scopePresent: Object.hasOwn(args, 'expectedWorkspaceScope'), expectedScope: args.expectedWorkspaceScope, payrollAvs: extra.payroll.avsFund, company: args.data.company_name });
      // Synthetic accepted mutation only. This is not a LocalStore/SQL oracle.
      rawSettings = structuredClone(args.data);
      workspace.settings!.payroll = structuredClone(extra.payroll);
      return {};
    }
    if (command === 'get_payroll_rules') return { rules: [], sources: [], activeRules: [], version: 'synthetic' };
    if (command === 'list_payroll_contribution_definitions') return [];
    try { return await previousInvoke(command, args, options); }
    catch (error) { proof.blockedNative.push(command); throw error; }
  };
  Object.assign(window, { __qaPayrollPreflight: {
    proof,
    holdNext() { nextHeld = true; },
    settle(readId: number) { const pending = held.get(readId); if (!pending) throw Error('No held preflight'); held.delete(readId); proof.reads.find(read => read.id === readId)!.pending = false; pending.resolve(raw()); },
    switchVerifiedAccount() {
      const account: CloudAccountState = { status: 'connected', organizationId: 'synthetic-organization-b', organizationName: 'SYNTHETIC COMPANY B', role: 'owner' };
      identity.link(account, 'synthetic-member-b', 'synthetic-company-b');
      identity.setAccount(account, 'synthetic-member-b'); identity.identityMode('ready'); identity.releaseAccount(1);
    },
    makeReadOnly() { identity.setAccount({ status: 'connected', organizationId: 'automation-qa', organizationName: 'Entreprise fictive A', role: 'read_only' }); identity.releaseAccount(1); },
    snapshot() { return { scope: workspace.workNotesScope, company: workspace.settings!.organization.legalName, payrollAvs: JSON.parse(rawSettings.extra_settings_json).payroll.avsFund }; },
  }});
}
