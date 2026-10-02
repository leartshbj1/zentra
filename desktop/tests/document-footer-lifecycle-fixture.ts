import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';

// Captured during ESM evaluation, before the existing mobile harness substitutes
// its business methods. App, DocumentEditor, act and this implementation stay real.
const productionSaveSettings = desktopApi.saveSettings;
const productionLoadWorkspace = desktopApi.loadWorkspace;

export function installFooterReceiptFixture(workspace: Workspace, installIdentity: (workspace: Workspace) => void) {
  installIdentity(workspace);
  const identity = (window as any).__qaAppDraftIdentity;
  const publicRead = desktopApi.loadWorkspace;
  const native = (window as any).__TAURI_INTERNALS__;
  const previousInvoke = native.invoke;
  let mode = 'ordinary-a';
  let rawReceipt: any;
  let releaseRead: ((failure: boolean) => void) | undefined;
  let originSnapshot: Workspace | undefined;
  let originRawReceipt: any;
  const proof = {
    attempts: 0, acknowledgedWrites: 0,
    payloads: [] as any[], reads: [] as any[], nativeCommands: [] as string[], nativeInputs: [] as any[],
  };
  desktopApi.saveSettings = productionSaveSettings;
  desktopApi.loadWorkspace = async () => {
    proof.reads.push({ kind: proof.attempts ? 'parent-fallback' : 'startup-read', scope: workspace.workNotesScope, pending: false });
    return publicRead();
  };
  native.invoke = async (command: string, args?: any, options?: any) => {
    proof.nativeCommands.push(command);
    proof.nativeInputs.push({ command, args: args === undefined ? null : structuredClone(args) });
    if (command === 'update_settings') {
      proof.attempts++;
      proof.payloads.push({
        expectedScopePresent: Object.hasOwn(args, 'expectedWorkspaceScope'),
        expectedWorkspaceScope: args.expectedWorkspaceScope,
        data: structuredClone(args.data),
      });
      if (mode === 'native-refusal') throw Error('L’entreprise ouverte a changé. Refus synthétique du modèle de bas de page.');
      proof.acknowledgedWrites++;
      workspace.settings!.billing.footerTemplates = structuredClone(JSON.parse(args.data.extra_settings_json).billing.footerTemplates);
      originSnapshot = structuredClone(workspace);
      rawReceipt = {
        schema_version: 43, work_notes_scope: workspace.workNotesScope,
        settings: structuredClone(args.data),
        clients: workspace.clients.map(client => ({
          id: client.id, name: client.name, company: client.company,
          email: 'fixture@example.invalid', phone: '', street: 'Rue fictive',
          building_number: '1', postal_code: '1000', city: 'Lausanne', archived_at: null,
        })),
      };
      originRawReceipt = structuredClone(rawReceipt);
      // After acknowledgement, fallback/retry use the production loadWorkspace
      // and real Tauri SDK too. Only startup/refusal retains the identity fixture read.
      desktopApi.loadWorkspace = productionLoadWorkspace;
      return {};
    }
    if (command === 'get_app_state') {
      proof.reads.push({ kind: 'SDK-app-state', pending: false });
      if (mode === 'foreign-b' || mode === 'foreign-fallback-retry-a') {
        // Only the simulated transport's backing state changes; React's existing
        // A clone stays unchanged until the actual parent receives the GET result.
        workspace.workNotesScope = 'synthetic-company-b';
        workspace.settings!.organization.legalName = 'FOREIGN RECEIPT COMPANY B';
        if (mode === 'foreign-b') {
          rawReceipt.work_notes_scope = workspace.workNotesScope;
          rawReceipt.settings.company_name = workspace.settings!.organization.legalName;
        }
        identity.link({ status: 'connected', organizationId: 'automation-qa', organizationName: 'Entreprise fictive A', role: 'owner' }, 'synthetic-member-a', workspace.workNotesScope);
      }
      return { onboarding_completed: true, activity_profile_required: false, data_dir: '', app_version: 'synthetic' };
    }
    if (command === 'get_workspace') {
      if (!rawReceipt) throw Error('Closed footer fixture: no acknowledged write for a receipt');
      if (mode === 'foreign-fallback-retry-a' && proof.reads.some(row => row.kind === 'SDK-workspace')) {
        rawReceipt.work_notes_scope = 'synthetic-company-b';
        rawReceipt.settings.company_name = 'FOREIGN RECEIPT COMPANY B';
      }
      const row = { kind: 'SDK-workspace', scope: rawReceipt.work_notes_scope, pending: true };
      proof.reads.push(row);
      const snapshot = structuredClone(rawReceipt);
      return new Promise((resolve, reject) => { releaseRead = failure => {
        row.pending = false;
        releaseRead = undefined;
        if (failure) reject(Error('Synthetic acknowledged footer refresh unavailable'));
        else resolve(snapshot);
      }; });
    }
    return previousInvoke(command, args, options);
  };
  Object.assign(window, {
    __qaFooterReceipt: {
      proof,
      begin(next: string) { mode = next; },
      release(failure = false) { if (!releaseRead) throw Error('No held footer receipt'); releaseRead(failure); },
      restoreOriginForRead() {
        if (!originSnapshot || !originRawReceipt) throw Error('No original acknowledged synthetic receipt');
        Object.assign(workspace, structuredClone(originSnapshot));
        rawReceipt = structuredClone(originRawReceipt);
        mode = 'retry-a';
        identity.link({ status: 'connected', organizationId: 'automation-qa', organizationName: 'Entreprise fictive A', role: 'owner' }, 'synthetic-member-a', workspace.workNotesScope);
      },
      makeReadOnly() {
        identity.setAccount({ status: 'connected', organizationId: 'automation-qa', organizationName: 'Entreprise fictive A', role: 'read_only' });
        identity.releaseAccount(1);
      },
      transportState() {
        return { scope: workspace.workNotesScope, company: workspace.settings!.organization.legalName,
          originScope: originSnapshot?.workNotesScope };
      },
    },
  });
}
