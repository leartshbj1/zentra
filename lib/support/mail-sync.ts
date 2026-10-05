import { supportAutomationState } from '@/lib/automation/execution';
import { database, runtimeValue } from '@/lib/runtime';
import { reportServiceFailure, createSchedulerProgress, markMailSyncFailure, mailSyncFailureStage, mailSyncFailureTransport, type MailSyncFailureStage, type MailSyncTransport } from '@/lib/service-diagnostics';
import { encryptSecret, decryptSecret, digest, equalHash } from './crypto';
import {
  verifyMailbox,
  normalizeMailToken,
  listMail,
  readMail,
  readMailAttachment,
  mailExternalId,
  MAIL_DIRECTORY,
  MAIL_RULES,
  MAIL_PAGE_SIZE,
  type MailReference,
} from './infomaniak';
import {
  SupportError,
  type Connection,
  type Workspace,
  type Ticket,
  type SourceTicket,
} from './types';
import { openImapMailbox, decodeImapCredentials, encodeImapCredentials, type ImapMailbox } from './infomaniak-imap';
import { requireSupportSubscription } from './billing';
import { ingest, processTicket } from './service';
import { mailboxCaptureNeeded, captureMailboxInvoices } from '@/lib/supplier-inbox/capture';
import { prepareMailDocuments } from './mail-documents';
import { decodeMailScanResume, encodeMailScanResume, mailScanHints, mailScanLink,
  scanLinkIdentity, scanProviderIdentity, MAIL_SCAN_LOOKUP_SIZE, type MailScanHint } from './mail-scan-state';

export type Mailbox = {
  connection_id: string;
  workspace_id: string;
  email: string;
  mailbox_id: string;
  folder_id: string;
  since_at: number;
  scan_offset: number;
  scan_resume_json: string | null;
  next_sync_at: number;
  last_sync_at: number | null;
  last_error: string | null;
  lease: string | null;
  lease_until: number;
};
const now = () => Math.floor(Date.now() / 1000);
const MAIL_LEASE_SECONDS = 600;
export type MailSyncControl = { deadline?: number };
class MailSyncDeferred extends Error {
  constructor(readonly reason: 'lease') { super('Mailbox work deferred'); }
}
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
          'UPDATE support_mailboxes SET mailbox_id=?,folder_id=?,since_at=?,scan_offset=?,scan_resume_json=NULL,last_error=NULL,next_sync_at=0 WHERE connection_id=?',
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
export async function refreshMailboxTicket(workspace: Workspace, connection: Connection, previous: SourceTicket) {
  await requireSupportSubscription(workspace);
  const mailbox = await database().prepare('SELECT * FROM support_mailboxes WHERE connection_id=? AND workspace_id=?')
    .bind(connection.id, workspace.id).first<Mailbox>();
  if (!mailbox) throw new SupportError('Reconnectez cette boîte mail avant de relancer l’analyse.');
  const token = await decryptSecret(runtimeValue('SUPPORT_ENCRYPTION_KEY'), connection.secret, `connection:${workspace.id}:${connection.id}`);
  const credentials = decodeImapCredentials(token);
  const uid = previous.mail?.uid || (credentials ? /^(\d+):/.exec(previous.mail?.attachments[0]?.id || '')?.[1] : undefined);
  if (!uid || await mailExternalId(mailbox.mailbox_id, mailbox.folder_id, uid) !== previous.externalId)
    throw new SupportError('Cet ancien mail ne peut pas être relu automatiquement. Vérifiez son classement manuellement. Les nouveaux mails prennent en charge la nouvelle analyse.');
  const imap = credentials ? await openImapMailbox(mailbox.email, credentials.password, mailbox.folder_id) : null;
  try {
    const ref = { uid, date: null };
    const source = imap ? await imap.read(ref) : await readMail(token, mailbox.mailbox_id, mailbox.folder_id, ref);
    const readAttachment = imap?.attachment ?? ((id: string) => readMailAttachment(token, mailbox.mailbox_id, mailbox.folder_id, uid, id));
    return (await prepareMailDocuments(source, readAttachment)).source;
  } finally { imap?.close(); }
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
    .bind(lease, now() + MAIL_LEASE_SECONDS, connection.id, workspace.id, now())
    .first<Mailbox>();
  if (!mailbox) return { syncing: true };
  return syncClaimedMailbox(workspace, connection, mailbox, true);
}

