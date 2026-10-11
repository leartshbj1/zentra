import type { QuoteLedgerFence } from './ledger-types';
import { QuoteLedgerError } from './ledger-types';
import type { DeviceQuoteAuthority } from './production-admission';
import {
  quotePublicationEvidencePredicate,
  type QuotePublicationEvidenceFence,
} from './quote-publication-evidence';
import {
  combineQuotePredicates,
  type SupportQuoteAccessCapability,
} from './support-source';
import { captureActor } from './validation';

/** Private confirmation composition. No request may supply these capabilities.
 * A current read grant plus a historical transport row alone is insufficient:
 * confirmation also requires the exact immutable canonical SQLite evidence. */
export function createHistoricalQuoteFences(
  authority: DeviceQuoteAuthority,
  access: SupportQuoteAccessCapability,
) {
  const actor = captureActor(authority.actor),
    installationId = authority.installationId;
  const current = () =>
    combineQuotePredicates(authority.predicate('read'), access.predicate());
  const matches = (candidate: typeof actor) => {
    const found = captureActor(candidate);
    if (
      found.organizationId !== actor.organizationId ||
      found.userId !== actor.userId
    )
      throw new QuoteLedgerError('forbidden');
  };
  const bound = (proposalId: string) =>
    combineQuotePredicates(current(), {
      sql: 'EXISTS(SELECT 1 FROM action_engine_quote_proposals WHERE organization_id=? AND id=? AND source_id=?)',
      bindings: [actor.organizationId, proposalId, access.sourceId],
    });
  const ledgerFence: QuoteLedgerFence = async (request) => {
    matches(request.actor);
    if (request.operation === 'read') {
      if (request.sourceId !== null) {
        if (request.sourceId !== access.sourceId || request.proposalId !== null)
          throw new QuoteLedgerError('forbidden');
        return current();
      }
      if (!request.proposalId) throw new QuoteLedgerError('forbidden');
      return bound(request.proposalId);
    }
    if (request.operation !== 'confirm') return { sql: '0', bindings: [] };
    const r = request.reservation;
    if (
      request.proposal.plan.sourceId !== access.sourceId ||
      r.installationId !== installationId ||
      r.userId !== actor.userId
    )
      throw new QuoteLedgerError('forbidden');
    return combineQuotePredicates(
      bound(request.proposal.id),
      quotePublicationEvidencePredicate({
        organizationId: actor.organizationId,
        proposalId: request.proposal.id,
        reservationId: r.id,
        fingerprint: request.proposal.fingerprint,
        userId: actor.userId,
        installationId,
        customerId: r.customerId,
        quoteId: r.quoteId,
        receipt: request.receipt,
      }),
    );
  };
  const evidenceFence: QuotePublicationEvidenceFence = async (request) => {
    matches(request.actor);
    if (request.operation === 'read')
      return combineQuotePredicates(current(), {
        sql: 'EXISTS(SELECT 1 FROM action_engine_quote_reservations r JOIN action_engine_quote_proposals p ON p.organization_id=r.organization_id AND p.id=r.proposal_id WHERE r.organization_id=? AND r.id=? AND r.user_id=? AND r.installation_id=? AND p.source_id=?)',
        bindings: [
          actor.organizationId,
          request.reservationId,
          actor.userId,
          installationId,
          access.sourceId,
        ],
      });
    if (request.verified.installationId !== installationId)
      throw new QuoteLedgerError('forbidden');
    return bound(request.verified.proposalId);
  };
  return Object.freeze({ ledgerFence, evidenceFence });
}
