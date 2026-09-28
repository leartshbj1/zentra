import { record, SupportError, type Workspace } from './types';

/** Bounded batches use the same guarded individual operation and its idempotency ledger. */
export async function solicitationBatch(
  raw: Record<string, unknown>,
  action: string,
  invoke: (action: string, item: Record<string, unknown>) => Promise<unknown>,
  reauthorize: () => Promise<Workspace>,
) {
  const operations: Record<string, string> = {
    previewSolicitationBatch: 'previewSolicitationReply',
    sendSolicitationBatch: 'sendSolicitationReply',
    ignoreSolicitationBatch: 'ignoreSolicitation',
  };
  if (
    !operations[action] ||
    !Array.isArray(raw.items) ||
    !raw.items.length ||
    raw.items.length > 20
  )
    throw new SupportError('Sélectionnez entre 1 et 20 messages.');
  const items = raw.items.map(record),
    ids = items.map((i) => String(i.ticketId || ''));
  if (
    ids.some((id) => !id || id.length > 50) ||
    new Set(ids).size !== ids.length
  )
    throw new SupportError(
      'La sélection contient des messages invalides ou répétés.',
    );
  if (action === 'sendSolicitationBatch' && raw.confirm !== true)
    throw new SupportError(
      'Relisez chaque destinataire et confirmez les envois.',
    );
  const recipients = new Set<string>(),
    results = [];
  for (const item of items) {
    try {
      await reauthorize();
      // One STOP per mailbox within a batch, never several replies to the same sender.
      const recipient = String(
        record(item.target).recipient || '',
      ).toLowerCase();
      if (action === 'sendSolicitationBatch' && recipients.has(recipient))
        throw new SupportError(
          'Un autre message de ce lot vise déjà ce destinataire. Aucun nouvel envoi demandé.',
        );
      if (action === 'sendSolicitationBatch') recipients.add(recipient);
      const result = await invoke(operations[action], {
        ...item,
        intent: 'stop',
        confirm: action === 'sendSolicitationBatch',
      });
      results.push({ ticketId: item.ticketId, result });
    } catch (error) {
      results.push({
        ticketId: item.ticketId,
        error:
          error instanceof SupportError
            ? error.message
            : 'Cette action n’a pas abouti. Vérifiez l’état du message avant de réessayer.',
      });
    }
  }
  return { results };
}
