import { ACCOUNT_ROLES, type AccountRole } from '../account-security';
import { snapshotPrivateJson } from './private-json';
import { UsMailboxError } from './us-support-mailbox-contract';

export interface UsMailboxMessage {
  readonly uid: string; readonly version: string; readonly subject: string; readonly sender: string;
  readonly receivedAt: number;
  readonly attachments: readonly Readonly<{ id: string; name: string; sizeBytes: number }>[];
}
export interface UsMailboxMessages {
  readonly schemaVersion: 1; readonly organizationId: string; readonly userId: string; readonly role: AccountRole;
  readonly workspaceId: string; readonly connectionId: string; readonly revision: number;
  readonly offset: number; readonly nextOffset: number | null; readonly messages: readonly UsMailboxMessage[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const controls = /[\p{Cc}\p{Cf}]/u;
function invalid(): never { throw new UsMailboxError('invalid_mailbox_record', 503); }
function object(v: unknown, keys: readonly string[]) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) return invalid();
  return v as Record<string, unknown>;
}
function text(v: unknown, max: number, empty = false): v is string { return typeof v === 'string' && (empty || v.length > 0) && v.length <= max && !controls.test(v); }
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export function validateUsMailboxOffset(input: string | null): number {
  if (input === null) return 0;
  if (!/^(0|[1-9]\d{0,2})$/.test(input) || Number(input) > 200 || Number(input) % 20 !== 0) throw new UsMailboxError('invalid_mailbox_request', 422);
  return Number(input);
}
/** Detached public metadata only. Mail HTML/body, credentials and URLs never
 * belong in this DTO; an observed provider date is not a content checksum. */
export function validateUsMailboxMessages(input: unknown, organizationId?: string): UsMailboxMessages {
  try {
    const v = object(snapshotPrivateJson(input), ['schemaVersion','organizationId','userId','role','workspaceId','connectionId','revision','offset','nextOffset','messages']);
    if (v.schemaVersion !== 1 || ![v.organizationId,v.userId,v.workspaceId,v.connectionId].every(id => typeof id === 'string' && uuid.test(id)) || organizationId !== undefined && v.organizationId !== organizationId || !(ACCOUNT_ROLES as readonly unknown[]).includes(v.role) || !['owner','admin'].includes(String(v.role)) || !integer(v.revision, 1) || !integer(v.offset, 0, 200) || v.offset % 20 !== 0 || v.nextOffset !== null && (!integer(v.nextOffset, 20, 200) || v.nextOffset !== v.offset + 20) || !Array.isArray(v.messages) || v.messages.length > 100) return invalid();
    const ids = new Set<string>();
    for (const raw of v.messages) {
      const m = object(raw, ['uid','version','subject','sender','receivedAt','attachments']);
      if (typeof m.uid !== 'string' || !/^\d{1,20}$/.test(m.uid) || ids.has(m.uid) || !text(m.version, 200) || !text(m.subject, 300, true) || !text(m.sender, 254, true) || !integer(m.receivedAt, 1, 253_402_300_799) || !Array.isArray(m.attachments) || m.attachments.length > 20) return invalid();
      ids.add(m.uid); const attachments = new Set<string>();
      for (const rawAttachment of m.attachments) {
        const a = object(rawAttachment, ['id','name','sizeBytes']);
        if (!text(a.id, 200) || /[\s/\\]/u.test(a.id) || attachments.has(a.id) || !text(a.name, 180) || /[/\\]/u.test(a.name) || !/\.(pdf|png|jpe?g|ics)$/i.test(a.name) || !integer(a.sizeBytes, 0, 6 * 1024 * 1024)) return invalid();
        attachments.add(a.id);
      }
    }
    return v as unknown as UsMailboxMessages;
  } catch { return invalid(); }
}
