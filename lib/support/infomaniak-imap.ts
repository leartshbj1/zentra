import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import { SupportError, type SourceTicket } from './types';
import { MAIL_PAGE_SIZE, mailExternalId, plainMail, type MailReference } from './infomaniak';

const PREFIX = 'zentra-imap-v1:';
const MAX_MESSAGE = 12 * 1024 * 1024;
const MAX_ATTACHMENT = 6 * 1024 * 1024;
type Credentials = { password: string; firstUid: number };

export function encodeImapCredentials(value: Credentials) {
  return PREFIX + JSON.stringify(value);
}
export function decodeImapCredentials(secret: string): Credentials | null {
  if (!secret.startsWith(PREFIX)) return null;
  try {
    const value = JSON.parse(secret.slice(PREFIX.length));
    if (typeof value.password === 'string' && Number.isSafeInteger(value.firstUid) && value.firstUid > 0)
      return value;
  } catch { /* Never expose stored credentials in an error. */ }
  throw new SupportError('Reconnectez votre boîte mail dans Connexions.', 422);
}

function connectionError(error: unknown) {
  if (error instanceof SupportError) return error;
  const e = error as { authenticationFailed?: boolean; responseStatus?: string; code?: string };
  if (e?.authenticationFailed || e?.code === 'AUTHENTICATIONFAILED')
    return new SupportError('Infomaniak refuse ce mot de passe. Utilisez le mot de passe dédié à cette adresse mail, ou un mot de passe d’application si la double authentification est active. La clé API ne convient pas.', 422);
  return new SupportError('La connexion sécurisée à Infomaniak n’a pas abouti. Réessayez dans un instant. Vos e-mails restent dans votre boîte.', 503);
}

/** Fixed destination, verified TLS and read-only IMAP. Never send mail or modify flags. */
export async function openImapMailbox(email: string, password: string, expectedFolder?: string) {
  if (!/^[^\s:@]+@[^\s:]+\.[^\s:]+$/.test(email) || !password || password.length > 8192 || /[\x00-\x1f\x7f]/.test(password))
    throw new SupportError('Renseignez votre adresse mail et le mot de passe de cette boîte.', 422);
  const client = new ImapFlow({
    host: 'mail.infomaniak.com', port: 993, secure: true,
    auth: { user: email, pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'mail.infomaniak.com' },
    logger: false, emitLogs: false, logRaw: false,
    disableAutoIdle: true, disableCompression: true, disableBinary: true, disableAutoEnable: true,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
  client.on('error', () => { /* Errors are converted to safe messages by the awaited operation. */ });
  try {
    await client.connect();
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    const folderId = `imap:INBOX:${box.uidValidity}`;
    if (expectedFolder && expectedFolder !== folderId)
      throw new SupportError('Infomaniak a recréé cette boîte de réception. Contactez Zentra pour reprendre sa réception sans doublons.', 409);
    const mailboxId = `imap:${email.toLowerCase()}`;
    const nextUid = box.uidNext;
    if (!Number.isSafeInteger(nextUid) || nextUid < 1)
      throw new SupportError('Infomaniak n’a pas confirmé les identifiants des e-mails. Réessayez.', 503);
    let attachmentCache = new Map<string, Uint8Array>();
    return {
      mailboxId, folderId, nextUid,
      close() { attachmentCache.clear(); client.close(); },
      async list(offset: number, firstUid: number) {
        // Bounded UID windows avoid searching or loading an entire company mailbox.
        // A complete scan repeats to recover delivery during pagination and UID gaps.
        const high = nextUid - 1 - offset;
        if (high < firstUid) return { messages: [], count: 0 };
        const low = Math.max(firstUid, high - MAIL_PAGE_SIZE + 1);
        try {
          const rows = await client.fetchAll(`${low}:${high}`, { uid: true, internalDate: true }, { uid: true });
          const messages: MailReference[] = rows.filter(row => row.uid >= low && row.uid <= high)
            .sort((a, b) => b.uid - a.uid)
            .map(row => ({ uid: String(row.uid), date: row.internalDate instanceof Date ? Math.floor(row.internalDate.getTime() / 1000) : null }));
          return { messages, count: low > firstUid ? MAIL_PAGE_SIZE : Math.min(MAIL_PAGE_SIZE - 1, high - low + 1) };
        } catch (error) { throw connectionError(error); }
      },
      async read(ref: MailReference): Promise<SourceTicket> {
        attachmentCache.clear();
        if (!/^\d+$/.test(ref.uid)) throw new SupportError('Identifiant de mail invalide.', 422);
        try {
          const metadata = await client.fetchOne(ref.uid, { size: true }, { uid: true });
          if (!metadata) throw new SupportError('Un e-mail a quitté la boîte de réception pendant la lecture. La réception sera réessayée.', 503);
          if ((metadata.size ?? 0) > MAX_MESSAGE)
            throw new SupportError('Un e-mail dépasse 12 Mo. Importez son justificatif directement dans Gestion ; les autres e-mails continuent d’être reçus.', 422);
          const row = await client.fetchOne(ref.uid, { source: { start: 0, maxLength: MAX_MESSAGE + 1 }, internalDate: true }, { uid: true });
          if (!row || !row.source || row.source.length > MAX_MESSAGE)
            throw new SupportError('Un e-mail est incomplet ou trop volumineux. Importez son justificatif directement dans Gestion.', 422);
          const parsed = await PostalMime.parse(row.source, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 30, maxHeadersSize: 65536 });
          const body = (parsed.text?.trim() || plainMail(parsed.html)).slice(0, 24001);
          const attachments: NonNullable<SourceTicket['mail']>['attachments'] = [];
          for (const [index, file] of parsed.attachments.entries()) {
            if (file.disposition === 'inline' || file.related || !/\.(pdf|png|jpe?g)$/i.test(file.filename || '')) continue;
            const bytes = new Uint8Array(file.content as ArrayBuffer);
            const id = `${ref.uid}:${index}`;
            attachments.push({ id, name: (file.filename || 'Document').slice(0, 180), size: bytes.length });
            attachmentCache.set(id, bytes);
          }
          const sender = (parsed.from?.address || '').slice(0, 254).toLowerCase();
          const subject = (parsed.subject || 'Mail sans objet').slice(0, 300);
          return {
            externalId: await mailExternalId(mailboxId, folderId, ref.uid),
            mail: { sender, attachments }, subject,
            body: `${sender ? `De : ${sender}\n\n` : ''}${body || subject}`.slice(0, 24000),
            version: String(ref.date ?? ''), groupId: null, agentId: null, closed: false,
            incomplete: !body || body.length > 23000 || parsed.attachments.length > 0,
          };
        } catch (error) { throw connectionError(error); }
      },
      async attachment(id: string) {
        const bytes = attachmentCache.get(id);
        if (!bytes) throw new SupportError('Pièce jointe indisponible. La réception sera réessayée.', 503);
        if (bytes.length > MAX_ATTACHMENT) throw new SupportError('Une pièce jointe dépasse 6 Mo. Importez-la directement dans Gestion.', 422);
        return bytes;
      },
    };
  } catch (error) { client.close(); throw connectionError(error); }
}

export type ImapMailbox = Awaited<ReturnType<typeof openImapMailbox>>;
