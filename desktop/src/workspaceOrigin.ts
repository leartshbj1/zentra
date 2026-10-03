import type { Workspace } from './types';
import { WorkspaceRefreshAfterMutationError, refreshWorkspaceAfterMutation } from './workspaceMutation';

/** A read from another local workspace can never acknowledge the original action. */
export class WorkspaceOriginChangedError extends Error {
  constructor() {
    super('L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.');
    this.name = 'WorkspaceOriginChangedError';
  }
}

export function assertWorkspaceOrigin(workspace: Workspace, expectedWorkspaceScope?: string): void {
  if (expectedWorkspaceScope !== undefined && workspace.workNotesScope !== expectedWorkspaceScope)
    throw new WorkspaceOriginChangedError();
}

export function workspaceOriginFailure(reason: unknown): WorkspaceOriginChangedError | null {
  if (reason instanceof WorkspaceOriginChangedError) return reason;
  if (reason instanceof WorkspaceRefreshAfterMutationError && reason.refreshCause instanceof WorkspaceOriginChangedError)
    return reason.refreshCause;
  return null;
}

/** The mutation already acknowledged. A failed read must never resend it. */
export function refreshWorkspaceInOrigin(load: () => Promise<Workspace>, expectedWorkspaceScope?: string): Promise<Workspace> {
  return refreshWorkspaceAfterMutation(async () => {
    const next = await load();
    assertWorkspaceOrigin(next, expectedWorkspaceScope);
    return next;
  });
}
