import { database } from '@/lib/runtime';
import { digest } from './crypto';
import {
  record,
  text,
  SupportError,
  type Connection,
  type Decision,
  type SourceTicket,
  type Ticket,
  type Workspace,
} from './types';
import { solicitationDraft, type ReplyIntent } from './solicitation';
import {
  prepareReplyTransport,
  resolveReplyTarget,
  type ReplyTarget,
} from './reply-transport';

type ReplyRow = {
  id: string;
  intent: string;
  state: string;
  payload_hash: string;
  updated_at: number;
};
const now = () => Math.floor(Date.now() / 1000);
const publicReply = (r: ReplyRow | null) =>
  r
    ? {
        intent: r.intent,
        state:
          r.state === 'preparing' && r.updated_at < now() - 180
            ? 'rejected'
            : r.state === 'submitting' && r.updated_at < now() - 180
              ? 'uncertain'
              : r.state,
      }
    : null;
async function existing(t: Ticket) {
  return database()
    .prepare(
      'SELECT id,intent,state,payload_hash,updated_at FROM support_solicitation_replies WHERE workspace_id=? AND ticket_id=? AND fingerprint=?',
    )
    .bind(t.workspace_id, t.id, t.fingerprint)
    .first<ReplyRow>();
}
export async function solicitationAction(options: {
  action: string;
  raw: Record<string, unknown>;
  workspace: Workspace;
  ticket: Ticket;
  connection: Connection;
  actor: string;
  secret: () => Promise<string>;
  reauthorize: () => Promise<Workspace>;
}) {
  const {
    action,
    raw,
    workspace: w,
    ticket: t,
    connection: c,
    actor,
    secret,
    reauthorize,
  } = options;
  const decision = t.decision_json
    ? (JSON.parse(t.decision_json) as Decision)
    : null;
  if (decision?.category !== 'solicitation')
    throw new SupportError(
      'Ces actions sont réservées aux messages classés Démarchage.',
      409,
    );
  if (
    raw.revision !== t.revision ||
    t.state === 'processing' ||
    (t.lease_until ?? 0) > now()
  )
    throw new SupportError(
      'Ce message a changé. Rechargez-le avant de continuer.',
      409,
    );
  const db = database();
  let previous = await existing(t);
  if (action === 'ignoreSolicitation' || action === 'restoreSolicitation') {
    if (previous && previous.state !== 'ignored')
      throw new SupportError(
        'Une réponse a déjà été préparée ou envoyée. Consultez son état.',
        409,
      );
    if (action === 'restoreSolicitation')
      await db
        .prepare(
          "DELETE FROM support_solicitation_replies WHERE workspace_id=? AND ticket_id=? AND fingerprint=? AND state='ignored'",
        )
        .bind(w.id, t.id, t.fingerprint)
        .run();
    else
      await db
        .prepare(
          "INSERT INTO support_solicitation_replies(id,workspace_id,ticket_id,fingerprint,intent,state,actor,created_at,updated_at) VALUES(?,?,?,?,'ignore','ignored',?,?,?) ON CONFLICT(ticket_id,fingerprint) DO NOTHING",
        )
        .bind(
          crypto.randomUUID(),
          w.id,
          t.id,
          t.fingerprint,
          actor,
          now(),
          now(),
        )
        .run();
    return {
      saved: true,
      disposition: action === 'ignoreSolicitation' ? 'ignored' : null,
    };
  }
  if (!['interested', 'stop'].includes(String(raw.intent)))
    throw new SupportError('Choisissez Intéressé ou STOP.');
  const intent = raw.intent as ReplyIntent,
    source = JSON.parse(t.source_json) as SourceTicket;
  if (action === 'previewSolicitationReply') {
    const draft = solicitationDraft(w, t.subject, decision, intent);
    let target: ReplyTarget | null = null,
      unavailable = '';
    try {
      target = await resolveReplyTarget(c, await secret(), source, w.name);
    } catch (error) {
      if (
        error instanceof SupportError ||
        (error instanceof Error && 'status' in error)
      )
        unavailable = error.message;
      else throw error;
    }
    return {
      draft: {
        ...draft,
        target,
        intent,
        fingerprint: t.fingerprint,
        status: publicReply(previous),
        enabled: !!w.replies_enabled,
        unavailable,
      },
    };
  }
  if (action !== 'sendSolicitationReply')
    throw new SupportError('Action inconnue.');
  if (raw.confirm !== true || !w.replies_enabled)
    throw new SupportError(
      'Un administrateur doit autoriser les réponses dans les paramètres Démarchage, puis vous pouvez confirmer chaque envoi.',
      403,
    );
  const subject = text(raw.subject, 301),
    body = text(raw.body, 6001);
  if (
    !subject ||
    subject.length > 300 ||
    /[\r\n\x00-\x1f\x7f]/.test(subject) ||
    !body ||
    body.length > 6000 ||
    body.includes('\0')
  )
    throw new SupportError('Vérifiez l’objet et le texte de votre réponse.');
  const target = record(raw.target);
  const hash = await digest(JSON.stringify({ intent, subject, body, target }));
  if (previous?.state === 'preparing' && previous.updated_at < now() - 180) {
    await db
      .prepare(
        "UPDATE support_solicitation_replies SET state='rejected' WHERE id=? AND state='preparing' AND updated_at<?",
      )
      .bind(previous.id, now() - 180)
      .run();
    previous = await existing(t);
  }
  if (previous && !['ignored', 'rejected'].includes(previous.state)) {
    if (previous.payload_hash !== hash)
      throw new SupportError(
        'Une réponse existe déjà pour ce message. Vérifiez son état avant de poursuivre.',
        409,
      );
    return { reply: publicReply(previous), replayed: true };
  }
  const key = await secret(),
    resolved = await resolveReplyTarget(c, key, source, w.name);
  if (
    raw.fingerprint !== t.fingerprint ||
    resolved.recipient !== target.recipient ||
    resolved.from !== target.from ||
    resolved.name !== target.name ||
    resolved.sourceVersion !== target.sourceVersion
  )
    throw new SupportError(
      'Le destinataire ou le message a changé. Rouvrez la réponse pour le vérifier.',
      409,
    );
  const id = crypto.randomUUID();
  // The source and connection must still be current when claiming the operation.
  const claimed = await db
    .prepare(`INSERT INTO support_solicitation_replies(id,workspace_id,ticket_id,fingerprint,intent,state,recipient,subject,body,payload_hash,actor,created_at,updated_at)
    SELECT ?,?,?,?,?,'preparing',?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM support_tickets WHERE id=? AND workspace_id=? AND revision=? AND fingerprint=? AND state<>'processing')
    AND (SELECT COUNT(*) FROM support_solicitation_replies WHERE workspace_id=? AND created_at>=? AND state<>'ignored')<120
    ON CONFLICT(ticket_id,fingerprint) DO UPDATE SET id=excluded.id,intent=excluded.intent,state='preparing',recipient=excluded.recipient,subject=excluded.subject,body=excluded.body,payload_hash=excluded.payload_hash,actor=excluded.actor,updated_at=excluded.updated_at
    WHERE support_solicitation_replies.state IN ('ignored','rejected') RETURNING id`)
    .bind(
      id,
      w.id,
      t.id,
      t.fingerprint,
      intent,
      resolved.recipient,
      subject,
      body,
      hash,
      actor,
      now(),
      now(),
      t.id,
      w.id,
      t.revision,
      t.fingerprint,
      w.id,
      now() - 3600,
    )
    .first<{ id: string }>();
  if (!claimed) {
    const concurrent = await existing(t);
    if (concurrent?.payload_hash === hash)
      return { reply: publicReply(concurrent), replayed: true };
    throw new SupportError(
      'Une action est déjà en cours ou la limite d’envoi est atteinte. Actualisez ce message.',
      409,
    );
  }
  let submitting = false,
    transport: Awaited<ReturnType<typeof prepareReplyTransport>> | undefined;
  try {
    transport = await prepareReplyTransport(
      c,
      key,
      resolved,
      source,
      { subject, body },
      claimed.id,
    );
    const fresh = await reauthorize();
    if (!fresh.replies_enabled)
      throw new SupportError(
        'L’envoi de réponses a été désactivé par votre équipe.',
        403,
      );
    const ready = await db
      .prepare(`UPDATE support_solicitation_replies SET state='submitting',updated_at=? WHERE id=? AND state='preparing'
      AND EXISTS(SELECT 1 FROM support_tickets WHERE id=? AND workspace_id=? AND revision=? AND fingerprint=? AND state<>'processing')
      AND EXISTS(SELECT 1 FROM support_connections WHERE id=? AND workspace_id=? AND active=1 AND secret=?)
      AND EXISTS(SELECT 1 FROM support_workspaces WHERE id=? AND replies_enabled=1) RETURNING id`)
      .bind(
        now(),
        claimed.id,
        t.id,
        w.id,
        t.revision,
        t.fingerprint,
        c.id,
        w.id,
        c.secret,
        w.id,
      )
      .first();
    if (!ready)
      throw new SupportError(
        'Le message ou la connexion a changé. Rouvrez la réponse avant de l’envoyer.',
        409,
      );
    submitting = true;
    await transport.submit();
    await db
      .prepare(
        "UPDATE support_solicitation_replies SET state='accepted',updated_at=? WHERE id=? AND state='submitting'",
      )
      .bind(now(), claimed.id)
      .run();
    await db
      .prepare(
        'INSERT INTO support_events(id,workspace_id,ticket_id,kind,detail,actor,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        w.id,
        t.id,
        'solicitation_reply',
        intent === 'stop'
          ? 'Réponse STOP acceptée par la messagerie.'
          : 'Réponse d’intérêt acceptée par la messagerie.',
        actor,
        now(),
      )
      .run();
    return { reply: { intent, state: 'accepted' }, replayed: false };
  } catch (error) {
    const state = submitting ? 'uncertain' : 'rejected';
    await db
      .prepare(
        "UPDATE support_solicitation_replies SET state=?,updated_at=? WHERE id=? AND state IN ('preparing','submitting')",
      )
      .bind(state, now(), claimed.id)
      .run()
      .catch(() => {});
    if (submitting)
      return { reply: { intent, state: 'uncertain' }, replayed: false };
    if (
      error instanceof SupportError ||
      (error instanceof Error && 'status' in error)
    )
      throw error;
    throw new SupportError(
      'La réponse n’a pas pu être préparée. Aucun envoi demandé ; vérifiez votre connexion.',
      503,
    );
  } finally {
    transport?.close();
  }
}
