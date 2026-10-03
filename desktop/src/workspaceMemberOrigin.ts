import type { Workspace } from './types';
import type { FormDraftIdentityValue } from './useFormDraft';
import { WorkspaceOriginChangedError } from './workspaceOrigin';

/** Terminal local account failure; shares the recovery boundary, not its company wording. */
export class WorkspaceMemberOriginChangedError extends WorkspaceOriginChangedError {
  constructor(message = 'Le compte connecté a changé. Rouvrez cette action avec le bon compte.') {
    super();
    this.name = 'WorkspaceMemberOriginChangedError';
    this.message = message;
  }
}

/** Local connection context only. This nonce grants no server authorization. */
export type WorkspaceMutationOrigin = Readonly<{
  workspaceScope: string;
  memberContextNonce: string;
}>;
const isExactIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value === value.trim() && !value.includes('\0');
const isMemberContextNonce = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);

/** Call before the first await. Strings are copied, not native/context refs. */
export function captureWorkspaceMutationOrigin(
  workspace: Pick<Workspace, 'workNotesScope'> | undefined,
  admitted: Readonly<FormDraftIdentityValue>,
): WorkspaceMutationOrigin {
  const workspaceScope = workspace?.workNotesScope ?? admitted.companyId;
  if (!isExactIdentifier(workspaceScope) || !isExactIdentifier(admitted.companyId) || admitted.companyId !== workspaceScope)
    throw new WorkspaceOriginChangedError();
  if (admitted.ready !== true || !isExactIdentifier(admitted.memberId) || !isMemberContextNonce(admitted.memberContextNonce))
    throw new WorkspaceMemberOriginChangedError('Le contexte local du compte doit être vérifié. Rouvrez votre espace.');
  return Object.freeze({ workspaceScope, memberContextNonce: admitted.memberContextNonce });
}

/** Every command/read uses this original nonce. Never obtain a replacement here. */
export function mutationOriginInvokeArgs(origin: WorkspaceMutationOrigin, expectedWorkspaceScope?: string) {
  if (!isExactIdentifier(origin.workspaceScope) ||
      expectedWorkspaceScope !== undefined && expectedWorkspaceScope !== origin.workspaceScope)
    throw new WorkspaceOriginChangedError();
  if (!isMemberContextNonce(origin.memberContextNonce))
    throw new WorkspaceMemberOriginChangedError('Le contexte local du compte doit être vérifié. Rouvrez votre espace.');
  return { expectedWorkspaceScope: origin.workspaceScope, expectedMemberContextNonce: origin.memberContextNonce };
}
