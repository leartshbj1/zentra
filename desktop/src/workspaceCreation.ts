import type { EntityKind, Workspace } from './types';
import { createId } from './utils';
import { refreshWorkspaceAfterMutation } from './workspaceMutation';

function containsCreation(workspace: Workspace, entity: EntityKind, id: string): boolean {
  // An empty onboarding screen is not evidence that a pending write failed.
  if (!workspace.onboardingCompleted || !Array.isArray(workspace[entity])) {
    throw new Error('La base de votre entreprise doit être accessible pour vérifier cet enregistrement.');
  }
  return workspace[entity].some(row => row.id === id);
}

/** No acknowledgement was received. Only an authoritative read can resolve this attempt. */
export class WorkspaceCreationOutcomeUnknownError extends Error {
  constructor(readonly entity: EntityKind, readonly recordId: string, readonly mutationCause: unknown) {
    super('La réponse de l’enregistrement n’a pas été reçue. Vérifions les données avant de réessayer.');
    this.name = 'WorkspaceCreationOutcomeUnknownError';
  }
  wasRecorded(workspace: Workspace): boolean {
    return containsCreation(workspace, this.entity, this.recordId);
  }
}

export async function createWorkspaceEntity(
  entity: EntityKind,
  data: Record<string, unknown>,
  create: (data: Record<string, unknown>) => Promise<unknown>,
  load: () => Promise<Workspace>,
): Promise<Workspace> {
  const suppliedId = typeof data.id === 'string' && data.id.trim() ? data.id : null;
  const id = suppliedId ?? createId();
  // Quick client creation supplies its ID so the editor can select it afterwards.
  // Never mistake a previously existing row for the result of this new attempt.
  if (suppliedId && containsCreation(await load(), entity, id)) {
    throw new Error('Cet élément existe déjà. Ouvrez sa fiche pour le modifier ; aucune nouvelle création n’a été envoyée.');
  }
  try {
    await create({ ...data, id });
  } catch (cause) {
    throw new WorkspaceCreationOutcomeUnknownError(entity, id, cause);
  }
  return refreshWorkspaceAfterMutation(load);
}
