import { ErpError } from './erp-contract';
import type { FinancialAuthority } from './accounting/ledger';

export interface ErpReadAdmission { readonly mode: 'browser' | 'device'; readonly actor: FinancialAuthority }

/** Optional form binding only narrows access; it never establishes identity or grants a role. */
export function confirmErpExpectedUser(request: Request, admitted: ErpReadAdmission): void {
  if (!request.headers.has('X-Zentra-Expected-User')) return;
  if (request.headers.get('X-Zentra-Expected-User') !== admitted.actor.userId) {
    throw new ErpError('session_changed', 401);
  }
}

/** A slow read must not publish data after the caller loses the admitted company/session/role. */
export function confirmErpReadAdmission(trusted: ErpReadAdmission, fresh: ErpReadAdmission): void {
  if (fresh.mode !== trusted.mode || fresh.actor.organizationId !== trusted.actor.organizationId || fresh.actor.userId !== trusted.actor.userId) {
    throw new ErpError('session_changed', 401);
  }
  if (!fresh.actor.managementEntitled) throw new ErpError('management_entitlement_required', 402);
  if (fresh.actor.role !== trusted.actor.role) throw new ErpError('forbidden', 403);
}
