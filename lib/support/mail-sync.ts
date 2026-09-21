import { database, runtimeValue } from '@/lib/runtime';
import { encryptSecret, decryptSecret, digest, equalHash } from './crypto';
import {
  verifyMailbox,
  normalizeMailToken,
  listMail,
  readMail,
  mailExternalId,
  MAIL_DIRECTORY,
  MAIL_RULES,
  MAIL_PAGE_SIZE,
} from './infomaniak';
import {
  SupportError,
  type Connection,
  type Workspace,
  type Ticket,
} from './types';
import { openImapMailbox, decodeImapCredentials, encodeImapCredentials, type ImapMailbox } from './infomaniak-imap';
import { requireSupportSubscription } from './billing';
import { ingest, processTicket } from './service';
import { mailboxCaptureNeeded, captureMailboxInvoices } from '@/lib/supplier-inbox/capture';

type Mailbox = {
  connection_id: string;
  workspace_id: string;
  email: string;
  mailbox_id: string;
  folder_id: string;
  since_at: number;
  scan_offset: number;
  next_sync_at: number;
  last_sync_at: number | null;
  last_error: string | null;
  lease: string | null;
  lease_until: number;
};
const now = () => Math.floor(Date.now() / 1000);
export async function connectMailbox(
  workspace: Workspace,
  email: string,
  token: string,
  mode: 'api' | 'imap' = 'api',
) {
  const db = database();
  const address = email.trim().toLowerCase();

  const existing = await db
    .prepare('SELECT * FROM support_mailboxes WHERE workspace_id=? AND email=?')
    .bind(workspace.id, address)
    .first<Mailbox>();
  if (existing && existing.lease_until > now())
    throw new SupportError('Une synchronisation est en cours. Réessayez dans quelques instants.', 409);
  let verified: { mailboxId: string; folderId: string };
  let switching = false;
  if (mode === 'imap') {
    const previous = existing ? await db.prepare('SELECT secret FROM support_connections WHERE id=? AND workspace_id=?').bind(existing.connection_id, workspace.id).first<{ secret: string }>() : null;
    const credentials = previous ? decodeImapCredentials(await decryptSecret(runtimeValue('SUPPORT_ENCRYPTION_KEY'), previous.secret, `connection:${workspace.id}:${existing!.connection_id}`)) : null;
    const session = await openImapMailbox(address, token, credentials ? existing!.folder_id : undefined);
    try {
      verified = session;
      token = encodeImapCredentials({ password: token, firstUid: credentials?.firstUid ?? session.nextUid });
      switching = !!existing && !credentials;
    } finally { session.close(); }
  } else {
    token = normalizeMailToken(token);
    verified = await verifyMailbox(address, token);
  }
  if (
    existing && !switching &&
    (existing.mailbox_id !== verified.mailboxId ||
      existing.folder_id !== verified.folderId)
  )
    throw new SupportError(
      'L’identité de cette boîte a changé chez Infomaniak. Contactez Zentra pour reprendre son historique.',
    );
  const id = existing?.connection_id || crypto.randomUUID();
  const secret = await encryptSecret(
    runtimeValue('SUPPORT_ENCRYPTION_KEY'),
    token,
    `connection:${workspace.id}:${id}`,
  );
  if (existing) {
    if (existing.lease_until > now())
      throw new SupportError(
        'Une synchronisation est en cours. Réessayez dans quelques instants.',
        409,
      );
    await db.batch([
      db
        .prepare(
          'UPDATE support_connections SET secret=?,active=1 WHERE id=? AND workspace_id=?',
        )
        .bind(secret, id, workspace.id),
      db
        .prepare(
          'UPDATE support_mailboxes SET mailbox_id=?,folder_id=?,since_at=?,scan_offset=?,last_error=NULL,next_sync_at=0 WHERE connection_id=?',
        )
        .bind(verified.mailboxId, verified.folderId, switching ? now() : existing.since_at, switching ? 0 : existing.scan_offset, id),
    ]);
  } else {
    await db.batch([
      db
        .prepare(
          'INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          id,
          workspace.id,
          'infomaniak',
          address,
          'mail.infomaniak.com',
          address,
          secret,
          '',
          JSON.stringify(MAIL_DIRECTORY),
          JSON.stringify(MAIL_RULES),
          now(),
        ),
      db
        .prepare(
          'INSERT INTO support_mailboxes(connection_id,workspace_id,email,mailbox_id,folder_id,since_at) VALUES(?,?,?,?,?,?)',
        )
        .bind(
          id,
          workspace.id,
          address,
          verified.mailboxId,
          verified.folderId,
          now(),
        ),
    ]);
  }
  return { saved: true, connectionId: id, mailbox: true };
}
export async function mailboxStates(workspaceId: string) {
  return (
    await database()
      .prepare(
        'SELECT connection_id AS connectionId,email,last_sync_at AS lastSyncAt,last_error AS lastError,next_sync_at AS nextSyncAt FROM support_mailboxes WHERE workspace_id=?',
      )
      .bind(workspaceId)
      .all()
  ).results;
}
export async function syncMailbox(
  workspace: Workspace,
  connection: Connection,
) {
  if (connection.provider !== 'infomaniak' || !connection.active)
    throw new SupportError('Cette boîte mail n’est pas connectée.');
  await requireSupportSubscription(workspace);
  if (workspace.mode === 'paused') return { paused: true };
  const db = database(),
    lease = crypto.randomUUID();
  const mailbox = await db
    .prepare(
      'UPDATE support_mailboxes SET lease=?,lease_until=? WHERE connection_id=? AND workspace_id=? AND lease_until<=? RETURNING *',
    )
    .bind(lease, now() + 600, connection.id, workspace.id, now())
    .first<Mailbox>();
  if (!mailbox) return { syncing: true };
  let imported = 0,
    processed = 0;
  let captured=0,captureDeferred=false;
  let captureError:string|null=null;
  let imap: ImapMailbox | undefined;
  try {
    const token = await decryptSecret(
      runtimeValue('SUPPORT_ENCRYPTION_KEY'),
      connection.secret,
      `connection:${workspace.id}:${connection.id}`,
    );
    const credentials = decodeImapCredentials(token);
    if (credentials) imap = await openImapMailbox(mailbox.email, credentials.password, mailbox.folder_id);
    const newest = imap ? await imap.list(0, credentials!.firstUid) : await listMail(
      token,
      mailbox.mailbox_id,
      mailbox.folder_id,
      0,
      mailbox.since_at,
    );
    // Check new arrivals on every run, even during a long historical scan.
    const page =
      mailbox.scan_offset > 0
        ? imap ? await imap.list(mailbox.scan_offset, credentials!.firstUid) : await listMail(
            token,
            mailbox.mailbox_id,
            mailbox.folder_id,
            mailbox.scan_offset,
            mailbox.since_at,
          )
        : newest;
    const messages = new Map(
      [...newest.messages, ...page.messages].map((ref) => [ref.uid, ref]),
    );
    for (const ref of messages.values()) {
      if (ref.date !== null && ref.date < mailbox.since_at) continue;
      const external = await mailExternalId(
        mailbox.mailbox_id,
        mailbox.folder_id,
        ref.uid,
      );
      const duplicate = await db
        .prepare(
          'SELECT id FROM support_tickets WHERE connection_id=? AND external_id=?',
        )
        .bind(connection.id, external)
        .first();
      const capture=await mailboxCaptureNeeded(workspace.id,connection.id,external);
      if(capture && captured>=3) captureDeferred=true;
      if(duplicate && capture && captured>=3) continue;
      if (duplicate && !capture) continue;
      const active = await db
        .prepare('SELECT active FROM support_connections WHERE id=?')
        .bind(connection.id)
        .first<{ active: number }>();
      if (!active?.active)
        throw new SupportError('La boîte a été déconnectée.');
      let source;
      try { source = imap ? await imap.read(ref) : await readMail(
        token,
        mailbox.mailbox_id,
        mailbox.folder_id,
        ref,
      ); } catch (error) {
        if (imap && error instanceof SupportError && error.status === 422) { captureError = error.message; continue; }
        throw error;
      }
      if(capture && captured<3) {
        if(source.mail?.attachments.length)captured++;
        try {await captureMailboxInvoices({workspace,connectionId:connection.id,source,token,mailboxId:mailbox.mailbox_id,folderId:mailbox.folder_id,uid:ref.uid,readAttachment:imap?.attachment});}
        catch(error){captureError=error instanceof SupportError?error.message:'Certains justificatifs n’ont pas pu être importés dans Gestion. La réception réessaiera ; les tickets Support continuent d’être traités. Pour un document de plus de 6 Mo ou un mail de plus de 12 pièces, utilisez l’import manuel de Gestion.';}
      }
      if(!duplicate){await ingest(connection, source);imported++;}
    }
    // Repeat complete scans from the connection date. There is no newest-N cap;
    // restarting each scan also recovers changes to offset pagination during delivery.
    const more = page.count >= MAIL_PAGE_SIZE;
    await db
      .prepare(
        'UPDATE support_mailboxes SET scan_offset=?,last_sync_at=? WHERE connection_id=? AND lease=?',
      )
      .bind(
        more ? mailbox.scan_offset + page.count : 0,
        now(),
        connection.id,
        lease,
      )
      .run();
    const pending = await db
      .prepare(
        "SELECT id FROM support_tickets WHERE connection_id=? AND (state='pending' OR (state='processing' AND lease_until<=?) OR (state='error' AND attempts<3 AND updated_at<?)) ORDER BY created_at,id LIMIT 5",
      )
      .bind(connection.id, now(), now() - 300)
      .all<Pick<Ticket, 'id'>>();
    for (const ticket of pending.results) {
      await processTicket(
        ticket.id,
        workspace,
        connection,
        'Synchronisation mail',
      );
      processed++;
    }
    await db
      .prepare(
        'UPDATE support_mailboxes SET next_sync_at=?,last_error=?,lease=NULL,lease_until=0 WHERE connection_id=? AND lease=?',
      )
      .bind(
        now() + (more || captureDeferred || pending.results.length === 5 ? 30 : 300),
        captureError,
        connection.id,
        lease,
      )
      .run();
    return { imported, processed, more };
  } catch (error) {
    const message =
      error instanceof SupportError
        ? error.message
        : 'La synchronisation a été interrompue. Elle sera réessayée.';
    await db
      .prepare(
        'UPDATE support_mailboxes SET last_error=?,next_sync_at=?,lease=NULL,lease_until=0 WHERE connection_id=? AND lease=?',
      )
      .bind(message, now() + 300, connection.id, lease)
      .run();
    throw new SupportError(message, 503);
  } finally { imap?.close(); }
}
export async function runMailSync(request: Request) {
  const expected = runtimeValue('SUPPORT_MAIL_SYNC_TOKEN');
  const actual =
    request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  if (
    !expected ||
    !actual ||
    !equalHash(await digest(expected), await digest(actual))
  )
    throw new SupportError('Accès refusé.', 401);
  const db = database();
  const due = await db
    .prepare(
      "SELECT c.* FROM support_mailboxes m JOIN support_connections c ON c.id=m.connection_id JOIN support_workspaces w ON w.id=c.workspace_id WHERE c.active=1 AND c.provider='infomaniak' AND w.mode<>'paused' AND m.next_sync_at<=? AND m.lease_until<=? ORDER BY m.next_sync_at,m.connection_id LIMIT 1",
    )
    .bind(now(), now())
    .first<Connection>();
  if (!due) return { idle: true };
  const workspace = await db
    .prepare('SELECT * FROM support_workspaces WHERE id=?')
    .bind(due.workspace_id)
    .first<Workspace>();
  if (!workspace) throw new SupportError('Espace introuvable.', 404);
  try {
    return { idle: false, ...(await syncMailbox(workspace, due)) };
  } catch {
    // Retain fair scheduling even if subscription validation fails before a lease.
    await db
      .prepare(
        'UPDATE support_mailboxes SET next_sync_at=? WHERE connection_id=?',
      )
      .bind(now() + 300, due.id)
      .run();
    return { idle: false, failed: true };
  }
}
