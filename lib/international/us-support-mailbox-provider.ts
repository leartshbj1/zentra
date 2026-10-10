import { listMail, readMail, verifyMailbox, type MailReference } from '../support/infomaniak';
import { SupportError } from '../support/types';
import { UsMailboxError, type UsMailboxConnection } from './us-support-mailbox-contract';
import { validateUsMailboxMessages, type UsMailboxMessage } from './us-support-mailbox-messages';
import type { UsMailboxContext } from './us-support-mailbox-contract';

type Check = () => Promise<unknown>;
function guarded(fetcher: typeof fetch, check: Check, deadline: AbortSignal): typeof fetch {
  return async (input, init) => {
    deadline.throwIfAborted(); await check(); deadline.throwIfAborted();
    const response = await fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
    try { await check(); deadline.throwIfAborted(); } catch (error) { void response.body?.cancel().catch(() => {}); throw error; } return response;
  };
}
function providerError(error: unknown): never {
  if (error instanceof UsMailboxError) throw error;
  if (error instanceof SupportError && [401,403,422].includes(error.status)) throw new UsMailboxError('mailbox_credentials_rejected', 422);
  throw new UsMailboxError('mailbox_provider_unavailable', 503);
}
/** Shared Infomaniak parser, fixed API origin, bounded responses/timeouts. No
 * mail acknowledgement, download, analysis, worker or financial operation. */
export function createUsMailboxProvider(fetcher: typeof fetch = fetch) {
  return {
    async verify(email: string, token: string, check: Check): Promise<{ mailboxId: string; folderId: string }> {
      try { const result = await verifyMailbox(email, token, guarded(fetcher, check, AbortSignal.timeout(12_000))); await check(); return result; } catch (error) { return providerError(error); }
    },
    async messages(context: UsMailboxContext, connection: UsMailboxConnection, token: string, offset: number, check: Check): Promise<{ messages: readonly UsMailboxMessage[]; nextOffset: number | null }> {
      try {
        const transport = guarded(fetcher, check, AbortSignal.timeout(12_000));
        const page = await listMail(token, connection.mailboxId, connection.folderId, offset, connection.verifiedAt - 30 * 86400, transport); await check();
        if (!Number.isSafeInteger(page.count) || page.count < 0 || page.count > 20 || page.messages.length > 100 || new Set(page.messages.map(m => m.uid)).size !== page.messages.length) throw new UsMailboxError('mailbox_page_unavailable', 503);
        const messages: UsMailboxMessage[] = [];
        // Sequential and bounded: do not fan out 100 provider requests.
        for (const reference of page.messages) {
          if (!/^\d{1,20}$/.test(reference.uid) || reference.date === null || !Number.isFinite(reference.date) || reference.date <= 0) throw new UsMailboxError('mailbox_page_unavailable', 503);
          const ref: MailReference = { ...reference };
          const ticket = await readMail(token, connection.mailboxId, connection.folderId, ref, transport); await check();
          if (ticket.mail?.uid !== reference.uid) throw new UsMailboxError('mailbox_page_unavailable', 503);
          messages.push({ uid: reference.uid, version: ticket.version, subject: ticket.subject, sender: ticket.mail.sender, receivedAt: Math.floor(reference.date), attachments: ticket.mail.attachments.map(a => ({ id: a.id, name: a.name, sizeBytes: a.size })) });
        }
        const nextOffset = page.count === 20 && offset < 200 ? offset + 20 : null;
        const result = validateUsMailboxMessages({ schemaVersion: 1, organizationId: context.authority.organizationId, userId: context.authority.userId, role: context.authority.role, workspaceId: context.workspaceId, connectionId: connection.id, revision: connection.revision, offset, nextOffset, messages }, context.authority.organizationId);
        return { messages: result.messages, nextOffset: result.nextOffset };
      } catch (error) { return providerError(error); }
    },
  };
}
