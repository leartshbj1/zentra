import { decisionApiKey } from '@/lib/automation/config';
import { database } from '@/lib/runtime';
import { prepareQuoteProposal } from './engine';
import { createD1QuoteIntake } from './intake';
import { createD1QuoteLedger } from './ledger';
import { createDeviceQuoteAuthority } from './production-admission';
import { createQuoteDecisionProvider } from './provider';
import { loadDeviceQuotePlanningContext } from './published-context';
import { createPublishedQuoteFences } from './published-fences';
import { publicationCoordinationEnabled } from './publication-gateway';
import { ActionEngineError } from './types';
import { actionIdentifier } from './validation';

/**
 * Private server composition only. No route, Support trigger or native IPC calls
 * this yet. It can prepare an immutable proposal, never confirm/issue/send one.
 * Only guarded CH paid-Complete companies with separate consent are admitted.
 */
export async function prepareDeviceSupportQuote(
  request: Request,
  rawSourceId: string,
) {
  const sourceId = actionIdentifier(rawSourceId),
    captured = new Request(request.url, {
      headers: new Headers(request.headers),
    });
  const authority = await createDeviceQuoteAuthority(captured);
  if (!publicationCoordinationEnabled(authority.actor.organizationId))
    throw new ActionEngineError('forbidden');
  const cas = await authority.preflightCas();
  const loaded = await loadDeviceQuotePlanningContext(captured, sourceId);
  const fences = await createPublishedQuoteFences(authority, cas, loaded);
  const db = database();
  const authorize = async () => {
    if (!publicationCoordinationEnabled(authority.actor.organizationId))
      throw new ActionEngineError('forbidden');
    const current = await authority.preflight();
    if (current.revision !== fences.admission.revision)
      throw new ActionEngineError('stale_plan');
    const predicate = fences.progression();
    const row = await db
      .prepare(
        `SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS allowed`,
      )
      .bind(...predicate.bindings)
      .first<{ allowed: number }>();
    if (row?.allowed !== 1) throw new ActionEngineError('forbidden');
    return current;
  };
  await authorize();
  const ledger = createD1QuoteLedger(db, fences.ledgerFence);
  const intake = createD1QuoteIntake(db, fences.intakeFence);
  const provider = createQuoteDecisionProvider(
    await decisionApiKey(),
    async () => {
      await authorize();
    },
  );
  return prepareQuoteProposal(authority.actor, sourceId, {
    intake,
    provider,
    authorize,
    loadContext: async () => fences.context,
    findProposal: ledger.findProposal,
    saveProposal: ledger.saveProposal,
  });
}
