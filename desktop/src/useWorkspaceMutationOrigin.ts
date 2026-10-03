import type { Workspace } from './types';
import { useFormDraftIdentity } from './useFormDraft';
import { captureWorkspaceMutationOrigin } from './workspaceMemberOrigin';

/** Captures this admitted render before any business await. No native/auth call. */
export function useWorkspaceMutationOrigin(workspace: Pick<Workspace, 'workNotesScope'> | undefined) {
  const admitted = useFormDraftIdentity();
  return () => captureWorkspaceMutationOrigin(workspace, admitted);
}
