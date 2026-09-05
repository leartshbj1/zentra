import type { Workspace } from './types';
import { errorMessage } from './utils';

/** The native command returned success; only the subsequent workspace read failed. */
export class WorkspaceRefreshAfterMutationError extends Error {
  constructor(readonly refreshCause: unknown) {
    super(`L’opération a été enregistrée, mais l’actualisation des données a échoué. ${errorMessage(refreshCause, 'Réessayez pour retrouver les données enregistrées.')}`);
    this.name = 'WorkspaceRefreshAfterMutationError';
  }
}

export async function refreshWorkspaceAfterMutation(load: () => Promise<Workspace>): Promise<Workspace> {
  try {
    return await load();
  } catch (reason) {
    throw new WorkspaceRefreshAfterMutationError(reason);
  }
}
