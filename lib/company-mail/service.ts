import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { database, runtimeValue } from '@/lib/runtime';
import { decryptSecret, encryptSecret } from '@/lib/support/crypto';
import { mailLogo } from './logo';
import {
  emailAddress,
  InfomaniakSender,
  mailToken,
  MailProviderError,
  type PreparedMail,
} from './provider';

export type MailActor = {
  organizationId: string;
  userId: string;
  role: string;
};
export type MailAuthorization = () => Promise<MailActor>;
type Connection = {
  organization_id: string;
  connection_id: string;
  mailbox_id: string;
  identity_id: string | null;
  from_email: string;
  from_name: string;
  secret_ciphertext: string;
  updated_at: number;
};
type Submission = {
  request_id: string;
  payload_hash: string;
  state: string;
  created_at: number;
};
const clock = () => Math.floor(Date.now() / 1000);
function publicStatus(state: string, createdAt: number) {
  if (state === 'preparing' || state === 'submitting')
    return createdAt <= clock() - 120
      ? state === 'preparing'
        ? 'rejected'
        : 'uncertain'
      : 'pending';
  return state;
}
const SENDERS = ['owner', 'admin', 'accountant', 'member'];
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const keyContext = (org: string, id: string) =>
  `zentra.company-mail.v1:${org}:${id}`;
function role(actor: MailActor, manage = false) {
  if (!(manage ? ['owner', 'admin'] : SENDERS).includes(actor.role))
    throw new AccountPublicError(
      manage
        ? 'Demandez à un administrateur de configurer la messagerie de l’entreprise.'
        : 'Votre rôle permet la consultation uniquement.',
      403,
    );
}
async function reauthorize(
  actor: MailActor,
  authorize: MailAuthorization,
  manage = false,
) {
  const current = await authorize();
  if (
    current.organizationId !== actor.organizationId ||
    current.userId !== actor.userId
  )
    throw new AccountPublicError(
      'L’entreprise ou le compte a changé. Rouvrez cette action.',
      409,
    );
  role(current, manage);
}
const connection = (org: string) =>
  database()
    .prepare('SELECT * FROM company_mail_connections WHERE organization_id=?')
    .bind(org)
    .first<Connection>();
