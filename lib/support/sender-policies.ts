import { database } from '@/lib/runtime';
import {
  CATEGORIES,
  SupportError,
  text,
  type Decision,
  type Rules,
  type SourceTicket,
  type Ticket,
} from './types';

export type SenderPolicy = {
  id: string;
  sender: string;
  subject: string;
  category: string;
  enabled: number;
  revision: number;
};
export function senderAddress(source: SourceTicket): string {
  const value = source.senderEmail || source.mail?.sender || '';
  // A single connector envelope address; arbitrary addresses in the body are never used.
  const candidate = value.match(/^[^<>\r\n]*<([^<>]+)>$/)?.[1] || value;
  return candidate.length <= 254 &&
    /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(candidate.trim())
    ? candidate.trim().toLowerCase()
    : '';
}
export const normalizedSubject = (value: string) =>
  value
    .trim()
    .toLocaleLowerCase()
    .replace(/^(?:(?:re|fw|fwd|tr|aw):\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
export function policyInput(raw: Record<string, unknown>) {
  const sender = senderAddress({
      senderEmail: text(raw.sender, 255),
    } as SourceTicket),
    subject = normalizedSubject(text(raw.subject, 161)),
    category = text(raw.category, 40);
  if (
    !sender ||
    !['trusted', ...Object.keys(CATEGORIES)].includes(category) ||
    (subject && subject.length < 3)
  )
    throw new SupportError(
      'Indiquez une adresse complète et, si nécessaire, au moins trois caractères de l’objet.',
    );
  if (category === 'trusted' && subject)
    throw new SupportError(
      'Un expéditeur fiable est protégé pour tous ses objets.',
    );
  return { sender, subject, category };
}
export async function senderPolicies(workspace: string) {
  return (
    await database()
      .prepare(
        'SELECT id,sender,subject,category,enabled,revision FROM support_sender_policies WHERE workspace_id=? ORDER BY sender,subject LIMIT 201',
      )
      .bind(workspace)
      .all<SenderPolicy>()
  ).results;
}
export async function saveSenderPolicy(
  workspace: string,
  actor: string,
  raw: Record<string, unknown>,
) {
  const { sender, subject, category } = policyInput(raw),
    id = text(raw.id, 50),
    db = database(),
    time = Math.floor(Date.now() / 1000);
  if (id) {
    const row = await db
      .prepare(
        'UPDATE support_sender_policies SET sender=?,subject=?,category=?,enabled=?,revision=revision+1,updated_at=? WHERE workspace_id=? AND id=? AND revision=? RETURNING id',
      )
      .bind(
        sender,
        subject,
        category,
        raw.enabled === false ? 0 : 1,
        time,
        workspace,
        id,
        Number(raw.revision) || 0,
      )
      .first();
    if (!row)
      throw new SupportError(
        'Cette règle a changé. Rechargez les paramètres.',
        409,
      );
  } else {
    const same = await db
      .prepare(
        'SELECT id FROM support_sender_policies WHERE workspace_id=? AND sender=? AND subject=?',
      )
      .bind(workspace, sender, subject)
      .first();
    if (same)
      throw new SupportError(
        'Une règle existe déjà pour cet expéditeur et cet objet. Modifiez-la dans les paramètres.',
        409,
      );
    const inserted = await db
      .prepare(
        'INSERT INTO support_sender_policies(id,workspace_id,sender,subject,category,created_by,created_at,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM support_sender_policies WHERE workspace_id=?)<200 RETURNING id',
      )
      .bind(
        crypto.randomUUID(),
        workspace,
        sender,
        subject,
        category,
        actor,
        time,
        time,
        workspace,
      )
      .first();
    if (!inserted)
      throw new SupportError(
        'La limite de 200 règles est atteinte. Supprimez une règle inutilisée.',
      );
  }
  return { saved: true };
}
export async function deleteSenderPolicy(
  workspace: string,
  raw: Record<string, unknown>,
) {
  const result = await database()
    .prepare(
      'DELETE FROM support_sender_policies WHERE workspace_id=? AND id=? AND revision=? RETURNING id',
    )
    .bind(workspace, text(raw.id, 50), Number(raw.revision) || 0)
    .first();
  if (!result)
    throw new SupportError(
      'Cette règle a changé. Rechargez les paramètres.',
      409,
    );
  return { saved: true };
}
export function applySenderPolicies(
  decision: Decision,
  source: SourceTicket,
  policies: SenderPolicy[],
  routes: Rules,
): Decision {
  const sender = senderAddress(source);
  if (!sender) return decision;
  const rules = policies.filter((p) => p.enabled && p.sender === sender);
  if (
    rules.some((p) => p.category === 'trusted') &&
    ['solicitation', 'spam'].includes(decision.category)
  )
    return {
      ...decision,
      category: 'other',
      priority: decision.priority === 'low' ? 'normal' : decision.priority,
      destination: null,
      confidence: 0,
      categoryConfidence: 0,
      reason:
        'Expéditeur fiable : ce message reste visible. Choisissez sa catégorie.',
    };
  const trusted = rules.some((p) => p.category === 'trusted');
  const matches = rules.filter(
    (p) =>
      p.category !== 'trusted' &&
      !(trusted && ['solicitation', 'spam'].includes(p.category)) &&
      (!p.subject || normalizedSubject(source.subject).includes(p.subject)),
  );
  // Conflicting company rules are a review case, never an arbitrary winner.
  if (new Set(matches.map((p) => p.category)).size > 1)
    return {
      ...decision,
      destination: null,
      confidence: 0,
      reason:
        'Deux règles de votre équipe se contredisent. Vérifiez la catégorie.',
    };
  const rule = matches[0];
  if (!rule) return decision;
  const category = rule.category as Decision['category'];
  const urgent =
    ['high', 'urgent'].includes(decision.priority) ||
    ['high', 'urgent'].includes(source.priority || '') ||
    (decision.signals?.humanRequested || 0) >= 0.2;
  if (urgent && ['solicitation', 'spam'].includes(category))
    return {
      ...decision,
      destination: null,
      confidence: 0,
      reason:
        'Ce message semble important. La règle de mise à l’écart nécessite une vérification.',
    };
  return {
    ...decision,
    category,
    categoryConfidence: 1,
    confidence: Math.min(1, decision.priorityConfidence),
    destination: category === 'solicitation' ? null : routes[category] || null,
    priority: category === 'solicitation' ? 'low' : decision.priority,
    policyVersion: `company:${rule.id}:${rule.revision}`,
    reason: 'Catégorie définie par une règle explicite de votre équipe.',
  };
}
export async function protectTicket(ticket: Ticket, revision: unknown) {
  const decision = ticket.decision_json
    ? (JSON.parse(ticket.decision_json) as Decision)
    : null;
  if (decision?.category !== 'solicitation')
    throw new SupportError('Ce message n’est plus classé Démarchage.', 409);
  const updated = {
    ...decision,
    category: 'other',
    priority: decision.priority === 'low' ? 'normal' : decision.priority,
    confidence: 0,
    categoryConfidence: 0,
    destination: null,
    manual: true,
    reason: 'Retiré du démarchage par votre équipe. Choisissez sa catégorie.',
  };
  const row = await database()
    .prepare(
      "UPDATE support_tickets SET state='review',decision_json=?,automatic=0,corrected=1,revision=revision+1,updated_at=unixepoch() WHERE id=? AND workspace_id=? AND revision=? AND state<>'processing' AND COALESCE(lease_until,0)<=unixepoch() RETURNING id",
    )
    .bind(
      JSON.stringify(updated),
      ticket.id,
      ticket.workspace_id,
      Number(revision) || 0,
    )
    .first();
  if (!row) throw new SupportError('Ce message a changé. Rechargez-le.', 409);
  return { saved: true };
}