async function syncClaimedMailbox(
  workspace: Workspace, connection: Connection, mailbox: Mailbox,
  subscriptionVerified = false,
  control: MailSyncControl = {},
) {
  const db = database(), lease = mailbox.lease!;
  const trackPhase = createSchedulerProgress();
  let stage: MailSyncFailureStage = 'subscription';
  let transport: MailSyncTransport | undefined;
  const admissionExpired = () => control.deadline !== undefined && Date.now() >= control.deadline;
  // Drain each admitted message/classification, then check the admission budget
  // before starting another. A first useful unit in each queue prevents slow
  // setup or a busy mail queue from starving durable progress in the other.
  // Lease ownership still fences every effect; this is never a hard timeout.
  const checkpoint = async () => {
    try {
      const time = now();
      const owned = await db.prepare(`UPDATE support_mailboxes SET lease_until=?
      WHERE connection_id=? AND workspace_id=? AND lease=? AND lease_until>?
      AND EXISTS(SELECT 1 FROM support_connections c JOIN support_workspaces w ON w.id=c.workspace_id
        WHERE c.id=support_mailboxes.connection_id AND c.workspace_id=support_mailboxes.workspace_id
          AND c.active=1 AND c.provider='infomaniak' AND w.mode<>'paused') RETURNING connection_id`)
      .bind(time + MAIL_LEASE_SECONDS, connection.id, workspace.id, lease, time).first();
      if (!owned) throw new MailSyncDeferred('lease');
    } catch (error) { throw markMailSyncFailure(error, 'lease', transport); }
  };
  let imported = 0,
    processed = 0;
  let captured=0,captureDeferred=false;
  let preparedMessages = 0;
  let completedMessageUnits = 0, budgetDeferred = false;
  let completedScanChecks = 0;
  let captureError:string|null=null;
  let imap: ImapMailbox | undefined;
  try {
    if (!subscriptionVerified) await requireSupportSubscription(workspace);
    await checkpoint();
    stage = 'decrypt';
    const token = await decryptSecret(
      runtimeValue('SUPPORT_ENCRYPTION_KEY'),
      connection.secret,
      `connection:${workspace.id}:${connection.id}`,
    );
    const credentials = decodeImapCredentials(token);
    transport = credentials ? 'imap' : 'api';
    if (credentials) {
      stage = 'open';
      imap = await openImapMailbox(mailbox.email, credentials.password, mailbox.folder_id);
    }
    await checkpoint();
    stage = 'list';
    const newest = imap ? await imap.list(0, credentials!.firstUid) : await listMail(
      token,
      mailbox.mailbox_id,
      mailbox.folder_id,
      0,
      mailbox.since_at,
    );
    // Check new arrivals on every run, even during a long historical scan.
    await checkpoint();
    stage = 'lookup';
    const initialLink = await mailScanLink(workspace.id);
    const linkIdentity = await scanLinkIdentity(initialLink);
    const providerIdentity = await scanProviderIdentity(mailbox,{transport,firstUid:credentials?.firstUid??null});
    const savedResume = decodeMailScanResume(mailbox.scan_resume_json);
    // A changed provider/filter/link never reuses an old list of consumed UIDs.
    let resume = savedResume && savedResume.identity === providerIdentity &&
      savedResume.link === linkIdentity && savedResume.offset === mailbox.scan_offset ? savedResume : null;
    // UIDVALIDITY is already checked by the IMAP connector's exact folder ID.
    // A provider whose recent UID range shrinks must not hide replacement UIDs
    // behind a previous resume's high-water mark, even under the same folder ID.
    if(resume && newest.messages.length){
      const highest=newest.messages.reduce((uid,ref)=>BigInt(ref.uid)>BigInt(uid)?ref.uid:uid,'0');
      if(BigInt(highest)<BigInt(resume.latestUid))resume=null;
    }
    const scanOffset = mailbox.scan_resume_json && !resume ? 0 : mailbox.scan_offset;
    stage = 'list';
    const page = resume ?? (
      scanOffset > 0
        ? imap ? await imap.list(scanOffset, credentials!.firstUid) : await listMail(
            token,
            mailbox.mailbox_id,
            mailbox.folder_id,
            scanOffset,
            mailbox.since_at,
          )
        : newest);
    // Revisited recent pages must not reintroduce the already consumed prefix
    // of a durable resume. UID order belongs to this exact folder identity.
    const freshMessages = resume ? newest.messages.filter(ref => BigInt(ref.uid) > BigInt(resume.latestUid)) : newest.messages;
    const messages = new Map(
      [...freshMessages, ...page.messages].map((ref) => [ref.uid, ref]),
    );
    const handledMessages = new Set<string>();
    const refs = [...messages.values()];
    let hints = new Map<string, MailScanHint>();
    let hintEnd = 0;
    for (let index = 0; index < refs.length; index++) {
      const ref = refs[index];
      if (ref.date !== null && ref.date < mailbox.since_at) { handledMessages.add(ref.uid); continue; }
      stage = 'lookup';
      if (index >= hintEnd) {
        if (completedScanChecks > 0 && admissionExpired()) { budgetDeferred = true; break; }
        await checkpoint();
        const chunk = refs.slice(index, index + MAIL_SCAN_LOOKUP_SIZE);
        const externals = await Promise.all(chunk.map(item => mailExternalId(mailbox.mailbox_id, mailbox.folder_id, item.uid)));
        hints = await mailScanHints(workspace.id, connection.id, externals, initialLink);
        hintEnd = index + chunk.length;
      }
      const external = await mailExternalId(
        mailbox.mailbox_id,
        mailbox.folder_id,
        ref.uid,
      );
      const hint = hints.get(external)!;
      const duplicate = hint.duplicate;
      if (duplicate && hint.captured) { handledMessages.add(ref.uid); completedScanChecks++; continue; }
      if (duplicate && captured >= 3) { captureDeferred = true; continue; }
      if (completedMessageUnits > 0 && admissionExpired()) { budgetDeferred = true; break; }
      await checkpoint();
      const capture=await mailboxCaptureNeeded(workspace.id,connection.id,external);
      if(capture && captured>=3) captureDeferred=true;
      if(duplicate && capture && captured>=3) continue;
      if (duplicate && !capture) {
        handledMessages.add(ref.uid); completedScanChecks++;
        if (admissionExpired()) { budgetDeferred = true; break; }
        continue;
      }
      if (completedMessageUnits > 0 && admissionExpired()) { budgetDeferred = true; break; }
      const active = await db
        .prepare('SELECT active FROM support_connections WHERE id=?')
        .bind(connection.id)
        .first<{ active: number }>();
      if (!active?.active)
        throw new SupportError('La boîte a été déconnectée.');
      let source: SourceTicket;
      stage = 'read';
      try { source = imap ? await imap.read(ref) : await readMail(
        token,
        mailbox.mailbox_id,
        mailbox.folder_id,
        ref,
      ); } catch (error) {
        if (imap && error instanceof SupportError && error.status === 422) { captureError = error.message; handledMessages.add(ref.uid); continue; }
        throw error;
      }
      await checkpoint();
      if (!duplicate && source.mail?.attachments.length) {
        if (preparedMessages >= 3) { captureDeferred = true; continue; }
        preparedMessages++;
      }
      const readAttachment = imap?.attachment ?? ((id: string) => readMailAttachment(token, mailbox.mailbox_id, mailbox.folder_id, ref.uid, id));
      stage = 'prepare';
      const prepared = !duplicate ? await trackPhase('mail.prepare', () => prepareMailDocuments(source, readAttachment), transport) : null;
      if (prepared) source = prepared.source;
      await checkpoint();
      if(capture && captured<3) {
        if(source.mail?.attachments.length)captured++;
        stage = 'capture';
        try {await trackPhase('mail.capture', () => captureMailboxInvoices({workspace,connectionId:connection.id,source,token,mailboxId:mailbox.mailbox_id,folderId:mailbox.folder_id,uid:ref.uid,readAttachment,documents:prepared?.documents}), transport);}
        catch(error){reportServiceFailure(markMailSyncFailure(error,'capture',transport),{operation:'support.mailbox.capture',mailTransport:transport});captureError=error instanceof SupportError?error.message:'Certains justificatifs n’ont pas pu être importés dans Gestion. La réception réessaiera ; les tickets Support continuent d’être traités. Pour un document de plus de 6 Mo ou un mail de plus de 12 pièces, utilisez l’import manuel de Gestion.';}
      }
      await checkpoint();
      if(!duplicate){stage = 'ingest';await ingest(connection, source);imported++;}
      handledMessages.add(ref.uid);
      completedMessageUnits++;
      completedScanChecks++;
    }
    // Repeat complete scans from the connection date. There is no newest-N cap;
    // restarting each scan also recovers changes to offset pagination during delivery.
    // Provider offsets count threads or UID windows, not returned messages.
    // Keep the entire page until all its messages have been handled; duplicates
    // skip durable completed work on the next cycle without skipping unread mail.
    stage = 'lookup';
    const unchangedLink = await scanLinkIdentity(await mailScanLink(workspace.id)) === linkIdentity;
    const pageHandled = unchangedLink && refs.every(ref => handledMessages.has(ref.uid));
    // The provider offset counts threads/UID windows. Persist remaining UIDs
    // instead of interpreting a consumed message prefix as a provider offset.
    // A changed link retains the full page so its receipts are re-evaluated.
    const remaining: MailReference[] = refs.filter(ref => !unchangedLink || !handledMessages.has(ref.uid));
    const latestUid = newest.messages.reduce((highest, ref) => BigInt(ref.uid) > BigInt(highest) ? ref.uid : highest, resume?.latestUid ?? '0');
    const resumeJson = pageHandled ? null : encodeMailScanResume({version:1,identity:providerIdentity,
      link:linkIdentity,offset:scanOffset,count:page.count,createdAt:resume?.createdAt ?? now(),latestUid,
      messages:remaining});
    const pageHasMore = page.count >= MAIL_PAGE_SIZE;
    let more = budgetDeferred || !pageHandled || pageHasMore;
    await checkpoint();
    stage = 'progress';
    const progress = await db
      .prepare(
        `UPDATE support_mailboxes SET scan_offset=?,last_sync_at=?,scan_resume_json=? WHERE connection_id=? AND workspace_id=? AND lease=? AND lease_until>? AND mailbox_id=? AND folder_id=? AND since_at=? AND scan_offset=?
        AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM support_gestion_links WHERE workspace_id=?))
          OR EXISTS(SELECT 1 FROM support_gestion_links WHERE workspace_id=? AND organization_id=? AND connected_by=? AND enabled=? AND created_at=?))`,
      )
      .bind(
        pageHandled ? (pageHasMore ? scanOffset + page.count : 0) : scanOffset,
        now(),
        resumeJson,
        connection.id,
        workspace.id,
        lease,
        now(),
        mailbox.mailbox_id,
        mailbox.folder_id,
        mailbox.since_at,
        mailbox.scan_offset,
        initialLink?.organization_id ?? null,
        workspace.id,
        workspace.id,
        initialLink?.organization_id ?? null,
        initialLink?.connected_by ?? null,
        initialLink?.enabled ?? null,
        initialLink?.created_at ?? null,
      )
      .run();
    if (!progress.meta.changes) throw new MailSyncDeferred('lease');
    await checkpoint();
    stage = 'classify';
    const pending = await trackPhase('mail.classify', async () => {
      const canAnalyze = (await supportAutomationState(workspace.id)).enabled;
      const pending = canAnalyze ? await db
        .prepare(
          "SELECT id FROM support_tickets WHERE connection_id=? AND (state='pending' OR (state='processing' AND lease_until<=?) OR (state='error' AND attempts<3 AND updated_at<?)) ORDER BY created_at,id LIMIT 5",
        )
        .bind(connection.id, now(), now() - 300)
        .all<Pick<Ticket, 'id'>>() : {results:[]};
      for (const ticket of pending.results) {
        await checkpoint();
        if (processed > 0 && admissionExpired()) { budgetDeferred = true; more = true; break; }
        await processTicket(
          ticket.id,
          workspace,
          connection,
          'Synchronisation mail',
        );
        processed++;
      }
      return pending;
    }, transport);
    await checkpoint();
    stage = 'finalize';
    const completed = await db
      .prepare(
        'UPDATE support_mailboxes SET next_sync_at=?,last_error=?,lease=NULL,lease_until=0 WHERE connection_id=? AND lease=? AND lease_until>?',
      )
      .bind(
        now() + (more || captureDeferred || pending.results.length === 5 ? 30 : 300),
        captureError,
        connection.id,
        lease,
        now(),
      )
      .run();
    if (!completed.meta.changes) throw new MailSyncDeferred('lease');
    return { imported, processed, more, incomplete: Boolean(captureError || captureDeferred || budgetDeferred), ...(budgetDeferred ? { budgetExhausted: true } : {}) };
  } catch (error) {
    markMailSyncFailure(error, stage, transport);
    // An upstream failure can arrive after another worker acquired this box.
    // Report deferred ownership and never overwrite the successor's outcome.
    if (!(error instanceof MailSyncDeferred)) {
      const owner = await db.prepare('SELECT 1 FROM support_mailboxes WHERE connection_id=? AND lease=? AND lease_until>?')
        .bind(connection.id,lease,now()).first();
      if (!owner) error = new MailSyncDeferred('lease');
    }
    if (error instanceof MailSyncDeferred) {
      await db.prepare('UPDATE support_mailboxes SET next_sync_at=?,lease=NULL,lease_until=0 WHERE connection_id=? AND lease=? AND lease_until>?')
        .bind(now() + 30, connection.id, lease, now()).run();
      return { imported, processed, incomplete: true, syncing: true };
    }
    const message =
      error instanceof SupportError
        ? error.message
        : 'La synchronisation a été interrompue. Elle sera réessayée.';
    await db
      .prepare(
        'UPDATE support_mailboxes SET last_error=?,next_sync_at=?,lease=NULL,lease_until=0 WHERE connection_id=? AND lease=? AND lease_until>?',
      )
      .bind(message, now() + 300, connection.id, lease, now())
      .run();
    throw markMailSyncFailure(new SupportError(message, 503, { cause: error }), mailSyncFailureStage(error) ?? stage, mailSyncFailureTransport(error) ?? transport);
  } finally { imap?.close(); }
}
export type MailSyncResult = {
  idle: boolean;
  failed?: boolean;
  paused?: boolean;
  syncing?: boolean;
  incomplete?: boolean;
  imported?: number;
  processed?: number;
  more?: boolean;
  reference?: string;
  budgetExhausted?: boolean;
};
export async function requireMailScheduler(request: Request): Promise<void> {
  const expected = runtimeValue('SUPPORT_MAIL_SYNC_TOKEN');
  const actual =
    request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  if (
    !expected ||
    !actual ||
    !equalHash(await digest(expected), await digest(actual))
  )
    throw new SupportError('Accès refusé.', 401);
}
export async function runMailSync(request: Request, control: MailSyncControl = {}): Promise<MailSyncResult> {
  const startedAt = Date.now();
  await requireMailScheduler(request);
  if (control.deadline !== undefined && Date.now() >= control.deadline)
    return {idle: false, incomplete: true, budgetExhausted: true};
  const db = database(), lease = crypto.randomUUID(), time = now();
  // Selection and reservation are one SQLite statement. Parallel requests move
  // to distinct due boxes instead of all selecting the same unclaimed row.
  const mailbox = await db.prepare(`UPDATE support_mailboxes SET lease=?,lease_until=?
    WHERE connection_id=(SELECT m.connection_id FROM support_mailboxes m
      JOIN support_connections c ON c.id=m.connection_id AND c.workspace_id=m.workspace_id
      JOIN support_workspaces w ON w.id=m.workspace_id
      WHERE c.active=1 AND c.provider='infomaniak' AND w.mode<>'paused'
        AND m.next_sync_at<=? AND m.lease_until<=?
      ORDER BY m.next_sync_at,m.connection_id LIMIT 1)
    AND next_sync_at<=? AND lease_until<=? RETURNING *`)
    .bind(lease,time+MAIL_LEASE_SECONDS,time,time,time,time).first<Mailbox>();
  if (!mailbox) return { idle: true };
  try {
    const connection = await db.prepare('SELECT * FROM support_connections WHERE id=? AND workspace_id=?')
      .bind(mailbox.connection_id,mailbox.workspace_id).first<Connection>();
    const workspace = await db.prepare('SELECT * FROM support_workspaces WHERE id=?')
      .bind(mailbox.workspace_id).first<Workspace>();
    if (!connection || !workspace) throw new SupportError('Espace indisponible.',503);
    return { idle: false, ...(await syncClaimedMailbox(workspace, connection, mailbox, false, control)) };
  } catch (error) {
    const cause = error instanceof SupportError && error.cause ? error.cause : error;
    const reference = reportServiceFailure(cause, {operation:'support.mailbox.sync',request,startedAt,mailStage:mailSyncFailureStage(error) ?? 'lookup',mailTransport:mailSyncFailureTransport(error)});
    // Subscription/setup failures must back off too, but only their own lease.
    // A late error can never postpone or release the next worker's claim.
    await db.prepare('UPDATE support_mailboxes SET next_sync_at=?,lease=NULL,lease_until=0 WHERE connection_id=? AND lease=? AND lease_until>?')
      .bind(now()+300,mailbox.connection_id,lease,now()).run();
    return { idle: false, failed: true, ...(reference ? {reference} : {}) };
  }
}
