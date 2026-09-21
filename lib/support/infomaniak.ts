import {
  CATEGORIES,
  SupportError,
  record,
  text,
  type Directory,
  type Rules,
  type SourceTicket,
  type Connection,
} from './types';
import { digest } from './crypto';

// API used by Infomaniak's official mail client:
// https://github.com/Infomaniak/mcp-server-mail/blob/main/src/mail-client.ts
const ORIGIN = 'https://mail.infomaniak.com/api';
class MailProviderError extends SupportError {
  constructor(message: string, public providerStatus: number) { super(message, 503); }
}
export const MAIL_PAGE_SIZE = 20;
export const MAIL_DIRECTORY: Directory = {
  teams: Object.entries(CATEGORIES).map(([id, name]) => ({ id, name })),
  agents: [],
};
export const MAIL_RULES: Rules = Object.fromEntries(
  Object.keys(CATEGORIES).map((id) => [id, { teamId: id }]),
);
// Existing mailboxes gain the new internal folder without changing any custom routing.
export function mailConnection(c: Connection): Connection {
  if (c.provider !== 'infomaniak') return c;
  const directory = JSON.parse(c.directory_json) as Directory;
  const rules = JSON.parse(c.routes_json) as Rules;
  if (!directory.teams.some(t => t.id === 'supplier_invoice'))
    directory.teams.push({ id: 'supplier_invoice', name: CATEGORIES.supplier_invoice });
  if (!Object.hasOwn(rules, 'supplier_invoice'))
    rules.supplier_invoice = { teamId: 'supplier_invoice' };
  return { ...c, directory_json: JSON.stringify(directory), routes_json: JSON.stringify(rules) };
}
function segment(value: unknown): string {
  const id = String(value ?? '');
  if (!id || id.length > 200 || /[\x00-\x20]/.test(id))
    throw new SupportError('Identifiant Infomaniak invalide.', 502);
  return encodeURIComponent(id);
}
export function normalizeMailToken(value: string): string {
  const token = value.trim().replace(/^Bearer(?:\s+|$)/i, '');
  if (!token || token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(token))
    throw new SupportError(
      'Collez la clé API Infomaniak complète, sans texte supplémentaire. Le mot de passe de votre boîte mail ne convient pas.',
      422,
    );
  return token;
}
// Diagnostic metadata only: never retain an upstream message, URL or response body.
async function providerFailureCode(response: Response): Promise<string | number | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 8192) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const payload = record(JSON.parse(new TextDecoder().decode(bytes)));
    const code = record(payload.error).code ?? payload.error_code ?? payload.code;
    return typeof code === 'number' && Number.isSafeInteger(code) ? code
      : typeof code === 'string' && /^[A-Za-z]{2,20}(?:_[A-Za-z]{2,20}){1,4}$/.test(code) ? code : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}
export async function mailRequest(
  token: string,
  path: string,
  fetcher: typeof fetch = fetch,
) {
  const key = normalizeMailToken(token);
  let response: Response;
  try {
    response = await fetcher(`${ORIGIN}${path}`, {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new SupportError(
      'Infomaniak ne répond pas. La synchronisation sera réessayée.',
      503,
    );
  }
  if (!response.ok) console.error('support_mail_connection_failed', {
    providerStatus: response.status,
    providerCode: await providerFailureCode(response),
    operation: path.startsWith('/mailbox?') ? 'mailboxes' : /\/folder(?:\?|$)/.test(path) ? 'folders' : 'messages',
  });
  if (response.status === 401)
    throw new SupportError(
      'Cette clé API est refusée par Infomaniak. Elle peut être expirée ou révoquée. Créez une nouvelle clé API et collez-la ici, à la place du mot de passe de la boîte mail.',
      422,
    );
  if (response.status === 403)
    throw new SupportError(
      'Cette clé ne permet pas de lire les e-mails. Dans Infomaniak, autorisez workspace:mail et vérifiez que le compte qui crée la clé a accès à cette boîte.',
      422,
    );
  if (!response.ok || response.status >= 300)
    throw new MailProviderError(
      response.status === 429
        ? 'Infomaniak limite les demandes. La synchronisation reprendra plus tard.'
        : 'Impossible de lire cette boîte Infomaniak. Réessayez plus tard.',
      response.status,
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
    !token
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
      'Cette adresse ne figure pas dans les boîtes de ce compte Infomaniak. Utilisez l’adresse principale de la boîte et créez la clé depuis le compte qui peut ouvrir ses e-mails.',
      422,
    );
  const folderPath = `/mail/${segment(box.uuid)}/folder`;
  let folders: unknown;
  try {
    folders = await mailRequest(token, `${folderPath}?with=ik-static`, fetcher);
  } catch (error) {
    // The optional virtual-folder expansion can fail independently of IMAP folders.
    // Retry only provider 5xx errors, at the same authorized mailbox and endpoint.
    if (!(error instanceof MailProviderError) || error.providerStatus < 500) throw error;
    try {
      folders = await mailRequest(token, folderPath, fetcher);
    } catch (fallbackError) {
      if (fallbackError instanceof MailProviderError && fallbackError.providerStatus >= 500)
        throw new MailProviderError(
          'Votre boîte est reconnue, mais Infomaniak renvoie une erreur à l’ouverture des dossiers. Réessayez plus tard. Si cela continue, signalez cette erreur au support Infomaniak.',
          fallbackError.providerStatus,
        );
      throw fallbackError;
    }
  }
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
    mail: { sender: Array.isArray(m.from) ? text(record(m.from[0]).email,254).toLowerCase() : '', uid: ref.uid,
      attachmentCount: Array.isArray(m.attachments) ? m.attachments.map(record).filter(a => !a.is_inline).length || Number(!!m.has_attachments) : Number(!!m.has_attachments),
      bodyIncomplete: body.length > 23000,
      attachments: (Array.isArray(m.attachments)?m.attachments:[]).map(record).filter(a=>!a.is_inline&&/\.(pdf|png|jpe?g)$/i.test(text(a.name))).map(a=>({id:String(a.resource?String(a.resource).split('/').pop():a.part_id??''),name:text(a.name,180),size:Number(a.size||0)})).filter(a=>a.id) },
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

/** Fetch only the fixed provider endpoint, never an attachment-controlled URL. */
export async function readMailAttachment(token:string,mailboxId:string,folderId:string,uid:string,id:string,fetcher:typeof fetch=fetch) {
  const response=await fetcher(`${ORIGIN}/mail/${segment(mailboxId)}/folder/${segment(folderId)}/message/${segment(uid)}/attachment/${segment(id)}`,{headers:{Authorization:`Bearer ${token}`},redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new SupportError('La pièce jointe est indisponible. La réception sera réessayée.',503);
  const max=6*1024*1024;
  if(Number(response.headers.get('content-length'))>max) throw new SupportError('Une pièce jointe dépasse 6 Mo. Importez-la directement dans Gestion.');
  const reader=response.body?.getReader();if(!reader) throw new SupportError('Pièce jointe vide.',502);
  const chunks:Uint8Array[]=[];let size=0;
  try { for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>max){await reader.cancel();throw new SupportError('Une pièce jointe dépasse 6 Mo. Importez-la directement dans Gestion.');}chunks.push(part.value);} } finally {reader.releaseLock();}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
