import { database } from '@/lib/runtime';
import { createHistoricalQuoteFences } from './historical-quote-fences';
import { createD1QuoteLedger } from './ledger';
import { QuoteLedgerError } from './ledger-types';
import type { DeviceQuoteAuthority } from './production-admission';
import { readSupportQuoteAccess } from './support-source';
import { ActionEngineError, type StoredQuoteProposal } from './types';
import { actionIdentifier, captureActor } from './validation';

/** Recover only an immutable preparation, never a permission to execute it.
 * In particular, an ACK lost after save must not require the current archive,
 * current article prices, a live connector or another model decision. A8 still
 * checks all current progression gates before granting any fresh draft write.
 * This is private server composition; it is not a route or a Support worker. */
export async function readPreparedDeviceQuote(
  authority: DeviceQuoteAuthority,
  rawSourceId: string,
): Promise<StoredQuoteProposal | null> {
  const actor = captureActor(authority.actor),
    sourceId = actionIdentifier(rawSourceId);
  await authority.authorizeRead();
  let access;
  try {
    access = await readSupportQuoteAccess(actor, sourceId);
  } catch (error) {
    await authority.authorizeRead();
    throw error;
  }
  if (access.sourceId !== sourceId) throw new ActionEngineError('forbidden');
  const db = database(),
    fences = createHistoricalQuoteFences(authority, access);
  const authorize = async () => {
    await authority.authorizeRead();
    const predicate = await fences.ledgerFence({
      operation: 'read',
      actor,
      sourceId,
      proposalId: null,
    });
    try {
      const row = await db
        .prepare(
          `SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS allowed`,
        )
        .bind(...predicate.bindings)
        .first<{ allowed: number }>();
      if (row?.allowed !== 1) throw new ActionEngineError('forbidden');
    } catch (error) {
      if (error instanceof ActionEngineError) throw error;
      throw new QuoteLedgerError('service_unavailable');
    }
  };
  await authorize();
  let proposal: StoredQuoteProposal | null;
  try {
    proposal = await createD1QuoteLedger(db, fences.ledgerFence).findProposal(
      actor,
      sourceId,
    );
  } catch (error) {
    await authorize();
    throw error;
  }
  // Check both device and delegated source access after the ledger's digest
  // awaits, including the empty result. Never turn a failed read into a miss.
  await authorize();
  return proposal;
}