function singleLine(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    // eslint-disable-next-line no-control-regex -- reject mail header injection
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new AccountPublicError(`Vérifiez ${label}.`);
  return value.trim();
}
export async function sharedMailState(
  actor: MailActor,
  target?: { entity: string; id: string },
) {
  const c = await connection(actor.organizationId);
  const history = target
    ? await database()
        .prepare(
          `SELECT request_id AS requestId,recipient,subject,state AS status,from_email AS fromEmail,actor_id AS actorId,created_at AS createdAt FROM company_mail_submissions WHERE organization_id=? AND entity=? AND document_id=? ORDER BY created_at DESC,request_id DESC LIMIT 10`,
        )
        .bind(actor.organizationId, target.entity, target.id)
        .all()
    : { results: [] };
  return {
    scope: 'company',
    canConfigure: ['owner', 'admin'].includes(actor.role),
    canSend: SENDERS.includes(actor.role),
    organizationId: actor.organizationId,
    connection: c
      ? {
          connected: !!c.identity_id,
          connectionId: c.connection_id,
          provider: 'infomaniak',
          fromEmail: c.from_email,
          fromName: c.from_name,
          verifiedAt: c.updated_at,
        }
      : { connected: false },
    history: history.results.map((row) => ({
      ...row,
      status: publicStatus(String(row.status), Number(row.createdAt)),
      createdAt: new Date(Number(row.createdAt) * 1000).toISOString(),
    })),
  };
}
export async function sharedMailReceipt(actor: MailActor, requestId: string) {
  if (!uuid(requestId))
    throw new AccountPublicError('Rouvrez l’historique du document.');
  const row = await database()
    .prepare(
      `SELECT request_id AS requestId,entity,document_id AS documentId,recipient,subject,state AS status,from_email AS fromEmail,attachment_hash AS attachmentHash,created_at AS createdAt FROM company_mail_submissions WHERE organization_id=? AND request_id=?`,
    )
    .bind(actor.organizationId, requestId.toLowerCase())
    .first<Record<string, unknown>>();
  return row
    ? {
        ...row,
        status: publicStatus(String(row.status), Number(row.createdAt)),
        createdAt: new Date(Number(row.createdAt) * 1000).toISOString(),
      }
    : null;
}
export async function connectSharedMail(
  actor: MailActor,
  raw: Record<string, unknown>,
  authorize: MailAuthorization,
) {
  role(actor, true);
  const token = mailToken(raw.token),
    email = emailAddress(raw.fromEmail),
    name = singleLine(raw.fromName, 120, 'le nom de l’expéditeur');
  const identity = await new InfomaniakSender(token).verify(email, name);
  const id = crypto.randomUUID();
  // The encryption domain differs from every Support connection. Nothing is copied from Support.
  const sealed = await encryptSecret(
    runtimeValue('SUPPORT_ENCRYPTION_KEY'),
    token,
    keyContext(actor.organizationId, id),
  );
  await reauthorize(actor, authorize, true);
  await database()
    .prepare(`INSERT INTO company_mail_connections(organization_id,connection_id,provider,mailbox_id,identity_id,from_email,from_name,secret_ciphertext,connected_by,updated_at)
    VALUES(?,?,'infomaniak',?,?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET connection_id=excluded.connection_id,mailbox_id=excluded.mailbox_id,identity_id=excluded.identity_id,from_email=excluded.from_email,from_name=excluded.from_name,secret_ciphertext=excluded.secret_ciphertext,connected_by=excluded.connected_by,updated_at=excluded.updated_at`)
    .bind(
      actor.organizationId,
      id,
      identity.mailboxId,
      identity.identityId,
      identity.email,
      identity.name,
      sealed,
      actor.userId,
      clock(),
    )
    .run();
  return sharedMailState(actor);
}
export async function disconnectSharedMail(actor: MailActor) {
  role(actor, true);
  await database()
    .prepare('DELETE FROM company_mail_connections WHERE organization_id=?')
    .bind(actor.organizationId)
    .run();
  return sharedMailState(actor);
}
async function validateSubmission(raw: Record<string, unknown>) {
  if (raw.confirmed !== true)
    throw new AccountPublicError(
      'Relisez le destinataire et le message, puis confirmez l’envoi.',
    );
  const allowed = [
    'action',
    'organizationId',
    'requestId',
    'confirmed',
    'entity',
    'documentId',
    'sourceRevision',
    'recipient',
    'subject',
    'body',
    'attachmentName',
    'pdfBase64',
    'signatureLogoDataUrl',
    'connectionId',
  ];
  if (Object.keys(raw).some((k) => !allowed.includes(k)))
    throw new AccountPublicError(
      'Ce format d’e-mail n’est pas pris en charge. Actualisez Zentra avant d’envoyer.',
    );
  if (
    !uuid(raw.requestId) ||
    !uuid(raw.connectionId) ||
    !uuid(raw.documentId) ||
    typeof raw.sourceRevision !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(raw.sourceRevision) ||
    !['quotes', 'invoices', 'reminders'].includes(String(raw.entity))
  )
    throw new AccountPublicError(
      'Rouvrez le document pour préparer son envoi.',
    );
  const subject = singleLine(raw.subject, 250, 'l’objet du message'),
    recipient = emailAddress(raw.recipient);
  if (
    typeof raw.body !== 'string' ||
    !raw.body.trim() ||
    new TextEncoder().encode(raw.body).length > 24000 ||
    // eslint-disable-next-line no-control-regex -- allow newlines, reject non-text controls
    /[\x00\x0b\x0c\x7f]/.test(raw.body)
  )
    throw new AccountPublicError(
      'Ajoutez un message de moins de 24 000 octets.',
    );
  const filename = singleLine(
    raw.attachmentName,
    180,
    'le nom de la pièce jointe',
  );
  if (!/\.pdf$/i.test(filename) || /[/\\]/.test(filename))
    throw new AccountPublicError('Joignez le PDF du document.');
  if (
    typeof raw.pdfBase64 !== 'string' ||
    raw.pdfBase64.length > 8 * 1024 * 1024 ||
    raw.pdfBase64.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(raw.pdfBase64)
  )
    throw new AccountPublicError('Le PDF doit peser moins de 6 Mo.');
  const padding = raw.pdfBase64.indexOf('=');
  if (
    padding !== -1 &&
    (padding < raw.pdfBase64.length - 2 ||
      /[^=]/.test(raw.pdfBase64.slice(padding)))
  )
    throw new AccountPublicError('Le PDF est incomplet. Rouvrez le document.');
  const pdf = Uint8Array.from(atob(raw.pdfBase64), (c) => c.charCodeAt(0));
  if (
    pdf.length < 12 ||
    pdf.length > 6 * 1024 * 1024 ||
    !/^%PDF-[12]\./.test(new TextDecoder().decode(pdf.subarray(0, 8)))
  )
    throw new AccountPublicError(
      'La pièce jointe n’est pas un PDF valide. Rouvrez le document.',
    );
  const attachmentHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', pdf)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const logo = mailLogo(raw.signatureLogoDataUrl);
  const logoHash = logo
    ? Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', logo.bytes)),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('')
    : null;
  const input: PreparedMail = {
    recipient,
    subject,
    body: raw.body,
    filename: filename
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_. ()-]/gi, '_'),
    pdf,
    logo,
  };
  const documentId = raw.documentId.toLowerCase();
  const hash = await sha256Hex(
    JSON.stringify([
      raw.entity,
      documentId,
      raw.sourceRevision.toLowerCase(),
      recipient,
      subject,
      raw.body,
      input.filename,
      attachmentHash,
      logoHash,
      raw.connectionId.toLowerCase(),
    ]),
  );
  return {
    input,
    hash,
    attachmentHash,
    requestId: raw.requestId.toLowerCase(),
    entity: raw.entity as string,
    documentId,
  };
}
async function replay(actor: MailActor, old: Submission, hash: string) {
  if (old.payload_hash !== hash)
    throw new AccountPublicError(
      'Cette tentative concerne un autre message. Fermez puis rouvrez l’e-mail.',
      409,
    );
  if (old.state === 'accepted') return { status: 'accepted', replayed: true };
  if (old.state === 'preparing' || old.state === 'submitting') {
    if (old.created_at > clock() - 120)
      return { status: 'pending', replayed: true };
    // A dead worker must never leave a spinner forever or cause an automatic re-send.
    const state = old.state === 'submitting' ? 'uncertain' : 'rejected';
    await database()
      .prepare(
        'UPDATE company_mail_submissions SET state=?,updated_at=? WHERE organization_id=? AND request_id=? AND state=?',
      )
      .bind(state, clock(), actor.organizationId, old.request_id, old.state)
      .run();
    const fresh = await database()
      .prepare(
        'SELECT state FROM company_mail_submissions WHERE organization_id=? AND request_id=?',
      )
      .bind(actor.organizationId, old.request_id)
      .first<{ state: string }>();
    if (fresh?.state === 'accepted')
      return { status: 'accepted', replayed: true };
    return {
      status: publicStatus(fresh?.state ?? state, old.created_at),
      replayed: true,
    };
  }
  return { status: old.state, replayed: true };
}
export async function sendSharedMail(
  actor: MailActor,
  raw: Record<string, unknown>,
  authorize: MailAuthorization,
) {
  role(actor);
  if (
    raw.organizationId !== undefined &&
    raw.organizationId !== actor.organizationId
  )
    throw new AccountPublicError('Cette entreprise n’est pas accessible.', 403);
  const { input, hash, attachmentHash, requestId, entity, documentId } =
      await validateSubmission(raw),
    db = database();
  const previous = () =>
    db
      .prepare(
        'SELECT request_id,payload_hash,state,created_at FROM company_mail_submissions WHERE organization_id=? AND request_id=?',
      )
      .bind(actor.organizationId, requestId)
      .first<Submission>();
  const old = await previous();
  if (old) return replay(actor, old, hash);
  const c = await connection(actor.organizationId);
  if (!c || !c.identity_id)
    throw new AccountPublicError(
      'Connectez une adresse d’envoi dans les e-mails de l’entreprise.',
      409,
    );
  if (String(raw.connectionId).toLowerCase() !== c.connection_id)
    throw new AccountPublicError(
      'L’adresse d’envoi a changé. Rouvrez l’e-mail pour vérifier l’expéditeur.',
      409,
    );
  const claimed = await db
    .prepare(`INSERT INTO company_mail_submissions(organization_id,request_id,payload_hash,connection_id,actor_id,entity,document_id,recipient,subject,from_email,attachment_hash,state,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,'preparing',?,? WHERE
      (SELECT COUNT(*) FROM company_mail_submissions WHERE organization_id=? AND created_at>=?)<360 AND
      (SELECT COUNT(*) FROM company_mail_submissions WHERE organization_id=? AND created_at>=?)<1000
    ON CONFLICT(organization_id,request_id) DO NOTHING RETURNING request_id`)
    .bind(
      actor.organizationId,
      requestId,
      hash,
      c.connection_id,
      actor.userId,
      entity,
      documentId,
      input.recipient,
      input.subject,
      c.from_email,
      attachmentHash,
      clock(),
      clock(),
      actor.organizationId,
      clock() - 3600,
      actor.organizationId,
      clock() - 86400,
    )
    .first();
  if (!claimed) {
    const concurrent = await previous();
    if (concurrent) return replay(actor, concurrent, hash);
    throw new AccountPublicError(
      'La limite de sécurité des envois de cette entreprise est atteinte. Réessayez plus tard.',
      429,
    );
  }
  let submitting = false;
  try {
    const token = await decryptSecret(
      runtimeValue('SUPPORT_ENCRYPTION_KEY'),
      c.secret_ciphertext,
      keyContext(actor.organizationId, c.connection_id),
    );
    const sender = new InfomaniakSender(token),
      identity = await sender.verify(c.from_email, c.from_name);
    if (
      identity.mailboxId !== c.mailbox_id ||
      identity.identityId !== c.identity_id ||
      identity.name !== c.from_name
    )
      throw new AccountPublicError(
        'L’identité d’expédition a changé dans Infomaniak. Reconnectez cette adresse avant d’envoyer.',
        409,
      );
    const draft = await sender.prepare(identity, input);
    await reauthorize(actor, authorize);
    // Disconnect/reconnect and worker cancellation can win before the irreversible send.
    const ready = await db
      .prepare(`UPDATE company_mail_submissions SET state='submitting',draft_id=?,updated_at=? WHERE organization_id=? AND request_id=? AND state='preparing'
      AND EXISTS(SELECT 1 FROM company_mail_connections WHERE organization_id=? AND connection_id=?) RETURNING request_id`)
      .bind(
        draft.uuid,
        clock(),
        actor.organizationId,
        requestId,
        actor.organizationId,
        c.connection_id,
      )
      .first();
    if (!ready)
      throw new AccountPublicError(
        'La messagerie a changé pendant la préparation. Rouvrez l’e-mail.',
        409,
      );
    submitting = true;
    await sender.submit(identity, draft);
    await db
      .prepare(
        "UPDATE company_mail_submissions SET state='accepted',updated_at=? WHERE organization_id=? AND request_id=? AND state IN ('submitting','uncertain')",
      )
      .bind(clock(), actor.organizationId, requestId)
      .run();
    return { status: 'accepted', replayed: false };
  } catch (error) {
    const state =
      submitting &&
      (!(error instanceof MailProviderError) || error.outcome === 'uncertain')
        ? 'uncertain'
        : 'rejected';
    try {
      await db
        .prepare(
          "UPDATE company_mail_submissions SET state=?,updated_at=? WHERE organization_id=? AND request_id=? AND state IN ('preparing','submitting','uncertain')",
        )
        .bind(state, clock(), actor.organizationId, requestId)
        .run();
    } catch {
      /* The original pending reservation still prevents a second send. */
    }
    if (state === 'uncertain')
      throw new AccountPublicError(
        'L’envoi n’a pas de confirmation certaine. Vérifiez les messages envoyés avant de préparer un nouvel envoi.',
        503,
      );
    if (error instanceof AccountPublicError) throw error;
    throw new AccountPublicError(
      'La préparation du message a échoué. Aucun envoi n’a été demandé.',
      503,
    );
  }
}
