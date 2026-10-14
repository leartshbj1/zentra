import { normalizeAutopilotReviewPage } from './autopilotReview';
import type { CatalogItem, Workspace } from './types';
import type { FormDraftIdentityValue } from './useFormDraft';
import { captureWorkspaceMutationOrigin, WorkspaceMemberOriginChangedError, type WorkspaceMutationOrigin } from './workspaceMemberOrigin';

export type AutopilotCatalogueRequest = Readonly<{
  organizationId: string; proposalId: string; sourceId: string; origin: WorkspaceMutationOrigin;
}>;
export type AutopilotCatalogueFollowup = Readonly<{ request: AutopilotCatalogueRequest; catalogItemId: string }>;
type Current = Readonly<{ active: boolean; readOnly: boolean }>;
type Context = Pick<Workspace, 'workNotesScope'> | undefined;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/.test(value);

/** Navigation only. The review remains immutable; it is never an item or a quote. */
export function autopilotCatalogueContextMatches(request: AutopilotCatalogueRequest, workspace: Context,
  identity: Readonly<FormDraftIdentityValue>, current: Current): boolean {
  try {
    if (!current.active || !workspace?.workNotesScope || !identifier(request.organizationId)
      || !identifier(request.proposalId) || !identifier(request.sourceId) || identity.organizationId !== request.organizationId) return false;
    const actual = captureWorkspaceMutationOrigin(workspace, identity);
    return actual.workspaceScope === request.origin.workspaceScope && actual.memberContextNonce === request.origin.memberContextNonce;
  } catch { return false; }
}

export function resolveAutopilotCatalogueEntry(request: AutopilotCatalogueRequest, rawPage: unknown, workspace: Context,
  identity: Readonly<FormDraftIdentityValue>, current: Current, mode: 'browse' | 'create'): AutopilotCatalogueRequest | null {
  if (!autopilotCatalogueContextMatches(request, workspace, identity, current) || mode === 'create' && current.readOnly) return null;
  const page = normalizeAutopilotReviewPage(rawPage, request.organizationId);
  const item = page?.items.find(row => row.proposalId === request.proposalId && row.sourceId === request.sourceId);
  // missing_article can also mean ambiguous identity. Never claim proven absence.
  if (!item?.reasons.includes('missing_article')) return null;
  return Object.freeze({ organizationId: request.organizationId, proposalId: item.proposalId, sourceId: item.sourceId,
    origin: Object.freeze({ ...request.origin }) });
}

export function resolveAutopilotCatalogueFollowup(followup: AutopilotCatalogueFollowup | null,
  workspace: Pick<Workspace, 'workNotesScope' | 'catalogItems'> | undefined,
  identity: Readonly<FormDraftIdentityValue>, current: Current): AutopilotCatalogueFollowup | null {
  if (!followup || !autopilotCatalogueContextMatches(followup.request, workspace, identity, current)) return null;
  const items = workspace?.catalogItems.filter(item => item.id === followup.catalogItemId);
  return items?.length === 1 && !items[0].archivedAt ? followup : null;
}

/** Preserve the original member nonce all the way to the ordinary native writer. */
export function assertAutopilotCatalogueMutationOrigin(request: AutopilotCatalogueRequest, actual: WorkspaceMutationOrigin): void {
  if (request.origin.workspaceScope !== actual.workspaceScope || request.origin.memberContextNonce !== actual.memberContextNonce)
    throw new WorkspaceMemberOriginChangedError();
}

/** Match the existing catalogue import's SKU rule; this is a local preflight,
 * not a database uniqueness guarantee against simultaneous writes. */
export function autopilotCatalogueSkuExists(sku: string, items: readonly CatalogItem[]): boolean {
  const key = sku.trim().toLocaleLowerCase('fr-CH');
  return !!key && items.some(item => item.sku?.trim().toLocaleLowerCase('fr-CH') === key);
}
