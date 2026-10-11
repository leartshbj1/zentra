import type { Quote, Workspace } from './types';
import type { FormDraftIdentityValue } from './useFormDraft';
import { captureWorkspaceMutationOrigin, type WorkspaceMutationOrigin } from './workspaceMemberOrigin';

export type ConfirmedQuoteDestinationRequest = Readonly<{
  organizationId: string;
  quoteId: string;
  origin: WorkspaceMutationOrigin;
}>;

export type ConfirmedQuoteDestination =
  | Readonly<{ kind: 'available'; quote: Readonly<Quote>; mode: 'edit' | 'consult' }>
  | Readonly<{ kind: 'unavailable'; reason: 'invalid_request' | 'context_changed' | 'missing' | 'ambiguous' }>;

/** Private preparation only: resolve a historical quote ID in the admitted,
 * currently loaded company. This performs no read, navigation or write and
 * grants no server authority. Absence does not prove the quote was deleted. */
export function resolveConfirmedQuoteDestination(
  request: ConfirmedQuoteDestinationRequest,
  workspace: Pick<Workspace, 'workNotesScope' | 'quotes'> | undefined,
  identity: Readonly<FormDraftIdentityValue>,
  current: Readonly<{ active: boolean; readOnly: boolean }>,
): ConfirmedQuoteDestination {
  if (!request.organizationId || request.organizationId !== request.organizationId.trim()
    || !request.quoteId || request.quoteId !== request.quoteId.trim())
    return { kind: 'unavailable', reason: 'invalid_request' };

  // Do not use the origin helper's legacy fallback to identity.companyId:
  // this destination requires the actual loaded physical workspace.
  if (!current.active || !workspace?.workNotesScope || identity.organizationId !== request.organizationId)
    return { kind: 'unavailable', reason: 'context_changed' };

  let origin: WorkspaceMutationOrigin;
  try {
    origin = captureWorkspaceMutationOrigin(workspace, identity);
  } catch {
    return { kind: 'unavailable', reason: 'context_changed' };
  }
  if (origin.workspaceScope !== request.origin.workspaceScope
    || origin.memberContextNonce !== request.origin.memberContextNonce)
    return { kind: 'unavailable', reason: 'context_changed' };

  let quote: Quote | undefined;
  for (const candidate of workspace.quotes) {
    if (candidate.id !== request.quoteId) continue;
    if (quote) return { kind: 'unavailable', reason: 'ambiguous' };
    quote = candidate;
  }
  if (!quote) return { kind: 'unavailable', reason: 'missing' };
  return { kind: 'available', quote, mode: current.readOnly || quote.status !== 'draft' ? 'consult' : 'edit' };
}
