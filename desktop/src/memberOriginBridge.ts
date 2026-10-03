import type { Workspace } from './types';
import type { WorkspaceMutationOrigin } from './workspaceMemberOrigin';
import { mutationOriginInvokeArgs, WorkspaceMemberOriginChangedError } from './workspaceMemberOrigin';
import { WorkspaceOriginChangedError } from './workspaceOrigin';

const CHANGED_MEMBER = 'Le compte connecté a changé. Rouvrez cette action avec le bon compte.';
const UNVERIFIED_MEMBER = 'Le contexte local du compte doit être vérifié. Rouvrez votre espace.';

/** Exact native validation messages only; never classify a generic network error. */
export function memberOriginNativeFailure(reason: unknown): WorkspaceOriginChangedError | null {
  const raw = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : null;
  if (raw === null) return null;
  const message = raw.trim().replace(/^Champ invalide\s*:\s*/, '');
  return message === CHANGED_MEMBER || message === UNVERIFIED_MEMBER ? new WorkspaceMemberOriginChangedError(message) : null;
}

/** Native context admission does not replace require_write or server authorization. */
export async function invokeInMemberOrigin<T>(
  invoke: (command: string, args: Record<string, unknown>) => Promise<T>,
  command: string,
  args: Record<string, unknown>,
  origin: WorkspaceMutationOrigin,
  expectedWorkspaceScope?: string,
): Promise<T> {
  const bound = mutationOriginInvokeArgs(origin, expectedWorkspaceScope);
  try { return await invoke(command, { ...args, ...bound }); }
  catch (reason) { throw memberOriginNativeFailure(reason) ?? reason; }
}

/** Bind synchronously at action start. A retry never reads the newer provider. */
export function bindWorkspaceMutationRead(
  origin: WorkspaceMutationOrigin,
  load: (expectedWorkspaceScope: string, expectedMemberContextNonce: string) => Promise<Workspace>,
): () => Promise<Workspace> {
  const { expectedWorkspaceScope, expectedMemberContextNonce } = mutationOriginInvokeArgs(origin);
  return async () => {
    try { return await load(expectedWorkspaceScope, expectedMemberContextNonce); }
    catch (reason) { throw memberOriginNativeFailure(reason) ?? reason; }
  };
}

/** Deliberate fail-closed compatibility with an older native binary, never an unguarded write. */
export function classifyMemberNonceCompatibility(memberContextNonce: string | undefined):
  'guarded-member-origin' | 'legacy-backend-without-member-nonce' {
  return memberContextNonce && /^[0-9a-f]{32}$/.test(memberContextNonce)
    ? 'guarded-member-origin' : 'legacy-backend-without-member-nonce';
}
