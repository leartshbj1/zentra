import {
  CATEGORIES,
  SupportError,
  record,
  text,
  type Directory,
  type Rules,
  type SourceTicket,
} from './types';
import { digest } from './crypto';

// API used by Infomaniak's official mail client:
// https://github.com/Infomaniak/mcp-server-mail/blob/main/src/mail-client.ts
const ORIGIN = 'https://mail.infomaniak.com/api';
export const MAIL_PAGE_SIZE = 20;
export const MAIL_DIRECTORY: Directory = {
  teams: Object.entries(CATEGORIES).map(([id, name]) => ({ id, name })),
  agents: [],
};
export const MAIL_RULES: Rules = Object.fromEntries(
  Object.keys(CATEGORIES).map((id) => [id, { teamId: id }]),
);
function segment(value: unknown): string {
  const id = String(value ?? '');
  if (!id || id.length > 200 || /[\x00-\x20]/.test(id))
    throw new SupportError('Identifiant Infomaniak invalide.', 502);
  return encodeURIComponent(id);
}
export async function mailRequest(
  token: string,
  path: string,
  fetcher: typeof fetch = fetch,
) {
  let response: Response;
  try {
    response = await fetcher(`${ORIGIN}${path}`, {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new SupportError(
      'Infomaniak ne répond pas. La synchronisation sera réessayée.',
      503,
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new SupportError(
      'Infomaniak refuse la clé. Reconnectez la boîte avec une clé autorisée pour workspace:mail.',
      503,
    );
  if (!response.ok || response.status >= 300)
    throw new SupportError(
      response.status === 429
        ? 'Infomaniak limite les demandes. La synchronisation reprendra plus tard.'
        : 'Impossible de lire cette boîte Infomaniak. Réessayez plus tard.',
      503,
    );
  const reader = response.body?.getReader();
  if (!reader) throw new SupportError('Réponse Infomaniak vide.', 502);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 2_000_000) {
        await reader.cancel();
        throw new SupportError(
          'Ce message Infomaniak est trop volumineux pour être importé.',
          502,
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  let payload: Record<string, unknown>;
  try {
    payload = record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new SupportError('La réponse Infomaniak est illisible.', 502);
  }
  if (payload.result !== 'success')
    throw new SupportError(
      'Infomaniak n’a pas confirmé la lecture de la boîte.',
      502,
    );
  return payload.data;
}
export async function verifyMailbox(
  email: string,
  token: string,
  fetcher: typeof fetch = fetch,
) {
  if (
    !/^[^\s:@]+@[^\s:]+\.[^\s:]+$/.test(email) ||
    !token ||
    /[\r\n]/.test(token)
  )
    throw new SupportError(
      'Renseignez votre adresse mail et votre clé Infomaniak.',
    );
  const boxes = await mailRequest(
    token,
    '/mailbox?with=aliases,permissions,accountId,count_users',
    fetcher,
  );
  if (!Array.isArray(boxes))
    throw new SupportError(
      'La liste des boîtes Infomaniak est illisible.',
      502,
    );
  const box = boxes
    .map(record)
    .find((b) => text(b.email, 254).toLowerCase() === email.toLowerCase());
  if (!box)
    throw new SupportError(
      'Cette adresse ne figure pas parmi les boîtes accessibles avec cette clé. Vérifiez le compte Infomaniak.',
    );
  const folders = await mailRequest(
    token,
    `/mail/${segment(box.uuid)}/folder?with=ik-static`,
    fetcher,
  );
  const flatten = (items: unknown, depth = 0): Record<string, unknown>[] =>
    Array.isArray(items) && depth < 10
      ? items.flatMap((v) => {
          const f = record(v);
          return [f, ...flatten(f.children, depth + 1)];
        })
      : [];
  const inbox = flatten(folders).find(
    (f) => String(f.role).toLowerCase() === 'inbox',
  );
  if (!inbox)
    throw new SupportError(
      'La boîte de réception Infomaniak est introuvable.',
      502,
    );
  segment(inbox.id);
  return { mailboxId: String(box.uuid), folderId: String(inbox.id) };
}
export type MailReference = { uid: string; date: number | null };
export function mailDate(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : /^\d+(\.\d+)?$/.test(String(value))
        ? Number(value)
        : NaN;
  const result = Number.isFinite(number)
    ? number > 1e12
      ? number / 1000
      : number
    : Date.parse(String(value)) / 1000;
  return Number.isFinite(result) && result > 0 ? result : null;
}
export async function listMail(
  token: string,
  mailboxId: string,
  folderId: string,
  offset: number,
  since: number,
  fetcher: typeof fetch = fetch,
) {
  const params = new URLSearchParams({
    offset: String(offset),
    thread: 'off',
    severywhere: '0',
    limit: String(MAIL_PAGE_SIZE),
    sfromdate: `${new Date((since - 86400) * 1000).toISOString().slice(0, 10)} 00:00:00`,
  });
  const data = record(
    await mailRequest(
      token,
      `/mail/${segment(mailboxId)}/folder/${segment(folderId)}/message?${params}`,
      fetcher,
    ),
  );
  if (!Array.isArray(data.threads))
    throw new SupportError(
      'La liste des messages Infomaniak est illisible.',
      502,
    );
  const messages: MailReference[] = [];
  for (const item of data.threads) {
    const thread = record(item);
    if (!Array.isArray(thread.messages) || !thread.messages.length)
      throw new SupportError(
        'Infomaniak a renvoyé un message sans identifiant. La récupération sera réessayée.',
        502,
      );
    for (const raw of thread.messages) {
      const m = record(raw);
      const fullUid = String(m.uid ?? '');
      const uid = fullUid.split('@')[0];
      if (!/^\d+$/.test(uid))
        throw new SupportError('Identifiant de mail Infomaniak invalide.', 502);
      if (m.folder_id != null && String(m.folder_id) !== folderId) continue;
      messages.push({ uid, date: mailDate(m.date ?? thread.date) });
    }
  }
  return { messages, count: data.threads.length };
}
export async function mailExternalId(
  mailboxId: string,
  folderId: string,
  uid: string,
) {
  return 'mail_' + (await digest(JSON.stringify([mailboxId, folderId, uid])));
}
export function plainMail(value: unknown) {
  // This is text extraction only. Email HTML is never rendered in the product.
  return String(value ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*(br|\/p|\/div|\/li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(?:nbsp|amp|lt|gt|quot|#39);/g,
      (v) =>
        ({
          '&nbsp;': ' ',
          '&amp;': '&',
          '&lt;': '<',
          '&gt;': '>',
          '&quot;': '"',
          '&#39;': "'",
        })[v] || v,
    )
    .trim();
}
export async function readMail(
  token: string,
  mailboxId: string,
  folderId: string,
  ref: MailReference,
  fetcher: typeof fetch = fetch,
): Promise<SourceTicket> {
  const m = record(
    await mailRequest(
      token,
      `/mail/${segment(mailboxId)}/folder/${segment(folderId)}/message/${segment(ref.uid)}?prefered_format=html&with=auto_uncrypt,thread_context`,
      fetcher,
    ),
  );
  const body = plainMail(m.body ?? m.html ?? m.preview);
  const from = Array.isArray(m.from)
    ? m.from
        .map((v) => {
          const f = record(v);
          return `${text(f.name, 100)} <${text(f.email, 254)}>`;
        })
        .join(', ')
    : '';
  const subject = text(m.subject, 300) || 'Mail sans objet';
  return {
    externalId: await mailExternalId(mailboxId, folderId, ref.uid),
    subject,
    body: `${from ? `De : ${from}\n\n` : ''}${body || subject}`.slice(0, 24000),
    version: String(m.date ?? ref.date ?? ''),
    groupId: null,
    agentId: null,
    closed: false,
    incomplete:
      !body ||
      body.length > 23000 ||
      !!m.has_attachments ||
      (Array.isArray(m.attachments) && m.attachments.length > 0),
  };
}
