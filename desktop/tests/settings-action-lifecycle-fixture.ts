import { desktopApi, type CloudAccountState } from '../src/bridge';
import type { Workspace } from '../src/types';

// Capture the real implementation before mobile-harness installs its business
// substitutes. Only the SDK's window transport is synthetic for this action.
const productionSaveSettings = desktopApi.saveSettings;
const productionRestoreBackup = desktopApi.restoreBackup;
type Held = { resolve: (value: unknown) => void; reject: (reason: Error) => void; snapshot: unknown };
type IdentityControls = {
  link: (account: CloudAccountState, member: string, scope: string) => void;
  setAccount: (account: CloudAccountState, member?: string) => void;
  identityMode: (mode: 'ready') => void;
  releaseAccount: (id: number) => void;
};

/** Closed acceptance dependencies for the real App/SettingsScreen/bridge/SDK. */
export function installSettingsAuditFixture(workspace: Workspace, installIdentity: (workspace: Workspace) => void) {
  installIdentity(workspace);
  const identity = (window as unknown as { __qaAppDraftIdentity: IdentityControls }).__qaAppDraftIdentity;
  const read = desktopApi.loadWorkspace;
  const resolveCompany = desktopApi.resolveConnectedCompany;
  const native = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: any, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const previousInvoke = native.invoke;
  let mode = 'late-success';
  let holdFallback = false;
  let nextId = 0;
  let rawSnapshot: unknown;
  let originSnapshot: Workspace | undefined;
  const held = new Map<number, Held>();
  const proof = {
    writes: 0,
    restores: 0,
    reads: [] as { id: number; kind: string; scope?: string; pending: boolean }[],
    resolutionChoices: [] as string[],
    scopedInputs: [] as { present: boolean; value?: string }[],
  };
  function hold(kind: string, snapshot: unknown) {
    const id = ++nextId;
    const scope = (snapshot as Workspace).workNotesScope ?? (snapshot as { work_notes_scope?: string }).work_notes_scope;
    proof.reads.push({ id, kind, scope, pending: true });
    return new Promise<any>((resolve, reject) => held.set(id, { resolve, reject, snapshot }));
  }
  desktopApi.resolveConnectedCompany = async (organizationId, choice) => {
    proof.resolutionChoices.push(`${organizationId}:${choice || 'auto'}`);
    if (((organizationId === 'synthetic-organization-b' && workspace.workNotesScope === 'synthetic-company-a') || (mode.startsWith('foreign-') && organizationId === 'automation-qa' && workspace.workNotesScope === 'synthetic-company-b')) && (!choice || choice === 'auto')) {
      return { status: 'choose_remote', organizationId, changed: false };
    }
    return resolveCompany(organizationId, choice);
  };
  desktopApi.loadWorkspace = async () => {
    const snapshot = await read();
    return holdFallback ? hold('fallback-read', snapshot) : snapshot;
  };
  desktopApi.saveSettings = productionSaveSettings;
  desktopApi.restoreBackup = productionRestoreBackup;
  desktopApi.chooseRestoreFile = async () => '/synthetic/settings-audit.zentra';
  native.invoke = async (command, args, options) => {
    if (command === 'restore_backup') {
      proof.restores++;
      workspace.workNotesScope = 'synthetic-company-restored';
      workspace.settings!.organization.legalName = 'RESTORED COMPANY';
      const raw = rawSnapshot as { work_notes_scope: string; settings: { company_name: string } };
      if (!raw) throw Error('Restore control requires its acknowledged original settings snapshot');
      raw.work_notes_scope = workspace.workNotesScope;
      raw.settings.company_name = workspace.settings!.organization.legalName;
      identity.link({ status: 'connected', organizationId: 'automation-qa', organizationName: 'Entreprise fictive A', role: 'owner' }, 'synthetic-member-a', workspace.workNotesScope);
      return {};
    }
    if (command === 'update_settings') {
      proof.writes++;
      proof.scopedInputs.push({ present: Object.hasOwn(args, 'expectedWorkspaceScope'), value: args.expectedWorkspaceScope });
      workspace.settings!.organization.legalName = String(args.data.company_name);
      originSnapshot = structuredClone(workspace);
      rawSnapshot = {
        schema_version: 43,
        work_notes_scope: workspace.workNotesScope,
        settings: structuredClone(args.data),
        clients: workspace.clients.map(client => ({
          id: client.id, company: client.company, name: client.name, contact_person: client.contactPerson,
          email: client.email, phone: client.phone, address_line1: 'Rue fictive', postal_code: '1000',
          city: 'Lausanne', archived_at: null,
        })),
      };
      return {};
    }
    if (command === 'get_app_state') {
      if (mode.startsWith('foreign-')) {
        workspace.workNotesScope = 'synthetic-company-b';
        workspace.settings!.organization.legalName = 'FOREIGN COMPANY B';
        const raw = rawSnapshot as { work_notes_scope: string; settings: { company_name: string } };
        raw.work_notes_scope = workspace.workNotesScope;
        raw.settings.company_name = workspace.settings!.organization.legalName;
      }
      return { onboarding_completed: true, activity_profile_required: false, data_dir: '', app_version: 'synthetic' };
    }
    if (command === 'get_workspace') {
      if (!rawSnapshot) throw Error('Closed settings fixture: no admitted synthetic write');
      if (mode === 'control' || mode.startsWith('foreign-')) {
        if (mode.startsWith('foreign-')) holdFallback = true;
        return structuredClone(rawSnapshot);
      }
      holdFallback = true;
      return hold('action-final', structuredClone(rawSnapshot));
    }
    return previousInvoke(command, args, options);
  };
  Object.assign(window, {
    __qaActParent: {
      proof,
      begin(next: string) { mode = next; },
      pending() { return [...held.keys()]; },
      settle(id: number, failure = false) {
        const read = held.get(id);
        if (!read) throw Error('No held settings read');
        held.delete(id);
        proof.reads.find(row => row.id === id)!.pending = false;
        if (failure) read.reject(Error('Synthetic settings read unavailable'));
        else read.resolve(read.snapshot);
      },
      switchVerifiedAccount() {
        holdFallback = false;
        const account: CloudAccountState = {
          status: 'connected', organizationId: 'synthetic-organization-b',
          organizationName: 'SYNTHETIC COMPANY B', role: 'owner',
        };
        identity.link(account, 'synthetic-member-b', 'synthetic-company-b');
        identity.setAccount(account, 'synthetic-member-b');
        identity.identityMode('ready');
        identity.releaseAccount(1);
      },
      makeReadOnly() {
        identity.setAccount({ status: 'connected', organizationId: 'automation-qa', organizationName: 'Entreprise fictive A', role: 'read_only' });
        identity.releaseAccount(1);
      },
      restoreOriginForRead() {
        if (!originSnapshot) throw Error('No acknowledged original settings write');
        Object.assign(workspace, structuredClone(originSnapshot));
      },
      database() {
        return {
          scope: workspace.workNotesScope, company: workspace.settings!.organization.legalName,
          clients: workspace.clients.map(row => ({ id: row.id, company: row.company })),
        };
      },
    },
  });
}
