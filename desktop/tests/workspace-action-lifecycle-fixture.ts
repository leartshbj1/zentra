import { desktopApi, type CloudAccountState } from '../src/bridge';
import type { Client, Workspace } from '../src/types';
import { createWorkspaceEntity } from '../src/workspaceCreation';

type IdentityControls = {
  link: (account: CloudAccountState, member: string, scope: string) => void;
  setAccount: (account: CloudAccountState, member: string) => void;
  identityMode: (mode: 'ready') => void;
  releaseAccount: (id: number) => void;
};
type HeldRead = {
  resolve: (workspace: Workspace) => void;
  reject: (reason: Error) => void;
  snapshot: Workspace;
};
type Scenario = 'late-success' | 'late-catch-read' | 'recovery-cleanup' | 'control';

/** Non-shipping dependencies for the real App/WorkspaceApp action lifecycle.
 * The runner supplies the original account fixture without creating an import
 * cycle. No action runner, component or production setter is replaced here.
 */
export function installWorkspaceActionLifecycleFixture(
  workspace: Workspace,
  installIdentity: (workspace: Workspace) => void,
) {
  installIdentity(workspace);
  const identity = (window as unknown as { __qaAppDraftIdentity: IdentityControls }).__qaAppDraftIdentity;
  const baseRead = desktopApi.loadWorkspace;
  const baseResolve = desktopApi.resolveConnectedCompany;
  const reads = new Map<number, HeldRead>();
  const proof = {
    writes: 0,
    reads: [] as { id: number; kind: 'ordinary' | 'action-final' | 'act-or-recovery'; scope?: string; pending: boolean }[],
    resolutionChoices: [] as string[],
  };
  let holdRead = false;
  let nextId = 0;
  let mode: Scenario = 'late-success';

  desktopApi.resolveConnectedCompany = async (organizationId, choice) => {
    proof.resolutionChoices.push(`${organizationId}:${choice || 'auto'}`);
    // Native company_account::decide requires an explicit choice before
    // replacing the non-empty local company with a different remote company.
    if (organizationId === 'synthetic-organization-b' && workspace.workNotesScope === 'synthetic-company-a' && (!choice || choice === 'auto')) {
      return { status: 'choose_remote', organizationId, changed: false };
    }
    return baseResolve(organizationId, choice);
  };

  function remember(kind: 'action-final' | 'act-or-recovery', snapshot: Workspace) {
    const id = ++nextId;
    proof.reads.push({ id, kind, scope: snapshot.workNotesScope, pending: true });
    return new Promise<Workspace>((resolve, reject) => reads.set(id, { resolve, reject, snapshot }));
  }

  desktopApi.loadWorkspace = async () => {
    const snapshot = await baseRead();
    if (holdRead) return remember('act-or-recovery', snapshot);
    proof.reads.push({ id: ++nextId, kind: 'ordinary', scope: snapshot.workNotesScope, pending: false });
    return snapshot;
  };
  desktopApi.createEntity = (entity, input) => createWorkspaceEntity(entity, input, async value => {
    if (entity !== 'clients') throw new Error('Closed synthetic fixture: unsupported entity');
    proof.writes++;
    workspace.clients.push({
      id: String(value.id), name: String(value.company), company: String(value.company),
      contactPerson: String(value.contactPerson), email: '', phone: '', address: 'Rue fictive', notes: '', archivedAt: null,
    } as Client);
    holdRead = mode !== 'control';
  }, async () => mode === 'control' ? structuredClone(workspace) : remember('action-final', structuredClone(workspace)));

  Object.assign(window, {
    __qaActParent: {
      proof,
      begin(next: Scenario) { mode = next; },
      pending() { return [...reads.keys()]; },
      settle(id: number, failure = false) {
        const pending = reads.get(id);
        if (!pending) throw new Error('No synthetic held read');
        reads.delete(id);
        proof.reads.find(read => read.id === id)!.pending = false;
        if (failure) pending.reject(new Error('Synthetic read unavailable'));
        else pending.resolve(pending.snapshot);
      },
      switchVerifiedAccount() {
        // Simulate an already replaced protected session reported by the
        // original pending App revalidation; no server or real account is used.
        holdRead = false;
        const next: CloudAccountState = {
          status: 'connected', organizationId: 'synthetic-organization-b',
          organizationName: 'SYNTHETIC COMPANY B', role: 'owner',
        };
        identity.link(next, 'synthetic-member-b', 'synthetic-company-b');
        identity.setAccount(next, 'synthetic-member-b');
        identity.identityMode('ready');
        identity.releaseAccount(1);
      },
      database() {
        return { scope: workspace.workNotesScope, clients: workspace.clients.map(row => ({ id: row.id, company: row.company })) };
      },
    },
  });
}
