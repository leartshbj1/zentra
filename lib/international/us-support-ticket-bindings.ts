import { usSupportWorkspacesEnabled } from './us-support-workspace-bindings';
import { usSupportMailboxMember } from './us-support-mailbox-bindings';
import { d1UsSupportTicketStore } from './us-support-ticket-d1';
import { UsSupportTicketError } from './us-support-ticket-contract';
import { isUsSupportWorkerContext, sameUsSupportExecutionContext, validateUsSupportExecutionContext, type UsSupportExecutionContext } from './us-support-execution-contract';
import { createUsSupportTicketHandlers } from './us-support-ticket-server';
import { sha256Hex } from './canonical-hash';

/** Ticket history depends on H1 and its own gate, never on a live mailbox,
 * provider key, Automation entitlement or current classification recipe. */
export async function usSupportTicketsEnabled(): Promise<boolean> {
  try {
    if (!await usSupportWorkspacesEnabled()) return false;
    const { env } = await import('cloudflare:workers');
    return (env as unknown as Record<string, string | undefined>).INTERNATIONAL_US_SUPPORT_TICKETS_ENABLED === 'true' && await usSupportWorkspacesEnabled();
  } catch { return false; }
}
export const usSupportTicketHandlers = createUsSupportTicketHandlers({
  enabled: usSupportTicketsEnabled,
  now: () => Math.floor(Date.now() / 1000),
  member: usSupportMailboxMember,
  async store() { return d1UsSupportTicketStore((await import('../runtime')).database()); },
  async rateLimit(request, operation, key) { await (await import('../account')).enforceAccountRateLimit(request, 'international-us-support-ticket-' + operation, key, operation === 'head' ? 3600 : operation === 'read' ? 600 : 60); },
  diagnostic(event) { console.warn('zentra.international.us-support-ticket', event); },
});

/** Exact stable envelope for completion/replay hooks. Each actor retains their
 * own receipt; source uniqueness in D1 prevents new recipes creating copies. */
export async function usSupportTicketCompletionRequestId(jobId: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(jobId)) throw new UsSupportTicketError('invalid_ticket_request', 422);
  const digest = await sha256Hex('zentra:us-support-ticket:completed:v1:' + jobId);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((parseInt(digest[16], 16) & 3) | 8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
/** No new model/provider call. A failed confirmation keeps the completed H3a
 * result durable; its exact HTTP retry can finish this separately gated step. */
export async function recordUsSupportTicketCompletion(context: UsSupportExecutionContext, jobId: string, revalidate: () => Promise<UsSupportExecutionContext>): Promise<void> {
  const initial = validateUsSupportExecutionContext(context);
  if (!await usSupportTicketsEnabled()) {
    if (isUsSupportWorkerContext(initial)) throw new UsSupportTicketError('feature_unavailable', 404);
    return;
  }
  const current = async () => {
    const next = validateUsSupportExecutionContext(await revalidate()); sameUsSupportExecutionContext(initial, next);
    if (!await usSupportTicketsEnabled()) throw new UsSupportTicketError('feature_unavailable', 404);
    return next;
  };
  const requestId = await usSupportTicketCompletionRequestId(jobId); await current();
  const store = d1UsSupportTicketStore((await import('../runtime')).database());
  await store.commit(await current(), { schemaVersion: 1, requestId, action: 'create', jobId }, current); await current();
}
