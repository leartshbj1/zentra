import type { AccountingFallback } from './types';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

/** Keep native accounting warnings available while the acknowledged posting is recovered by reads. */
export class PayslipPostingRefreshError extends WorkspaceRefreshAfterMutationError {
  constructor(cause: unknown, readonly accountingFallbacks: AccountingFallback[]) {
    super(cause);
    this.name = 'PayslipPostingRefreshError';
  }
}
