import { withKnownErrorIncident } from './diagnostics';
import type { EntityKind, Workspace } from './types';
import { createId } from './utils';
import { assertWorkspaceOrigin, refreshWorkspaceInOrigin, workspaceOriginFailure } from './workspaceOrigin';

function containsCreation(workspace: Workspace, entity: EntityKind, id: string, expectedWorkspaceScope?: string): boolean {
  assertWorkspaceOrigin(workspace, expectedWorkspaceScope);
  // An empty onboarding screen is not evidence that a pending write failed.
  if (!workspace.onboardingCompleted || !Array.isArray(workspace[entity])) {
    throw new Error('La base de votre entreprise doit être accessible pour vérifier cet enregistrement.');
  }
  return workspace[entity].some(row => row.id === id);
}

/** No acknowledgement was received. Only an authoritative read can resolve this attempt. */
export class WorkspaceCreationOutcomeUnknownError extends Error {
  constructor(readonly entity: EntityKind, readonly recordId: string, readonly mutationCause: unknown, readonly expectedWorkspaceScope?: string) {
    super('La réponse de l’enregistrement n’a pas été reçue. Vérifions les données avant de réessayer.');
    this.name = 'WorkspaceCreationOutcomeUnknownError';
    withKnownErrorIncident(this, mutationCause);
  }
  wasRecorded(workspace: Workspace): boolean {
    return containsCreation(workspace, this.entity, this.recordId, this.expectedWorkspaceScope);
  }
}

export async function createWorkspaceEntity(
  entity: EntityKind,
  data: Record<string, unknown>,
  create: (data: Record<string, unknown>) => Promise<unknown>,
  load: () => Promise<Workspace>,
  expectedWorkspaceScope?: string,
): Promise<Workspace> {
  const suppliedId = typeof data.id === 'string' && data.id.trim() ? data.id : null;
  const id = suppliedId ?? createId();
  // Quick client creation supplies its ID so the editor can select it afterwards.
  // Never mistake a previously existing row for the result of this new attempt.
  if (suppliedId && containsCreation(await load(), entity, id, expectedWorkspaceScope)) {
    throw new Error('Cet élément existe déjà. Ouvrez sa fiche pour le modifier ; aucune nouvelle création n’a été envoyée.');
  }
  try {
    await create({ ...data, id });
  } catch (cause) {
    // A native context guard rejects before writing. It is a terminal origin
    // failure, not a lost response requiring an indefinite read-only retry.
    const originFailure = workspaceOriginFailure(cause);
    if (originFailure) throw originFailure;
    throw new WorkspaceCreationOutcomeUnknownError(entity, id, cause, expectedWorkspaceScope);
  }
  return refreshWorkspaceInOrigin(load, expectedWorkspaceScope);
}
